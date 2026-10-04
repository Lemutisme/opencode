"""Issuer-owned adapter around the qualified model-only gateway. Never part of H."""

import argparse
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import signal
import sqlite3
import threading
import time
import hashlib
from contextlib import closing


class ProviderResponse:
    """Bounded, passive observation of upstream bytes; never worker testimony."""
    def __init__(self):
        self.pending = bytearray()
        self.failure = None
        self.unknown = False
        self.digest = hashlib.sha256()

    def write(self, data):
        self.digest.update(data)
        if self.unknown:
            return
        self.pending.extend(data)
        while b"\n" in self.pending:
            line, _, self.pending = self.pending.partition(b"\n")
            if len(line) > 65536:
                self.unknown = True
                self.pending.clear()
                return
            self.line(line.strip())
        if len(self.pending) > 65536:
            self.unknown = True
            self.pending.clear()

    def line(self, line):
        if not line or line.startswith(b":"):
            return
        if line in (b"event: error", b"event: response.created", b"event: response.in_progress"):
            return
        if line.startswith(b"data:"):
            line = line[5:].strip()
        if line == b"[DONE]" and self.failure:
            return
        try:
            value = json.loads(line, object_pairs_hook=self.unique_fields)
        except (ValueError, UnicodeDecodeError):
            self.unknown = True
            return
        if not isinstance(value, dict):
            self.unknown = True
            return
        error = value.get("error")
        if (isinstance(error, dict) and str(error.get("code")) == "500"
            and isinstance(error.get("message"), str)
            and "servers are currently overloaded" in error["message"].lower()
            and set(value) <= {"error", "type"}
            and value.get("type") in (None, "error") and not self.failure):
            self.failure = "500"
            return
        response = value.get("response")
        if (not self.failure and value.get("type") in ("response.created", "response.in_progress")
            and isinstance(response, dict) and response.get("output") == [] and not response.get("error")):
            return
        # Includes reasoning/tool/text deltas, completed output, unknown events
        # and malformed envelopes. EOF alone can never authorize task recovery.
        self.unknown = True

    @staticmethod
    def unique_fields(pairs):
        value = {}
        for name, field in pairs:
            if name in value:
                raise ValueError("ambiguous provider error")
            value[name] = field
        return value

    def finish(self):
        if self.pending:
            self.line(bytes(self.pending).strip())
            self.pending.clear()
        if self.unknown or not self.failure:
            return None
        return {"code": self.failure, "frame_sha256": self.digest.hexdigest()}


class ObservedWriter:
    def __init__(self, writer, observation):
        self.writer = writer
        self.observation = observation

    def write(self, data):
        self.observation.write(data)
        return self.writer.write(data)

    def __getattr__(self, name):
        return getattr(self.writer, name)


def observed_gateway(module):
    class Handler(module.Handler):
        def send_response(self, code, message=None):
            self.provider_status = code
            return super().send_response(code, message)

        def end_headers(self):
            super().end_headers()
            observation = getattr(self.server.observation, "response", None)
            if getattr(self, "provider_status", None) == 200 and observation:
                self.wfile = ObservedWriter(self.wfile, observation)

    class Gateway(module.Gateway):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.observation = threading.local()
            self.RequestHandlerClass = Handler
            self.db.execute("""CREATE TABLE provider_failure (
                request_id INTEGER PRIMARY KEY, kind TEXT NOT NULL, status INTEGER NOT NULL,
                code TEXT NOT NULL, frame_sha256 TEXT NOT NULL)""")
            self.db.commit()

        def record(self, pid, body):
            request = super().record(pid, body)
            self.observation.request = request
            self.observation.response = ProviderResponse()
            return request

        def finish(self, request_id, status, outcome, usage, **kwargs):
            super().finish(request_id, status, outcome, usage, **kwargs)
            if getattr(self.observation, "request", None) != request_id:
                return
            response = self.observation.response
            failure = response.finish() if status == 200 else None
            if (status in (429, 502, 503, 504) and outcome == "upstream_http_" + str(status)
                and kwargs.get("close_reason") == "http_status"):
                failure = {"code": str(status), "frame_sha256": hashlib.sha256(str(status).encode()).hexdigest()}
            # A connection error, terminal response or concurrent shutdown is not
            # interchangeable with an observed pre-output provider error.
            if not failure or kwargs.get("error") is not None or usage is not None:
                return
            if status == 200 and (outcome != "transport_failed" or kwargs.get("close_reason") != "eof_without_terminal"):
                return
            with self.lock:
                # shutdown may already have sealed this row as unknown. A late
                # handler cannot reinterpret that durable terminal observation.
                row = self.db.execute("SELECT status,outcome,close_reason,terminal_at FROM request WHERE id=?",
                                      (request_id,)).fetchone()
                if row != (status, outcome, kwargs.get("close_reason"), None):
                    return
                self.db.execute("INSERT INTO provider_failure VALUES (?,?,?,?,?)", (
                    request_id, "provider-unavailable", status, failure["code"], failure["frame_sha256"],
                ))
                self.db.commit()
    return Gateway


