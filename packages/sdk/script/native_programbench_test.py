"""Run with the pinned ProgramBench src directory on PYTHONPATH. No model or Docker."""

import importlib.util
import json
from pathlib import Path
import tempfile
import os
import shutil
import unittest

spec = importlib.util.spec_from_file_location(
    "native_programbench", Path(__file__).with_name("native-programbench.py")
)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class OfficialAggregationTest(unittest.TestCase):
    def evaluate(self, rows, expected=("pass", "ignored"), **fields):
        instance = {
            "branches": {
                "current": {
                    "tests": list(expected),
                    "ignored_tests": [{"name": "ignored"}],
                },
                "retired": {"ignored": True, "tests": ["old"]},
            }
        }
        value = {
            "test_branches": ["current", "retired"],
            "test_results": [{**row, "extra": {}} for row in rows],
            **fields,
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "raw.eval.json"
            path.write_text(json.dumps(value))
            before = path.read_bytes()
            result = native.official_result(path, instance)
            self.assertEqual(
                path.read_bytes(), before, "aggregation must not rewrite raw evidence"
            )
            return result

    def test_ignored_failure_and_retired_branch_do_not_veto_an_official_full_pass(self):
        result = self.evaluate(
            [
                {"branch": "current", "name": "pass", "status": "passed"},
                {"branch": "current", "name": "ignored", "status": "failure"},
                {"branch": "retired", "name": "old", "status": "failure"},
            ]
        )
        self.assertEqual((result.n_resolved, len(result), result.score), (1, 1, 1))

    def test_an_active_failure_still_prevents_discharge(self):
        result = self.evaluate(
            [
                {"branch": "current", "name": "pass", "status": "passed"},
                {"branch": "current", "name": "failure", "status": "failure"},
                {"branch": "current", "name": "ignored", "status": "passed"},
            ],
            expected=("pass", "failure", "ignored"),
        )
        self.assertEqual((result.n_resolved, len(result), result.score), (1, 2, 0.5))

    def test_missing_active_tests_cannot_become_a_full_pass(self):
        with self.assertRaisesRegex(RuntimeError, "missing branches or tests"):
            self.evaluate(
                [{"branch": "current", "name": "pass", "status": "passed"}],
                expected=("pass", "failure", "ignored"),
            )

    def test_filtering_preserves_infrastructure_faults_and_warnings(self):
        result = self.evaluate(
            [{"branch": "current", "name": "pass", "status": "system_error"}],
            error_code="setup-failed",
            warnings=["incomplete evidence"],
        )
        self.assertEqual(result.error_code, "setup-failed")
        self.assertEqual(result.n_system_errors, 1)
        self.assertEqual(result.warnings, ["incomplete evidence"])


class DeliveryAdmissionTest(unittest.TestCase):
    def test_idle_or_blocked_worker_cannot_synthesize_report_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ended.json"
            for disposition in [
                {},
                {"state": "open"},
                {"state": "blocked", "reason": "unresolved public behavior"},
            ]:
                path.write_text(
                    json.dumps(
                        {"authoritativeCompletion": False, "delivery": disposition}
                    )
                )
                with self.assertRaisesRegex(
                    RuntimeError, "No explicit delivery handoff"
                ):
                    native.delivery_handoff(path)
            handoff = {
                "state": "ready",
                "snapshot": "fixture-hash",
                "summary": "public cases only",
                "probes": 2,
            }
            path.write_text(
                json.dumps({"authoritativeCompletion": False, "delivery": handoff})
            )
            self.assertEqual(native.delivery_handoff(path), handoff)
            path.write_text(
                json.dumps({"authoritativeCompletion": True, "delivery": handoff})
            )
            with self.assertRaisesRegex(RuntimeError, "must not assert"):
                native.delivery_handoff(path)

    def test_incomplete_handoff_cannot_be_admitted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ended.json"
            path.write_text(
                json.dumps(
                    {"authoritativeCompletion": False, "delivery": {"state": "ready"}}
                )
            )
            with self.assertRaisesRegex(RuntimeError, "Incomplete"):
                native.delivery_handoff(path)

    def test_ripgrep_is_copied_qualified_and_content_bound(self):
        source = shutil.which("rg")
        self.assertIsNotNone(
            source, "offline qualification requires an actual ripgrep binary"
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = native.prepare_ripgrep(Path(source), root)
            self.assertNotEqual(os.path.realpath(source), str(target))
            self.assertEqual(native.sha(Path(source)), native.sha(target))
            self.assertEqual(
                json.loads((root / "TOOLS.json").read_text())["rg"]["sha256"],
                native.sha(target),
            )
            self.assertFalse((root / "rg-probe").exists())


if __name__ == "__main__":
    unittest.main()
