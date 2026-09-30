"""Admission boundary tests use the real SQLite reader; no provider calls."""

import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "rsi_gateway", Path(__file__).with_name("rsi-gateway.py")
)
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class AdmissionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "ota.sqlite"
        self.db = sqlite3.connect(self.path)
        self.db.execute("CREATE TABLE ota_state(id INTEGER PRIMARY KEY, value TEXT)")
        self.state = {
            "protocol": "p",
            "epoch": 1,
            "active": {"pair": {"s": "s", "h": "h"}},
            "job": {"id": "j", "phase": "running"},
            "kernel": {"contracts": {}},
        }
        self.scope = {
            "database": str(self.path),
            "protocol": "p",
            "epoch": 1,
            "incumbent": {"s": "s", "h": "h"},
            "job": "j",
            "phase": "running",
        }
        self.save()

    def save(self):
        self.db.execute(
            "INSERT OR REPLACE INTO ota_state VALUES(1,?)", (json.dumps(self.state),)
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_authorized_seed_and_scoped_evaluation(self):
        gateway.standing(self.scope)
        self.state["job"]["phase"] = "evaluating"
        self.save()
        with self.assertRaisesRegex(ValueError, "job"):
            gateway.standing(self.scope)
        gateway.standing({**self.scope, "phase": "evaluating"})

    def test_stale_epoch_job_protocol_and_baseline_are_denied(self):
        for key, value in [
            ("epoch", 2),
            ("job", "foreign"),
            ("protocol", "foreign"),
            ("incumbent", {"s": "other", "h": "h"}),
        ]:
            with self.assertRaises(ValueError):
                gateway.standing({**self.scope, key: value})

    def test_support_revocation_and_explicit_cancel_deny_new_requests(self):
        self.state["active"]["support"] = "contract"
        self.state["kernel"]["contracts"]["contract"] = {"status": "discharged"}
        self.save()
        gateway.standing(self.scope)
        self.state["kernel"]["contracts"]["contract"]["status"] = "escalated"
        self.save()
        with self.assertRaisesRegex(ValueError, "withdrawn"):
            gateway.standing(self.scope)
        self.state["kernel"]["contracts"]["contract"]["status"] = "discharged"
        self.save()
        (Path(self.temp.name) / "CANCEL").write_text("cancel")
        with self.assertRaisesRegex(ValueError, "cancelled"):
            gateway.standing(self.scope)


if __name__ == "__main__":
    unittest.main()
