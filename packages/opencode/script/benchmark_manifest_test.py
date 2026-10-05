import json
import hashlib
from pathlib import Path
import tempfile
import unittest

from benchmark_manifest import build, verify, load_public_replay


class ManifestTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "tests").mkdir()
        (self.root / "environment").mkdir()
        (self.root / "instruction.md").write_text("Deliver /app/result.txt.\n")
        (self.root / "task.toml").write_text('artifacts = ["/app/result.txt"]\n[verifier]\nenvironment_mode = "separate"\n')
        (self.root / "tests/test.sh").write_text("SEALED_TEST_SENTINEL")
        (self.root / "tests/Dockerfile").write_text("FROM scratch\n")
        (self.root / "environment/Dockerfile").write_text("FROM scratch\n")

    def test_no_final_test_contents_in_admission(self):
        result = build(self.root)
        self.assertNotIn("SEALED_TEST_SENTINEL", json.dumps(result))
        self.assertNotIn("replay", result["manifest"])
        self.assertEqual(result["manifest"]["mode"], "external-only")
        verify(self.root, result)

    def test_actual_input_mutations_are_rejected(self):
        for name in ("instruction.md", "task.toml", "tests/test.sh", "tests/Dockerfile", "environment/Dockerfile"):
            with self.subTest(name=name):
                expected = build(self.root)
                path = self.root / name
                original = path.read_text()
                path.write_text(original + "\n# changed\n")
                with self.assertRaisesRegex(ValueError, "changed after admission"):
                    verify(self.root, expected)
                path.write_text(original)

    def test_reject_missing_tests_and_escaping_symlinks(self):
        (self.root / "tests/test.sh").unlink()
        with self.assertRaisesRegex(ValueError, "Missing official"):
            build(self.root)
        (self.root / "tests/test.sh").symlink_to(self.root / "instruction.md")
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            build(self.root)

    def test_sidecar_collection_is_preserved(self):
        (self.root / "task.toml").write_text('artifacts = [{source="/results/out.json", service="backend"}]\n[verifier]\nenvironment_mode="separate"\n')
        self.assertEqual(build(self.root)["identity"]["artifacts"], [{"source": "/results/out.json", "service": "backend"}])

    def test_uses_harness_delivered_instruction_without_changing_source_binding(self):
        source = build(self.root)
        delivered = build(self.root, "Harness-normalized instruction")
        self.assertNotEqual(source["manifest"]["instructionHash"], delivered["manifest"]["instructionHash"])
        self.assertEqual(source["manifest"]["finalEvaluatorHash"], delivered["manifest"]["finalEvaluatorHash"])
        verify(self.root, delivered, "Harness-normalized instruction")
        with self.assertRaisesRegex(ValueError, "changed after admission"):
            verify(self.root, delivered, "Different instruction")

    def test_public_replay_cannot_substitute_a_different_official_evaluator(self):
        official = build(self.root)
        manifest = {**official["manifest"], "version": 1, "visibility": "public", "replay": {"checks": []}}
        manifest.pop("mode")
        path = self.root / "public.json"
        path.write_text(json.dumps(manifest))
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        self.assertEqual(load_public_replay(path, digest, official), manifest)
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            load_public_replay(path, "0" * 64, official)
        for field in ("instructionHash", "finalEvaluatorHash"):
            with self.subTest(field=field):
                path.write_text(json.dumps({**manifest, field: "0" * 64}))
                with self.assertRaisesRegex(ValueError, "cannot replace"):
                    load_public_replay(path, hashlib.sha256(path.read_bytes()).hexdigest(), official)


if __name__ == "__main__":
    unittest.main()