def standing(scope):
    if (Path(scope["database"]).parent / "CANCEL").exists():
        raise ValueError("campaign_cancelled")
    if scope.get("kind") == "audit":
        return audit_standing(scope)
    if scope.get("kind") == "evaluation":
        return evaluation_standing(scope)
    with closing(sqlite3.connect(f"file:{scope['database']}?mode=ro", uri=True)) as db:
        state = json.loads(
            db.execute("SELECT value FROM ota_state WHERE id=1").fetchone()[0]
        )
    if (
        state.get("stopped")
        or state["epoch"] != scope["epoch"]
        or state["protocol"] != scope["protocol"]
    ):
        raise ValueError("stale_issuer_scope")
    if (
        state.get("job", {}).get("id") != scope["job"]
        or state["job"]["phase"] != scope["phase"]
    ):
        raise ValueError("stale_issuer_job")
    if state["active"]["pair"] != scope["incumbent"]:
        raise ValueError("incumbent_changed")
    if state["job"].get("purpose") != scope.get("purpose"):
        raise ValueError("execution_purpose_changed")
    producer = state["job"].get("producer")
    if producer != scope.get("producer"):
        raise ValueError("research_producer_changed")
    if producer:
        if not producer.get("support") and producer["pair"] != state["active"]["pair"]:
            raise ValueError("research_producer_unqualified")
        if producer.get("support"):
            grant = state["kernel"]["contracts"].get(producer["support"], {})
            pair_hash = hashlib.sha256(json.dumps(
                {"s": producer["pair"]["s"], "h": producer["pair"]["h"]},
                separators=(",", ":"),
            ).encode()).hexdigest()
            if (grant.get("status") != "discharged" or grant.get("scope") != scope["protocol"]
                or grant.get("handoff", {}).get("subjectHash") != pair_hash
                or not grant.get("attestationID")):
                raise ValueError("research_support_withdrawn")
    task = state.get("task")
    if task and scope.get("task") != {"id": task["id"], "checkpoint": task["checkpoint"]}:
        raise ValueError("task_checkpoint_changed")
    if not task and scope.get("task"):
        raise ValueError("foreign_task_scope")
    if task and state["kernel"]["contracts"].get(task.get("contractID"), {}).get("status") != "active":
        raise ValueError("task_support_withdrawn")
    support = state["active"].get("support")
    if (
        support
        and state["kernel"]["contracts"].get(support, {}).get("status") != "discharged"
    ):
        raise ValueError("deployment_support_withdrawn")


def audit_standing(scope):
    with closing(sqlite3.connect(f"file:{scope['database']}?mode=ro", uri=True)) as db:
        state = json.loads(db.execute("SELECT value FROM rsi_audit WHERE id=1").fetchone()[0])
    assignment = next((item for item in state["assignments"] if item["id"] == scope["assignment"]), None)
    if (state.get("stopped") or state["protocol"] != scope["protocol"] or not assignment
        or assignment["status"] != "active" or assignment["pair"] != scope["pair"]
        or assignment.get("deadline") != scope["deadline"] or time.time() * 1000 >= scope["deadline"]):
        raise ValueError("stale_audit_admission")
    if state["kernel"]["contracts"].get(assignment.get("contractID"), {}).get("status") != "active":
        raise ValueError("audit_support_withdrawn")
    source = state["source"]
    with closing(sqlite3.connect(f"file:{source['database']}?mode=ro", uri=True)) as db:
        raw = db.execute("SELECT value FROM ota_state WHERE id=1").fetchone()[0]
        original = json.loads(raw)
    support = original["active"].get("support")
    if (hashlib.sha256(raw.encode()).hexdigest() != source["stateHash"]
        or original["revision"] != source["revision"] or original["protocol"] != source["protocol"]
        or original["active"]["pair"] != source["pair"] or original["seed"] != source["seed"]
        or original.get("task") or original.get("trial")
        or original.get("stopped") != "recursive closure completed" or not support
        or original["kernel"]["contracts"].get(support, {}).get("status") != "discharged"):
        raise ValueError("audit_source_changed")


