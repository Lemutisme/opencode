"""Host-owned Terminal-Bench 4 bridge; candidate H never imports this module.

Harbor owns the original task environment, artifact collection and separate
verifier. Only terminal commands cross the public socket. Settlement is a
host-only file signal after the native worker has been fenced. No official
reward, tests or reference solution are available through the tool socket.
"""
import argparse
import ctypes
import asyncio
import hashlib
import json
import os
from pathlib import Path
import signal
import tempfile
import shutil
import socket
import struct
import shlex
import sys
import time
import traceback


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def checked(reference):
    path = Path(reference["path"])
    if not path.is_absolute() or not path.is_file():
        raise ValueError("trusted input must be an absolute regular file")
    with path.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != reference["sha256"]:
            raise ValueError("trusted input changed: " + str(path))
    return path


def binding(root):
    """Hash private inputs without parsing tests or making them solver-visible."""
    import tomllib
    root = Path(root).resolve()
    config = tomllib.loads((root / "task.toml").read_text())
    if config.get("verifier", {}).get("environment_mode") != "separate" or not config.get("artifacts"):
        raise ValueError("official separate verifier and artifact plan required")
    environment = config.get("environment", {})
    verifier = config.get("verifier", {}).get("environment", {})
    if environment.get("gpus", 0) or verifier.get("gpus", 0):
        raise ValueError("initial Terminal-Bench profile is CPU-only")
    if config.get("steps") or environment.get("mcp_servers") or environment.get("skills_dir"):
        raise ValueError("initial profile does not silently drop multi-step, MCP or skills interfaces")
    # This profile deliberately keeps a single official container alive instead
    # of pretending an artifact archive captures services and installation state.
    if (root / "environment/docker-compose.yaml").exists():
        raise ValueError("initial profile requires one official task container")
    if any(not isinstance(item, str) for item in config["artifacts"]):
        raise ValueError("initial profile requires main-container artifact entries")
    files = [root / "instruction.md", root / "task.toml"]
    for name in ("environment", "tests"):
        files.extend(item for item in (root / name).rglob("*") if item.is_file() or item.is_symlink())
    identities = {}
    for item in sorted(files):
        if item.is_symlink():
            raise ValueError("unfrozen symbolic task input")
        with item.open("rb") as stream:
            identities[item.relative_to(root).as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"files": identities, "artifacts": config["artifacts"], "config": config}


