"""Pure issuer-admission tests. No providers, credentials or benchmark data."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location("rsi_gateway", Path(__file__).with_name("rsi-gateway.py"))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class EvaluationAdmission(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.file = self.root / "evaluation.sqlite"
        self.deadline = int(time.time() * 1000) + 60000
        self.pair = {"s": "a" * 64, "h": "b" * 64}
        self.scope = {"kind": "evaluation", "database": str(self.file), "protocol": "c" * 64, "assignment": "t1", "pair": self.pair, "deadline": self.deadline}
        self.state = {"protocol": self.scope["protocol"], "pair": self.pair, "assignments": [{"id": "t1", "pair": self.pair, "status": "active", "deadline": self.deadline, "contractID": "pct_measure_t1"}], "kernel": {"contracts": {"pct_measure_t1": {"status": "active", "scope": self.scope["protocol"], "spec": {"budget": {"deadline": self.deadline}}}}}}
        with sqlite3.connect(self.file) as db:
            db.execute("CREATE TABLE rsi_evaluation(id INTEGER PRIMARY KEY,value TEXT)")
        self.write()

    def write(self):
        with sqlite3.connect(self.file) as db:
            db.execute("INSERT OR REPLACE INTO rsi_evaluation VALUES(1,?)", (json.dumps(self.state),))

    def tearDown(self):
        self.temp.cleanup()

    def test_real_measurement_scope_does_not_need_fake_ota_or_completed_audit(self):
        gateway.standing(self.scope)
        with self.assertRaises(sqlite3.OperationalError):
            gateway.standing({**self.scope, "kind": "audit"})

    def test_pair_deadline_assignment_protocol_and_closed_contract_are_bound(self):
        for change in [{"pair": {**self.pair, "h": "d" * 64}}, {"deadline": self.deadline + 1}, {"assignment": "other"}, {"protocol": "different"}]:
            with self.assertRaises(ValueError):
                gateway.standing({**self.scope, **change})
        self.state["kernel"]["contracts"]["pct_measure_t1"]["status"] = "discharged"
        self.write()
        with self.assertRaisesRegex(ValueError, "withdrawn"):
            gateway.standing(self.scope)

    def test_stopped_and_cancelled_measurements_cannot_admit_new_model_requests(self):
        self.state["stopped"] = "cancelled"
        self.write()
        with self.assertRaises(ValueError):
            gateway.standing(self.scope)
        self.state.pop("stopped")
        self.write()
        (self.root / "CANCEL").touch()
        with self.assertRaisesRegex(ValueError, "cancelled"):
            gateway.standing(self.scope)


if __name__ == "__main__":
    unittest.main()
