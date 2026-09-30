"""Issuer-owned adapter around the qualified model-only gateway. Never part of H."""

import argparse
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import signal
import sqlite3
import threading


def standing(scope):
    if (Path(scope["database"]).parent / "CANCEL").exists():
        raise ValueError("campaign_cancelled")
    with sqlite3.connect(f"file:{scope['database']}?mode=ro", uri=True) as db:
        state = json.loads(
            db.execute("SELECT value FROM ota_state WHERE id=1").fetchone()[0]
        )
    if (
        state.get("stopped")
        or state["epoch"] != scope["epoch"]
        or state["protocol"] != scope["protocol"]
    ):
        raise ValueError("stale_issuer_scope")
    if (
        state.get("job", {}).get("id") != scope["job"]
        or state["job"]["phase"] != scope["phase"]
    ):
        raise ValueError("stale_issuer_job")
    if state["active"]["pair"] != scope["incumbent"]:
        raise ValueError("incumbent_changed")
    support = state["active"].get("support")
    if (
        support
        and state["kernel"]["contracts"].get(support, {}).get("status") != "discharged"
    ):
        raise ValueError("deployment_support_withdrawn")


def main():
    parser = argparse.ArgumentParser()
    for name in [
        "gateway",
        "scope",
        "channel",
        "control",
        "issue",
        "model",
        "effort",
        "owner",
    ]:
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    # The credential process must not outlive its supervising host process.
    if os.getppid() != int(args.owner):
        raise RuntimeError("supervisor already exited")
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "cannot bind gateway lifetime")
    if os.getppid() != int(args.owner):
        raise RuntimeError("supervisor exited during admission")
    spec = importlib.util.spec_from_file_location("gateway", args.gateway)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    scope = json.loads(Path(args.scope).read_text())

    class Gateway(module.Gateway):
        def record(self, pid, body):
            standing(scope)
            if not (Path(args.scope).parent / "active").exists():
                raise ValueError("allocation_closed")
            tools = json.loads(body).get("tools", [])
            if any(
                tool.get("name")
                not in {
                    "glob",
                    "grep",
                    "read",
                    "patch",
                    "shell",
                    "rsi_handoff",
                    "rsi_blocked",
                }
                for tool in tools
            ):
                raise ValueError("tool_not_admitted")
            return super().record(pid, body)

    server = Gateway(
        Path(args.channel),
        Path(args.control),
        args.model,
        args.effort,
        issue=Path(args.issue),
        upstream=os.environ["OPENAI_BASE_URL"],
        api_key=os.environ["OPENAI_API_KEY"],
    )
    server.db.execute("PRAGMA journal_mode=WAL")
    server.db.execute("PRAGMA busy_timeout=5000")
    Path(args.control, "gateway.json").write_text(json.dumps({"pid": os.getpid()}))

    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        server.checkpoint_shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
