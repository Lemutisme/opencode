"""Admission boundary tests use the real SQLite reader; no provider calls."""

import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import hashlib
import time
from contextlib import closing
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

    def test_task_continuation_binds_checkpoint_purpose_and_task_contract(self):
        self.state["task"] = {"id": "original-task", "checkpoint": "checkpoint-1", "contractID": "task-contract"}
        self.state["kernel"]["contracts"]["task-contract"] = {"status": "active"}
        self.state["job"]["purpose"] = "continuation"
        self.save()
        scope = {**self.scope, "purpose": "continuation", "task": {"id": "original-task", "checkpoint": "checkpoint-1"}}
        gateway.standing(scope)
        with self.assertRaisesRegex(ValueError, "purpose"):
            gateway.standing({**scope, "purpose": "proposal"})
        with self.assertRaisesRegex(ValueError, "checkpoint"):
            gateway.standing({**scope, "task": {"id": "original-task", "checkpoint": "checkpoint-2"}})
        self.state["kernel"]["contracts"]["task-contract"]["status"] = "escalated"
        self.save()
        with self.assertRaisesRegex(ValueError, "task_support"):
            gateway.standing(scope)

    def test_task_tools_cannot_escape_into_evaluation_or_proposal(self):
        body = lambda name: json.dumps({"tools": [{"name": name}]})
        gateway.validate_tools({}, body("rsi_handoff"))
        gateway.validate_tools({"mode": "programbench"}, body("contract_delivery"))
        gateway.validate_tools({"mode": "programbench", "allowRevise": True, "purpose": "continuation"}, body("rsi_revise"))
        for scope, tool in [({}, "contract_delivery"), ({"mode": "programbench"}, "rsi_handoff"),
                            ({"mode": "programbench", "allowRevise": True}, "rsi_revise")]:
            with self.assertRaisesRegex(ValueError, "tool_not_admitted"):
                gateway.validate_tools(scope, body(tool))

    def test_independent_audit_admission_rejects_replay_foreign_pair_and_changed_source(self):
        self.state.update(revision=42, seed={"s": "seed-s", "h": "seed-h"}, stopped="recursive closure completed", trial=False)
        self.state["active"]["support"] = "selected"
        self.state["kernel"]["contracts"]["selected"] = {"status": "discharged"}
        self.save()
        audit = Path(self.temp.name) / "audit.sqlite"
        deadline = int(time.time() * 1000) + 60000
        state = {"protocol": "audit-protocol", "source": {
            "database": str(self.path), "revision": 42, "protocol": "p",
            "seed": self.state["seed"], "pair": self.state["active"]["pair"],
            "stateHash": hashlib.sha256(json.dumps(self.state).encode()).hexdigest(),
        }, "assignments": [{"id": "final-r1", "pair": {"s": "s", "h": "h"},
                            "status": "active", "deadline": deadline, "contractID": "audit-contract"}],
                 "kernel": {"contracts": {"audit-contract": {"status": "active"}}}}
        scope = {"kind": "audit", "database": str(audit), "protocol": "audit-protocol", "assignment": "final-r1",
                 "pair": {"s": "s", "h": "h"}, "deadline": deadline}
        with closing(sqlite3.connect(audit)) as db:
            db.execute("CREATE TABLE rsi_audit(id INTEGER PRIMARY KEY,value TEXT)")
            db.execute("INSERT INTO rsi_audit VALUES(1,?)", (json.dumps(state),))
            db.commit()
        gateway.standing(scope)
        for change in ({"pair": {"s": "foreign", "h": "h"}}, {"assignment": "extra-r3"}, {"deadline": deadline + 1}):
            with self.assertRaisesRegex(ValueError, "audit_admission"):
                gateway.standing({**scope, **change})
        self.state["revision"] += 1
        self.save()
        with self.assertRaisesRegex(ValueError, "audit_source"):
            gateway.standing(scope)
        state["assignments"][0]["status"] = "closed"
        with closing(sqlite3.connect(audit)) as db:
            db.execute("UPDATE rsi_audit SET value=? WHERE id=1", (json.dumps(state),))
            db.commit()
        with self.assertRaisesRegex(ValueError, "audit_admission"):
            gateway.standing(scope)


if __name__ == "__main__":
    unittest.main()
