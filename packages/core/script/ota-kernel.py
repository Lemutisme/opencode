"""Check immutable normative source bytes in an untrusted H archive; never extract."""
import hashlib
import json
from pathlib import PurePosixPath
import sys
import tarfile


def verify(manifest, archive):
    if manifest.get('kind') != 'ota-fixed-kernel-v1' or not manifest.get('files'):
        raise ValueError('fixed Kernel manifest required')
    expected = manifest['files']
    seen, matched = set(), set()
    total = 0
    with tarfile.open(archive, 'r:') as stream:
        for item in stream:
            name = item.name.rstrip('/')
            if name in seen or not name or PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts:
                raise ValueError('ambiguous source archive path')
            seen.add(name)
            total += item.size
            if item.size < 0 or total > 1024 ** 3:
                raise ValueError('source archive bound exceeded')
            if name not in expected:
                continue
            record = expected[name]
            mode = 0o755 if item.mode & 0o111 else 0o644
            if not item.isfile() or item.size > 1024 ** 2 or mode != record['mode']:
                raise ValueError('fixed Kernel file type/mode changed: ' + name)
            if hashlib.sha256(stream.extractfile(item).read()).hexdigest() != record['sha256']:
                raise ValueError('fixed Kernel bytes changed: ' + name)
            matched.add(name)
    if matched != set(expected):
        raise ValueError('fixed Kernel source missing: ' + ', '.join(sorted(set(expected) - matched)))
    return {'passed': True, 'kind': 'ota-fixed-kernel-check-v1', 'files': sorted(matched)}


if __name__ == '__main__':
    try:
        with open(sys.argv[1]) as source:
            result = verify(json.load(source), sys.argv[2])
    except (ValueError, OSError, tarfile.TarError, KeyError) as error:
        print(json.dumps({'passed': False, 'reason': str(error)}))
        sys.exit(65)
    print(json.dumps(result))