def identity(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rpartition(") ")[2].split()
    return {"pid": pid, "ticks": fields[19]}


def owner_live(owner):
    try:
        fields = Path(f"/proc/{owner['pid']}/stat").read_text().rpartition(") ")[2].split()
        return fields[0] != "Z" and fields[19] == owner["ticks"]
    except (FileNotFoundError, ProcessLookupError):
        return False


def tool_arguments(value):
    if not isinstance(value, dict) or set(value) - {"command", "timeout_ms", "cwd"}:
        raise ValueError("invalid terminal arguments")
    if not isinstance(value.get("command"), str) or not value["command"].strip() or len(value["command"].encode()) > 262144:
        raise ValueError("one bounded nonempty command required")
    timeout = value.get("timeout_ms", 60000)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 600000:
        raise ValueError("individual command timeout must be between 1 and 600000 ms")
    if "cwd" in value and (not isinstance(value["cwd"], str) or not value["cwd"].startswith("/") or "\0" in value["cwd"]):
        raise ValueError("cwd must be an absolute task-container path")
    return value["command"], timeout, value.get("cwd")


TOOL = {
    "name": "terminal",
    "description": "Run a shell command inside the original Terminal-Bench task environment with its original user. Files, installed dependencies and services persist across calls. The native agent's own /candidate is not this task environment. There is no official verifier access.",
    "inputSchema": {"type": "object", "properties": {
        "command": {"type": "string"}, "cwd": {"type": "string"},
        "timeout_ms": {"type": "integer", "minimum": 1, "maximum": 600000, "default": 60000},
    }, "required": ["command"], "additionalProperties": False},
}


async def serve(args):
    config = json.loads(Path(args.config).read_text())
    if config.get("harbor"):
        sys.path.insert(0, config["harbor"])
    from aiohttp import web
    from harbor.agents.base import BaseAgent
    from harbor.models.task.task import Task
    from harbor.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig, TrialConfig, VerifierConfig
    from harbor.trial.trial import Trial
    root = Path(args.run).resolve()
    root.mkdir(parents=True, exist_ok=False)
    (root / "control").mkdir(mode=0o700)
    channel = Path(tempfile.mkdtemp(prefix="rsi-terminal-"))
    save(root / "CHANNEL.json", {"socket": str(channel / "tools.sock")})
    owner = identity(args.owner)
    if os.getppid() != args.owner:
        raise RuntimeError("terminal host owner already exited")
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "cannot bind terminal bridge lifetime")
    if os.getppid() != args.owner:
        raise RuntimeError("terminal host owner exited during admission")
    if config.get("compose"):
        compose = checked(config["compose"])
        docker_config = root / "control/docker"
        docker_config.mkdir(mode=0o700)
        save(docker_config / "config.json", {"cliPluginsExtraDirs": [str(compose.parent)]})
        os.environ["DOCKER_CONFIG"] = str(docker_config)
    save(root / "INPUT.json", config)
    shutil.copyfile(__file__, root / "ADAPTER.py")
    os.chmod(root / "ADAPTER.py", 0o400)
    for reference in config["authority"]:
        checked(reference)
    expected = json.loads(checked(config["binding"]).read_text())
    task_path = Path(config["task"]).resolve()
    if binding(task_path) != expected:
        raise ValueError("official task inputs changed after freeze")
    os.environ["FAIR_TRIAL_ROOT"] = str(root)
    os.environ["OPENAI_BASE_URL"] = config["providerBase"]
    for key in list(os.environ):
        if any(word in key.upper() for word in ("API_KEY", "TOKEN", "SECRET", "PASSWORD")):
            del os.environ[key]
    sys.path.insert(0, config["guardDirectory"])
    from network_guard import policy, stop_project
    from guarded_environment import GuardedDockerEnvironment
    if not config.get("qualification", False) and set(config.get("images", {})) != {"agent", "verifier"}:
        raise ValueError("live Terminal-Bench requires frozen agent and verifier image IDs")
    save(root / "credential-hashes.json", {})
    await asyncio.to_thread(policy, root)
    state = {"environment": None, "settling": False, "calls": 0, "uid": None, "gid": None, "requests": {}}
    lock = asyncio.Lock()
    finished = asyncio.Event()
    admitted = asyncio.Event()
    trial = None

    def live(native=False):
        if native and args.native_run and not (Path(args.native_run) / "admission/active").exists():
            raise RuntimeError("native execution admission ended")
        if state["settling"] or time.time() * 1000 >= args.deadline or not owner_live(owner):
            raise RuntimeError("terminal admission ended")

    class TerminalAgent(BaseAgent):
        @staticmethod
        def name():
            return "native-rsi-terminal-bridge"

        def version(self):
            return hashlib.sha256((root / "ADAPTER.py").read_bytes()).hexdigest()

        async def setup(self, environment):
            available = await environment.exec("command -v timeout >/dev/null && command -v bash >/dev/null", timeout_sec=20)
            if available.return_code:
                raise RuntimeError("original task environment must support bounded shell operations")
            observed = await environment.exec("id -u; id -g; pwd", timeout_sec=20)
            fields = observed.stdout.strip().splitlines()
            if observed.return_code or len(fields) != 3 or not all(item.isdecimal() for item in fields[:2]):
                raise RuntimeError("cannot resolve original task user and working directory")
            state.update(environment=environment, uid=int(fields[0]), gid=int(fields[1]))
            save(root / "ENVIRONMENT.json", {"uid": state["uid"], "gid": state["gid"], "workdir": fields[2],
                "defaultUser": environment.default_user, "originalEnvironment": True,
                "taskFilesystemNotExportedAsWorkspace": True})

        async def run(self, instruction, environment, context):
            live()
            save(root / "READY.json", {"deadline": args.deadline, "identity": config["id"],
                "instruction": instruction, "tools": [TOOL], "socket": str(channel / "tools.sock"),
                "environment": json.loads((root / "ENVIRONMENT.json").read_text())})
            admitted.set()
            await finished.wait()

    class TerminalEnvironment(GuardedDockerEnvironment):
        def __init__(self, *values, **kwargs):
            context = Path(kwargs["environment_dir"]).resolve()
            role = "agent" if context == (task_path / "environment").resolve() else "verifier"
            pinned = config.get("images", {}).get(role)
            if pinned:
                # Harbor's own prebuilt-image path preserves the official image
                # bytes and avoids rebuilding mutable registry/apt inputs per arm.
                kwargs["task_env_config"] = kwargs["task_env_config"].model_copy(update={"docker_image": pinned})
            super().__init__(*values, **kwargs)

        async def start(self, force_build):
            await super().start(force_build)
            context = self.environment_dir.resolve()
            if context not in ((task_path / "environment").resolve(), (task_path / "tests").resolve()):
                await self.stop(delete=True)
                raise RuntimeError("unexpected official environment build context")
            role = "agent" if context == (task_path / "environment").resolve() else "verifier"
            main = [item for item in self.guard_receipt["services"] if item["service"] == "main"]
            if len(main) != 1:
                raise RuntimeError("one original main environment required")
            import docker
            image = docker.from_env(timeout=30).images.get(main[0]["image"])
            image.tag("opencode-rsi-tb4", config["id"] + "-" + role + "-" + image.id.split(":")[1][:16])
            observed = root / ("IMAGE-" + role + ".json")
            save(observed, {"image": main[0]["image"], "role": role})
            if config.get("images", {}).get(role, main[0]["image"]) != main[0]["image"]:
                await self.stop(delete=True)
                raise RuntimeError("official environment image identity changed after freeze")

    # Harbor imports the host class by name; this is not candidate code.
    import types
    module = types.ModuleType("rsi_terminal_agent")
    module.TerminalAgent = TerminalAgent
    module.TerminalEnvironment = TerminalEnvironment
    sys.modules[module.__name__] = module

    async def tools(request):
        live()
        return web.json_response({"tools": [TOOL]})

    async def call(request):
        live(True)
        if not admitted.is_set():
            raise web.HTTPServiceUnavailable(text="official task environment not ready")
        value = await request.json()
        if not isinstance(value, dict) or set(value) != {"name", "arguments", "id", "sessionID"} or value["name"] != TOOL["name"]:
            raise web.HTTPBadRequest(text="only the frozen terminal tool is admitted")
        if not all(isinstance(value.get(key), str) and 0 < len(value[key]) <= 256 for key in ("id", "sessionID")):
            raise web.HTTPBadRequest(text="explicit bounded tool-call and Session identities required")
        if args.native_run:
            native = Path(args.native_run)
            if not (native / "admission/active").exists() or (native / "FENCED.json").exists():
                raise web.HTTPForbidden(text="native execution admission ended")
            runtime = json.loads((native / "control/runtime.json").read_text())
            admitted_worker = json.loads((native / "admission/worker.json").read_text())
            peer, _, _ = struct.unpack("3i", request.transport.get_extra_info("socket").getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if peer != runtime["pid"] or identity(peer)["ticks"] != str(runtime["start_ticks"]) or value["sessionID"] != admitted_worker["id"]:
                raise web.HTTPForbidden(text="tool caller is not the admitted native worker")
        try:
            command, timeout, cwd = tool_arguments(value["arguments"])
        except ValueError as error:
            raise web.HTTPBadRequest(text=str(error)) from error
        async with lock:
            live(True)
            prior = state["requests"].get(value["id"])
            if prior:
                if prior["request"] != value or "response" not in prior:
                    raise web.HTTPConflict(text="conflicting or interrupted tool call; no implicit replay")
                return web.json_response(prior["response"])
            state["requests"][value["id"]] = {"request": value}
            sequence = state["calls"]
            state["calls"] += 1
            record = root / "calls" / f"{sequence:08d}.json"
            save(record, {"request": value, "started": time.time(), "deadline": args.deadline, "status": "active"})
            try:
                seconds = min(timeout / 1000, max(.001, args.deadline / 1000 - time.time()))
                result = await state["environment"].exec(
                    "timeout --signal=TERM --kill-after=5s " + str(seconds) + "s bash -lc " + shlex.quote(command),
                    cwd=cwd, timeout_sec=min(seconds + 10, max(.001, args.deadline / 1000 - time.time())))
                observation = {"stdout": result.stdout or "", "stderr": result.stderr or "", "return_code": result.return_code}
                save(record, {"request": value, "completed": time.time(), "deadline": args.deadline,
                    "status": "completed", "observation": observation})
                live(True)
                # Retain complete host logs; bound only the individual tool response.
                response = {"result": {**observation,
                    "stdout": (result.stdout or "")[-1048576:], "stderr": (result.stderr or "")[-1048576:]}}
                state["requests"][value["id"]]["response"] = response
                return web.json_response(response)
            except BaseException as error:
                save(record.with_suffix(".error.json"), {"error": str(error), "type": type(error).__name__})
                raise

    application = web.Application(client_max_size=1048576)
    application.router.add_get("/tools", tools)
    application.router.add_post("/call", call)
    runner = web.AppRunner(application)
    await runner.setup()
    site = web.UnixSite(runner, channel / "tools.sock")
    await site.start()
    os.chmod(channel / "tools.sock", 0o600)
    remaining = max(.001, args.deadline / 1000 - time.time())
    cfg = TrialConfig(task=TaskConfig(path=task_path), trial_name=root.name,
        trials_dir=root / "harbor", agent=AgentConfig(import_path="rsi_terminal_agent:TerminalAgent",
            override_timeout_sec=remaining),
        environment=EnvironmentConfig(import_path="rsi_terminal_agent:TerminalEnvironment",
            delete=True, cpu_enforcement_policy="limit", memory_enforcement_policy="limit"),
        verifier=VerifierConfig(disable=False))
    save(root / "CONFIG.json", cfg.model_dump(mode="json"))
    save(root / "BUDGET.json", {"originalDeadline": args.deadline,
        "cumulativeProviderCalls": None, "cumulativeToolCalls": None,
        "officialAgentSeconds": expected["config"]["agent"]["timeout_sec"],
        "officialVerifierSeconds": expected["config"]["verifier"]["timeout_sec"],
        "profile": "six-hour-allocation-deadline-not-eight-hour-leaderboard"})
    trial = await Trial.create(cfg)
    running = asyncio.create_task(trial.run())

    async def watch():
        while not running.done():
            if time.time() * 1000 >= args.deadline or not owner_live(owner):
                running.cancel()
                return
            if not state["settling"] and (root / "control/REVOKE.json").exists():
                state["settling"] = True
                async with lock:
                    save(root / "REVOKED.json", {"at": time.time(), "calls": state["calls"], "inFlight": 0})
            if not finished.is_set() and (root / "control/SETTLE.json").exists():
                request = json.loads((root / "control/SETTLE.json").read_text())
                fence = Path(request["fence"])
                if not fence.is_absolute() or not fence.is_file():
                    raise RuntimeError("host native fence acknowledgement required before verification")
                # No command is admitted after the atomic phase change; any
                # in-flight command completes under its existing operation bound.
                state["settling"] = True
                async with lock:
                    save(root / "GENERATION-FENCED.json", {"at": time.time(), "nativeFence": str(fence),
                        "calls": state["calls"], "officialRewardExposedToSolver": False})
                    finished.set()
            await asyncio.sleep(.1)

    watcher = asyncio.create_task(watch())

    def watcher_failed(task):
        if task.cancelled() or task.exception() is None:
            return
        save(root / "WATCHER-ERROR.json", {"error": str(task.exception())})
        running.cancel()

    watcher.add_done_callback(watcher_failed)
    this = asyncio.current_task()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, this.cancel)
    result = None
    try:
        raw = (await running).model_dump(mode="json")
        save(root / "HARBOR-RESULT.json", raw)
        if binding(task_path) != expected:
            raise RuntimeError("official evaluator changed while scoring")
        reward = ((raw.get("verifier_result") or {}).get("rewards") or {}).get("reward")
        valid = raw.get("exception_info") is None and reward in (0, 1) and finished.is_set()
        result = {"passed": int(reward == 1), "total": 1, "valid": valid,
            "cleanupAcknowledged": True, "officialArtifactCollection": True, "separateVerifier": True,
            "scoringTrust": "official-harbor-normal-use", "hostileCandidateQualified": False,
            "deadline": args.deadline, "late": time.time() * 1000 >= args.deadline,
            "nativePeerBound": bool(args.native_run)}
        if not valid or time.time() * 1000 >= args.deadline:
            raise RuntimeError("invalid or late official Terminal-Bench result")
    finally:
        state["settling"] = True
        watcher.cancel()
        running.cancel()
        await asyncio.gather(watcher, running, return_exceptions=True)
        await runner.cleanup()
        shutil.rmtree(channel)
        # Trial normally tears these down. This additional exact-project fence
        # handles cancellation before or during its normal finalization.
        for receipt in (root / "network-environments").glob("*/receipt.json"):
            value = json.loads(receipt.read_text())
            await asyncio.to_thread(stop_project, value["project"], receipt.parent, True)
        save(root / "CLEANUP.json", {"acknowledged": True, "at": time.time()})
    if result:
        save(root / "RESULT.json", result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config")
    parser.add_argument("--run")
    parser.add_argument("--deadline", type=int)
    parser.add_argument("--owner", type=int)
    parser.add_argument("--bind-task")
    parser.add_argument("--native-run")
    args = parser.parse_args()
    if args.bind_task:
        print(json.dumps(binding(args.bind_task), indent=2))
        return
    if not all((args.config, args.run, args.deadline, args.owner)):
        parser.error("--config, --run, --deadline and --owner are required")
    try:
        asyncio.run(serve(args))
    except BaseException as error:
        save(Path(args.run) / "ERROR.json", {"type": type(error).__name__, "error": str(error),
            "traceback": traceback.format_exc()})
        raise


if __name__ == "__main__":
    main()
