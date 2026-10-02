"""No-model tests of the trusted Terminal-Bench bridge's actual boundaries."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("rsi_terminal", Path(__file__).with_name("rsi-terminal.py"))
terminal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(terminal)


class TerminalBoundaryTest(unittest.TestCase):
    def test_command_timeout_is_individual_not_cumulative(self):
        for _ in range(1001):
            self.assertEqual(terminal.tool_arguments({"command": "pwd", "timeout_ms": 600000}), ("pwd", 600000, None))
        for timeout in (0, -1, 600001, True, 1.2, "100"):
            with self.assertRaises(ValueError):
                terminal.tool_arguments({"command": "pwd", "timeout_ms": timeout})

    def test_no_user_elevation_or_service_substitution(self):
        for extra in ({"user": "root"}, {"service": "verifier"}, {"env": {"TOKEN": "x"}}):
            with self.assertRaises(ValueError):
                terminal.tool_arguments({"command": "pwd", **extra})
        for cwd in ("relative", 1, "/app\0"):
            with self.assertRaises(ValueError):
                terminal.tool_arguments({"command": "pwd", "cwd": cwd})

    def test_tool_exposes_only_terminal_not_official_verification(self):
        self.assertEqual(terminal.TOOL["name"], "terminal")
        self.assertEqual(set(terminal.TOOL["inputSchema"]["properties"]), {"command", "cwd", "timeout_ms"})

    def test_official_binding_preserves_private_bytes_without_projection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "environment").mkdir()
            (root / "tests").mkdir()
            (root / "task.toml").write_text('artifacts=["/app/output"]\n[verifier]\nenvironment_mode="separate"\n[environment]\ngpus=0\n')
            (root / "instruction.md").write_text("public problem")
            (root / "tests/test.sh").write_text("private grading secret")
            (root / "environment/Dockerfile").write_text("FROM fixed")
            value = terminal.binding(root)
            self.assertNotIn("private grading secret", json.dumps(value))
            (root / "tests/test.sh").write_text("changed secret")
            self.assertNotEqual(terminal.binding(root), value)
            (root / "environment/docker-compose.yaml").write_text("services: {}")
            with self.assertRaisesRegex(ValueError, "one official task container"):
                terminal.binding(root)

    def test_context_losing_profiles_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for config in (
                'artifacts=["/app/output"]\n[verifier]\nenvironment_mode="shared"\n',
                'artifacts=["/app/output"]\n[verifier]\nenvironment_mode="separate"\n[environment]\ngpus=1\n',
                'artifacts=["/app/output"]\n[verifier]\nenvironment_mode="separate"\n[environment]\nskills_dir="/skills"\n',
                'artifacts=[{source="/out",service="database"}]\n[verifier]\nenvironment_mode="separate"\n',
            ):
                (root / "task.toml").write_text(config)
                with self.assertRaises(ValueError):
                    terminal.binding(root)


if __name__ == "__main__":
    unittest.main()
