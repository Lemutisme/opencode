"""Exercise the real gateway with deterministic, test-only signal scheduling."""
import json
import os
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


gateway = str(Path(sys.argv.pop(1)).resolve())

# No production hooks or alternate stop implementation: trace the actual lock
# owner or interrupt the actual stop body after its lock acquisition (if any).
tracer = """
import ast, runpy, signal, sys, threading, time
from pathlib import Path
gateway, config, mode, marker = sys.argv[1:]
tree = ast.parse(Path(gateway).read_text())
stop = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'stop')
target = next((node.body[0].lineno for node in stop.body if isinstance(node, ast.With)), stop.body[-1].lineno)
lines = Path(gateway).read_text().splitlines()
fired = False
def trace(frame, event, arg):
    global fired
    if event != 'line' or frame.f_code.co_filename != gateway or fired:
        return trace
    if mode == 'journal' and frame.f_code.co_name == 'record' and 'os.fsync(out.fileno())' in lines[frame.f_lineno - 1]:
        fired = True
        assert frame.f_globals['lock'].locked()
        Path(marker).write_text('journal-lock-held')
        time.sleep(60)
    if mode == 'reentrant' and frame.f_code.co_name == 'stop' and frame.f_lineno == target:
        fired = True
        Path(marker).write_text('nested-signal')
        signal.raise_signal(signal.SIGINT)
    return trace
sys.settrace(trace)
threading.settrace(trace)
sys.argv = [gateway, config]
runpy.run_path(gateway, run_name='__main__')
"""


class Shutdown(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="gateway-shutdown-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.config = {
            "socket": str(self.root / "gateway.sock"),
            "ledger": str(self.root / "ledger.sqlite"),
            "journal": str(self.root / "requests.jsonl"),
            "cancel": str(self.root / "CANCEL"),
            "deadline": int(time.time() * 1000) + 30000,
            "task": "task",
            "grant": "grant",
            "parent": "parent-policy",
            "method": "method-policy",
            "model": "never-called",
            "effort": "max",
            "upstream": "http://127.0.0.1:1/v1",
            "pid": os.getpid(),
            "birth": Path(f"/proc/{os.getpid()}/stat").read_text().rsplit(")", 1)[1].split()[19],
        }

    def start(self, mode):
        with sqlite3.connect(self.config["ledger"]) as db:
            db.execute("CREATE TABLE state (id INTEGER PRIMARY KEY, data TEXT)")
            db.execute("INSERT INTO state VALUES (1, ?)", (json.dumps({"kernel": {"contracts": {
                "task": {"status": "active", "spec": {"budget": {"deadline": self.config["deadline"]}}},
                "grant": {"status": "discharged", "handoff": {"subjectHash": self.config["parent"]}},
            }}}),))
        (self.root / "config.json").write_text(json.dumps(self.config))
        child = subprocess.Popen(
            [sys.executable, "-c", tracer, gateway, str(self.root / "config.json"), mode, str(self.root / "MARKER")],
            env={"PATH": "/usr/bin:/bin"}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        # Popen retains the owned PID until reaped. Never signal by name or use
        # process-global cleanup, including when this test fails on old code.
        self.addCleanup(self.reap, child)
        self.wait_file(Path(self.config["socket"]), child)
        return child

    def reap(self, child):
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=3)

    def wait_file(self, file, child):
        deadline = time.monotonic() + 3
        while not file.exists():
            self.assertIsNone(child.poll(), "Gateway exited before scheduled test point")
            self.assertLess(time.monotonic(), deadline, "Gateway did not reach scheduled test point")
            time.sleep(0.005)

    def hold_journal(self):
        child = self.start("journal")
        peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(peer.close)
        peer.settimeout(3)
        peer.connect(self.config["socket"])
        body = json.dumps({"model": self.config["model"], "reasoning": {"effort": "max"}}).encode()
        peer.sendall(f"POST /v1/responses HTTP/1.0\r\nHost: test\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
        self.wait_file(self.root / "MARKER", child)
        self.assertEqual((self.root / "MARKER").read_text(), "journal-lock-held")
        return child, peer

    def assert_stopped(self, child):
        _, stderr = child.communicate(timeout=2)
        self.assertEqual(child.returncode, 0, stderr.decode())
        self.assertEqual(stderr, b"")

    def assert_incomplete(self, peer):
        # Exit closes the admitted peer without inventing response.completed or
        # a finished journal receipt; accounting must keep this admission unknown.
        self.assertEqual(peer.recv(1), b"")
        records = [json.loads(line) for line in Path(self.config["journal"]).read_text().splitlines()]
        self.assertEqual([record["type"] for record in records], ["admitted"])

    def test_repeated_signals_with_held_journal_lock(self):
        child, peer = self.hold_journal()
        child.send_signal(signal.SIGTERM)
        child.send_signal(signal.SIGINT)
        self.assert_stopped(child)
        self.assert_incomplete(peer)

    def test_reentrant_signal_during_stop(self):
        child = self.start("reentrant")
        child.send_signal(signal.SIGTERM)
        self.assert_stopped(child)
        self.assertEqual((self.root / "MARKER").read_text(), "nested-signal")
        self.assertFalse(Path(self.config["journal"]).exists())

    def test_cancel_with_held_journal_lock(self):
        child, peer = self.hold_journal()
        Path(self.config["cancel"]).write_text("cancelled")
        self.assert_stopped(child)
        self.assert_incomplete(peer)

    def test_original_deadline_with_held_journal_lock(self):
        self.config["deadline"] = int(time.time() * 1000) + 1000
        child, peer = self.hold_journal()
        self.assert_stopped(child)
        self.assertGreaterEqual(time.time() * 1000, self.config["deadline"])
        self.assert_incomplete(peer)


unittest.main()
