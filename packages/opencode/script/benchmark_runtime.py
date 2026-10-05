"""Host-only retained-state export and provider health accounting.

No model requests, candidate edits, or database writes are performed here.
Official rewards stay separate from recovered transport errors.
"""
import json
from contextlib import closing
from pathlib import Path
import sqlite3
import time


def export_messages(database, session_id, output):
    output = Path(output)
    pending = output.with_suffix(output.suffix + ".partial")
    count = 0
    last = None
    with closing(sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True, timeout=10)) as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        with pending.open("x", encoding="utf-8") as stream:
            for row in connection.execute(
                "SELECT id,type,seq,data FROM session_message WHERE session_id=? ORDER BY seq", (session_id,)
            ):
                data = json.loads(row[3])
                data.update(id=row[0], type=row[1])
                stream.write(json.dumps(data, ensure_ascii=False) + "\n")
                count += 1
                last = row[2]
    pending.replace(output)
    receipt = {"at": time.time(), "complete": True, "messages": count, "last_sequence": last,
               "session_id": session_id, "source": "read-only retained SQLite projection",
               "bytes": output.stat().st_size}
    output.with_suffix(".receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def provider_health(database):
    with closing(sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True, timeout=10)) as connection:
        connection.row_factory = sqlite3.Row
        rows = [dict(row) for row in connection.execute(
            "SELECT id,status,outcome,usage,close_reason,error_name FROM request ORDER BY id"
        )]
    completed = [row for row in rows if row["outcome"] == "response.completed"]
    unfinished = [row for row in rows if row["outcome"] not in (
        "response.completed", "response.failed", "response.incomplete", "error", "admitted", "sending", "response_started"
    )]
    return {
        "requests": len(rows),
        "completed": len(completed),
        "incomplete": sum(row["outcome"] == "response.incomplete" for row in rows),
        "provider_failed": sum(row["outcome"] in ("response.failed", "error") for row in rows),
        "nonterminal_errors": len(unfinished),
        "unknown_usage": sum(row["usage"] is None for row in rows),
        "nonterminal_error_requests": [{key: row[key] for key in ("id", "status", "outcome", "close_reason", "error_name")} for row in unfinished],
        "scope": "intermediate provider health, not the official task verdict",
    }
