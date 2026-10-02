"""Host-owned tau3 half-duplex environment. Candidate H supplies actions, not users or rewards.

One /turn request is one official AssistantMessage, including a batch of business
tools. The unmodified official Orchestrator advances every user/environment step.
There is no solver model loop here and no virtual provider-step accounting.
"""

import argparse
import ctypes
import hashlib
import http.client
import http.server
import importlib.util
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import socketserver
import sqlite3
import stat
import struct
import sys
import threading
import time
from urllib.parse import urlsplit


def write(file, value):
    temporary = file.with_name(file.name + ".new")
    with temporary.open("w") as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(file)


def identity(pid):
    raw = Path(f"/proc/{pid}/stat").read_text()
    return {"pid": pid, "start_ticks": raw[raw.rindex(")") + 1:].split()[19]}


def tree_hash(directory):
    directory = Path(directory).resolve(strict=True)
    digest = hashlib.sha256()
    for item in sorted(directory.rglob("*")):
        relative = item.relative_to(directory)
        if ".git" in relative.parts or "__pycache__" in relative.parts or item.suffix == ".pyc":
            continue
        if item.is_symlink():
            if not item.resolve(strict=True).is_relative_to(directory):
                raise ValueError("trusted tau supply symlink escapes frozen tree")
            digest.update(b"link\0" + str(relative).encode() + b"\0" + os.readlink(item).encode() + b"\0")
            continue
        if item.is_file():
            digest.update(str(relative).encode() + b"\0" + str(stat.S_IMODE(item.stat().st_mode)).encode() + b"\0" + hashlib.sha256(item.read_bytes()).digest())
    return digest.hexdigest()


def load_tau(vendor):
    vendor = Path(vendor).resolve(strict=True)
    os.environ["TAU2_DATA_DIR"] = str(vendor / "data")
    sys.path.insert(0, str(vendor / "src"))
    from tau2.agent.base_agent import HalfDuplexAgent
    from tau2.data_model.message import AssistantMessage

    class ExternalAgent(HalfDuplexAgent):
        def __init__(self, tools, domain_policy):
            super().__init__(tools, domain_policy)
            self.action = None

        def get_init_state(self, message_history=None):
            return {}

        def generate_next_message(self, message, state):
            if self.action is None:
                raise RuntimeError("No native agent action was admitted")
            result, self.action = self.action, None
            return result, state

        @classmethod
        def is_stop(cls, message):
            return message.content == "###STOP###" and not message.is_tool_call()

    return ExternalAgent


