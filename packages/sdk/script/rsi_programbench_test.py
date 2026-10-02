"""No-container grader boundaries; the process tests launch only local Python.

Set PROGRAMBENCH_RUNNER to the frozen runner and use its dependency interpreter
for the official-scope cases. These cases create synthetic result JSON, never
open benchmark data, start Docker, call a model, or qualify real containment.
"""

import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location(
    "rsi_programbench", Path(__file__).with_name("rsi-programbench.py")
)
grader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grader)


class BoundaryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        for name in ["operations", "home", "tmp"]:
            (self.root / name).mkdir()
        self.control = {
            "root": str(self.root),
            "deadline": int((time.time() + 60) * 1000),
            "token": "a" * 32,
            "config": {
                "image": "sha256:" + "b" * 64,
                "instance": "fixture__program.deadbeef",
                "docker": {"path": str(self.root / "fake-docker")},
            },
        }
        # This executable is an explicit test transport, not a Docker daemon.
        (self.root / "fake-docker").write_text(
            "#!" + str(Path(sys.executable).resolve()) + "\n"
            "import json,pathlib,sys,time\n"
            "root=pathlib.Path(__file__).parent\n"
            "with (root/'calls.jsonl').open('a') as out: out.write(json.dumps(sys.argv[1:])+'\\n')\n"
            "if sys.argv[1]=='create':\n"
            " time.sleep(0.3)\n"
            " print('c'*64)\n"
            "if sys.argv[1]=='exec': time.sleep(30)\n"
        )
        (self.root / "fake-docker").chmod(0o500)
        self.control_path = self.root / "control.json"
        grader.write(self.control_path, self.control)

    def tearDown(self):
        self.temp.cleanup()

    def guard(self, args):
        return subprocess.Popen(
            [
                sys.executable,
                "-I",
                "-S",
                str(Path(grader.__file__)),
                "--docker",
                str(self.control_path),
                *args,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )

    def wait_operation(self):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            records = list((self.root / "operations").glob("*.json"))
            if records and (self.root / "calls.jsonl").exists():
                return records[0]
            time.sleep(0.01)
        self.fail("Guard never registered its operation")

    def test_tree_identity_covers_names_modes_bytes_and_links(self):
        supply = self.root / "supply"
        supply.mkdir()
        (supply / "module.py").write_text("x=1\n")
        first = grader.tree_hash(supply)
        self.assertEqual(first, grader.tree_hash(supply))
        (supply / "module.py").write_text("x=2\n")
        second = grader.tree_hash(supply)
        self.assertNotEqual(first, second)
        (supply / "module.py").chmod(0o500)
        self.assertNotEqual(second, grader.tree_hash(supply))
        (supply / "outside").symlink_to(self.root / "private")
        with self.assertRaisesRegex(grader.GraderError, "escapes"):
            grader.tree_hash(supply)

    def test_reference_rejects_replaced_supplies(self):
        source = self.root / "trusted.py"
        source.write_text("print(1)\n")
        reference = {"path": str(source), "sha256": grader.sha(source)}
        self.assertEqual(grader.reference(reference), source)
        source.write_text("print(2)\n")
        with self.assertRaisesRegex(grader.GraderError, "hash mismatch"):
            grader.reference(reference)

    def test_frozen_venv_executable_link_keeps_venv_path(self):
        # A venv Python symlink must stay a venv invocation while bytes are pinned.
        link = self.root / "python"
        link.symlink_to(Path(sys.executable).resolve())
        self.assertEqual(
            grader.reference({"path": str(link), "sha256": grader.sha(link)}), link
        )

    def test_clean_environment_has_no_operator_credentials(self):
        value = grader.environment(self.root)
        self.assertEqual(
            set(value),
            {
                "PATH",
                "HOME",
                "LANG",
                "TMPDIR",
                "PYTHONDONTWRITEBYTECODE",
                "PYTHONNOUSERSITE",
            },
        )
        self.assertEqual(value["HOME"], str(self.root / "home"))
        self.assertNotIn("PYTHONPATH", value)
        self.assertNotIn("OPENAI_API_KEY", value)
        self.assertNotIn("DOCKER_HOST", value)

    def test_every_creation_is_labeled_networkless_and_image_pinned(self):
        for command in ["create", "run"]:
            args = grader.docker_arguments(
                self.control,
                [
                    command,
                    "--name",
                    "test",
                    "programbench/fixture_1776_program.deadbeef:task_cleanroom_v6",
                ],
            )
            self.assertIn(grader.LABEL + "=" + self.control["token"], args)
            self.assertEqual(args[args.index("--network") + 1], "none")
            self.assertEqual(args[args.index("--cap-drop") + 1], "ALL")
            self.assertIn(self.control["config"]["image"], args)
            self.assertEqual(args[args.index("--pull") + 1], "never")

    def test_fence_rejects_new_admission_without_spawning(self):
        grader.write(self.root / "FENCE.json", {"acknowledged": False})
        with self.assertRaisesRegex(grader.GraderError, "fenced"):
            grader.docker_guard(self.control_path, ["create", "image"])
        self.assertFalse((self.root / "calls.jsonl").exists())
        self.assertFalse(list((self.root / "operations").glob("*.json")))

    def test_original_deadline_rejects_new_admission(self):
        self.control["deadline"] = 1
        with self.assertRaisesRegex(grader.GraderError, "expired"):
            grader.register(self.control, ["run", "image"])
        self.assertFalse((self.root / "calls.jsonl").exists())

    def test_fence_after_create_prevents_start(self):
        process = self.guard(["run", "-d", "image"])
        try:
            receipt = self.wait_operation()
            grader.write(self.root / "FENCE.json", {"acknowledged": False})
            output, error = process.communicate(timeout=5)
            self.assertNotEqual(process.returncode, 0, (output, error))
            record = json.loads(receipt.read_text())
            self.assertEqual(record["phase"], "failed")
            self.assertEqual(record["failure"], "cancelled")
            calls = [
                json.loads(line)
                for line in (self.root / "calls.jsonl").read_text().splitlines()
            ]
            self.assertEqual([call[0] for call in calls], ["create"])
        finally:
            grader.signal_group(process.pid, signal.SIGKILL)
            process.wait()

    def test_fence_terminates_an_active_exec(self):
        process = self.guard(["exec", "container", "sleep", "30"])
        try:
            receipt = self.wait_operation()
            grader.write(self.root / "FENCE.json", {"acknowledged": False})
            process.communicate(timeout=5)
            self.assertNotEqual(process.returncode, 0)
            self.assertEqual(json.loads(receipt.read_text())["failure"], "cancelled")
        finally:
            grader.signal_group(process.pid, signal.SIGKILL)
            process.wait()

    def test_cleanup_kills_real_worker_process_group_and_acknowledges(self):
        marker = self.root / "child.pid"
        process = subprocess.Popen(
            [
                sys.executable,
                "-I",
                "-c",
                "import pathlib,subprocess,sys,time; "
                "p=subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(60)']); "
                "pathlib.Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)",
                str(marker),
            ],
            start_new_session=True,
        )
        try:
            end = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < end:
                time.sleep(0.01)
            self.assertTrue(marker.exists())
            child = int(marker.read_text())
            result = grader.cleanup(self.control, process, "cancelled")
            self.assertTrue(result["acknowledged"], result)
            self.assertEqual(process.returncode, -signal.SIGKILL)
            end = time.monotonic() + 5
            while time.monotonic() < end:
                status = Path(f"/proc/{child}/stat")
                if not status.exists() or status.read_text().split()[2] == "Z":
                    break
                time.sleep(0.01)
            else:
                self.fail("Child outlived grader process-group fence")
            self.assertTrue(
                json.loads((self.root / "FENCE.json").read_text())["acknowledged"]
            )
        finally:
            grader.signal_group(process.pid, signal.SIGKILL)
            process.wait()

    def test_uncertain_daemon_mutation_can_never_acknowledge_cleanup(self):
        grader.write(
            self.root / "operations/uncertain.json",
            {"phase": "uncertain", "argv": ["create", "image"]},
        )
        process = subprocess.Popen(
            [sys.executable, "-c", "pass"], start_new_session=True
        )
        process.wait()
        result = grader.cleanup(self.control, process, "deadline")
        self.assertFalse(result["acknowledged"])
        self.assertTrue(result["errors"])

    def test_candidate_special_entries_rejected_without_reading_them(self):
        workspace = self.root / "workspace"
        workspace.mkdir()
        for name in ["compile.sh", "validate.sh"]:
            (workspace / name).write_text("exit 0\n")
        grader.validate_workspace(workspace)
        os.mkfifo(workspace / "fifo")
        with self.assertRaisesRegex(grader.GraderError, "special"):
            grader.validate_workspace(workspace)

    def test_required_build_scripts_are_not_host_symlinks(self):
        workspace = self.root / "workspace"
        workspace.mkdir()
        (workspace / "compile.sh").symlink_to("/etc/passwd")
        (workspace / "validate.sh").write_text("exit 0\n")
        with self.assertRaisesRegex(grader.GraderError, "regular compile"):
            grader.validate_workspace(workspace)

    def test_docker_export_reads_one_regular_file_without_extracting(self):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as archive:
            member = tarfile.TarInfo("../../not-a-host-path.xml")
            member.size = 4
            archive.addfile(member, io.BytesIO(b"xml!"))
        destination = self.root / "result.xml"
        destination.touch()
        stream.seek(0)
        grader.export_regular(stream, destination)
        self.assertEqual(destination.read_bytes(), b"xml!")

    def test_docker_export_rejects_links_and_host_destination_symlinks(self):
        for kind in ["member", "destination"]:
            with self.subTest(kind=kind):
                stream = io.BytesIO()
                with tarfile.open(fileobj=stream, mode="w") as archive:
                    member = tarfile.TarInfo("result.xml")
                    if kind == "member":
                        member.type = tarfile.SYMTYPE
                        member.linkname = "/etc/passwd"
                    archive.addfile(member)
                destination = self.root / kind
                if kind == "destination":
                    destination.symlink_to("/etc/passwd")
                else:
                    destination.touch()
                stream.seek(0)
                with self.assertRaises((grader.GraderError, OSError)):
                    grader.export_regular(stream, destination)

    def test_cli_rejects_foreign_owner_before_reading_configuration(self):
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                str(Path(grader.__file__)),
                "--config",
                str(self.root / "not-read.json"),
                "--workspace",
                str(self.root),
                "--output",
                str(self.root / "not-created"),
                "--deadline",
                str(self.control["deadline"]),
                "--owner",
                "1",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["failure"], "cancelled")
        self.assertFalse((self.root / "not-created").exists())

    def test_owner_lost_during_preparation_is_not_adopted_at_supervise(self):
        marker = self.root / "prepared"
        result = self.root / "owner-result.json"
        child_code = """
import importlib.util,json,os,pathlib,sys,time
spec=importlib.util.spec_from_file_location('grader',sys.argv[1])
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
owner=os.getppid()
pathlib.Path(sys.argv[2]).write_text(str(owner))
time.sleep(0.3)
try:
 g.supervise({},pathlib.Path(sys.argv[2]).parent,pathlib.Path(sys.argv[2]).parent/'not-created',int(time.time()*1000)+60000,'hash',owner)
except g.GraderError as error:
 pathlib.Path(sys.argv[3]).write_text(json.dumps({'failure':error.classification,'owner':owner,'now':os.getppid()}))
"""
        parent_code = """
import pathlib,subprocess,sys,time
subprocess.Popen([sys.executable,'-I','-c',sys.argv[1],*sys.argv[2:]],start_new_session=True)
end=time.monotonic()+5
while not pathlib.Path(sys.argv[3]).exists() and time.monotonic()<end:time.sleep(0.01)
"""
        parent = subprocess.Popen(
            [
                sys.executable,
                "-I",
                "-c",
                parent_code,
                child_code,
                str(Path(grader.__file__)),
                str(marker),
                str(result),
            ]
        )
        parent.wait(timeout=5)
        end = time.monotonic() + 5
        while not result.exists() and time.monotonic() < end:
            time.sleep(0.01)
        value = json.loads(result.read_text())
        self.assertEqual(value["failure"], "cancelled")
        self.assertNotEqual(value["owner"], value["now"])
        self.assertFalse((self.root / "not-created").exists())

    def test_grade_recovery_is_fence_only_and_preserves_historical_receipts(self):
        self.control["config"]["docker"]["sha256"] = grader.sha(
            self.root / "fake-docker"
        )
        process = subprocess.Popen(
            [sys.executable, "-I", "-c", "import time;time.sleep(60)"],
            start_new_session=True,
        )
        try:
            self.control["worker"] = grader.process_identity(process.pid)
            grader.write(self.control_path, self.control)
            grader.write(
                self.root / "FENCE.json", {"acknowledged": True, "historical": True}
            )
            original = (self.root / "FENCE.json").read_bytes()
            (self.root / "RESULT.json").write_text('"historical score"')
            result = grader.recover_grade(self.root)
            self.assertTrue(result["acknowledged"], result)
            self.assertEqual(process.wait(timeout=5), -signal.SIGKILL)
            self.assertEqual((self.root / "FENCE.json").read_bytes(), original)
            self.assertEqual(
                (self.root / "RESULT.json").read_text(), '"historical score"'
            )
            self.assertTrue((self.root / "RECOVERY_FENCE.json").is_file())
            calls = [
                json.loads(line)[0]
                for line in (self.root / "calls.jsonl").read_text().splitlines()
            ]
            self.assertTrue(all(command == "ps" for command in calls), calls)
        finally:
            grader.signal_group(process.pid, signal.SIGKILL)
            process.wait()

    def test_grade_recovery_rejects_foreign_metadata_and_keeps_uncertainty(self):
        self.control["config"]["docker"]["sha256"] = grader.sha(
            self.root / "fake-docker"
        )
        grader.write(self.control_path, {**self.control, "root": "/foreign"})
        with self.assertRaisesRegex(grader.GraderError, "foreign"):
            grader.recover_grade(self.root)
        self.assertFalse((self.root / "calls.jsonl").exists())
        grader.write(self.control_path, self.control)
        grader.write(
            self.root / "operations/uncertain.json",
            {"phase": "uncertain", "argv": ["create", "image"]},
        )
        result = grader.recover_grade(self.root)
        self.assertFalse(result["acknowledged"])
        self.assertEqual(
            json.loads((self.root / "operations/uncertain.json").read_text())["phase"],
            "uncertain",
        )


