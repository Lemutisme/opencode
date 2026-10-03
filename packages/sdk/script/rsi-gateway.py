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

    class Gateway(module.Gateway):
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
