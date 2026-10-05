"""Host-only integration for optional public readiness and sealed final evidence.

The existing native runtime still owns the model loop and replay. This adapter
never runs a hidden benchmark verifier as model feedback or changes a deadline.
"""
import hashlib
import fcntl
import json
import base64
import secrets
from pathlib import Path
import subprocess
import time
import asyncio

from benchmark_runtime import export_messages, provider_health


BRIDGE = Path(__file__).with_name("benchmark-contract.ts")


def command(operation, value):
    result = subprocess.run(
        ["bun", str(BRIDGE), operation], input=json.dumps(value),
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode:
        raise RuntimeError("Benchmark completion contract rejected: " + result.stderr[-3000:])
    return json.loads(result.stdout)


def bind(native_class):
    class CompletionNative(native_class):
        def __init__(self, *args, public_manifest, manifest_sha256, **kwargs):
            self.public_manifest = Path(public_manifest).resolve()
            self.manifest_sha256 = manifest_sha256
            self.manifest = self.read_manifest()
            super().__init__(*args, **kwargs)

        def read_manifest(self):
            raw = self.public_manifest.read_bytes()
            if hashlib.sha256(raw).hexdigest() != self.manifest_sha256:
                raise RuntimeError("Issuer-owned verification manifest changed")
            return json.loads(raw)

        async def messages(self):
            # Avoid the HTTP page-size ceiling and retain history after daemon
            # loss. This reads a consistent projection; it never edits state.
            databases = list((self.native / "data/opencode").glob("*.db"))
            if len(databases) != 1:
                raise RuntimeError("Cannot identify the retained native message database")
            await asyncio.to_thread(export_messages, databases[0], self.session_id, self.control / "messages.jsonl")
            if (self.control / "requests.db").exists():
                report = await asyncio.to_thread(provider_health, self.control / "requests.db")
                (self.control / "provider-health.json").write_text(json.dumps(report, indent=2) + "\n")
            return []

        def http(self, method, path, body=None, timeout=15, permit_error=False):
            if method == "POST" and path == "/api/contract":
                prepared = command("admission", {
                    "id": body["id"], "scope": body["scope"], "instruction": body["goal"],
                    "executionPolicy": body["executionPolicy"], "location": body["location"],
                    "model": body["model"], "budget": body["budget"], "manifest": self.read_manifest(),
                })
                if prepared["budget"] != body["budget"] or prepared["model"] != body["model"]:
                    raise RuntimeError("Completion bridge changed the frozen execution coordinates")
                body = prepared
                (self.control / "admission.json").write_text(json.dumps(body, indent=2) + "\n")
                (self.control / "completion-manifest.json").write_text(json.dumps({
                    "path": str(self.public_manifest), "sha256": self.manifest_sha256,
                    "final_evaluator_hash": self.manifest["finalEvaluatorHash"],
                    "bridge_sha256": hashlib.sha256(BRIDGE.read_bytes()).hexdigest(),
                    "readiness_is_not_final_acceptance": True,
                }, indent=2) + "\n")
            return super().http(method, path, body, timeout=timeout, permit_error=permit_error)

    return CompletionNative


def settle(http, *, subject, evaluator_hash, artifacts_hash, outcome, report_path, stop_receipt, output):
    """Requires a host single-writer seal and an already disabled solver channel.

The caller supplies a trusted evaluator classification; a reward file alone is
not enough to distinguish an infrastructure fault from an unsuccessful task.
"""
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    stop_receipt = Path(stop_receipt).resolve()
    lock = stop_receipt.with_name("settlement.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    stopped = json.loads(stop_receipt.read_text())
    generated = json.loads(stop_receipt.with_name("generation-result.json").read_text())
    authority = json.loads(stop_receipt.with_name("completion-manifest.json").read_text())
    if subject.get("evaluatorHash") != authority["final_evaluator_hash"]:
        raise RuntimeError("Final evaluator is not bound to the admitted task")
    if (generated.get("contract_id") != subject["contractID"] or generated.get("status") != "verification"
            or generated.get("verification_allowed") is not True or stopped.get("verification_allowed") is not True
            or stopped.get("server_alive") or stopped.get("gateway_alive")):
        raise RuntimeError("The matching native generation was not safely sealed")
    references = [stopped.get("runtime")]
    gateway = stop_receipt.with_name("gateway.json")
    if gateway.exists():
        references.append(json.loads(gateway.read_text()))
    for reference in references:
        if not reference:
            continue
        status = Path(f"/proc/{reference['pid']}/stat")
        if status.exists():
            fields = status.read_text().rpartition(") ")[2].split()
            if fields[19] == str(reference["start_ticks"]) and fields[0] != "Z":
                raise RuntimeError("A sealed generation process is still alive")
    report_hash = hashlib.sha256(Path(report_path).read_bytes()).hexdigest()
    current = http("GET", "/api/contract/" + subject["contractID"])["data"]
    decision = command("verdict", {
        "subject": subject, "current": current, "generationSealed": True,
        "sealHash": hashlib.sha256(stop_receipt.read_bytes()).hexdigest(),
        "evaluatorHash": evaluator_hash, "artifactsHash": artifacts_hash,
        "outcome": outcome, "reportHash": report_hash,
    })
    # Retain evidence before mutation; never expose the sealed report to a model.
    (output / (decision["evidenceHash"] + ".json")).write_text(json.dumps(decision["evidence"], indent=2) + "\n")
    if decision["action"] != "pending":
        http("POST", decision["path"], decision["body"])
    after = http("GET", "/api/contract/" + subject["contractID"])["data"]
    expected = {"passed": "discharged", "failed": "escalated", "unavailable": "verification"}[outcome]
    if after["status"] != expected:
        raise RuntimeError("Final evidence did not produce the expected kernel state")
    receipt = {"at": time.time(), "outcome": outcome, "action": decision["action"],
        "subject": subject, "evidence_hash": decision["evidenceHash"], "before": current["status"],
        "after": after["status"], "model_feedback": "none; sealed final evaluation",
        "complete": after["status"] == "discharged"}
    (output / "settlement.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def settle_offline(native, *, runtime_dir, image, subject, evaluator_hash, artifacts_hash, outcome, report_path, output):
    """Adjudicate persisted state after Harbor has destroyed the solver environment.

    This isolated administrative process has no task mount, provider channel or
    real model credential. It cannot reopen inference to consume held-out data.
    """
    runtime_dir = Path(runtime_dir).resolve()
    setup = json.loads((native.control / "setup.json").read_text())
    if hashlib.sha256((runtime_dir / "opencode").read_bytes()).hexdigest() != setup["binary_sha256"]:
        raise RuntimeError("Administrative runtime differs from the executed runtime")
    stopped = json.loads((native.control / "stopped.json").read_text())
    if stopped.get("verification_allowed") is not True or stopped.get("server_alive") or stopped.get("gateway_alive"):
        raise RuntimeError("Cannot start adjudication before generation is sealed")
    if not image.startswith("sha256:") or len(image) != 71:
        raise RuntimeError("Administrative image must be pinned by digest")
    storage = (native.native / "data" / "opencode").resolve()
    if not storage.is_relative_to(native.native.resolve()):
        raise RuntimeError("Native state escaped its retained root")
    owner = storage.stat()
    # Harbor chowns writable mounts to the host user during teardown. The
    # adjudicator follows retained-state ownership, never broadens file modes or
    # regains DAC override to impersonate the earlier solver UID.
    user = f"{owner.st_uid}:{owner.st_gid}"
    cid = subprocess.run([
        "docker", "run", "-d", "--user", user, "--network", "none", "--init",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--cpus", "1", "--memory", "2g", "--pids-limit", "256", "--workdir", "/workspace",
        "--label", "procontract.role=completion-adjudicator", "--label", "procontract.run=" + native.root.name,
        "-v", str(runtime_dir) + ":/opt/procontract:ro", "-v", str(native.native) + ":/procontract-state",
        "--entrypoint", "tail", image, "-f", "/dev/null",
    ], capture_output=True, text=True, check=True, timeout=30).stdout.strip()
    password = secrets.token_urlsafe(32)
    env = {"HOME": "/procontract-state", "XDG_CONFIG_HOME": "/procontract-state/config",
        "XDG_DATA_HOME": "/procontract-state/data", "XDG_CACHE_HOME": "/procontract-state/cache",
        "XDG_STATE_HOME": "/procontract-state/state", "TMPDIR": "/procontract-state/tmp",
        "OPENCODE_DISABLE_MODELS_FETCH": "true", "OPENCODE_SERVER_PASSWORD": password,
        "OPENCODE_CONFIG_CONTENT": json.dumps({"username": "completion-adjudicator"}),
        "OPENAI_API_KEY": "offline-adjudicator-no-provider", "OPENAI_BASE_URL": "http://provider.invalid/v1",
        "OPENCODE_PROVIDER_SOCKET": "/provider-channel/absent.sock"}
    log = "/procontract-state/adjudicator-" + secrets.token_hex(8) + ".log"
    launch = "import json,os,subprocess,sys; e=dict(os.environ); e.update(json.load(sys.stdin)); f=open(" + repr(log) + ",'ab'); p=subprocess.Popen(['/opt/procontract/opencode','serve','--hostname','127.0.0.1','--port','4096'],cwd='/workspace',env=e,stdout=f,stderr=f,start_new_session=True); print(p.pid)"
    transport = "import http.client,json,sys; x=json.load(sys.stdin); c=http.client.HTTPConnection('127.0.0.1',4096,timeout=5); c.request(x['method'],x['path'],body=x['body'],headers=x['headers']); r=c.getresponse(); b=r.read(4194305); assert len(b)<=4194304; print(json.dumps({'status':r.status,'body':b.decode()}))"

    def http(method, path, body=None):
        request = {"method": method, "path": path, "body": json.dumps(body) if body is not None else None,
            "headers": {"Authorization": "Basic " + base64.b64encode(("opencode:" + password).encode()).decode(),
                        "Content-Type": "application/json"}}
        raw = subprocess.run(["docker", "exec", "-i", cid, "python3", "-I", "-S", "-c", transport],
            input=json.dumps(request), capture_output=True, text=True, timeout=10)
        if raw.returncode:
            raise RuntimeError("Offline adjudication transport unavailable: " + raw.stderr[-500:])
        value = json.loads(raw.stdout)
        if value["status"] >= 400:
            raise RuntimeError("Offline adjudication rejected: " + value["body"][:1000])
        return json.loads(value["body"])

    try:
        subprocess.run(["docker", "exec", "-i", cid, "python3", "-I", "-S", "-c", launch],
            input=json.dumps(env), capture_output=True, text=True, check=True, timeout=20)
        until = time.monotonic() + 30
        while time.monotonic() < until:
            try:
                if http("GET", "/global/health").get("healthy"):
                    break
            except RuntimeError:
                pass
            time.sleep(.2)
        else:
            raise RuntimeError("Offline adjudicator did not become healthy")
        return settle(http, subject=subject, evaluator_hash=evaluator_hash, artifacts_hash=artifacts_hash,
            outcome=outcome, report_path=report_path, stop_receipt=native.control / "stopped.json", output=output)
    finally:
        cleanup = subprocess.run(["docker", "rm", "-f", cid], capture_output=True, text=True, timeout=30)
        Path(output).mkdir(parents=True, exist_ok=True)
        (Path(output) / "administration.json").write_text(json.dumps({"container": cid, "user": user,
            "network": "none", "task_mount": False, "provider_channel": False, "real_credentials": False,
            "cleanup_returncode": cleanup.returncode, "cleanup_error": cleanup.stderr[-1000:]}, indent=2) + "\n")
