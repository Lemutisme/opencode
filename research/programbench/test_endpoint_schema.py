"""Opt-in actual TypeScript endpoint producer -> Python controller consumer.

PROGRAMBENCH_ENDPOINT_QUALIFY=1 PROGRAMBENCH_QUALIFICATION_ROOT=/tmp/new-root \
python3 -m unittest discover -s . -p 'test_endpoint_schema.py' -v
No model/grader calls. Receipts are explicitly scripted zero-model evidence.
"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from cohort import Child, endpoint, read, write


@unittest.skipUnless(os.environ.get('PROGRAMBENCH_ENDPOINT_QUALIFY') == '1', 'Explicit cross-language zero-model qualification')
class EndpointSchemaTests(unittest.TestCase):
    def test_actual_endpoint_producer_matches_controller_consumer(self):
        root = Path(os.environ.get('PROGRAMBENCH_QUALIFICATION_ROOT') or tempfile.mkdtemp(prefix='endpoint-schema-'))
        root.mkdir(parents=True, exist_ok=True)
        outcomes = []
        for valid, mixed, refused in ((False, False, False), (True, False, False), (False, True, False), (True, True, False), (False, False, True)):
            case = root / (('actual-valid' if valid else 'actual-invalid') + ('-mixed' if mixed else '') + ('-refusal' if refused else ''))
            case.mkdir()
            command = [os.environ.get('PROGRAMBENCH_QUALIFICATION_BUN') or shutil.which('bun'),
                       str(Path(__file__).with_name('endpoint-fixture.ts'))]
            if valid:
                command.append('--valid')
            if mixed:
                command.append('--mixed')
            if refused:
                command.append('--refusal')
            produced = subprocess.run(command, capture_output=True, text=True, timeout=10, check=True,
                                      env={**os.environ, 'PROGRAMBENCH_FIXTURE_ROOT': str(case)})
            (case / 'producer.stdout').write_text(produced.stdout)
            (case / 'producer.stderr').write_text(produced.stderr)
            observed = json.loads(produced.stdout.strip().splitlines()[-1])
            self.assertEqual(observed['root'], str(case))
            self.assertEqual(observed['errors'], [])
            fixture = read(case / 'FIXTURE.json')
            child = Child(fixture['allocation'], Path(fixture['directory']), fixture['admission'], time.monotonic())
            child.process = subprocess.Popen([sys.executable, '-c', 'raise SystemExit(' + str(fixture['returncode']) + ')'])
            child.process.wait(timeout=3)
            consumed = endpoint(child, fixture['admission']['cohortToken'])
            self.assertEqual(consumed['outcome'], 'provider-refusal' if refused else 'scored' if valid else 'invalid-official-score')
            self.assertEqual(consumed['cleanup']['native']['acknowledged'], True)
            self.assertEqual(consumed['cleanup']['official'], {'acknowledged': True, 'state': 'not-admitted' if refused else 'fenced', 'admitted': 0 if refused else 3 if mixed else 1})
            outcomes.append({'root': str(case), 'producer': observed['outcome'], 'consumer': consumed['outcome']})
        write(root / 'SCHEMA-RESULT.json', {'passed': True, 'modelCalls': 0, 'graderCalls': 0,
              'scriptedQualificationOnly': True, 'outcomes': outcomes,
              'sources': [{'path': str(Path(__file__).with_name(name)),
                           'sha256': hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()}
                          for name in ('cohort.py', 'endpoint.ts', 'endpoint-fixture.ts', 'test_endpoint_schema.py')]})


if __name__ == '__main__':
    unittest.main()
