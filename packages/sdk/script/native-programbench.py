"""Fresh native V2 allocation. The issuer, credentials and scorer remain host-only."""

import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import signal
import shutil
import shlex
import sqlite3
import subprocess
import sys
import threading
import time
import uuid


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def command(argv, timeout=60, env=None):
    result = subprocess.run(
        argv, capture_output=True, text=True, timeout=timeout, env=env
    )
    if result.returncode:
        raise RuntimeError(
            f"{argv[0]} failed ({result.returncode}): {result.stderr[-4000:]}"
        )
    return result.stdout


def prepare_ripgrep(source, root):
    """Freeze an explicit offline executable; workers never download tools."""
    target = root / "tools" / "rg"
    target.parent.mkdir()
    shutil.copyfile(source.resolve(strict=True), target)
    target.chmod(0o555)
    version = command([str(target), "--version"]).strip()
    fixture = root / "rg-probe"
    fixture.mkdir()
    (fixture / "needle.txt").write_text("offline-ripgrep-qualified\n")
    try:
        listing = command([str(target), "--files", "--glob", "*.txt", str(fixture)])
        matching = command(
            [str(target), "--fixed-strings", "offline-ripgrep-qualified", str(fixture)]
        )
        if "needle.txt" not in listing or "offline-ripgrep-qualified" not in matching:
            raise RuntimeError("Offline ripgrep smoke test failed")
    finally:
        shutil.rmtree(fixture)
    write(root / "TOOLS.json", {"rg": {"sha256": sha(target), "version": version}})
    return target


def delivery_handoff(path):
    value = json.loads(path.read_text())
    delivery = value.get("delivery", {})
    if delivery.get("state") != "ready":
        raise RuntimeError(
            "No explicit delivery handoff: "
            + delivery.get("reason", "obligations remain open")
        )
    if (
        not delivery.get("snapshot")
        or not delivery.get("summary")
        or not delivery.get("probes", 0)
    ):
        raise RuntimeError("Incomplete public-evidence handoff")
    if value.get("authoritativeCompletion") is not False:
        raise RuntimeError("Worker must not assert authoritative completion")
    return delivery


def official_result(path, instance):
    """Use the scorer's canonical scope; raw eval JSON retains ignored tests."""
    from programbench.eval.eval import EvaluationResult
    from programbench.eval.eval_batch import get_branches_to_eval
    from programbench.utils.load_data import get_active_branches, get_ignored_tests

    result = EvaluationResult.model_validate_json(path.read_text())
    branches = get_active_branches(instance)
    ignored = get_ignored_tests(instance)
    if not result.error_code and get_branches_to_eval(
        eval_json=path,
        all_test_branches=branches,
        tests_by_branch={
            branch: instance["branches"][branch]["tests"] for branch in branches
        },
        ignored_tests=ignored,
    ):
        raise RuntimeError("Official evaluation has missing branches or tests")
    return result.for_branches(branches).without_ignored(ignored)


