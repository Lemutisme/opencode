"""Zero-model real-process fixture for controller qualification only."""
from pathlib import Path
import json
import hashlib
import os
import signal
import sys
import time

root = Path(sys.argv[1])
mode = sys.argv[2]
admission = json.loads((root / 'ADMISSION.json').read_text())
if mode == 'ignore':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    (root / 'READY').write_text(str(os.getpid()))
    while True:
        time.sleep(1)
if mode == 'missing':
    raise SystemExit(0)
result = {'valid': mode == 'scored'}
(root / 'RESULT.json').write_text(json.dumps(result))
endpoint = {'version': 1, 'id': admission['id'], 'admissionID': admission['admissionID'],
            'cohortToken': admission['cohortToken'], 'instance': 'task-' + admission['id'].split('-')[0],
            'deadline': admission['deadline'], 'profileSha256': 'a' * 64, 'taskSha256': 'b' * 64,
            'outcome': 'scored' if mode == 'scored' else 'invalid-official-score',
            'cleanup': {'native': {'acknowledged': mode != 'unack'}, 'official': {'acknowledged': True}},
            'finished': int(time.time() * 1000)}
if mode == 'wrong-binding':
    endpoint['deadline'] += 1
classification = {**endpoint, 'eligible': True, 'errors': [],
                  'predicates': {'scriptedLocalEndpoint': mode != 'wrong-classification'}}
(root / 'CLASSIFICATION.json').write_text(json.dumps(classification))
artifacts = [('admission', root / 'ADMISSION.json'), ('classification', root / 'CLASSIFICATION.json'),
             ('result', root / 'RESULT.json')]
for kind in ('native-fence', 'native-ownership', 'native-admission', 'native-handoff', 'verification',
             'official-result', 'official-fence', 'official-wrapper-fence', 'official-subject', 'subject-archive'):
    path = root / (kind + '.fixture')
    path.write_text('Zero-model local process fixture; not benchmark evidence')
    artifacts.append((kind, path))
endpoint['artifacts'] = [{'kind': kind, 'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                         for kind, path in artifacts]
(root / 'ENDPOINT.json').write_text(json.dumps(endpoint))
if mode == 'wrong-artifact':
    (root / 'official-subject.fixture').write_text('Evidence changed after terminal hashing')
raise SystemExit(0 if result['valid'] else 1)