def evaluation_standing(scope):
    # A measurement has its own issuer/Contract. It is not an OTA proposal job
    # and does not borrow the strict independent audit's completed-RSI standing.
    with closing(sqlite3.connect(f"file:{scope['database']}?mode=ro", uri=True)) as db:
        state = json.loads(db.execute("SELECT value FROM rsi_evaluation WHERE id=1").fetchone()[0])
    assignment = next((item for item in state["assignments"] if item["id"] == scope["assignment"]), None)
    if (state.get("stopped") or state["protocol"] != scope["protocol"]
        or state["pair"] != scope["pair"] or not assignment
        or assignment["status"] != "active" or assignment["pair"] != scope["pair"]
        or assignment.get("deadline") != scope["deadline"] or time.time() * 1000 >= scope["deadline"]):
        raise ValueError("stale_measurement_admission")
    contract = state["kernel"]["contracts"].get(assignment.get("contractID"), {})
    if (contract.get("status") != "active" or contract.get("scope") != scope["protocol"]
        or contract.get("spec", {}).get("budget", {}).get("deadline") != scope["deadline"]):
        raise ValueError("measurement_contract_withdrawn")


def validate_tools(scope, body):
    mode = scope.get("mode")
    if mode in {"bridge", "tau"}:
        tools = scope.get("benchmarkTools")
        if (not isinstance(tools, list) or not tools
            or any(not isinstance(name, str) for name in tools)
            or len(set(tools)) != len(tools)
            or (mode == "tau" and tools != ["tau_turn"])):
            raise ValueError("benchmark_tool_admission_missing")
        allowed = set(tools)
        if mode == "bridge":
            allowed.update({"task_handoff", "task_blocked"})
        if any(tool.get("name") not in allowed for tool in json.loads(body).get("tools", [])):
            raise ValueError("tool_not_admitted")
        return
    allowed = {"glob", "grep", "read", "patch", "shell"}
    if mode == "programbench":
        allowed.add("contract_delivery")
        if scope.get("allowRevise") and scope.get("purpose") == "continuation":
            allowed.add("rsi_revise")
    elif mode is None:
        allowed.update({"rsi_handoff", "rsi_blocked"})
        proposal = scope.get("proposal")
        if isinstance(proposal, dict) and proposal.get("kind") in {"h", "s"}:
            allowed.add("rsi_check")
    else:
        raise ValueError("execution_mode_not_admitted")
    if any(tool.get("name") not in allowed for tool in json.loads(body).get("tools", [])):
        raise ValueError("tool_not_admitted")


def main():
    parser = argparse.ArgumentParser()
    for name in [
        "gateway",
        "scope",
        "channel",
        "control",
        "issue",
        "model",
        "effort",
        "owner",
    ]:
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    # The credential process must not outlive its supervising host process.
    if os.getppid() != int(args.owner):
        raise RuntimeError("supervisor already exited")
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "cannot bind gateway lifetime")
    if os.getppid() != int(args.owner):
        raise RuntimeError("supervisor exited during admission")
    spec = importlib.util.spec_from_file_location("gateway", args.gateway)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    scope = json.loads(Path(args.scope).read_text())

    class Gateway(observed_gateway(module)):
        def record(self, pid, body):
            standing(scope)
            if not (Path(args.scope).parent / "active").exists():
                raise ValueError("allocation_closed")
            if (Path(args.scope).parent / "provider-ended").exists():
                raise ValueError("official_environment_ended")
            validate_tools(scope, body)
            return super().record(pid, body)

    server = Gateway(
        Path(args.channel),
        Path(args.control),
        args.model,
        args.effort,
        issue=Path(args.issue),
        upstream=os.environ["OPENAI_BASE_URL"],
        api_key=os.environ["OPENAI_API_KEY"],
    )
    server.db.execute("PRAGMA journal_mode=WAL")
    server.db.execute("PRAGMA busy_timeout=5000")
    Path(args.control, "gateway.json").write_text(json.dumps({"pid": os.getpid()}))

    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        server.checkpoint_shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
