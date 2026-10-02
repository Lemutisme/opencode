"""Explicit no-model wire fixture for native tau qualification, never a score campaign.

Implements the solver Responses stream and the host user's Chat Completions
transport. Each request is retained with an explicit role. It cannot contact a
real model provider. Use only the official mock create_task qualification task.
"""
import argparse
import ctypes
import http.server
import json
import os
from pathlib import Path
import threading
import time
import signal


def main():
    owner = os.getppid()
    if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != owner:
        raise RuntimeError("fixture owner exited")
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    args = parser.parse_args()
    root = Path(args.output)
    root.mkdir(parents=True, exist_ok=False)
    lock = threading.Lock()
    counts = {"solver": 0, "user": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            raw = self.rfile.read(int(self.headers["Content-Length"]))
            request = json.loads(raw)
            role = "user" if self.path == "/v1/chat/completions" else "solver"
            with lock:
                index = counts[role]
                counts[role] += 1
                (root / f"{role}-{index}.json").write_text(json.dumps(request))
                (root / "COUNTS.json").write_text(json.dumps(counts))
            if role == "user":
                if request.get("model") != "gpt-5.2-2025-12-11" or request.get("reasoning_effort") != "low" or index > 2:
                    self.send_error(409, "unfrozen scripted user request")
                    return
                content = ["Create Important Meeting for user_1.", "Yes, please create it.", "###STOP###"][index]
                value = {"id": f"chatcmpl-fixture-{index}", "object": "chat.completion", "created": int(time.time()), "model": request["model"], "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
                body = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path != "/v1/responses" or index > 3:
                self.send_error(409, "unexpected scripted solver request")
                return
            if index < 3:
                if "tau_turn" not in {item["name"] for item in request.get("tools", [])}:
                    self.send_error(409, "native tau tool missing")
                    return
                action = [
                    {"speak": "Please confirm I should create Important Meeting for user_1."},
                    {"calls": [{"name": "create_task", "arguments": {"user_id": "user_1", "title": "Important Meeting"}}]},
                    {"speak": "The Important Meeting task was created successfully."},
                ][index]
                item = {"type": "function_call", "id": f"fc_tau_{index}", "call_id": f"call_tau_{index}", "name": "tau_turn"}
                output = {**item, "arguments": json.dumps(action)}
                events = [
                    {"type": "response.output_item.added", "item": item},
                    {"type": "response.function_call_arguments.delta", "item_id": item["id"], "delta": json.dumps(action)},
                    {"type": "response.output_item.done", "item": output},
                ]
            else:
                output = {"type": "message", "id": "msg_tau_complete", "role": "assistant", "content": [{"type": "output_text", "text": "Official conversation ended."}]}
                events = [
                    {"type": "response.output_item.added", "item": {**output, "content": []}},
                    {"type": "response.output_text.delta", "item_id": output["id"], "content_index": 0, "delta": "Official conversation ended."},
                    {"type": "response.output_item.done", "item": output},
                ]
            events.append({"type": "response.completed", "response": {"id": f"resp_tau_{index}", "status": "completed", "output": [output], "usage": {"input_tokens": 10, "output_tokens": 5, "output_tokens_details": {"reasoning_tokens": 0}}}})
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            for event in events:
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.flush()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    (root / "READY.json").write_text(json.dumps({"upstream": f"http://127.0.0.1:{server.server_port}/v1", "fixture": True}))
    server.serve_forever()


if __name__ == "__main__":
    main()
