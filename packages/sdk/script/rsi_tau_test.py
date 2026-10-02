"""No-model tests against the real official tau3 Orchestrator/environment/grader.

Run with the frozen tau dependency interpreter and TAU3_VENDOR. No task solution
or hidden retail/airline goals are inspected; only the official mock task is used.
"""
import importlib.util
import http.client
import http.server
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location("rsi_tau", Path(__file__).with_name("rsi-tau.py"))
tau = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tau)
VENDOR = os.environ.get("TAU3_VENDOR")


@unittest.skipUnless(VENDOR, "set TAU3_VENDOR and use its frozen dependency interpreter")
class OfficialTest(unittest.TestCase):
    def setUp(self):
        tau.load_tau(VENDOR)
        from tau2.user.user_simulator import UserSimulator
        from tau2.data_model.message import UserMessage

        class ScriptedUser(UserSimulator):
            def __init__(self):
                super().__init__(llm="scripted", instructions="HOST_PRIVATE_GOAL_DO_NOT_EXPORT")
                self.index = 0

            def generate_next_message(self, message, state):
                text = ["Create Important Meeting for user_1.", "Yes, please create it.", "###STOP###"][min(self.index, 2)]
                self.index += 1
                result = UserMessage(role="user", content=text, cost=0.0)
                state.messages.append(result)
                return result, state

        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.user = ScriptedUser()
        self.trial = tau.Trial(self.root, {
            "vendor": VENDOR, "domain": "mock", "task": "create_task_1_with_env_assertions", "split": None,
            "deadline": time.time() * 1000 + 60000, "seed": 626729,
        }, user=self.user)

    def tearDown(self):
        self.trial.close()
        self.temporary.cleanup()

    def act(self, action, generation="h0", id=None):
        return self.trial.turn({"id": id or str(self.trial.sequence), "sequence": self.trial.sequence, "action": action}, generation)

    def create(self, generation="h0", id="create"):
        return self.act({"calls": [{"name": "create_task", "arguments": {"user_id": "user_1", "title": "Important Meeting"}}]}, generation, id)

    def test_official_business_grade_and_no_private_state(self):
        public = self.trial.public()
        self.assertEqual(public["steps"], 1)
        self.assertNotIn("HOST_PRIVATE", json.dumps(public))
        self.assertNotIn("evaluation_criteria", json.dumps(public))
        self.act({"speak": "Please confirm creation."})
        self.create()
        result = self.act({"speak": "The task was created successfully."})
        self.assertTrue(result["terminal"])
        self.assertEqual(result["steps"], 7)
        self.assertNotIn("reward", result)
        self.assertEqual(self.trial.grade()["passed"], 1)

    def test_successor_preserves_user_database_steps_and_deadline(self):
        self.trial.public()
        self.act({"speak": "Please confirm creation."})
        before = self.create()
        orchestrator = self.trial.orchestrator
        successor = self.trial.public()
        self.assertIs(self.trial.orchestrator, orchestrator)
        self.assertEqual(successor["sequence"], before["sequence"])
        self.assertEqual(successor["steps"], 5)
        self.assertEqual(self.user.index, 2)
        self.assertEqual(len(orchestrator.environment.tools.db.tasks), 2)
        result = self.act({"speak": "The task was created successfully."}, "h1")
        self.assertEqual(result["deadline"], before["deadline"])
        self.assertEqual(self.user.index, 3)
        self.assertEqual(len(orchestrator.environment.tools.db.tasks), 2)
        self.assertEqual(self.trial.grade()["passed"], 1)

    def test_exact_retry_does_not_repeat_business_side_effect(self):
        self.trial.public()
        request = {"id": "once", "sequence": 0, "action": {"calls": [{"name": "create_task", "arguments": {"user_id": "user_1", "title": "Important Meeting"}}]}}
        first = self.trial.turn(request, "h0")
        self.assertEqual(self.trial.turn(request, "h0"), first)
        self.assertEqual(len(self.trial.orchestrator.environment.tools.db.tasks), 2)
        with self.assertRaisesRegex(ValueError, "conflicting"):
            self.trial.turn({**request, "action": {"stop": True}}, "h0")
        with self.assertRaisesRegex(ValueError, "stale"):
            self.trial.turn(request, "h1")

    def test_forged_tools_and_mixed_messages_never_mutate_state(self):
        self.trial.public()
        for action in [{"speak": "hi", "calls": []}, {"calls": [{"name": "grade", "arguments": {}}]}, {"stop": False}]:
            with self.assertRaises(ValueError):
                self.act(action)
        self.assertEqual(self.trial.sequence, 0)
        self.assertEqual(self.trial.orchestrator.step_count, 1)

    def test_official_interaction_ceiling_is_not_reset(self):
        self.trial.public()
        while not self.trial.orchestrator.done:
            self.act({"calls": [{"name": "get_users", "arguments": {}}]}, "h0" if self.trial.sequence < 20 else "h1")
        self.assertEqual(self.trial.orchestrator.max_steps, 100)
        # Official semantics finish environment work admitted at the ceiling.
        self.assertEqual(self.trial.orchestrator.step_count, 101)
        self.assertEqual(self.trial.grade()["passed"], 0)
        self.assertEqual(self.trial.result.termination_reason.value, "max_steps")

    def test_deadline_and_cancel_are_fail_closed(self):
        self.trial.public()
        original = self.trial.config["deadline"]
        self.trial.config["deadline"] = time.time() * 1000 - 1
        with self.assertRaisesRegex(ValueError, "deadline"):
            self.create()
        self.trial.config["deadline"] = original
        (self.root / "CANCEL").touch()
        with self.assertRaisesRegex(ValueError, "cancelled"):
            self.create()

    def test_native_peer_identity_and_revoked_lease(self):
        run = self.root / "native"
        (run / "control").mkdir(parents=True)
        tau.write(run / "control/runtime.json", tau.identity(os.getpid()))
        tau.write(run / "control/scope.json", {"fixture": True})
        (run / "control/active").touch()
        tau.write(self.root / "binding.json", {"run": str(run), "generation": "h0"})
        self.trial.config["fixture"] = True
        bridge = tau.Bridge(self.trial)
        try:
            self.assertEqual(bridge.authorize(os.getpid()), "h0")
            with self.assertRaises(ValueError):
                bridge.authorize(os.getppid())
            bridge.revoked.add("h0")
            with self.assertRaisesRegex(ValueError, "revoked"):
                bridge.authorize(os.getpid())
            tau.write(self.root / "binding.json", {"run": str(run), "generation": "h1"})
            self.assertEqual(bridge.authorize(os.getpid()), "h1")
        finally:
            bridge.server_close()

    def test_real_user_simulator_transport_is_separately_metered(self):
        records = []

        class ScriptedProvider(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                records.append(value)
                body = json.dumps({
                    "id": "chatcmpl-fixture", "object": "chat.completion", "created": int(time.time()),
                    "model": "gpt-5.2-2025-12-11",
                    "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "Create Important Meeting for user_1."}}],
                    "usage": {"prompt_tokens": 12, "completion_tokens": 7, "total_tokens": 19},
                }).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ScriptedProvider)
        threading.Thread(target=provider.serve_forever, daemon=True).start()
        previous = {name: os.environ.get(name) for name in ["OPENAI_API_KEY", "OPENAI_BASE_URL"]}
        os.environ["OPENAI_API_KEY"] = "scripted-not-a-secret"
        os.environ["OPENAI_BASE_URL"] = f"http://127.0.0.1:{provider.server_port}/v1"
        self.trial.user_override = None
        self.trial.config.update(userModel="gpt-5.2-2025-12-11", userEffort="low")
        try:
            public = self.trial.public()
            self.assertEqual(public["messages"][-1]["content"], "Create Important Meeting for user_1.")
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["model"], "gpt-5.2-2025-12-11")
            self.assertEqual(records[0]["reasoning_effort"], "low")
            row = self.trial.proxy.db.execute("SELECT actor,status,usage,error FROM request").fetchone()
            self.assertEqual(row[0:2], ("user", 200))
            self.assertEqual(json.loads(row[2])["total_tokens"], 19)
            self.assertIsNone(row[3])
        finally:
            provider.shutdown()
            provider.server_close()
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value


if __name__ == "__main__":
    unittest.main()