@unittest.skipUnless(
    os.environ.get("PROGRAMBENCH_RUNNER"),
    "Provide frozen ProgramBench runner for official-scope tests",
)
class OfficialScopeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(Path(os.environ["PROGRAMBENCH_RUNNER"]) / "src"))
        from programbench.eval.eval import EvaluationResult, TestResult

        cls.EvaluationResult = EvaluationResult
        cls.TestResult = TestResult

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "synthetic.eval.json"
        self.instance = {
            "branches": {
                "active": {
                    "tests": ["ok", "bad", "ignored"],
                    "ignored_tests": [{"name": "ignored"}],
                },
                "excluded": {"tests": ["not-in-denominator"], "ignored": True},
            }
        }
        self.result = self.EvaluationResult(
            test_branches=["active", "excluded"],
            test_results=[
                self.TestResult(name="ok", branch="active", status="passed", extra={}),
                self.TestResult(
                    name="bad", branch="active", status="failure", extra={}
                ),
                self.TestResult(
                    name="ignored", branch="active", status="not_run", extra={}
                ),
                self.TestResult(
                    name="not-in-denominator",
                    branch="excluded",
                    status="system_error",
                    extra={},
                ),
            ],
        )

    def tearDown(self):
        self.temp.cleanup()

    def grade(self):
        self.path.write_text(self.result.model_dump_json())
        return grader.official_result(self.path, self.instance)

    def test_valid_partial_uses_official_active_ignored_denominator(self):
        result, valid = self.grade()
        self.assertTrue(valid)
        self.assertEqual((result.n_resolved, len(result)), (1, 2))

    def test_missing_or_not_run_tests_are_invalid_not_a_zero_score(self):
        self.result.test_results[1].status = "not_run"
        _, valid = self.grade()
        self.assertFalse(valid)
        self.result.test_results = self.result.test_results[:1]
        _, valid = self.grade()
        self.assertFalse(valid)

    def test_warnings_system_errors_and_branch_errors_fail_closed(self):
        self.result.warnings = ["synthetic infrastructure issue"]
        _, valid = self.grade()
        self.assertFalse(valid)
        self.result.warnings = []
        self.result.test_results[1].status = "system_error"
        _, valid = self.grade()
        self.assertFalse(valid)

    def test_duplicate_or_unexpected_tests_cannot_inflate_score(self):
        self.result.test_results.append(self.result.test_results[0].model_copy())
        _, valid = self.grade()
        self.assertFalse(valid)
        self.result.test_results[-1].name = "extra"
        _, valid = self.grade()
        self.assertFalse(valid)


if __name__ == "__main__":
    unittest.main()
