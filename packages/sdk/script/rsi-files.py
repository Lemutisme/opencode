"""Small trusted file boundary for OTA. Never executes candidate code on the host."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile


def tree(root):
    result = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            info = path.lstat()
            key = path.relative_to(root).as_posix()
            if stat.S_ISLNK(info.st_mode):
                result[key] = {"link": os.readlink(path)}
                continue
            if stat.S_ISDIR(info.st_mode):
                result[key] = {"directory": True}
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("state contains a device, socket, FIFO or hardlink: " + key)
            with path.open('rb') as stream:
                result[key] = {"sha256": hashlib.file_digest(stream, 'sha256').hexdigest(), "size": info.st_size,
                               "mode": stat.S_IMODE(info.st_mode)}
    return result


def sync_tree(root):
    for directory, _, files in os.walk(root, followlinks=False):
        for name in files:
            file = Path(directory) / name
            if file.is_symlink():
                continue
            with file.open('rb') as stream:
                os.fsync(stream.fileno())
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        os.fsync(descriptor)
        os.close(descriptor)


def snapshot(source, destination, limit=1024 ** 3, maximum_files=100_000):
    """Seal a fenced public workspace; never follow candidate files on the host."""
    source, destination = Path(source), Path(destination)
    if (
        not source.is_absolute()
        or source.resolve(strict=True) != source
        or source.is_symlink()
        or not destination.is_absolute()
        or destination.resolve() != destination
        or destination.is_relative_to(source)
    ):
        raise ValueError("snapshot paths must be canonical and destination outside the source")
    root = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
        try:
            with os.fdopen(descriptor, 'wb') as output:
                class BoundedOutput:
                    def tell(self):
                        return output.tell()

                    def write(self, value):
                        if output.tell() + len(value) > limit:
                            raise ValueError("snapshot archive size limit")
                        return output.write(value)

                count = 0
                with tarfile.open(fileobj=BoundedOutput(), mode='w', format=tarfile.PAX_FORMAT) as archive:
                    def collect(directory, prefix=''):
                        nonlocal count
                        for name in sorted(os.listdir(directory)):
                            if not prefix and name in {'reference', '.git'}:
                                continue
                            count += 1
                            if count > maximum_files:
                                raise ValueError("snapshot file count limit")
                            key = prefix + name
                            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                            member = tarfile.TarInfo(key)
                            # Stable metadata: identity depends on public bytes and executable
                            # behavior, never host owner names or observation timestamps.
                            member.mode = 0o755 if stat.S_ISDIR(info.st_mode) or info.st_mode & 0o111 else 0o644
                            if stat.S_ISDIR(info.st_mode):
                                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                                try:
                                    opened = os.fstat(child)
                                    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                                        raise ValueError("snapshot directory changed")
                                    member.type = tarfile.DIRTYPE
                                    archive.addfile(member)
                                    collect(child, key + '/')
                                finally:
                                    os.close(child)
                                continue
                            if info.st_nlink != 1:
                                raise ValueError("snapshot contains a hardlink: " + key)
                            if stat.S_ISLNK(info.st_mode):
                                target = os.readlink(name, dir_fd=directory)
                                if Path(target).is_absolute() or not (source / key).resolve().is_relative_to(source):
                                    raise ValueError("snapshot symlink escapes its tree: " + key)
                                member.type, member.linkname, member.mode = tarfile.SYMTYPE, target, 0o777
                                archive.addfile(member)
                                continue
                            if not stat.S_ISREG(info.st_mode):
                                raise ValueError("snapshot contains a device, socket or FIFO: " + key)
                            if info.st_size > limit:
                                raise ValueError("snapshot archive size limit")
                            file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                            with os.fdopen(file, 'rb') as stream:
                                opened = os.fstat(stream.fileno())
                                before = (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
                                          info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                                current = (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_nlink,
                                           opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
                                if before != current:
                                    raise ValueError("snapshot file changed before reading: " + key)
                                member.size = info.st_size
                                archive.addfile(member, stream)
                                after = os.fstat(stream.fileno())
                                if current != (after.st_dev, after.st_ino, after.st_mode, after.st_nlink,
                                               after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                                    raise ValueError("snapshot file changed while reading: " + key)
                    collect(root)
                output.flush()
                os.fsync(output.fileno())
        except BaseException:
            # Remove only this invocation's exclusively-created partial output.
            destination.unlink(missing_ok=True)
            raise
        parent = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        os.close(root)


def main():
    action, *args = sys.argv[1:]
    if action == 'snapshot':
        snapshot(*args)
        return
    if action == 'source':
        root, destination = map(Path, args)
        root = root.resolve()
        names = subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', 'ls-files', '-z'], cwd=root, timeout=60).decode().rstrip('\0').split('\0')
        total = 0
        with tarfile.open(destination, 'w', format=tarfile.PAX_FORMAT) as archive:
            for name in sorted(names):
                path = root / name
                if not name or Path(name).is_absolute() or set(Path(name).parts) & {'..', '.git'}:
                    raise ValueError('unsafe source name')
                info = path.lstat()
                if path.resolve().is_relative_to(root) is False:
                    raise ValueError('source link escapes its tree')
                member = tarfile.TarInfo(name)
                member.mode = 0o755 if info.st_mode & 0o111 else 0o644
                if stat.S_ISLNK(info.st_mode):
                    if Path(os.readlink(path)).is_absolute():
                        raise ValueError('absolute source link')
                    member.type, member.linkname = tarfile.SYMTYPE, os.readlink(path)
                    archive.addfile(member)
                    continue
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError('source contains special files')
                total += info.st_size
                if total > 1024 ** 3:
                    raise ValueError('source archive limit')
                member.size = info.st_size
                with path.open('rb') as stream:
                    archive.addfile(member, stream)
        return
    if action == 'export':
        destination, expected, limit = Path(args[0]), args[1], int(args[2])
        with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
            member = archive.next()
            if not member or member.name != expected or not member.isfile() or not 0 < member.size <= limit:
                raise ValueError("export is not the expected bounded regular artifact")
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o500)
            with os.fdopen(descriptor, 'wb') as output, archive.extractfile(member) as stream:
                shutil.copyfileobj(stream, output)
                output.flush()
                os.fsync(output.fileno())
            if archive.next() is not None or destination.stat().st_size != member.size:
                raise ValueError("extra or truncated export")
        descriptor = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        os.fsync(descriptor)
        os.close(descriptor)
        return
    if action == 'fork':
        source, destination, receipt = map(Path, args)
        if source.resolve() != source or destination.resolve() != destination or destination.exists():
            raise ValueError("state paths must be new and canonical")
        before = tree(source)
        # Both source and all descendants are fenced. Copy WAL/journal files too.
        # No hardlinks: an old state must survive mutation of the new namespace.
        shutil.copytree(source, destination, symlinks=True)
        after = tree(destination)
        if before != after or before != tree(source):
            raise ValueError("state changed across its quiescent checkpoint")
        sync_tree(destination)
        value = {"source": str(source), "destination": str(destination),
                 "tree_sha256": hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
                 "files": len(before), "wal_preserved": True, "hardlinks": False}
        with receipt.open('x') as output:
            json.dump(value, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
        for directory in {receipt.parent, destination.parent}:
            descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            os.fsync(descriptor)
            os.close(descriptor)
        return
    if action == 'tree':
        print(json.dumps(tree(Path(args[0])), sort_keys=True))
        return
    if action == 'digest':
        before = tree(Path(args[0]))
        sync_tree(Path(args[0]))
        if before != tree(Path(args[0])):
            raise ValueError('checkpoint changed while sealing')
        print(hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest())
        return
    raise ValueError("unknown file boundary operation")


if __name__ == '__main__':
    main()
