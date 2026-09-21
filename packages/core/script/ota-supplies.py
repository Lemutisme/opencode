"""Freeze a full source archive and offline local build supplies. No code executes.

Usage: python3 ota-supplies.py REPO COMMIT MODELS_JSON PINNED_IMAGE NEW_DIRECTORY
The caller supplies an already installed workspace dependency tree and Bun.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile


def main():
    repository, commit, models, image, destination = sys.argv[1:]
    root, target = Path(repository).resolve(), Path(destination).resolve()
    if not re.fullmatch('[a-f0-9]{40}', commit) or not re.fullmatch('sha256:[a-f0-9]{64}', image):
        raise ValueError('exact source commit and image digest required')
    if not (root / 'node_modules').is_dir():
        raise ValueError('offline dependency tree required')
    target.mkdir(parents=True, exist_ok=False, mode=0o700)
    environment = {'PATH': os.defpath, 'HOME': '/nonexistent', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}
    with (target / 'source.tar').open('xb') as output:
        subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', 'archive', commit], cwd=root, env=environment, stdout=output, check=True, timeout=120)
    # Preserve relative workspace links; normalize only the external Bun store.
    modules = [root / 'node_modules']
    for directory, dirs, _ in os.walk(root / 'packages'):
        if 'node_modules' in dirs:
            modules.append(Path(directory) / 'node_modules')
            dirs.remove('node_modules')
    with tarfile.open(target / 'dependencies.tar', 'w') as archive:
        for directory in modules:
            for item in directory.iterdir():
                if directory == root / 'node_modules' and item.name in {'.bun', '.cache'}:
                    continue
                archive.add(item, arcname=item.relative_to(root).as_posix())
        archive.add((root / 'node_modules/.bun').resolve(), arcname='node_modules/.bun')
    shutil.copy2(shutil.which('bun'), target / 'bun')
    shutil.copy2(models, target / 'models.json')
    (target / 'empty.patch').write_bytes(b'')
    files = {}
    for name in ['source.tar', 'dependencies.tar', 'bun', 'models.json']:
        file = target / name
        with file.open('rb') as stream:
            files[name] = {'path': str(file), 'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}
    (target / 'supplies.json').write_text(json.dumps({'image': image, 'files': files}, indent=2) + '\n')
    (target / 'origin.json').write_text(json.dumps({'repository': str(root), 'commit': commit, 'scope': 'offline build supplies, no credentials'}, indent=2) + '\n')
    print(target / 'supplies.json')


if __name__ == '__main__':
    main()
