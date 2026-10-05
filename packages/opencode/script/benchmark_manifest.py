"""Bind official Harbor tasks without exposing final tests to the solver.

The identity is host-only. The admission manifest contains digests, not test
contents or reference answers. This is not a semantic replacement for Harbor.
"""
import hashlib
import json
from pathlib import Path
import tomllib


def build(task_path, instruction=None):
    root = Path(task_path).resolve()
    for name in ("instruction.md", "task.toml", "tests/test.sh", "tests/Dockerfile"):
        if not (root / name).is_file():
            raise ValueError("Missing official task component: " + name)
    config = tomllib.loads((root / "task.toml").read_text())
    if config.get("verifier", {}).get("environment_mode") != "separate":
        raise ValueError("A separate final verifier is required")
    if not config.get("artifacts"):
        raise ValueError("Official artifact collection plan is required")
    files = [root / "instruction.md", root / "task.toml"]
    for name in ("environment", "tests"):
        files.extend(path for path in (root / name).rglob("*") if path.is_file() or path.is_symlink())
    identity = {}
    for path in sorted(files):
        if path.is_symlink():
            raise ValueError("Unfrozen symbolic link in task inputs: " + str(path.relative_to(root)))
        with path.open("rb") as stream:
            identity[path.relative_to(root).as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
    evaluator_hash = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    admitted_instruction = (root / "instruction.md").read_text() if instruction is None else instruction
    return {
        "manifest": {
            "version": 2,
            "instructionHash": hashlib.sha256(admitted_instruction.encode()).hexdigest(),
            "finalEvaluatorHash": evaluator_hash,
            "visibility": "sealed",
            "mode": "external-only",
            "provenance": "Official Harbor separate verifier and declared artifact plan; host-only task input identity.",
        },
        "identity": {"files": identity, "artifacts": config["artifacts"], "config": config,
                     "admitted_instruction": admitted_instruction},
    }


def verify(task_path, expected, instruction=None):
    if build(task_path, instruction) != expected:
        raise ValueError("Official task/evaluator inputs changed after admission")


def load_public_replay(path, sha256, official):
    raw = Path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != sha256:
        raise ValueError("Public replay manifest hash mismatch")
    manifest = json.loads(raw)
    if manifest.get("version") != 1 or manifest.get("visibility") != "public":
        raise ValueError("An explicit public replay manifest must declare public version 1")
    for field in ("instructionHash", "finalEvaluatorHash"):
        if manifest.get(field) != official["manifest"][field]:
            raise ValueError("Public replay cannot replace the official " + field)
    return manifest


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task_path")
    args = parser.parse_args()
    print(json.dumps(build(args.task_path), indent=2))
