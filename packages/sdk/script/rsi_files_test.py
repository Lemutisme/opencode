"""Real filesystem attacks against the public task snapshot boundary; no Docker."""

import importlib.util
import os
from pathlib import Path
import socket
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("rsi_files", Path(__file__).with_name("rsi-files.py"))
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "workspace"
        self.source.mkdir()
        self.archive = self.root / "snapshot.tar"

    def tearDown(self):
        self.temp.cleanup()

    def test_stable_public_archive_omits_only_top_level_reference_and_git(self):
        (self.source / ".git").mkdir()
        (self.source / ".git" / "private").write_text("not task state")
        (self.source / "reference").symlink_to("/outside/reference")
        (self.source / "script").write_text("#!/bin/sh\necho public\n")
        (self.source / "script").chmod(0o700)
        (self.source / "nested").mkdir()
        (self.source / "nested" / "reference").write_bytes(b"public input\x00")
        (self.source / "alias").symlink_to("script")
        files.snapshot(self.source, self.archive)
        os.utime(self.source / "script", (1, 1))
        other = self.root / "again.tar"
        files.snapshot(self.source, other)
        self.assertEqual(self.archive.read_bytes(), other.read_bytes())
        with tarfile.open(self.archive) as archive:
            self.assertEqual(archive.getnames(), ["alias", "nested", "nested/reference", "script"])
            self.assertTrue(archive.getmember("alias").issym())
            self.assertEqual(archive.getmember("alias").linkname, "script")
            self.assertEqual(archive.getmember("script").mode, 0o755)
            self.assertTrue(all(item.uid == item.gid == item.mtime == 0 for item in archive))
            self.assertEqual(archive.extractfile("nested/reference").read(), b"public input\x00")

    def test_rejects_a_symlink_root_and_noncanonical_source(self):
        linked = self.root / "linked"
        linked.symlink_to(self.source, target_is_directory=True)
        for source in [linked, self.source / ".." / "workspace"]:
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "canonical"):
                files.snapshot(source, self.archive)
        self.assertFalse(self.archive.exists())

    def test_destination_never_overwrites_or_enters_source(self):
        self.archive.write_bytes(b"historical evidence")
        with self.assertRaises(FileExistsError):
            files.snapshot(self.source, self.archive)
        self.assertEqual(self.archive.read_bytes(), b"historical evidence")
        with self.assertRaisesRegex(ValueError, "outside"):
            files.snapshot(self.source, self.source / "recursive.tar")
        link = self.root / "linked-output"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "canonical"):
            files.snapshot(self.source, link / "new.tar")

    def test_rejects_fifo_without_opening_or_hanging(self):
        os.mkfifo(self.source / "fifo")
        with self.assertRaisesRegex(ValueError, "FIFO"):
            files.snapshot(self.source, self.archive)
        self.assertFalse(self.archive.exists())

    def test_rejects_socket(self):
        with socket.socket(socket.AF_UNIX) as peer:
            peer.bind(str(self.source / "socket"))
            with self.assertRaisesRegex(ValueError, "socket"):
                files.snapshot(self.source, self.archive)

    def test_rejects_hardlinked_files(self):
        (self.source / "file").write_text("shared")
        os.link(self.source / "file", self.root / "outside")
        with self.assertRaisesRegex(ValueError, "hardlink"):
            files.snapshot(self.source, self.archive)

    def test_rejects_absolute_and_relative_escape_symlinks(self):
        for target in ["/etc/passwd", "../outside", "missing/../../outside"]:
            with self.subTest(target=target):
                (self.source / "link").symlink_to(target)
                with self.assertRaisesRegex(ValueError, "escapes"):
                    files.snapshot(self.source, self.archive)
                (self.source / "link").unlink()

    def test_rejects_symlink_chains_to_excluded_external_reference(self):
        (self.source / "reference").symlink_to("/outside/reference")
        (self.source / "alias").symlink_to("reference")
        with self.assertRaisesRegex(ValueError, "escapes"):
            files.snapshot(self.source, self.archive)

    def test_directory_symlink_is_preserved_but_never_walked(self):
        (self.source / "dir").mkdir()
        (self.source / "dir" / "one").write_text("once")
        (self.source / "link").symlink_to("dir", target_is_directory=True)
        files.snapshot(self.source, self.archive)
        with tarfile.open(self.archive) as archive:
            self.assertEqual(archive.getnames(), ["dir", "dir/one", "link"])
            self.assertTrue(archive.getmember("link").issym())

    def test_file_count_and_actual_archive_size_are_bounded(self):
        (self.source / "a").write_text("a")
        (self.source / "b").write_text("b")
        with self.assertRaisesRegex(ValueError, "file count"):
            files.snapshot(self.source, self.archive, maximum_files=1)
        self.assertFalse(self.archive.exists())
        with self.assertRaisesRegex(ValueError, "archive size"):
            files.snapshot(self.source, self.archive, limit=512)
        self.assertFalse(self.archive.exists())


if __name__ == "__main__":
    unittest.main()
