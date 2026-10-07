"""Host-only, peer-bound model channel. No worker receives a provider credential."""
import http.client
import http.server
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


def record(value):
    with lock:
        with open(config["journal"], "a") as out:
            out.write(json.dumps(value, separators=(",", ":")) + "\n")
            out.flush()
            os.fsync(out.fileno())


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
            if pid != config["pid"] or birth(pid) != config["birth"]:
                self.send_error(403, "Only the admitted native runtime may use the model channel")
                return
            standing()
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
            record({"type": "failure", "id": identifier, "admitted": admitted, "error": str(error)})
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
