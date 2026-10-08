"""Host-only, peer-bound model channel. No worker receives a provider credential."""
import http.client
import http.server
import base64
import hashlib
import json
import os
import signal
import socket
import socketserver
import sqlite3
import struct
import sys
import threading
import time
import urllib.parse
import uuid
from pathlib import Path

config = json.loads(Path(sys.argv[1]).read_text())
endpoint = urllib.parse.urlsplit(config["upstream"])
if endpoint.scheme not in ("http", "https") or endpoint.username or endpoint.password:
    raise ValueError("HTTP(S) upstream without URL credentials required")
parent = os.getppid()
connections = set()
lock = threading.Lock()


def standing():
    if time.time() * 1000 >= config["deadline"] or Path(config["cancel"]).exists():
        raise PermissionError("Original deadline or cancellation")
    with sqlite3.connect(f"file:{config['ledger']}?mode=ro", uri=True) as db:
        state = json.loads(db.execute("SELECT data FROM state WHERE id = 1").fetchone()[0])
    task = state["kernel"]["contracts"][config["task"]]
    grant = state["kernel"]["contracts"][config["grant"]]
    if task["status"] != "active" or grant["status"] != "discharged":
        raise PermissionError("Task or method standing withdrawn")
    if task["spec"]["budget"]["deadline"] != config["deadline"]:
        raise PermissionError("Task deadline identity changed")
    if grant["handoff"]["subjectHash"] != config["parent"]:
        raise PermissionError("Method grant identity changed")


def birth(pid):
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]


def tool_admission(pid):
    standing()
    directory = config.get("toolCgroup")
    if not directory or pid == config["pid"] or birth(config["pid"]) != config["birth"]:
        raise PermissionError("No live tool resource capability")
    peer_birth = birth(pid)
    shell = int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[1])
    if shell <= 1 or shell == config["pid"]:
        raise PermissionError("The runtime cannot move itself into the tool leaf")
    shell_birth = birth(shell)
    ancestor = shell
    for _ in range(64):
        ancestor = int(Path(f"/proc/{ancestor}/stat").read_text().rsplit(")", 1)[1].split()[1])
        if ancestor == config["pid"]:
            break
        if ancestor <= 1:
            raise PermissionError("Foreign tool process")
    else:
        raise PermissionError("Tool ancestry exceeds the infrastructure guard")
    if birth(pid) != peer_birth or birth(shell) != shell_birth:
        raise PermissionError("Tool identity changed")
    # The peer is a synchronous child of the shell and remains alive awaiting
    # acknowledgement. No arbitrary PID, resource limit or host-leaf API exists.
    for process in [shell, pid]:
        (Path(directory) / "cgroup.procs").write_text(str(process))
    record({"type": "tool-admitted", "pid": pid, "birth": peer_birth, "shell": shell,
            "shellBirth": shell_birth, "time": time.time()})


def record(value):
    with lock:
        with open(config["journal"], "a") as out:
            out.write(json.dumps(value, separators=(",", ":")) + "\n")
            out.flush()
            os.fsync(out.fileno())


