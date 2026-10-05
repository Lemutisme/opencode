import json
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

from benchmark_runtime import export_messages, provider_health


class RuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.database = self.root / "state.db"
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,data TEXT)")
            connection.execute("CREATE TABLE request(id INTEGER,status INTEGER,outcome TEXT,usage TEXT,close_reason TEXT,error_name TEXT)")

    def test_large_unicode_exports_are_complete_and_read_only(self):
        text = "large\u2028message\n" + "x" * (33 * 1024 * 1024)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.executemany("INSERT INTO session_message VALUES (?,?,?,?,?)", [
                ("b", "s", "assistant", 9, json.dumps({"content": text})),
                ("a", "s", "user", 2, json.dumps({"content": "first"})),
                ("private", "other", "user", 1, json.dumps({"content": "other session"})),
            ])
        before = self.database.read_bytes()
        output = self.root / "messages.jsonl"
        receipt = export_messages(self.database, "s", output)
        with output.open() as stream:
            rows = [json.loads(line) for line in stream]
        self.assertEqual([row["id"] for row in rows], ["a", "b"])
        self.assertEqual(rows[1]["content"], text)
        self.assertTrue(receipt["complete"])
        self.assertEqual(receipt["messages"], 2)
        self.assertEqual(before, self.database.read_bytes())

    def test_failed_export_never_replaces_a_complete_file(self):
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("INSERT INTO session_message VALUES ('a','s','assistant',1,'not JSON')")
        output = self.root / "messages.jsonl"
        output.write_text("preserved\n")
        with self.assertRaises(ValueError):
            export_messages(self.database, "s", output)
        self.assertEqual(output.read_text(), "preserved\n")
        self.assertFalse(output.with_suffix('.receipt.json').exists())

    def test_http_200_is_not_success_and_terminal_disconnect_is_not_failure(self):
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.executemany("INSERT INTO request VALUES (?,?,?,?,?,?)", [
                (1, 200, "transport_failed", None, "eof_without_terminal", None),
                (2, 200, "response.completed", '{"input_tokens":10}', "connection_error", "BrokenPipeError"),
                (3, 200, "response.incomplete", '{"input_tokens":20}', "terminal_eof", None),
                (4, 200, "error", None, "terminal_eof", None),
            ])
        report = provider_health(self.database)
        self.assertEqual(report['completed'], 1)
        self.assertEqual(report['nonterminal_errors'], 1)
        self.assertEqual(report['nonterminal_error_requests'][0]['id'], 1)
        self.assertEqual(report['unknown_usage'], 2)
        self.assertEqual(report['incomplete'], 1)
        self.assertEqual(report['provider_failed'], 1)


if __name__ == "__main__":
    unittest.main()