class Trial:
    def __init__(self, root, config, user=None):
        self.root, self.config = Path(root), config
        self.user_override = user
        self.lock = threading.RLock()
        self.orchestrator = None
        self.result = None
        self.sequence = 0
        self.requests = {}
        self.proxy = None
        self.closed = False
        self.fault = None
        self.admission = None

    def live(self):
        if self.closed or (self.root / "CANCEL").exists():
            raise ValueError("tau trial cancelled")
        if time.time() * 1000 >= self.config["deadline"]:
            raise ValueError("original tau deadline reached")
        if self.admission:
            self.admission()

    def initialize(self):
        if self.orchestrator is not None:
            return
        self.live()
        ExternalAgent = load_tau(self.config["vendor"])
        from tau2.runner.helpers import get_tasks
        from tau2.runner.build import build_environment, build_user
        from tau2.orchestrator.orchestrator import Orchestrator
        from tau2.utils.llm_utils import llm_log_dir, llm_log_mode
        from tau2.utils.utils import get_now

        self.task = next(item for item in get_tasks(self.config["domain"], task_split_name=self.config.get("split", "base")) if item.id == self.config["task"])
        # ALL includes NL assertions when requested by the task. Refuse rather
        # than silently drop them or introduce an unfrozen grader model.
        if self.task.evaluation_criteria and "NL_ASSERTION" in self.task.evaluation_criteria.reward_basis:
            raise ValueError("This frozen adapter requires deterministic official grading")
        environment = build_environment(self.config["domain"])
        self.tools = {item.openai_schema["function"]["name"]: item.openai_schema["function"] for item in environment.get_tools()}
        user = self.user_override
        if user is None:
            self.proxy = SimulatorProxy(self)
            llm_log_dir.set(self.root / "user-llm")
            llm_log_mode.set("all")
            user = build_user("user_simulator", environment, self.task, llm=self.config["userModel"], llm_args={
                "reasoning_effort": self.config["userEffort"],
                "api_base": self.proxy.url,
                "api_key": self.proxy.token,
                "num_retries": 0,
                "timeout": 900,
            })
        self.orchestrator = Orchestrator(
            domain=self.config["domain"],
            agent=ExternalAgent(environment.get_tools(), environment.get_policy()),
            user=user,
            environment=environment,
            task=self.task,
            max_steps=100,
            max_errors=10,
            seed=self.config["seed"],
            simulation_id=self.root.name,
            timeout=None,
        )
        self.orchestrator._run_start_time = get_now()
        self.orchestrator._run_start_perf = time.perf_counter()
        try:
            self.orchestrator.initialize()
            self.advance()
        except BaseException as error:
            self.fault = {"type": type(error).__name__, "message": str(error)}
            write(self.root / "ERROR.json", self.fault)
            self.closed = True
            raise

    def advance(self):
        from tau2.orchestrator.orchestrator import Role
        while not self.orchestrator.done and self.orchestrator.to_role != Role.AGENT:
            self.live()
            self.orchestrator.step()
            self.orchestrator._check_termination()
            self.persist()
        self.live()
        if self.orchestrator.done and self.result is None:
            self.result = self.orchestrator._finalize()
            write(self.root / "simulation-ungraded.json", self.result.model_dump(mode="json"))
            # Official terminal, not candidate handoff, revokes further model
            # admission. Keep the allocation active long enough to seal handoff.
            binding = self.root / "binding.json"
            if binding.exists():
                run = Path(json.loads(binding.read_text())["run"])
                write(run / "control/provider-ended", {"source": "official-tau-terminal", "termination": self.result.termination_reason.value, "sequence": self.sequence, "at": time.time()})
        self.persist()

    def public(self):
        self.live()
        self.initialize()
        from tau2.agent.base_agent import is_valid_agent_history_message
        messages = [item.model_dump(mode="json", exclude_none=True) for item in self.orchestrator.get_messages() if is_valid_agent_history_message(item)]
        # Only official public content crosses the boundary. User private state,
        # task evaluation criteria, costs, provider internals and reward do not.
        messages = [{key: value for key, value in item.items() if key in {"role", "content", "tool_calls", "id", "error", "requestor"}} for item in messages]
        return {
            "kind": "tau-public-v1", "sequence": self.sequence,
            "terminal": self.orchestrator.done,
            "termination": self.orchestrator.termination_reason.value if self.orchestrator.done else None,
            "steps": self.orchestrator.step_count, "maxSteps": 100,
            "deadline": self.config["deadline"],
            "policy": self.orchestrator.environment.get_policy(),
            "tools": list(self.tools.values()), "messages": messages,
        }

    def persist(self):
        write(self.root / "trajectory-checkpoint.json", {
            "sequence": self.sequence, "steps": self.orchestrator.step_count,
            "messages": [item.model_dump(mode="json") for item in self.orchestrator.get_messages()],
        })

    def turn(self, value, generation):
        with self.lock:
            self.live()
            self.initialize()
            if set(value) != {"id", "sequence", "action"} or not isinstance(value["id"], str) or not value["id"] or len(value["id"]) > 200:
                raise ValueError("invalid native turn envelope")
            key = f"{generation}:{value['id']}"
            prior = self.requests.get(key)
            if prior:
                if prior["input"] != value:
                    raise ValueError("conflicting native turn retry")
                if "output" not in prior:
                    raise ValueError("interrupted business operation must not be retried")
                return prior["output"]
            if type(value["sequence"]) is not int or value["sequence"] != self.sequence:
                raise ValueError("stale official conversation sequence")
            if self.orchestrator.done:
                raise ValueError("official conversation already ended")
            from tau2.data_model.message import AssistantMessage, ToolCall
            action = value["action"]
            if not isinstance(action, dict):
                raise ValueError("invalid tau action")
            if set(action) == {"speak"} and isinstance(action["speak"], str) and action["speak"].strip():
                message = AssistantMessage(role="assistant", content=action["speak"], cost=0.0)
            elif set(action) == {"stop"} and action["stop"] is True:
                message = AssistantMessage(role="assistant", content="###STOP###", cost=0.0)
            elif set(action) == {"calls"} and isinstance(action["calls"], list) and action["calls"]:
                calls = action["calls"]
                if any(not isinstance(item, dict) or set(item) != {"name", "arguments"} or item["name"] not in self.tools or not isinstance(item["arguments"], dict) for item in calls):
                    raise ValueError("only public official business tools are admitted")
                message = AssistantMessage(role="assistant", tool_calls=[ToolCall(id=f"tau_{self.sequence}_{index}", name=item["name"], arguments=item["arguments"], requestor="assistant") for index, item in enumerate(calls)], cost=0.0)
            else:
                raise ValueError("choose exactly one speech, official tool batch, or stop")
            entry = {"input": value, "generation": generation, "at": time.time()}
            self.requests[key] = entry
            with (self.root / "turns.jsonl").open("a") as stream:
                stream.write(json.dumps({"state": "admitted", "key": key, **entry}) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            self.orchestrator.agent.action = message
            try:
                self.orchestrator.step()
                self.orchestrator._check_termination()
                self.sequence += 1
                self.advance()
                entry["output"] = self.public()
            except BaseException as error:
                self.fault = {"type": type(error).__name__, "message": str(error)}
                write(self.root / "ERROR.json", self.fault)
                self.closed = True
                raise
            with (self.root / "turns.jsonl").open("a") as stream:
                stream.write(json.dumps({"state": "committed", "key": key, "sequence": self.sequence, "steps": self.orchestrator.step_count}) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            return entry["output"]

    def grade(self):
        # Host-only command path. A candidate never receives reward feedback.
        with self.lock:
            self.live()
            if self.result is None or self.fault:
                raise ValueError("no valid terminal official simulation")
            if self.result.termination_reason.value == "user_error":
                raise ValueError("user simulator failure is not an agent score")
            from tau2.evaluator.evaluator import EvaluationType, evaluate_simulation
            self.result.reward_info = evaluate_simulation(simulation=self.result, task=self.task, evaluation_type=EvaluationType.ALL, solo_mode=False, domain=self.config["domain"])
            self.live()
            write(self.root / "simulation.json", self.result.model_dump(mode="json"))
            reward = self.result.reward_info.reward
            if reward not in (0, 1):
                raise ValueError("unexpected nonbinary official tau reward")
            score = {"passed": int(reward), "total": 1, "valid": True, "steps": self.orchestrator.step_count, "termination": self.result.termination_reason.value, "scoringTrust": "official-tau3-deterministic"}
            write(self.root / "RESULT.json", score)
            return score

    def close(self):
        self.closed = True
        if self.proxy:
            self.proxy.close()
        if self.orchestrator and self.result is None:
            self.orchestrator._cleanup()


class SimulatorProxy(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, trial):
        self.trial = trial
        self.token = secrets.token_urlsafe(32)
        self.upstream = urlsplit(os.environ["OPENAI_BASE_URL"].rstrip("/"))
        self.key = os.environ["OPENAI_API_KEY"]
        self.connections = set()
        self.lock = threading.RLock()
        self.db = sqlite3.connect(trial.root / "user-requests.sqlite", check_same_thread=False)
        self.db.execute("CREATE TABLE request(id INTEGER PRIMARY KEY, started REAL, finished REAL, model TEXT, effort TEXT, actor TEXT, status INTEGER, usage TEXT, error TEXT, body_hash TEXT)")
        self.db.commit()
        super().__init__(("127.0.0.1", 0), SimulatorHandler)
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_port}/v1"

    def close(self):
        self.shutdown()
        self.cancel()
        with self.lock:
            self.db.execute("UPDATE request SET finished=?,error='cancelled_usage_unknown' WHERE finished IS NULL", (time.time(),))
            self.db.commit()
        self.server_close()

    def cancel(self):
        with self.lock:
            for connection in self.connections:
                if connection.sock:
                    try:
                        connection.sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass


class SimulatorHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        server = self.server
        connection = None
        request_id = None
        status, usage, error = None, None, None
        try:
            server.trial.live()
            if self.path != "/v1/chat/completions" or self.headers.get("Authorization") != "Bearer " + server.token:
                raise ValueError("simulator endpoint not admitted")
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 16 * 1024 * 1024:
                raise ValueError("simulator request exceeds individual bound")
            raw = self.rfile.read(size)
            body = json.loads(raw)
            if body.get("model") != server.trial.config["userModel"] or body.get("reasoning_effort") != server.trial.config["userEffort"] or body.get("stream"):
                raise ValueError("simulator model/effort/transport differs from frozen profile")
            with server.lock:
                cursor = server.db.execute("INSERT INTO request(started,model,effort,actor,body_hash) VALUES (?,?,?,?,?)", (time.time(), body["model"], body["reasoning_effort"], "user", hashlib.sha256(raw).hexdigest()))
                request_id = cursor.lastrowid
                server.db.commit()
            cls = http.client.HTTPSConnection if server.upstream.scheme == "https" else http.client.HTTPConnection
            connection = cls(server.upstream.hostname, server.upstream.port, timeout=min(900, max(1, (server.trial.config["deadline"] - time.time() * 1000) / 1000)))
            with server.lock:
                server.connections.add(connection)
            connection.request("POST", server.upstream.path + "/chat/completions", raw, {"Authorization": "Bearer " + server.key, "Content-Type": "application/json"})
            response = connection.getresponse()
            status = response.status
            result = response.read(32 * 1024 * 1024 + 1)
            if len(result) > 32 * 1024 * 1024:
                raise ValueError("simulator response exceeds individual bound")
            usage = json.loads(result).get("usage")
            server.trial.live()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(result)))
            self.end_headers()
            self.wfile.write(result)
        except Exception as caught:
            error = type(caught).__name__ + ": " + str(caught)
            self.send_error(502, "Host user simulator failed; no implicit retry")
        finally:
            if connection:
                connection.close()
            with server.lock:
                server.connections.discard(connection)
                if request_id is not None:
                    server.db.execute("UPDATE request SET finished=?,status=?,usage=?,error=? WHERE id=?", (time.time(), status, json.dumps(usage), error, request_id))
                    server.db.commit()