def observation(handler):
    """The native peer supplies bytes, never host filenames or allocation IDs."""
    encoded = handler.headers.get("X-Observation", "")
    if len(encoded) > 16384:
        raise ValueError("Observation metadata exceeds the individual operation bound")
    metadata = json.loads(base64.b64decode(encoded, validate=True))
    if not isinstance(metadata, dict) or set(metadata) - {
        "kind", "sessionID", "messageID", "callID", "tool", "capture"
    }:
        raise ValueError("Invalid observation metadata")
    if metadata.get("kind") not in ("native-result", "model-visible", "shell-capture"):
        raise ValueError("Unknown observation representation")
    for key in ("sessionID", "messageID", "callID", "tool"):
        if not isinstance(metadata.get(key), str) or not 0 < len(metadata[key]) <= 1024:
            raise ValueError("Invalid native observation identity")
    size = int(handler.headers.get("Content-Length", "-1"))
    if not 0 <= size <= 64 * 1024 * 1024:
        raise ValueError("Observation exceeds the individual capture bound")
    capture = metadata.get("capture")
    if metadata["kind"] == "shell-capture":
        if (not isinstance(capture, dict) or set(capture) - {
                "stream", "encoding", "totalBytes", "complete", "timeout", "status", "exit", "signal"
            } or capture.get("stream") != "combined" or capture.get("encoding") != "bytes"
            or type(capture.get("totalBytes")) is not int or capture["totalBytes"] < size
            or type(capture.get("complete")) is not bool or type(capture.get("timeout")) is not bool
            or capture.get("status") not in ("exited", "timeout", "killed")
            or capture["timeout"] != (capture["status"] == "timeout")
            or (capture["complete"] and (capture["totalBytes"] != size or capture["status"] != "exited"
                                        or "exit" not in capture or "signal" in capture))
            or ("exit" in capture and type(capture["exit"]) is not int)
            or ("signal" in capture and not isinstance(capture["signal"], str))):
            raise ValueError("Invalid shell capture disposition")
    elif capture is not None:
        raise ValueError("Only shell captures have byte-stream dispositions")
    directory = Path(config["observations"])
    temporary = Path(config["observationStaging"]) / (".pending-" + str(uuid.uuid4()))
    digest = hashlib.sha256()
    remaining = size
    try:
        with temporary.open("xb") as output:
            while remaining:
                standing()
                disk = os.statvfs(directory)
                if disk.f_bavail * disk.f_frsize < config.get("reserveBytes", 0) + min(65536, remaining):
                    raise OSError("Observation disk reserve infrastructure guard")
                chunk = handler.rfile.read(min(65536, remaining))
                if not chunk:
                    raise EOFError("Incomplete observation upload")
                remaining -= len(chunk)
                digest.update(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        standing()
        hash_ = digest.hexdigest()
        os.chmod(temporary, 0o400)
        target = directory / "blobs" / hash_
        try:
            os.link(temporary, target)
        except FileExistsError:
            if target.stat().st_size != size or hashlib.sha256(target.read_bytes()).hexdigest() != hash_:
                raise ValueError("Existing public observation failed integrity validation")
        descriptor = os.open(directory / "blobs", os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        entry = {
            "version": 1, **metadata, "execution": config["execution"], "deadline": config["deadline"],
            "hash": hash_, "bytes": size, "time": time.time() * 1000,
        }
        with lock:
            with (directory / "index.jsonl").open("a") as index:
                index.write(json.dumps(entry, separators=(",", ":")) + "\n")
                index.flush()
                os.fsync(index.fileno())
        handler.send_response(201)
        handler.send_header("Content-Length", "0")
        handler.end_headers()
    finally:
        temporary.unlink(missing_ok=True)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *_):
        pass

    def do_POST(self):
        upstream = None
        identifier = f"{time.time_ns()}-{threading.get_ident()}"
        admitted = False
        complete = False
        usage = None
        try:
            self.connection.settimeout(max(0.01, min(900, (config["deadline"] - time.time() * 1000) / 1000)))
            pid, _, _ = struct.unpack("3i", self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if self.path == "/v1/tool-admission":
                if int(self.headers.get("Content-Length", "0")) != 0:
                    self.send_error(403, "Tool admission has no caller-selected parameters")
                    return
                tool_admission(pid)
                self.send_response(200)
                self.send_header("Content-Length", "8")
                self.end_headers()
                self.wfile.write(b"admitted")
                return
            if pid != config["pid"] or birth(pid) != config["birth"]:
                self.send_error(403, "Only the admitted native runtime may use the model channel")
                return
            standing()
            if self.path == "/v1/observations":
                observation(self)
                return
            if self.path != "/v1/responses":
                self.send_error(403, "Model endpoint only")
                return
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 32 * 1024 * 1024:
                self.send_error(413)
                return
            body = self.rfile.read(size)
            request = json.loads(body)
            if request.get("model") != config["model"] or request.get("reasoning", {}).get("effort") != config["effort"]:
                self.send_error(403, "Frozen model identity differs")
                return
            if request.get("tools") and any(tool.get("type") != "function" for tool in request["tools"]):
                self.send_error(403, "Remote tools are not admitted")
                return
            record({"type": "admitted", "id": identifier, "time": time.time(), "method": config["method"], "request": request})
            admitted = True
            remaining = max(0.01, min(900, (config["deadline"] - time.time() * 1000) / 1000))
            cls = http.client.HTTPSConnection if endpoint.scheme == "https" else http.client.HTTPConnection
            upstream = cls(endpoint.hostname, endpoint.port, timeout=remaining)
            with lock:
                connections.add(upstream)
            headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
            key = os.environ.get("OPENAI_API_KEY")
            if key:
                headers["Authorization"] = "Bearer " + key
            upstream.request("POST", endpoint.path.rstrip("/") + "/responses", body, headers)
            response = upstream.getresponse()
            self.send_response(response.status)
            self.send_header("Content-Type", response.getheader("Content-Type", "text/event-stream"))
            self.end_headers()
            pending = b""
            while True:
                standing()
                chunk = response.read1(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if not line.startswith(b"data: "):
                        continue
                    try:
                        event = json.loads(line[6:])
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if event.get("type") == "response.completed":
                        complete = True
                        usage = event.get("response", {}).get("usage")
                    if event.get("type") in ("response.failed", "error"):
                        record({"type": "provider-error", "id": identifier, "event": event})
                if len(pending) > 32 * 1024 * 1024:
                    raise ValueError("Unbounded provider event")
        except Exception as error:
            record({"type": "observation-failure" if self.path == "/v1/observations" else "failure",
                    "id": identifier, "admitted": admitted, "error": str(error)})
            if not admitted:
                self.send_error(403, "Admission denied")
        finally:
            if admitted:
                record({"type": "finished", "id": identifier, "complete": complete, "usage": usage,
                        "usageIncomplete": usage is None, "cost": None})
            if upstream:
                with lock:
                    connections.discard(upstream)
                upstream.close()
            self.close_connection = True


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def stop(*_):
    with lock:
        for connection in connections:
            if connection.sock:
                try:
                    connection.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
    os._exit(0)


def monitor():
    while True:
        time.sleep(0.1)
        try:
            if os.getppid() != parent:
                stop()
            standing()
        except Exception:
            stop()


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
server = Server(config["socket"], Handler)
os.chmod(config["socket"], 0o600)
threading.Thread(target=monitor, daemon=True).start()
server.serve_forever(poll_interval=0.1)
