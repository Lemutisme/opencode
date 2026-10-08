"""Offline advisory/fixture tests. No ProgramBench runner, Docker, or real model."""

import contextlib
import hashlib
import http.client
import http.server
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location("native_advisory", Path(__file__).with_name("native-programbench.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
CONFIG = {"nodes": {"submission": True, "blocked": True, "idle": True}, "reviewMs": 1800000, "afterMs": 0}
TOOLS = ["glob", "grep", "patch", "read", "shell", "contract_delivery"]


@contextlib.contextmanager
def fixture(advisory=CONFIG, barrier_seconds=2):
    with tempfile.TemporaryDirectory(prefix="advisory-fixture-") as directory:
        root = Path(directory)
        handler = native.fixture_handler(root, "scripted", 1, advisory, barrier_seconds)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield root, server, handler
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


def connect(server, reviewer=False, result=False):
    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
    body = {"model": "scripted", "tools": [{"name": name} for name in (["glob", "grep", "read"] if reviewer else TOOLS)], "input": []}
    if result:
        body["input"] = [{"type": "function_call_output", "call_id": "call_review_read", "output": "read result"}]
    connection.request("POST", "/v1/responses", json.dumps(body), {"Content-Type": "application/json"})
    return connection, connection.getresponse()


def request(server, reviewer=False, result=False):
    connection, response = connect(server, reviewer, result)
    try:
        events = [json.loads(line[6:]) for line in response.read().decode().splitlines() if line.startswith("data: ")]
        return events[-1]["response"]["output"][0]
    finally:
        connection.close()


class AdvisoryConfigurationTest(unittest.TestCase):
    def test_validation_requires_every_field_finite_numbers_and_an_enabled_node(self):
        self.assertEqual(native.validate_advisory(CONFIG), CONFIG)
        bad = [None, {}, {"nodes": CONFIG["nodes"], "reviewMs": 1}, {**CONFIG, "nodes": {"idle": True}},
               {**CONFIG, "nodes": dict.fromkeys(CONFIG["nodes"], False)}]
        bad += [{**CONFIG, "reviewMs": value} for value in [0, -1, float("nan"), float("inf"), True, "1", 10 ** 400]]
        bad += [{**CONFIG, "afterMs": value} for value in [-1, float("nan"), float("inf"), True, "0"]]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ValueError):
                native.validate_advisory(value)

    def cli(self, root, config, rg):
        blobs = root / "blobs/altdesktop__i3-style.f93821b"
        blobs.mkdir(parents=True)
        source = root / "input-advisory.json"
        source.write_bytes(config)
        return subprocess.run([
            sys.executable, str(Path(__file__).with_name("native-programbench.py")),
            "--root", str(root / "run"), "--runtime", str(root / "absent-runtime"), "--bun", "unused",
            "--rg", str(rg), "--runner", str(root / "absent-runner"), "--python", sys.executable,
            "--wheelhouse", str(root / "absent-wheelhouse"), "--blobs", str(root / "blobs"), "--advisory", str(source),
        ], capture_output=True, text=True, timeout=5)

    def test_cli_rejects_configuration_before_any_admission_or_run_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.cli(root, b"{}", root / "missing-rg")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("advisory requires", result.stderr)
            self.assertFalse((root / "run").exists())

    def test_valid_config_is_copied_byte_for_byte_even_when_pre_admission_setup_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = (json.dumps(CONFIG, indent=4) + "\n").encode()
            result = self.cli(root, source, root / "missing-rg")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("FileNotFoundError", result.stderr)
            self.assertEqual((root / "run/advisory.json").read_bytes(), source)
            self.assertFalse((root / "run/issue.json").exists())

    def test_result_keeps_legacy_format_and_hashes_config_for_both_fixture_and_formal_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = (json.dumps(CONFIG, indent=2) + "\n").encode()
            (root / "advisory.json").write_bytes(source)
            for report in [{"qualified": True, "fixture": True}, {"score": 0.5, "valid": True}]:
                native.write_result(root, report)
                self.assertEqual(json.loads((root / "RESULT.json").read_text()), report)
                native.write_result(root, report, CONFIG)
                self.assertEqual(json.loads((root / "RESULT.json").read_text()), {**report, "advisory": hashlib.sha256(source).hexdigest()})
                self.assertNotIn("advisory", report)


class FixtureAdvisoryTest(unittest.TestCase):
    def test_reviewer_routing_is_stateless_and_precedes_researcher_stop_and_action_counters(self):
        with fixture() as (_, server, handler):
            before = (handler.tools, handler.stopped, handler.qualification)
            self.assertEqual(request(server, reviewer=True)["name"], "read")
            self.assertEqual(request(server, reviewer=True)["name"], "read")
            self.assertEqual(request(server, reviewer=True, result=True)["type"], "message")
            self.assertEqual((handler.tools, handler.stopped, handler.qualification), before)
            first = request(server)
            self.assertEqual(first["name"], "shell")
            self.assertIn("python3 -c", json.loads(first["arguments"])["command"])
            self.assertEqual(request(server)["id"], "msg_premature_stop")
            self.assertEqual(request(server)["name"], "glob")

    def test_blocked_reply_flushes_tool_completion_then_waits_for_reviewer_arrival_and_reaches_second_blocked(self):
        with fixture() as (root, server, handler):
            for _ in range(6):
                request(server)
            connection, response = connect(server)
            try:
                while True:
                    line = response.readline().decode()
                    if line.startswith("data: ") and json.loads(line[6:])["type"] == "response.output_item.done":
                        break
                self.assertTrue(handler.blocked_inflight)
                self.assertFalse(handler.reviewer_arrived.is_set())
                self.assertEqual(request(server, reviewer=True)["name"], "read")
                self.assertIn('"type": "response.completed"', response.read().decode())
            finally:
                connection.close()
            self.assertEqual(json.loads((root / "fixture-overlap.json").read_text()), {"arrived": True, "overlap": True})
            self.assertTrue(handler.arrived)
            second = request(server)
            self.assertEqual(second["id"], "fc_qualification_6")
            self.assertEqual(json.loads(second["arguments"])["action"], "blocked")
            self.assertEqual(request(server)["id"], "msg_fixture")
            self.assertEqual(handler.qualification, 6)

    def test_missing_reviewer_arrival_is_recorded_and_releases_the_researcher_reply(self):
        with fixture(barrier_seconds=0.02) as (root, server, handler):
            for _ in range(7):
                request(server)
            self.assertFalse(handler.overlap)
            self.assertFalse(handler.arrived)
            self.assertEqual(json.loads((root / "fixture-overlap.json").read_text()), {"arrived": False, "overlap": False})
            self.assertEqual(request(server)["id"], "fc_qualification_6")
            self.assertEqual(request(server)["id"], "msg_fixture")

    def test_disabled_fixture_keeps_the_original_five_actions_and_writes_no_advisory_files(self):
        with fixture(advisory=None) as (root, server, handler):
            self.assertEqual(request(server)["name"], "shell")
            self.assertEqual(request(server)["id"], "msg_premature_stop")
            self.assertEqual([request(server)["name"] for _ in range(5)], ["glob", "grep", "patch", "read", "contract_delivery"])
            self.assertEqual(request(server)["id"], "msg_fixture")
            self.assertEqual((handler.calls, handler.tools, handler.qualification), (8, 1, 5))
            self.assertEqual([path.name for path in root.iterdir()], ["fixture-requests.jsonl"])


class AdvisoryQualificationTest(unittest.TestCase):
    @contextlib.contextmanager
    def evidence(self, scale=1000):
        with tempfile.TemporaryDirectory() as directory, sqlite3.connect(":memory:") as database:
            root = Path(directory)
            (root / "state").mkdir()
            epoch = 1760000000000
            journal = [
                {"type": "started", "sequence": 1, "node": "idle", "time": epoch + 100},
                {"type": "ended", "sequence": 1, "node": "idle", "time": epoch + 300, "outcome": "completed"},
                {"type": "started", "sequence": 2, "node": "blocked", "time": epoch + 500},
                {"type": "ended", "sequence": 2, "node": "blocked", "time": epoch + 700, "outcome": "completed"},
            ]
            (root / "state/advisory.jsonl").write_text("".join(json.dumps(row) + "\n" for row in journal))
            for index in [1, 2]:
                target = root / f"state/advisory/{index}"
                target.mkdir(parents=True)
                (target / "events.json").write_text(json.dumps([{"type": "session.tool.success", "data": {"id": "call_review_read", "content": [{"type": "text", "text": "native-v2-ok"}]}}]))
            database.execute("CREATE TABLE request(id,started,finished,status,body_sha256,peer_pid)")
            identities = []
            for index, (offset, role) in enumerate([(0, "researcher"), (150, "reviewer"), (350, "researcher"), (550, "reviewer"), (750, "researcher")]):
                # The first Researcher reply overlaps the first review, but its start remains outside the window.
                database.execute("INSERT INTO request VALUES(?,?,?,?,?,?)", (index, (epoch + offset) / scale, (epoch + offset + 200) / scale, 200, str(index), 100))
                identities.append({"time": epoch + offset + 2, "role": role, "bodyHash": str(index)})
            (root / "fixture-identities.jsonl").write_text("".join(json.dumps(row) + "\n" for row in identities))
            yield root, database, journal

    def test_gateway_units_and_window_roles_are_cross_checked_against_known_request_identity(self):
        for scale, unit in [(1, "milliseconds"), (1000, "seconds")]:
            with self.subTest(unit=unit), self.evidence(scale) as (root, database, _):
                native.qualify_advisory(root, CONFIG, database, arrived=True, overlap=True)
                result = json.loads((root / "advisory-qualification.json").read_text())
                self.assertTrue(result["attributionVerified"])
                self.assertEqual(result["attribution"], "verified")
                self.assertEqual(result["gatewayTimeUnit"], unit)
                self.assertEqual([row["role"] for row in result["requests"]], ["researcher", "reviewer", "researcher", "reviewer", "researcher"])

    def test_unobserved_overlap_is_recorded_without_failing_qualification(self):
        with self.evidence() as (root, database, _):
            native.qualify_advisory(root, CONFIG, database, arrived=False, overlap=False)
            result = json.loads((root / "advisory-qualification.json").read_text())
            self.assertFalse(result["arrived"])
            self.assertFalse(result["overlap"])
            self.assertTrue(result["attributionVerified"])
            self.assertEqual(result["attribution"], "verified")

    def test_missing_end_and_unsettled_instances_have_unknown_attribution(self):
        journal = [{"type": "started", "sequence": 1, "time": 100}]
        self.assertEqual(native.advisory_role(50, journal), "researcher")
        self.assertEqual(native.advisory_role(100, journal), "unknown")
        journal.append({"type": "ended", "sequence": 1, "time": 200, "outcome": "completed"})
        self.assertEqual(native.advisory_role(150, journal), "reviewer")
        self.assertEqual(native.advisory_role(200, journal), "researcher")
        journal[-1]["outcome"] = "unsettled"
        self.assertEqual(native.advisory_role(50, journal), "unknown")
        self.assertEqual(native.advisory_role(250, journal), "unknown")

    def test_qualification_rejects_failed_read_and_unfinished_review(self):
        with self.evidence() as (root, database, journal):
            (root / "state/advisory/1/events.json").write_text("[]")
            with self.assertRaisesRegex(RuntimeError, "read qualification"):
                native.qualify_advisory(root, CONFIG, database, arrived=False, overlap=False)
            journal[1]["outcome"] = "timeout"
            (root / "state/advisory.jsonl").write_text("".join(json.dumps(row) + "\n" for row in journal))
            with self.assertRaisesRegex(RuntimeError, "idle qualification"):
                native.qualify_advisory(root, CONFIG, database, arrived=False, overlap=False)

    def test_unverifiable_attribution_records_diagnostics_and_marks_all_usage_unknown(self):
        cases = [("hash", None), ("time", None), ("ambiguous", None), ("unfinished", None)]
        cases += [("status", status) for status in [403, None, "200", 200.0]]
        for failure, status in cases:
            with self.subTest(failure=failure, status=status), self.evidence() as (root, database, _):
                if failure == "hash":
                    database.execute("UPDATE request SET body_sha256='unmatched' WHERE id=1")
                if failure == "status":
                    database.execute("UPDATE request SET status=? WHERE id=1", (status,))
                if failure == "time":
                    database.execute("UPDATE request SET started=0")
                if failure == "unfinished":
                    database.execute("UPDATE request SET finished=NULL WHERE id=1")
                if failure == "ambiguous":
                    database.execute("UPDATE request SET started=0,finished=1")
                    identity = root / "fixture-identities.jsonl"
                    identity.write_text("".join(json.dumps({**json.loads(line), "time": 0}) + "\n" for line in identity.read_text().splitlines()))
                native.qualify_advisory(root, CONFIG, database, arrived=True, overlap=True)
                result = json.loads((root / "advisory-qualification.json").read_text())
                self.assertFalse(result["attributionVerified"])
                self.assertEqual(result["attribution"], "unknown")
                self.assertNotIn("requests", result)
                self.assertNotIn("gatewayTimeUnit", result)
                reason = "missing_gateway_record" if failure == "hash" else "gateway_status_not_2xx_integer" if failure == "status" else "gateway_time_unit_unverified"
                self.assertIn(reason, [row["reason"] for row in result["diagnostics"]["reasons"]])
                identities = [json.loads(line) for line in (root / "fixture-identities.jsonl").read_text().splitlines()]
                self.assertEqual(result["diagnostics"]["fixture"], identities)
                self.assertEqual(len(result["diagnostics"]["gateway"]), 5)
                for row in result["diagnostics"]["gateway"]:
                    self.assertEqual(set(row), {"id", "started", "finished", "status", "body_sha256"})
                    self.assertEqual(
                        (row["started"], row["finished"], row["status"], row["body_sha256"]),
                        database.execute("SELECT started,finished,status,body_sha256 FROM request WHERE id=?", (row["id"],)).fetchone(),
                    )

    def test_reliably_verified_attribution_mismatch_fails_qualification(self):
        with self.evidence() as (root, database, _):
            identity = root / "fixture-identities.jsonl"
            identity.write_text(identity.read_text().replace('"role": "reviewer"', '"role": "researcher"'))
            with self.assertRaisesRegex(RuntimeError, "windows disagree"):
                native.qualify_advisory(root, CONFIG, database, arrived=True, overlap=True)
            result = json.loads((root / "advisory-qualification.json").read_text())
            self.assertTrue(result["attributionVerified"])
            self.assertEqual(result["attribution"], "mismatch")
            self.assertEqual(result["gatewayTimeUnit"], "seconds")
            self.assertEqual([row["id"] for row in result["requests"] if row["role"] != row["fixtureRole"]], [1, 3])


if __name__ == "__main__":
    unittest.main()