class Bridge(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, trial):
        self.trial = trial
        self.revoked = set()
        spec = importlib.util.spec_from_file_location("rsi_tau_scope", Path(__file__).with_name("rsi-gateway.py"))
        self.scope = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.scope)
        self.directory = trial.root / "channel"
        self.directory.mkdir(mode=0o755)
        # Unix sockaddr paths are short; /proc fd indirection also pins the parent.
        self.fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
        super().__init__(f"/proc/self/fd/{self.fd}/tools.sock", BridgeHandler)
        (self.directory / "tools.sock").chmod(0o666)
        trial.admission = self.lease

    def lease(self):
        binding = json.loads((self.trial.root / "binding.json").read_text())
        if binding["generation"] in self.revoked:
            raise ValueError("native tau lease revoked")
        directory = Path(binding["run"])
        if not (directory / "control/active").is_file():
            raise ValueError("native tau allocation ended")
        scope = json.loads((directory / "control/scope.json").read_text())
        if not scope.get("fixture"):
            self.scope.standing(scope)
        elif not self.trial.config.get("fixture"):
            raise ValueError("scripted scope on real trial")
        return binding

    def authorize(self, peer):
        self.trial.live()
        binding = self.lease()
        directory = Path(binding["run"])
        current = json.loads((directory / "control/runtime.json").read_text())
        if identity(peer) != current or not (directory / "control/active").is_file():
            raise ValueError("not the current admitted native runtime")
        return binding["generation"]

    def server_close(self):
        super().server_close()
        os.close(self.fd)


class BridgeHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        try:
            self.connection.settimeout(min(30, max(1, (self.server.trial.config["deadline"] - time.time() * 1000) / 1000)))
            peer, _, _ = struct.unpack("3i", self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            generation = self.server.authorize(peer)
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 1024 * 1024:
                raise ValueError("individual business request exceeds bound")
            value = json.loads(self.rfile.read(size))
            with self.server.trial.lock:
                if self.server.authorize(peer) != generation:
                    raise ValueError("native tau lease changed during admission")
                if self.path == "/state" and value == {}:
                    result = self.server.trial.public()
                elif self.path == "/turn":
                    result = self.server.trial.turn(value, generation)
                elif self.path == "/call" and set(value) == {"name", "arguments", "id", "sessionID"}:
                    if value["name"] != "tau_turn":
                        raise ValueError("unknown official tau tool wrapper")
                    result = {"result": self.server.trial.turn({"id": str(value["sessionID"]) + ":" + str(value["id"]), "sequence": self.server.trial.sequence, "action": value["arguments"]}, generation)}
                else:
                    raise ValueError("unknown candidate operation")
            raw = json.dumps(result, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        except (ValueError, KeyError, OSError) as error:
            self.send_error(409, str(error))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tree-hash")
    parser.add_argument("--config")
    parser.add_argument("--root")
    parser.add_argument("--owner", type=int)
    args = parser.parse_args()
    if args.tree_hash:
        print(tree_hash(args.tree_hash))
        return
    if not args.config or not args.root or not args.owner:
        parser.error("--config, --root and --owner are required")
    if os.getppid() != args.owner or ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != args.owner:
        raise RuntimeError("cannot bind tau environment lifetime to issuer")
    root = Path(args.root)
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    config = json.loads(Path(args.config).read_text())
    for supply in config.get("supplies", []):
        if tree_hash(supply["path"]) != supply["sha256"]:
            raise ValueError("trusted tau supply changed")
    if config.get("domain") not in {"airline", "retail", "mock"} or config.get("userModel") != "gpt-5.2-2025-12-11" or config.get("userEffort") != "low":
        raise ValueError("unsupported frozen tau profile")
    write(root / "LAUNCH.json", {**config, "officialMaxSteps": 100, "maxErrors": 10, "providerCap": None, "costCap": None, "mode": "text-half-duplex"})
    trial = Trial(root, config)
    bridge = Bridge(trial)
    stopping = threading.Event()

    def stop(*_):
        stopping.set()
        trial.closed = True
        threading.Thread(target=bridge.shutdown, daemon=True).start()

    def watch():
        while not stopping.wait(.1):
            if time.time() * 1000 >= config["deadline"] or (root / "CANCEL").exists():
                stop()
                return
            if (root / "GRADE").exists() and not (root / "RESULT.json").exists():
                try:
                    # Scoring follows native fencing; it reads a terminal
                    # host-owned transcript and does not need a live agent lease.
                    trial.admission = None
                    trial.grade()
                except Exception as error:
                    write(root / "GRADE-ERROR.json", {"type": type(error).__name__, "message": str(error)})
                (root / "GRADE").unlink(missing_ok=True)
            if (root / "REVOKE.json").exists():
                request = json.loads((root / "REVOKE.json").read_text())
                bridge.revoked.add(request["generation"])
                if trial.proxy:
                    trial.proxy.cancel()
                with trial.lock:
                    write(root / "REVOKED.json", request)
                (root / "REVOKE.json").unlink(missing_ok=True)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    threading.Thread(target=watch, daemon=True).start()
    write(root / "READY.json", {"pid": os.getpid(), "deadline": config["deadline"]})
    try:
        bridge.serve_forever(poll_interval=.1)
    finally:
        stopping.set()
        trial.close()
        bridge.server_close()
        write(root / "FENCED.json", {"at": time.time(), "businessEnvironment": "stopped"})


if __name__ == "__main__":
    main()