def main():
    parser = argparse.ArgumentParser()
    for key in ["root", "runtime", "bun", "rg", "runner", "python", "wheelhouse"]:
        parser.add_argument("--" + key, type=Path, required=True)
    parser.add_argument("--instance", default="altdesktop__i3-style.f93821b")
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--fixture", action="store_true")
    parser.add_argument("--fixture-steps", type=int, default=1)
    parser.add_argument("--fixture-expiry", type=int)
    parser.add_argument("--blobs", type=Path)
    args = parser.parse_args()
    if not args.fixture and (
        args.blobs is None or not (args.blobs / args.instance).is_dir()
    ):
        raise ValueError(
            "Explicit offline official test blobs required before admission"
        )
    root = args.root.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    ripgrep = prepare_ripgrep(args.rg, root)
    sys.path[:0] = [str(args.runner), str(args.runner / "src")]
    from scripts.campaign_provider_gateway import Gateway, process_identity
    from scripts.campaign_vanilla_http import ORIGINAL_TASK
    from programbench.candidate import (
        package_workspace,
        preflight_candidate,
        verify_archive_no_credentials,
    )

    for name in ["candidate", "state", "admission", "channel", "control", "receipts"]:
        (root / name).mkdir(mode=0o755)
    for name in ["home", "config", "data", "cache"]:
        (root / "state" / name).mkdir()
    image = command(
        [
            "docker",
            "image",
            "inspect",
            f"programbench/{args.instance.replace('__', '_1776_')}:task_cleanroom_v6",
            "--format",
            "{{.Id}}",
        ]
    ).strip()
    (root / "image.txt").write_text(image + "\n")
    uid, gid = os.getuid(), os.getgid()
    command(
        [
            "docker",
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            "none",
            "--user",
            "0:0",
            "--mount",
            f"type=bind,src={root / 'candidate'},dst=/candidate",
            "--entrypoint",
            "/bin/sh",
            image,
            "-ec",
            f"cp -a /workspace/. /candidate/; rm -f /candidate/executable; ln -s /workspace/executable /candidate/reference; chown -R {uid}:{gid} /candidate",
        ],
        120,
    )
    started = int(time.time() * 1000)
    if args.fixture and args.fixture_expiry is not None:
        started -= (21600 - args.fixture_expiry) * 1000
    deadline = started + 21600 * 1000
    identity = uuid.uuid4().hex
    base = {
        "id": "pct_" + identity,
        "scope": root.name,
        "goal": ORIGINAL_TASK,
        "started": started,
        "deadline": deadline,
    }
    write(
        root / "issue.json",
        {"startedAt": started / 1000, "payload": {"budget": {"deadline": deadline}}},
    )

    def authority(action, **fields):
        request = root / "receipts" / f"{time.time_ns()}-{action}.json"
        output = request.with_suffix(".result.json")
        write(request, {**base, "action": action, **fields})
        command(
            [
                str(args.bun),
                str(args.runtime / "packages/core/script/contract-authority.ts"),
                str(request),
                str(output),
            ],
            env={**os.environ, "OPENCODE_DB": str(root / "issuer.sqlite")},
        )
        return json.loads(output.read_text())

    authority("issue")
    standing = {
        "contractID": base["id"],
        "revision": 1,
        "deadline": deadline,
        "active": True,
    }
    write(root / "admission/standing.json", standing)
    write(
        root / "admission/worker.json",
        {
            **{key: standing[key] for key in ["contractID", "revision", "deadline"]},
            "sessionID": "ses_" + identity,
            "promptID": "msg_" + identity,
            "directory": "/candidate",
            "reference": "/workspace/executable",
            "state": "/state",
            "standing": "/admission/standing.json",
            "socket": "/channel/provider.sock",
            "model": args.model,
            "effort": "max",
            "prompt": "Run the requested fixture shell command, then finish."
            if args.fixture
            else ORIGINAL_TASK,
        },
    )
    fixture = None
    if args.fixture:

        class Fixture(http.server.BaseHTTPRequestHandler):
            calls = 0
            tools = 0
            qualification = 0
            stopped = False

            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                Fixture.calls += 1
                index = Fixture.calls
                with (root / "fixture-requests.jsonl").open("a") as log:
                    log.write(
                        json.dumps(
                            body
                            if index <= 2
                            else {
                                "fixtureRequest": index,
                                "model": body["model"],
                                "reasoning": body.get("reasoning"),
                            }
                        )
                        + "\n"
                    )
                tool = next(
                    (
                        t["name"]
                        for t in body.get("tools", [])
                        if t.get("name", "").endswith("shell")
                    ),
                    None,
                )
                if tool and Fixture.tools < args.fixture_steps:
                    Fixture.tools += 1
                    probe = "import socket,os; assert os.listdir('/sys/class/net') == ['lo']; assert not os.path.exists('/var/run/docker.sock'); s=socket.socket(socket.AF_UNIX); s.connect('/channel/provider.sock'); s.sendall(b'POST /v1/responses HTTP/1.1\\r\\nHost: programbench-provider.invalid\\r\\nContent-Length: 2\\r\\n\\r\\n{}'); assert b'403' in s.recv(4096); print('native-v2-ok')"
                    item = {
                        "type": "function_call",
                        "id": "fc_fixture",
                        "call_id": "call_fixture",
                        "name": tool,
                        "arguments": json.dumps(
                            {
                                "command": (
                                    "python3 -c "
                                    + shlex.quote(probe)
                                    + " > /candidate/native-v2-marker.txt"
                                )
                                if index == 1
                                else "true",
                                "timeout": 10000,
                            }
                        ),
                        "status": "completed",
                    }
                elif not Fixture.stopped:
                    Fixture.stopped = True
                    item = {
                        "type": "message",
                        "id": "msg_premature_stop",
                        "role": "assistant",
                        "status": "completed",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "Finished.",
                                "annotations": [],
                            }
                        ],
                    }
                elif Fixture.qualification < 5:
                    actions = [
                        ("glob", {"pattern": "native-v2-marker.txt"}),
                        (
                            "grep",
                            {"pattern": "native-v2-ok", "path": "native-v2-marker.txt"},
                        ),
                        (
                            "patch",
                            {
                                "patchText": "*** Begin Patch\n*** Add File: /candidate/native-tools.txt\n+qualified\n*** End Patch"
                            },
                        ),
                        ("read", {"path": "/candidate/native-tools.txt"}),
                        (
                            "contract_delivery",
                            {
                                "action": "blocked",
                                "reason": "Scripted qualification finished, not a task submission",
                            },
                        ),
                    ]
                    name, arguments = actions[Fixture.qualification]
                    selected = next(
                        t["name"] for t in body["tools"] if t["name"].endswith(name)
                    )
                    Fixture.qualification += 1
                    item = {
                        "type": "function_call",
                        "id": f"fc_qualification_{Fixture.qualification}",
                        "call_id": f"call_qualification_{Fixture.qualification}",
                        "name": selected,
                        "arguments": json.dumps(arguments),
                        "status": "completed",
                    }
                else:
                    item = {
                        "type": "message",
                        "id": "msg_fixture",
                        "role": "assistant",
                        "status": "completed",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "Fixture complete.",
                                "annotations": [],
                            }
                        ],
                    }
                response = {
                    "id": f"resp_{index}",
                    "object": "response",
                    "model": args.model,
                    "status": "completed",
                    "output": [item],
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 10,
                        "total_tokens": 20,
                    },
                }
                events = [
                    {
                        "type": "response.created",
                        "response": {**response, "status": "in_progress", "output": []},
                    },
                    {
                        "type": "response.output_item.added",
                        "output_index": 0,
                        "item": {**item, "arguments": ""}
                        if item["type"] == "function_call"
                        else item,
                    },
                ]
                if item["type"] == "function_call":
                    events += [
                        {
                            "type": "response.function_call_arguments.delta",
                            "item_id": item["id"],
                            "output_index": 0,
                            "delta": item["arguments"],
                        },
                        {
                            "type": "response.function_call_arguments.done",
                            "item_id": item["id"],
                            "output_index": 0,
                            "arguments": item["arguments"],
                        },
                    ]
                else:
                    events += [
                        {
                            "type": "response.output_text.delta",
                            "item_id": item["id"],
                            "output_index": 0,
                            "content_index": 0,
                            "delta": "Fixture complete.",
                        }
                    ]
                events += [
                    {
                        "type": "response.output_item.done",
                        "output_index": 0,
                        "item": item,
                    },
                    {"type": "response.completed", "response": response},
                ]
                data = "".join(
                    "data: " + json.dumps(event) + "\n\n" for event in events
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        fixture = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        threading.Thread(target=fixture.serve_forever, daemon=True).start()

    class NativeGateway(Gateway):
        def record(self, pid, body):
            if any(
                tool.get("name") not in {"glob", "grep", "patch", "read", "shell"}
                for tool in json.loads(body).get("tools", [])
            ):
                raise ValueError("unqualified_native_tool")
            with sqlite3.connect(
                f"file:{root / 'issuer.sqlite'}?mode=ro", uri=True
            ) as connection:
                row = connection.execute(
                    "SELECT data FROM pro_contract WHERE id=?", (base["id"],)
                ).fetchone()
                state = json.loads(row[0]) if row else None
                if (
                    not state
                    or state["status"] != "active"
                    or state["revision"] != 1
                    or state["spec"]["budget"] != {"deadline": deadline}
                ):
                    raise ValueError("contract_not_active")
            return super().record(pid, body)

    gateway = NativeGateway(
        root / "channel",
        root / "control",
        args.model,
        "max",
        issue=root / "issue.json",
        upstream=f"http://127.0.0.1:{fixture.server_port}/v1"
        if fixture
        else os.environ["OPENAI_BASE_URL"],
        api_key="no-secret-fixture" if fixture else os.environ["OPENAI_API_KEY"],
    )
    if args.fixture:
        # Qualification-only history proves wire admission is not stopped by the
        # historical count ceiling. These synthetic rows never enter a live run.
        gateway.db.executemany(
            "INSERT INTO request(started,finished,peer_pid,outcome) VALUES (?,?,?,?)",
            [
                (time.time(), time.time(), 0, "synthetic-prior-request")
                for _ in range(3001)
            ],
        )
        gateway.db.commit()
    threading.Thread(target=gateway.serve_forever, daemon=True).start()
    name = "procontract-v2-" + identity
    write(root / "process.json", {**process_identity(os.getpid()), "container": name})

    def cancel(*_):
        (root / "CANCEL").write_text("explicit signal cancellation\n")

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        argv = [
            "docker",
            "run",
            "-d",
            "--pull",
            "never",
            "--name",
            name,
            "--label",
            f"procontract.qualifier={root.name}",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "512",
            "--memory",
            "8g",
            "--cpus",
            "4",
            "--user",
            f"{uid}:{gid}",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
            "--workdir",
            "/candidate",
        ]
        for source, target, mode in [
            (args.runtime, "/runtime", "readonly"),
            (root / "candidate", "/candidate", ""),
            (root / "state", "/state", ""),
            (root / "admission", "/admission", "readonly"),
            (root / "channel", "/channel", "readonly"),
            (args.bun, "/runtime-bun", "readonly"),
            (ripgrep, "/runtime-tools/rg", "readonly"),
        ]:
            argv += [
                "--mount",
                f"type=bind,src={source},dst={target}" + ("," + mode if mode else ""),
            ]
        for key, value in {
            "PATH": "/runtime-tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": "/state/home",
            "XDG_CONFIG_HOME": "/state/config",
            "XDG_DATA_HOME": "/state/data",
            "XDG_CACHE_HOME": "/state/cache",
        }.items():
            argv += ["--env", key + "=" + value]
        command(
            [
                *argv,
                "--entrypoint",
                "/runtime-bun",
                image,
                "/runtime/packages/sdk/script/contract-worker.ts",
                "/admission/worker.json",
            ]
        )
        pid = int(command(["docker", "inspect", "--format", "{{.State.Pid}}", name]))
        write(root / "control/runtime.json", process_identity(pid))
        (root / "admission/standing.json.ready").write_text("host admission complete\n")
        until = (
            min(deadline / 1000, time.time() + 900) if args.fixture else deadline / 1000
        )
        while True:
            status = json.loads(
                command(["docker", "inspect", "--format", "{{json .State}}", name])
            )
            write(
                root / "STATUS.json",
                {
                    "phase": "native-execution",
                    "container": status,
                    "deadline": deadline,
                    "updated": time.time(),
                },
            )
            if not status["Running"]:
                break
            if (root / "CANCEL").exists() or time.time() >= until:
                raise RuntimeError("cancelled or original deadline reached")
            time.sleep(1)
        raw = subprocess.run(
            ["docker", "logs", name], capture_output=True, text=True, timeout=30
        )
        (root / "worker.stdout").write_text(raw.stdout)
        (root / "worker.stderr").write_text(raw.stderr)
        if status["ExitCode"] != 0 or status["OOMKilled"]:
            raise RuntimeError("Native worker failed; see worker.stderr")
        command(["docker", "rm", "-f", name])
        gateway.shutdown()
        gateway.checkpoint_shutdown()
        gateway.server_close()
        if args.fixture:
            events = json.loads((root / "state/events.json").read_text())
            if any(event["type"] == "session.tool.failed" for event in events):
                raise RuntimeError("Native tool qualification failed; see events.json")
            for call_id, marker in [
                ("call_qualification_1", "native-v2-marker.txt"),
                ("call_qualification_2", "native-v2-ok"),
                ("call_qualification_4", "qualified"),
            ]:
                success = next(
                    (
                        event["data"]
                        for event in events
                        if event["type"] == "session.tool.success"
                        and event["data"]["id"] == call_id
                    ),
                    None,
                )
                if success is None or marker not in json.dumps(
                    success.get("content", [])
                ):
                    raise RuntimeError(
                        f"Native tool returned no expected evidence: {call_id}"
                    )
            if (root / "candidate/native-tools.txt").read_text() != "qualified\n":
                raise RuntimeError("Native patch/read qualification did not complete")
            if sum(event["type"] == "session.inbox.enqueued" for event in events) < 2:
                raise RuntimeError(
                    "Premature stop did not produce durable continuation"
                )
            if (
                root / "candidate/native-v2-marker.txt"
            ).read_text() != "native-v2-ok\n":
                raise RuntimeError("Native shell did not execute")
            write(
                root / "RESULT.json",
                {
                    "qualified": True,
                    "fixture": True,
                    "modelCalls": False,
                    "nativeV2Shell": True,
                    "allLeafTools": True,
                    "durableContinuation": True,
                    "syntheticPriorRequests": 3001,
                    "credentialAndNetworkProbe": True,
                    "nativeFixtureRequests": Fixture.calls,
                    "nativeFixtureTools": Fixture.tools,
                },
            )
            return
        handoff = delivery_handoff(root / "state/worker-ended.json")
        write(root / "HANDOFF.json", handoff)
        archive = package_workspace(
            root / "candidate", root / "submission", args.instance
        )
        verify_archive_no_credentials(archive, (os.environ["OPENAI_API_KEY"].encode(),))
        if not (root / "candidate/validate.sh").is_file():
            raise RuntimeError("Required independent self-check missing")
        subject = sha(archive)
        authority("ready", subjectHash=subject, summary=handoff["summary"])
        checked = preflight_candidate(
            archive,
            args.instance,
            image_ref=image,
            deadline=time.monotonic() + max(0, deadline / 1000 - time.time()),
            labels={"procontract.qualifier": root.name},
        )
        write(
            root / "preflight.json",
            {
                "archive": subject,
                "executable": checked.executable_hash,
                "output": checked.output,
            },
        )
        env = {
            k: os.environ[k]
            for k in ["PATH", "HOME", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR"]
            if k in os.environ
        }
        env.update(
            PYTHONPATH=f"{args.runner}:{args.runner / 'src'}",
            PROGRAMBENCH_SAFE_REPORTING="1",
            PROGRAMBENCH_EVAL_WHEELHOUSE=str(args.wheelhouse),
            HF_HUB_OFFLINE="1",
            HF_DATASETS_OFFLINE="1",
            PROGRAMBENCH_DOCKER_CPUS="4",
        )
        env["PROGRAMBENCH_BLOB_DIR"] = str(args.blobs)
        with (root / "score.log").open("w") as log:
            score = subprocess.run(
                [
                    str(args.python),
                    "-c",
                    "from programbench.cli.main import app; app()",
                    "eval",
                    str(root / "submission"),
                    "--workers",
                    "1",
                    "--branch-workers",
                    "1",
                    "--branch-retries",
                    "0",
                    "--docker-cpus",
                    "4",
                ],
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=3600,
            )
        if score.returncode:
            raise RuntimeError("Official evaluation unavailable; see score.log")
        if sha(archive) != subject:
            raise RuntimeError("Submission changed during grading")
        results = sorted((root / "submission").rglob("*.eval.json"))
        if len(results) != 1:
            raise RuntimeError("One exact official evaluation result required")
        from programbench.utils.load_data import load_all_instances

        instance = next(
            item
            for item in load_all_instances()
            if item["instance_id"] == args.instance
        )
        evaluated = official_result(results[0], instance)
        valid = (
            not evaluated.error_code
            and not evaluated.test_branch_errors
            and not evaluated.n_system_errors
            and not evaluated.warnings
            and len(evaluated) > 0
        )
        report = {
            "instance": args.instance,
            "subjectHash": subject,
            "evaluatorResult": str(results[0]),
            "evaluatorHash": sha(results[0]),
            "valid": valid,
            "resolved": evaluated.n_resolved,
            "total": len(evaluated),
            "score": evaluated.score,
            "model": args.model,
            "effort": "max",
            "deadline": deadline,
            "rsiPromotion": False,
        }
        write(root / "RESULT.json", report)
        if not valid:
            raise RuntimeError("Official evaluation incomplete; not a valid task score")
        write(
            root / "TERMINAL.json",
            authority(
                "settle",
                subjectHash=subject,
                evidenceHash=sha(root / "RESULT.json"),
                passed=evaluated.n_resolved == len(evaluated),
            ),
        )
    except BaseException as error:
        write(root / "admission/standing.json", {**standing, "active": False})
        logs = subprocess.run(
            ["docker", "logs", name], capture_output=True, text=True, timeout=30
        )
        if logs.returncode == 0:
            (root / "worker.stdout").write_text(logs.stdout)
            (root / "worker.stderr").write_text(logs.stderr)
        write(
            root / "FAILURE.json",
            {"error": type(error).__name__, "message": str(error), "time": time.time()},
        )
        authority("escalate", reason=str(error)[:1000])
        raise
    finally:
        write(root / "admission/standing.json", {**standing, "active": False})
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=45)
        gateway.shutdown()
        gateway.checkpoint_shutdown()
        gateway.server_close()
        if fixture:
            fixture.shutdown()
        rows = gateway.db.execute(
            "SELECT id,started,finished,status,outcome,usage,body_sha256,metadata FROM request WHERE peer_pid > 0"
        ).fetchall()
        write(
            root / "ACCOUNTING.json",
            {
                "requests": len(rows),
                "missingUsage": sum(row[5] is None for row in rows),
                "cost": None,
                "costStatus": "not independently verified",
                "records": [
                    dict(
                        zip(
                            [
                                "id",
                                "started",
                                "finished",
                                "status",
                                "outcome",
                                "usage",
                                "bodyHash",
                                "metadata",
                            ],
                            row,
                        )
                    )
                    for row in rows
                ],
            },
        )
        write(
            root / "FENCED.json",
            {
                "container": name,
                "running": command(
                    ["docker", "ps", "-q", "--filter", f"name=^/{name}$"]
                ).strip(),
                "time": time.time(),
            },
        )


if __name__ == "__main__":
    main()
