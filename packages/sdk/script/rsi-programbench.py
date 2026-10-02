"""Trusted ProgramBench grader for an already fenced native RSI workspace.

This bridge never solves a task and never imports or extracts candidate code on
its host. The frozen ProgramBench package owns packaging, build and scoring.
Every Docker operation goes through a private guard; a score is unusable until
both the worker process group and every owned container are fenced. No model
credentials are inherited. Real-container qualification is required separately. The frozen official scorer
commits candidate-built images; this bridge does not certify hostile-candidate
resistance of the in-container test framework.

Public CLI: --config FILE --workspace DIR --output NEW_DIR --deadline EPOCH_MS
[--owner PARENT_PID]. Explicit recovery: --fence EXISTING_GRADE_DIR (no allocation).
The config has version=1, instance, pinned image ID, cpus, and {path,sha256}
references for runner, python, docker, wheelhouse and blobs. Directories use
``tree_hash`` below; blobs points to the selected instance's offline directory.
"""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shlex
import signal
import stat
import subprocess
import sys
import tarfile
import time
import uuid


LABEL = "opencode.rsi-grade"
HEX = re.compile(r"[0-9a-f]{64}")
MAX_EXPORT = 128 * 1024 * 1024


class GraderError(RuntimeError):
    def __init__(self, classification, message):
        super().__init__(message)
        self.classification = classification


def write(path, value):
    temporary = path.with_name(path.name + ".new")
    temporary.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")
    temporary.replace(path)


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def tree_hash(root):
    """Identity of trusted supply bytes, relative names, links and mode bits.

    Bytecode caches are not source and are excluded. Links are recorded without
    following them; links that escape a supply tree are not admitted.
    """
    entries = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(name for name in dirs if name != "__pycache__")
        for name in sorted(dirs + files):
            path = Path(directory) / name
            info = path.lstat()
            entry = [path.relative_to(root).as_posix(), stat.S_IMODE(info.st_mode)]
            if stat.S_ISLNK(info.st_mode):
                if not path.resolve().is_relative_to(root):
                    raise GraderError("configuration", "Supply link escapes its tree")
                entry += ["link", os.readlink(path)]
            elif stat.S_ISDIR(info.st_mode):
                entry += ["directory"]
            elif stat.S_ISREG(info.st_mode):
                entry += ["file", info.st_size, sha(path)]
            else:
                raise GraderError("configuration", "Special file in trusted supply")
            entries.append(entry)
    return hashlib.sha256(
        json.dumps(sorted(entries), separators=(",", ":")).encode()
    ).hexdigest()


def reference(value, directory=False):
    if not isinstance(value, dict) or set(value) != {"path", "sha256"}:
        raise GraderError("configuration", "Expected a pinned path/sha256 reference")
    path = Path(value["path"])
    digest = value["sha256"]
    if (
        not path.is_absolute()
        or not isinstance(digest, str)
        or not HEX.fullmatch(digest)
    ):
        raise GraderError(
            "configuration", "Supply reference must be absolute and SHA-256 pinned"
        )
    if path.parent.resolve(strict=True) != path.parent or (
        directory and path.is_symlink()
    ):
        raise GraderError(
            "configuration",
            "Supply directories must be canonical, without path symlinks",
        )
    if (directory and not path.is_dir()) or (not directory and not path.is_file()):
        raise GraderError("configuration", "Wrong supply kind")
    actual = tree_hash(path) if directory else sha(path)
    if actual != digest:
        raise GraderError("configuration", "Frozen supply hash mismatch: " + str(path))
    return path


def config(path):
    value = json.loads(path.read_text())
    expected = {
        "version",
        "instance",
        "image",
        "runner",
        "python",
        "docker",
        "wheelhouse",
        "blobs",
        "cpus",
    }
    if set(value) != expected or value["version"] != 1:
        raise GraderError("configuration", "Unknown or incomplete grader configuration")
    if not isinstance(value["instance"], str) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9_.-]*__[A-Za-z0-9_.-]+", value["instance"]
    ):
        raise GraderError("configuration", "Invalid instance ID")
    if not isinstance(value["image"], str) or not re.fullmatch(
        r"sha256:[0-9a-f]{64}", value["image"]
    ):
        raise GraderError("configuration", "Task image must be pinned by content ID")
    if type(value["cpus"]) is not int or not 1 <= value["cpus"] <= 64:
        raise GraderError("configuration", "Invalid infrastructure CPU bound")
    for key in ["runner", "python", "docker", "wheelhouse", "blobs"]:
        reference(value[key], key in {"runner", "wheelhouse", "blobs"})
    return value


