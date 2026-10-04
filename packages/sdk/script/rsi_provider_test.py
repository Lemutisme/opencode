"""Real parser and optional local HTTP/Unix gateway tests; no model calls."""
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


rsi = load("rsi_gateway", Path(__file__).with_name("rsi-gateway.py"))
ERROR = json.dumps({"error": {"message": "litellm.APIError: Our servers are currently overloaded. Please try again later.",
                              "type": None, "param": None, "code": "500"}}).encode()


class ResponseTest(unittest.TestCase):
    def test_fragmented_error_and_bare_json(self):
        for data in (ERROR, b"data: " + ERROR + b"\n\n"):
            for width in (1, 7, len(data)):
                response = rsi.ProviderResponse()
                for offset in range(0, len(data), width):
                    response.write(data[offset:offset + width])
                self.assertEqual(response.finish(), {"code": "500", "frame_sha256": hashlib.sha256(data).hexdigest()})

    def test_semantic_or_unknown_prefix_never_authorizes_recovery(self):
        for prefix in (
            b'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
            b'data: {"type":"response.reasoning_text.delta","delta":"hmm"}\n\n',
            b'data: {"type":"response.output_item.added","item":{"type":"function_call"}}\n\n',
            b'data: {"type":"response.completed","response":{"usage":{}}}\n\n',
            b'data: {"type":"unknown"}\n\n',
            b'data: {bad-json}\n\n',
        ):
            response = rsi.ProviderResponse()
            response.write(prefix + b"data: " + ERROR + b"\n\n")
            self.assertIsNone(response.finish())

    def test_created_empty_output_then_error(self):
        response = rsi.ProviderResponse()
        response.write(b'data: {"type":"response.created","response":{"output":[]}}\n\n')
        response.write(b"data: " + ERROR + b"\n\n")
        self.assertEqual(response.finish()["code"], "500")

    def test_truncated_oversized_and_nonoverload_are_unknown(self):
        for data in (b"", b"data: " + ERROR[:-3], b"x" * 65537 + b"\n",
                     ERROR.replace(b'"code": "500"', b'"code": "400", "code": "500"'),
                     b'{"type":"response.output_text.delta","type":"error",' + ERROR[1:],
                     ERROR.replace(b'"500"', b'"400"'), ERROR.replace(b"overloaded", b"misconfigured")):
            response = rsi.ProviderResponse()
            response.write(data)
            self.assertIsNone(response.finish())


@unittest.skipUnless(os.environ.get("OPENCODE_RSI_GATEWAY"), "qualified gateway path required")
class WireTest(unittest.TestCase):
    def test_late_finish_cannot_reclassify_shutdown_unknown(self):
        module = load("qualified_gateway", os.environ["OPENCODE_RSI_GATEWAY"])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gateway = rsi.observed_gateway(module)(root / "channel", root / "control", "fixture", "max",
                upstream="http://127.0.0.1:1/v1", api_key="not-a-model-credential")
            try:
                request = gateway.record(os.getpid(), json.dumps({"model": "fixture", "reasoning": {"effort": "max"}}).encode())
                gateway.checkpoint(request, status=200)
                gateway.observation.response.write(b"data: " + ERROR + b"\n\n")
                gateway.checkpoint_shutdown()
                gateway.finish(request, 200, "transport_failed", None, close_reason="eof_without_terminal")
                self.assertEqual(gateway.db.execute("SELECT * FROM provider_failure").fetchall(), [])
                self.assertEqual(gateway.db.execute("SELECT outcome FROM request").fetchone()[0], "gateway_stopped_unknown")
            finally:
                gateway.server_close()
                gateway.db.close()

    def test_real_gateway_forwards_bytes_and_binds_only_the_error_request(self):
        module = load("qualified_gateway", os.environ["OPENCODE_RSI_GATEWAY"])
        bodies = [b"data: " + ERROR + b"\n\n", b'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n']

        class Provider(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                body = bodies.pop(0)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        host = threading.Thread(target=upstream.serve_forever, daemon=True)
        host.start()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gateway = rsi.observed_gateway(module)(root / "channel", root / "control", "fixture", "max",
                upstream=f"http://127.0.0.1:{upstream.server_port}/v1", api_key="not-a-model-credential")
            (root / "control/runtime.json").write_text(json.dumps(module.process_identity(os.getpid())))
            thread = threading.Thread(target=gateway.serve_forever, daemon=True)
            thread.start()
            try:
                for _ in range(2):
                    body = json.dumps({"model": "fixture", "reasoning": {"effort": "max"}, "stream": True, "input": []}).encode()
                    with socket.socket(socket.AF_UNIX) as client:
                        client.settimeout(5)
                        client.connect(str(root / "channel/provider.sock"))
                        client.sendall(b"POST /v1/responses HTTP/1.1\r\nHost: programbench-provider.invalid\r\nContent-Length: "
                                       + str(len(body)).encode() + b"\r\n\r\n" + body)
                        chunks = []
                        while chunk := client.recv(65536):
                            chunks.append(chunk)
                        self.assertIn(b"200 OK", b"".join(chunks))
                for _ in range(100):
                    with gateway.lock:
                        count = gateway.db.execute("SELECT count(*) FROM request WHERE finished IS NOT NULL").fetchone()[0]
                    if count == 2:
                        break
                    time.sleep(.01)
                with gateway.lock:
                    failures = gateway.db.execute("SELECT request_id,kind,status,code FROM provider_failure").fetchall()
                    rows = gateway.db.execute("SELECT outcome,usage FROM request ORDER BY id").fetchall()
                self.assertEqual(failures, [(1, "provider-unavailable", 200, "500")])
                self.assertEqual(rows[0], ("transport_failed", None))
                self.assertEqual(rows[1][0], "response.completed")
            finally:
                gateway.shutdown()
                thread.join()
                gateway.server_close()
                gateway.db.close()
                upstream.shutdown()
                host.join()
                upstream.server_close()


if __name__ == "__main__":
    unittest.main()