def environment(root):
    # In particular, no OPENAI_*, AZURE_*, proxy, PYTHONPATH or Docker context
    # variables may cross from the operator into the grader or its containers.
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": str(root / "home"),
        "LANG": "C.UTF-8",
        "TMPDIR": str(root / "tmp"),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
    }


def fenced(control):
    return (
        Path(control["root"]) / "FENCE.json"
    ).exists() or time.time() * 1000 >= control["deadline"]


def process_identity(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return {
            "pid": pid,
            "start": fields[19],
            "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        }
    except FileNotFoundError:
        return None


def owned_group(control):
    identity = control.get("worker")
    if not identity or type(identity.get("pid")) is not int or identity["pid"] <= 1:
        return None
    if (
        process_identity(identity["pid"]) == identity
        and os.getpgid(identity["pid"]) == identity["pid"]
    ):
        return identity["pid"]
    # A dead group leader does not make surviving guards somebody else's group.
    # Require a still-live registered identity; never signal a reused naked PID.
    for path in (Path(control["root"]) / "operations").glob("*.json"):
        record = json.loads(path.read_text())
        current = process_identity(record.get("pid"))
        if (
            current
            and current == record.get("identity")
            and os.getpgid(current["pid"]) == identity["pid"]
        ):
            return identity["pid"]
    return None


def register(control, argv):
    root = Path(control["root"])
    with (root / "admission.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if fenced(control):
            raise GraderError("cancelled", "Docker admission is fenced or expired")
        path = root / "operations" / (uuid.uuid4().hex + ".json")
        write(
            path,
            {
                "pid": os.getpid(),
                "identity": process_identity(os.getpid()),
                "argv": argv,
                "phase": "running",
                "started": time.time(),
            },
        )
    return path


def docker_arguments(control, argv):
    """All created containers, including trusted build preparation, are owned."""
    if not argv:
        raise GraderError("infrastructure", "Missing Docker command")
    value = control["config"]
    tag = (
        "programbench/"
        + value["instance"].replace("__", "_1776_")
        + ":task_cleanroom_v6"
    )
    argv = [value["image"] if part == tag else part for part in argv]
    if argv[0] in {"run", "create"}:
        # The frozen scorer already sets some isolation options. Docker rejects
        # duplicate network flags, even when both say none. Normalize only the
        # option prefix; never rewrite arguments belonging to the container's command.
        required = {
            "--pull": "never",
            "--network": "none",
            "--net": "none",
            "--pids-limit": "512",
            "--memory": "8g",
        }
        repeated = {"--cap-drop": "ALL", "--security-opt": "no-new-privileges"}
        flags = {
            "--init",
            "--rm",
            "--read-only",
            "--detach",
            "-d",
            "--interactive",
            "-i",
            "--tty",
            "-t",
            "-it",
            "-dit",
        }
        prefix = []
        index = 1
        while index < len(argv) and argv[index].startswith("-"):
            item = argv[index]
            if item == "--":
                index += 1
                break
            if item in flags:
                prefix.append(item)
                index += 1
                continue
            option, equal, argument = item.partition("=")
            length = 1 if equal else 2
            if not equal:
                if index + 1 >= len(argv):
                    raise GraderError("infrastructure", "Missing Docker option value")
                argument = argv[index + 1]
            if option in required:
                if argument != required[option]:
                    raise GraderError(
                        "infrastructure",
                        "Conflicting Docker isolation option: " + option,
                    )
            elif repeated.get(option) != argument:
                prefix.extend(argv[index : index + length])
            index += length
        if index >= len(argv):
            raise GraderError("infrastructure", "Missing Docker image")
        argv = [
            argv[0],
            "--pull",
            "never",
            "--label",
            LABEL + "=" + control["token"],
            "--network",
            "none",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "512",
            "--memory",
            "8g",
            *prefix,
            # The legacy scorer mounts wheels for builds but assumes networking
            # in test containers. Keep both phases offline with the same frozen
            # supply; a distinct target avoids duplicate legacy bind mounts.
            "--mount",
            "type=bind,source="
            + value["wheelhouse"]["path"]
            + ",target=/opt/rsi-grader-wheels,readonly",
            "--env",
            "PIP_NO_INDEX=1",
            "--env",
            "PIP_FIND_LINKS=/opt/rsi-grader-wheels",
            "--env",
            "PIP_DISABLE_PIP_VERSION_CHECK=1",
            *argv[index:],
        ]
    return argv


def guarded_command(control, argv, stdout=None, max_bytes=None):
    """Creation must reach a known terminal response before fencing can ACK.

    A timed-out create/start/commit leaves an uncertain daemon operation. Its
    receipt makes cleanup fail closed, even when a subsequent sweep looks empty.
    Non-mutating long execs can be killed immediately on cancellation.
    """
    if fenced(control):
        raise GraderError("cancelled", "Docker command cannot start after fence")
    creating = argv[0] in {"create", "start", "commit"}
    cutoff = time.monotonic() + (120 if creating else 900)
    process = subprocess.Popen(
        [control["config"]["docker"]["path"], *argv],
        stdout=stdout,
        env=environment(Path(control["root"])),
    )
    while process.poll() is None:
        expired = time.monotonic() >= cutoff
        oversized = max_bytes is not None and stdout.tell() > max_bytes
        if expired or oversized or (fenced(control) and not creating):
            process.kill()
            process.wait()
            if creating:
                raise GraderError(
                    "uncertain_docker_operation",
                    "Docker mutation did not acknowledge completion",
                )
            raise GraderError(
                "cancelled" if fenced(control) else "infrastructure",
                "Docker operation interrupted or artifact bound exceeded",
            )
        time.sleep(0.05)
    return process.returncode


def export_regular(stream, destination):
    """Read, never extract, the one file exported by docker cp.

    In particular a candidate-controlled symlink cannot become a host path that
    EvaluationResult parsing subsequently follows.
    """
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        member = archive.next()
        if member is None or not member.isfile() or not 0 <= member.size <= MAX_EXPORT:
            raise GraderError(
                "invalid_evaluation", "Docker export is not one bounded regular file"
            )
        descriptor = os.open(destination, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW)
        with (
            os.fdopen(descriptor, "wb") as target,
            archive.extractfile(member) as source,
        ):
            remaining = member.size
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise GraderError("invalid_evaluation", "Truncated Docker export")
                target.write(chunk)
                remaining -= len(chunk)
        if archive.next() is not None:
            raise GraderError("invalid_evaluation", "Multiple files in Docker export")


def docker_guard(path, original):
    control = json.loads(path.read_text())
    receipt = register(control, original)
    record = json.loads(receipt.read_text())
    try:
        argv = docker_arguments(control, original)
        if original[0] == "run":
            # ContainerEnvironment only uses detached run. Split creation from
            # start so a late create response cannot start work past the fence.
            if original[1] != "-d":
                raise GraderError(
                    "infrastructure", "Only qualified detached Docker run is admitted"
                )
            argv.remove("-d")
            argv[0] = "create"
            temporary = (
                Path(control["root"]) / "operations" / (receipt.stem + ".stdout")
            )
            with temporary.open("wb") as output:
                rc = guarded_command(control, argv, stdout=output)
            identity = temporary.read_text().strip()
            if rc or not re.fullmatch(r"[0-9a-f]{12,64}", identity):
                raise GraderError(
                    "infrastructure",
                    "Docker create did not return a container identity",
                )
            if fenced(control):
                raise GraderError(
                    "cancelled", "Container was created but not started after fence"
                )
            with open(os.devnull, "wb") as output:
                rc = guarded_command(control, ["start", identity], stdout=output)
            if rc == 0:
                print(identity)
        elif original[0] == "cp" and len(original) == 3 and ":" in original[1]:
            temporary = Path(control["root"]) / "operations" / (receipt.stem + ".tar")
            with temporary.open("wb") as output:
                rc = guarded_command(
                    control,
                    ["cp", original[1], "-"],
                    stdout=output,
                    max_bytes=MAX_EXPORT + 1024 * 1024,
                )
            if temporary.stat().st_size > MAX_EXPORT + 1024 * 1024:
                raise GraderError(
                    "invalid_evaluation",
                    "Docker export exceeds individual artifact bound",
                )
            if rc == 0:
                with temporary.open("rb") as source:
                    export_regular(source, Path(original[2]))
            temporary.unlink(missing_ok=True)
        else:
            rc = guarded_command(control, argv)
        write(
            receipt,
            {**record, "phase": "finished", "returncode": rc, "finished": time.time()},
        )
        return rc
    except BaseException as error:
        classification = (
            error.classification if isinstance(error, GraderError) else "infrastructure"
        )
        write(
            receipt,
            {
                **record,
                "phase": "uncertain"
                if not isinstance(error, GraderError)
                or classification == "uncertain_docker_operation"
                else "failed",
                "failure": classification,
                "message": str(error),
                "finished": time.time(),
            },
        )
        raise


def validate_workspace(path):
    if path.resolve(strict=True) != path or not path.is_dir():
        raise GraderError(
            "submission", "Candidate workspace must be canonical and already fenced"
        )
    for name in ["compile.sh", "validate.sh"]:
        target = path / name
        if target.is_symlink() or not target.is_file():
            raise GraderError("submission", "A regular " + name + " is required")
    count, size = 0, 0
    for directory, dirs, files in os.walk(path, followlinks=False):
        for name in dirs + files:
            info = (Path(directory) / name).lstat()
            count += 1
            if stat.S_ISREG(info.st_mode):
                size += info.st_size
            elif not (stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                raise GraderError(
                    "submission", "Candidate contains a special filesystem entry"
                )
            if count > 100_000 or size > 2 * 1024**3:
                raise GraderError(
                    "submission",
                    "Candidate exceeds individual archive infrastructure bound",
                )


def terminal_failure(result, acknowledgements, instance=None):
    """Only acknowledged candidate-owned commands can be terminal negatives.

    A Docker/host interruption does not produce the post-command receipt. This
    is the declared normal-use scorer boundary, not hostile-image certification.
    """
    stage = {
        "compile_failed": "compile",
        "copy_executable_failed": "copy_executable",
        "hash_executable_failed": "hash_executable",
    }.get(result.error_code)
    receipt = (acknowledgements or {}).get(stage)
    if (
        not stage
        or not receipt
        or receipt.get("acknowledged") is not True
        or type(receipt.get("exitCode")) is not int
        or not 1 <= receipt["exitCode"] <= 127
        or any(
            (instance or {}).get("branches", {}).get(branch, {}).get("tests") != []
            or any(error.error_code != "no_expected_test_list" for error in errors)
            for branch, errors in result.test_branch_errors.items()
        )
        or result.warnings
        or result.n_system_errors
        or not result.test_results
        or any(
            test.status != "not_run"
            or test.extra.get("error_code") != result.error_code
            for test in result
        )
    ):
        return None
    return {
        "kind": "candidate_build",
        "officialError": result.error_code,
        "stage": stage,
        "exitCode": receipt["exitCode"],
        "executedTests": 0,
    }


def official_result(path, instance, acknowledgements=None):
    """Canonical active/ignored scope, with completeness independent of score."""
    from programbench.eval.eval import EvaluationResult
    from programbench.eval.eval_batch import get_branches_to_eval
    from programbench.utils.load_data import get_active_branches, get_ignored_tests

    result = EvaluationResult.model_validate_json(path.read_text())
    branches = get_active_branches(instance)
    ignored = get_ignored_tests(instance)
    missing = get_branches_to_eval(
        eval_json=path,
        all_test_branches=branches,
        tests_by_branch={
            branch: instance["branches"][branch]["tests"] for branch in branches
        },
        ignored_tests=ignored,
    )
    result = result.for_branches(branches).without_ignored(ignored)
    expected = {
        f"{branch}/{name}"
        for branch in branches
        for name in instance["branches"][branch]["tests"]
        if f"{branch}/{name}" not in ignored
    }
    observed = [test.full_name for test in result]
    valid = bool(expected) and not (
        missing
        or result.error_code
        or result.test_branch_errors
        or result.n_system_errors
        or result.warnings
    )
    if terminal_failure(result, acknowledgements, instance):
        # The official evaluator declares every case not_run after a failed
        # build. These are denominator entries, never invented executed tests.
        valid = bool(expected)
    valid = valid and len(observed) == len(set(observed)) and set(observed) == expected
    return result, bool(valid)


def worker(path):
    # Bounds apply only to individual host grader operations, not task/model
    # allocation totals. Candidate output must not exhaust host RAM or disk.
    resource.setrlimit(resource.RLIMIT_AS, (4 * 1024**3, 4 * 1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    control = json.loads(path.read_text())
    root = Path(control["root"])
    value = control["config"]
    runner = Path(value["runner"]["path"])
    # The frozen interpreter and runner are operator-owned supplies, never H.
    sys.path[:0] = [str(runner), str(runner / "src")]
    os.environ.update(
        PROGRAMBENCH_DOCKER_EXECUTABLE=str(root / "docker-guard"),
        PROGRAMBENCH_CONTAINER_PREFIX="rsi-grade-" + control["token"],
        PROGRAMBENCH_SAFE_REPORTING="1",
        PROGRAMBENCH_EVAL_WHEELHOUSE=value["wheelhouse"]["path"],
        HF_HUB_OFFLINE="1",
        HF_DATASETS_OFFLINE="1",
        PROGRAMBENCH_DOCKER_CPUS=str(value["cpus"]),
    )
    from programbench.candidate import CandidateError, package_workspace
    from programbench.eval.eval import Evaluator
    from programbench.utils.load_data import (
        get_active_branches,
        get_ignored_branches,
        get_ignored_tests,
        _load_single_instance,
    )

    stage = "package"
    try:
        workspace = Path(control["workspace"])
        validate_workspace(workspace)
        archive = package_workspace(workspace, root / "submission", value["instance"])
        subject = sha(archive)
        archive.chmod(0o400)
        write(root / "SUBJECT.json", {"archive": str(archive), "sha256": subject})
        stage = "official_evaluation"
        # Only the trusted grader reads benchmark metadata; none is exposed to H.
        instance = _load_single_instance(
            runner / "src/programbench/data/tasks" / value["instance"],
            include_tests=True,
        )
        branches = get_active_branches(instance)
        acknowledgements = {}

        class AcknowledgedEvaluator(Evaluator):
            def _run_step(self, command, **options):
                name = options["step_name"]
                if name not in {"compile", "copy_executable", "hash_executable"}:
                    return super()._run_step(command, **options)
                marker = "__rsi_command_" + uuid.uuid4().hex + "__="
                wrapped = (
                    "set +e; ( " + command + "\n); status=$?; printf '\\n"
                    + marker + "%s\\n' \"$status\"; exit \"$status\""
                )
                try:
                    return super()._run_step(wrapped, **options)
                finally:
                    entry = options["log_buf"][-1] if options["log_buf"] else {}
                    codes = re.findall(
                        r"(?m)^" + re.escape(marker) + r"([0-9]+)$",
                        entry.get("output", ""),
                    )
                    acknowledged = (
                        entry.get("step") == name
                        and not entry.get("exception_info")
                        and len(codes) == 1
                        and int(codes[0]) == entry.get("returncode")
                    )
                    acknowledgements[name] = {
                        "acknowledged": acknowledged,
                        "exitCode": entry.get("returncode"),
                        "commandHash": hashlib.sha256(command.encode()).hexdigest(),
                    }
                    write(root / "COMMANDS.json", acknowledgements)

        result = AcknowledgedEvaluator(
            image_name=instance["image_name"],
            solution_branch="submission",
            submission_archive=archive,
            blob_dir=Path(value["blobs"]["path"]),
            tests_branches=branches,
            remove_hashes=instance.get("eval_clean_hashes", []),
            image_tag="task_cleanroom_v6",
            tests_by_branch={
                branch: instance["branches"][branch]["tests"] for branch in branches
            },
            ignored_tests=get_ignored_tests(instance),
            ignored_branches=get_ignored_branches(instance),
            instance_id=value["instance"],
            docker_cpus=value["cpus"],
            branch_workers=1,
            branch_retries=0,
        ).run()
        evaluation = root / "OFFICIAL.eval.json"
        evaluation.write_text(result.model_dump_json(indent=2))
        evaluated, valid = official_result(evaluation, instance, acknowledgements)
        terminal = terminal_failure(evaluated, acknowledgements, instance)
        faults = [
            record
            for path in (root / "operations").glob("*.json")
            if (record := json.loads(path.read_text()))["phase"] in {"failed", "uncertain"}
        ]
        if faults:
            valid = False
        if sha(archive) != subject:
            raise GraderError(
                "submission_changed", "Sealed submission changed during grading"
            )
        write(
            root / "worker-result.json",
            {
                "passed": evaluated.n_resolved if valid else None,
                "total": len(evaluated) if valid else None,
                "valid": valid,
                "failure": "candidate_build" if valid and terminal else None if valid else "invalid_evaluation",
                "terminalFailure": terminal if valid else None,
                "officialError": evaluated.error_code,
                "executedTests": sum(test.status != "not_run" for test in evaluated),
                "subjectHash": subject,
                "executableHash": evaluated.executable_hash,
                "stage": "complete",
            },
        )
    except BaseException as error:
        failure = (
            error.classification
            if isinstance(error, GraderError)
            else "candidate_build"
            if isinstance(error, CandidateError)
            else "infrastructure"
        )
        write(
            root / "worker-result.json",
            {
                "passed": None,
                "total": None,
                "valid": False,
                "failure": failure,
                "stage": stage,
                "message": str(error)[:2000],
            },
        )
        raise


def signal_group(pid, signum):
    try:
        os.killpg(pid, signum)
    except ProcessLookupError:
        pass


def cleanup(control, process, reason, receipt="FENCE.json"):
    with (Path(control["root"]) / "fence.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return cleanup_owned(control, process, reason, receipt)


def cleanup_owned(control, process, reason, receipt):
    """Close admission, settle admitted mutations, kill group, sweep and ACK."""
    root = Path(control["root"])
    with (root / "admission.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if receipt == "FENCE.json" or not (root / "FENCE.json").exists():
            write(
                root / "FENCE.json",
                {
                    "acknowledged": False,
                    "reason": reason,
                    "time": time.time(),
                    "token": control["token"],
                },
            )
    if process is None:
        identity = control.get("worker")
        if identity and process_identity(identity["pid"]) == identity:
            try:
                os.kill(identity["pid"], signal.SIGSTOP)
            except ProcessLookupError:
                pass
    if process is not None and process.poll() is None:
        # Stop only the orchestration process. Registered Docker guards continue
        # long enough to report a definite create/start/commit response.
        try:
            os.kill(process.pid, signal.SIGSTOP)
        except ProcessLookupError:
            pass
    docker = control["config"]["docker"]["path"]
    errors = []
    removed = set()

    def command(args):
        result = subprocess.run(
            [docker, *args],
            capture_output=True,
            text=True,
            timeout=30,
            env=environment(root),
        )
        if result.returncode:
            raise GraderError(
                "cleanup", "Docker fence failed: " + result.stderr[-1000:]
            )
        return result.stdout.strip()

    def sweep():
        identities = command(
            ["ps", "-aq", "--filter", "label=" + LABEL + "=" + control["token"]]
        ).split()
        if any(
            not re.fullmatch(r"[0-9a-f]{12,64}", identity) for identity in identities
        ):
            raise GraderError(
                "cleanup", "Unexpected container identity in fence response"
            )
        if identities:
            command(["rm", "-f", *identities])
            removed.update(identities)

    # Do not let an in-flight daemon mutation postpone fencing running code.
    # Repeat the sweep while creation/start responses settle, then verify again
    # after the process group is gone. An uncertain mutation can never ACK.
    end = time.monotonic() + 125
    try:
        while time.monotonic() < end:
            sweep()
            records = [
                json.loads(path.read_text())
                for path in (root / "operations").glob("*.json")
            ]
            running = [record for record in records if record["phase"] == "running"]
            if not running or not any(
                record.get("identity")
                and process_identity(record["pid"]) == record["identity"]
                for record in running
            ):
                break
            time.sleep(0.1)
    except BaseException as error:
        errors.append(str(error))
    finally:
        group = process.pid if process is not None else owned_group(control)
        if group is not None:
            signal_group(group, signal.SIGKILL)
        if process is not None:
            process.wait(timeout=10)
    records = [
        json.loads(path.read_text()) for path in (root / "operations").glob("*.json")
    ]
    if any(record["phase"] in {"running", "uncertain"} for record in records):
        errors.append("Docker operation has no terminal acknowledgement")
    try:
        sweep()
        if command(
            ["ps", "-aq", "--filter", "label=" + LABEL + "=" + control["token"]]
        ):
            errors.append("Owned containers remain")
        # Shared prepared-base caches are retained. Only this run's candidate
        # image commit names are eligible for cleanup.
        images = {
            record["argv"][-1]
            for record in records
            if record["argv"][0] == "commit"
            and record["argv"][-1].startswith("programbench-compiled/")
        }
        for name in sorted(images):
            inspect = subprocess.run(
                [docker, "image", "inspect", name],
                capture_output=True,
                timeout=30,
                env=environment(root),
            )
            if inspect.returncode == 0:
                command(["rmi", "-f", name])
    except BaseException as error:
        errors.append(str(error))
    value = {
        "acknowledged": not errors,
        "reason": reason,
        "time": time.time(),
        "token": control["token"],
        "removed": sorted(removed),
        "errors": errors,
        "workerGroup": process.pid
        if process is not None
        else (control.get("worker") or {}).get("pid"),
    }
    write(root / receipt, value)
    return value


def recover_grade(root):
    """Explicit cleanup only: no configuration imports, evaluator or allocation.

    Host-owned, canonical grade metadata selects one exact label. Historical
    score/FENCE receipts are retained. Unacknowledged mutations stay unknown.
    """
    if root.resolve(strict=True) != root or not root.is_dir():
        raise GraderError("cleanup", "Canonical existing grade directory required")
    info = root.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise GraderError("cleanup", "Grade metadata directory is not owner-controlled")
    path = root / "control.json"
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or info.st_uid != os.getuid()
        or info.st_size > 1024 * 1024
    ):
        raise GraderError(
            "cleanup", "Grade control must be one bounded host-owned regular file"
        )
    control = json.loads(path.read_text())
    if control.get("root") != str(root) or not re.fullmatch(
        r"[a-f0-9]{32}", control.get("token", "")
    ):
        raise GraderError("cleanup", "Grade control has a foreign directory or label")
    reference(control["config"]["docker"])
    (root / "CANCEL").write_text("explicit grading recovery; no allocation replay\n")
    return cleanup(
        control, None, "explicit recovery; no allocation replay", "RECOVERY_FENCE.json"
    )


def owner_alive(owner):
    return type(owner) is int and owner > 1 and os.getppid() == owner


def require_owner(owner):
    if not owner_alive(owner):
        raise GraderError("cancelled", "Original grader owner exited or changed")


def supervise(value, workspace, root, deadline, config_hash, owner):
    require_owner(owner)
    if time.time() * 1000 >= deadline:
        raise GraderError(
            "deadline", "Original deadline elapsed before worker admission"
        )
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name in ["home", "tmp", "operations"]:
        (root / name).mkdir(mode=0o700)
    control = {
        "config": value,
        "root": str(root),
        "workspace": str(workspace),
        "deadline": deadline,
        "token": uuid.uuid4().hex,
        "owner": owner,
    }
    write(root / "control.json", control)
    script = str(Path(__file__).resolve())
    (root / "docker-guard").write_text(
        "#!/bin/sh\nexec "
        + " ".join(
            shlex.quote(part)
            for part in [
                str(Path(sys.executable).resolve()),
                "-I",
                "-B",
                "-S",
                script,
                "--docker",
                str(root / "control.json"),
            ]
        )
        + ' "$@"\n'
    )
    (root / "docker-guard").chmod(0o500)
    stopped = []
    old_handlers = {}
    for signum in [signal.SIGTERM, signal.SIGINT]:
        old_handlers[signum] = signal.signal(
            signum, lambda signum, _frame: stopped.append(signum)
        )
    reason = "complete"
    report = {
        "passed": None,
        "total": None,
        "valid": False,
        "failure": "infrastructure",
    }
    try:
        with (root / "grader.log").open("wb") as log:
            require_owner(owner)
            if time.time() * 1000 >= deadline:
                raise GraderError(
                    "deadline", "Original deadline elapsed before worker admission"
                )
            process = subprocess.Popen(
                [
                    value["python"]["path"],
                    "-I",
                    "-B",
                    script,
                    "--worker",
                    str(root / "control.json"),
                ],
                cwd=root,
                env=environment(root),
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            control["worker"] = process_identity(process.pid) or {"pid": process.pid}
            write(root / "control.json", control)
            try:
                while process.poll() is None:
                    if stopped or (root / "CANCEL").exists() or not owner_alive(owner):
                        reason = "cancelled"
                        break
                    if time.time() * 1000 >= deadline:
                        reason = "deadline"
                        break
                    time.sleep(0.05)
                if reason == "complete" and time.time() * 1000 >= deadline:
                    reason = "deadline"
            finally:
                fence = cleanup(control, process, reason)
            result_path = root / "worker-result.json"
            if result_path.is_file():
                report = json.loads(result_path.read_text())
            if reason != "complete":
                report.update(valid=False, failure=reason)
            if not fence["acknowledged"]:
                report.update(valid=False, failure="cleanup_unacknowledged")
            if process.returncode != 0 and report["valid"]:
                report.update(valid=False, failure="worker_exit")
        report.update(
            version=1,
            instance=value["instance"],
            deadline=deadline,
            configHash=config_hash,
            scoringTrust="official-programbench-normal-use",
            hostileCandidateQualified=False,
            cleanupAcknowledged=fence["acknowledged"],
            label=LABEL + "=" + control["token"],
            artifacts={
                path.name: {"path": str(path), "sha256": sha(path)}
                for path in [
                    root / "SUBJECT.json",
                    root / "PREFLIGHT.json",
                    root / "OFFICIAL.eval.json",
                    root / "grader.log",
                    root / "FENCE.json",
                ]
                if path.is_file()
            },
        )
        write(root / "RESULT.json", report)
        return report
    finally:
        for signum, handler in old_handlers.items():
            signal.signal(signum, handler)


def main(entry_owner):
    if len(sys.argv) == 3 and sys.argv[1] == "--fence":
        result = recover_grade(Path(sys.argv[2]))
        print(json.dumps(result, sort_keys=True))
        return 0 if result["acknowledged"] else 1
    if len(sys.argv) >= 3 and sys.argv[1] == "--docker":
        return docker_guard(Path(sys.argv[2]), sys.argv[3:])
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        worker(Path(sys.argv[2]))
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--deadline", type=int, required=True)
    parser.add_argument("--owner", type=int, default=entry_owner)
    args = parser.parse_args()
    require_owner(args.owner)
    if args.deadline <= time.time() * 1000:
        raise GraderError("deadline", "Original task deadline already elapsed")
    if (
        args.output.resolve() != args.output
        or args.workspace.resolve(strict=True) != args.workspace
    ):
        raise GraderError("configuration", "Use canonical absolute run paths")
    if args.output.is_relative_to(args.workspace) or args.workspace.is_relative_to(
        args.output
    ):
        raise GraderError(
            "configuration", "Grader output and candidate workspace must be disjoint"
        )
    value = config(args.config)
    require_owner(args.owner)
    report = supervise(
        value, args.workspace, args.output, args.deadline, sha(args.config), args.owner
    )
    print(json.dumps(report, sort_keys=True))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    # Capture before argument parsing or any supply hashing; never adopt PID 1.
    entry_owner = os.getppid()
    try:
        sys.exit(main(entry_owner))
    except Exception as error:
        if "--worker" in sys.argv or "--docker" in sys.argv:
            raise
        print(
            json.dumps(
                {
                    "passed": None,
                    "total": None,
                    "valid": False,
                    "failure": error.classification
                    if isinstance(error, GraderError)
                    else "infrastructure",
                    "message": str(error)[:2000],
                    "cleanupAcknowledged": False,
                }
            )
        )
        sys.exit(1)
