"""Qualify and freeze one NEW task-only paired cohort; never launches it."""
from pathlib import Path
import datetime
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys


ROOT = Path(sys.argv[1]).resolve()
sys.dont_write_bytecode = True


def digest(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read(file):
    return json.loads(Path(file).read_text())


def ref(file):
    return {'path': str(Path(file).resolve()), 'sha256': digest(file)}


def create(file, value):
    with Path(file).open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


if any((ROOT / name).exists() for name in ['FROZEN.json', 'PROTOCOL.json', 'LAUNCH.json', 'CANCEL']):
    raise RuntimeError('Refusing to alter frozen, launched or cancelled cohort')
plan = read(ROOT / 'PROTOCOL-DRAFT.json')
spec = importlib.util.spec_from_file_location('paired_controller', ROOT / 'launch.py')
controller = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = controller
exec(compile((ROOT / 'launch.py').read_bytes(), str(ROOT / 'launch.py'), 'exec'), controller.__dict__)
controller.validate_protocol(plan)
assert plan['arms'] == ['r2', 'core'] and plan['rsi'] is False and plan['formalCandidateComparisons'] == 0
assert plan['performanceRule'] == 'task-pareto'
source = Path(plan['sourceDirectory'])
runtime = Path(plan['runtimeDirectory'])
for name, original in [('launch.py', 'cohort.py'), ('run-one.ts', 'run-one.ts'), ('endpoint.ts', 'endpoint.ts'), ('credential.py', 'credential.py')]:
    assert (ROOT / name).read_bytes() == (source / 'research/programbench' / original).read_bytes(), name
checks = {}
for name, count in [('controller-tests', 19), ('systemd-tests', 2), ('endpoint-tests', 1), ('credential-tests', 3)]:
    log = ROOT / 'reports' / (name + '.log')
    text = log.read_text()
    assert re.search(rf'Ran {count} tests?', text) and text.rstrip().endswith('OK'), name
    checks[name] = ref(log)
for name in ['sdk-units', 'endpoint-bun']:
    text = (ROOT / 'reports' / (name + '.log')).read_text()
    assert '0 fail' in text and not re.search(r'\n [1-9][0-9]* fail', text), name
    checks[name] = ref(ROOT / 'reports' / (name + '.log'))
for name in ['sdk-typecheck', 'driver-typecheck']:
    text = (ROOT / 'reports' / (name + '.log')).read_text()
    assert not re.search(r'error TS|error:', text), name
    checks[name] = ref(ROOT / 'reports' / (name + '.log'))
for name, arm, expected in [('core-rootfs-2', 'core', 36), ('r2-long', 'r2', 1012)]:
    qualified = read(ROOT / 'qualification' / name / 'RESULT.json')
    assert qualified['taskOnly'] is True and qualified['physicalRequests'] == expected
    assert qualified['realModel'] is False and qualified['performanceClaim'] is False
    assert qualified['result']['contract']['status'] == 'discharged' and qualified['comparisons'] == 0
    method = read(ROOT / 'methods' / (arm + '.json'))['instructions']
    actual = [json.loads(line) for file in (ROOT / 'qualification' / name / 'campaign/executions').glob('*/requests.jsonl')
              for line in file.read_text().splitlines() if json.loads(line)['type'] == 'admitted']
    assert len(actual) == expected and all(method in row['request'].get('instructions', '') for row in actual), name
    assert all(row['request']['model'] == 'scripted' and row['request']['reasoning']['effort'] == 'max' for row in actual)
    checks[name] = ref(ROOT / 'qualification' / name / 'RESULT.json')
faults = read(ROOT / 'qualification/faults/RESULT.json')
assert faults['taskOnly'] is True and faults['realModel'] is False
assert {row['mode'] for row in faults['results']} == {'cancel', 'expiry', 'withdrawal'}
assert all(row['status'] == 'escalated' and all(fence['acknowledged'] for fence in row['fenced']) for row in faults['results'])
checks['faults'] = ref(ROOT / 'qualification/faults/RESULT.json')
repair = read(ROOT / 'qualification/execution-repair/RESULT.json')
assert repair['realModel'] is False and repair['performanceClaim'] is False
assert repair['release'] == ref(runtime / 'RELEASE.json')
assert repair['source'] == ref(source / 'packages/sdk/script/pro-contract-repair-qualify.ts')
assert [row['mode'] for row in repair['results']] == ['nul-shell', 'refusal-sse', 'refusal-json', 'auth-sse', 'malformed-sse']
assert [row['physicalRequests'] for row in repair['results']] == [3, 1, 1, 1, 1]
assert all(row['executions'] == 1 and row['fence']['acknowledged'] is True for row in repair['results'])
assert repair['results'][0]['contract'] == 'discharged'
assert all(row['contract'] == 'escalated' for row in repair['results'][1:])
assert all(row['endpoint']['outcome'] == 'provider-refusal'
           and row['endpoint']['cleanup']['official'] == {'acknowledged': True, 'state': 'not-admitted', 'admitted': 0}
           for row in repair['results'][1:3])
checks['execution-repair'] = ref(ROOT / 'qualification/execution-repair/RESULT.json')

resource = read(ROOT / 'qualification/resource-oom-v2/RESULT.json')
assert resource['realModel'] is False and resource['mode'] == 'oom' and resource['result']['ok']
assert resource['result']['value']['contract']['status'] == 'discharged'
assert re.search(r'^oom_kill [1-9]', resource['toolEvents'], re.M) and re.search(r'^oom_kill 0$', resource['hostEvents'], re.M)
assert all(fence['acknowledged'] for fence in resource['fences'])
checks['resource-oom'] = ref(ROOT / 'qualification/resource-oom-v2/RESULT.json')
custody = read(ROOT / 'preparation/SUPPLIER-CUSTODY.json')
assert custody['passed'] is True and custody['status'] == 'passed' and len(custody['directories']) == 11
assert all(row['freshHashVerified'] for row in custody['files']) and all(row['freshDigestVerified'] for row in custody['directories'])
rootfs = json.loads((ROOT / 'reports/rootfs-verify.log').read_text().splitlines()[-1])
assert rootfs['passed'] is True and rootfs['instances'] == 9 and rootfs['modelCalls'] == 0
checks['rootfs'] = ref(ROOT / 'reports/rootfs-verify.log')
checks['suppliers'] = ref(ROOT / 'preparation/SUPPLIER-CUSTODY.json')
files = {}
links = []
def add(file, expected=None):
    path = Path(file)
    assert path.is_file(), str(path)
    if path.is_symlink():
        links.append({'path': str(path), 'link': os.readlink(path)})
        path = path.resolve(strict=True)
    value = digest(path)
    assert expected is None or value == expected, str(path)
    previous = files.get(str(path))
    assert previous is None or previous == value
    files[str(path)] = value

manifest = read(runtime / 'RELEASE.json')
for entry in manifest['files']:
    file = runtime / entry['path']
    assert file.resolve(strict=True).is_relative_to(runtime), str(file)
    if entry.get('link'):
        target = os.readlink(file)
        assert hashlib.sha256(('symlink:' + target).encode()).hexdigest() == entry['hash']
        links.append({'path': str(file), 'link': target})
    else:
        add(file, entry['hash'])
dependencies = []
dependency_roots = [runtime / 'node_modules', *runtime.glob('packages/*/node_modules')]
for directory in dependency_roots:
    assert directory.is_dir() and not directory.is_symlink()
    for parent, dirs, names in os.walk(directory, followlinks=False):
        for name in dirs + names:
            file = Path(parent) / name
            if file.is_symlink():
                target = os.readlink(file)
                assert not Path(target).is_absolute() and file.resolve(strict=True).is_relative_to(runtime), str(file)
                links.append({'path': str(file), 'link': target})
                dependencies.append({'path': str(file.relative_to(runtime)), 'link': target})
            elif file.is_file():
                add(file)
                dependencies.append({'path': str(file.relative_to(runtime)), 'sha256': files[str(file)]})
create(runtime / 'DEPENDENCIES.json', {'version': 1, 'kind': 'frozen-runtime-dependencies', 'sourceCommit': manifest['sourceCommit'],
                                     'roots': [str(path.relative_to(runtime)) for path in dependency_roots], 'entries': dependencies})
add(runtime / 'DEPENDENCIES.json')
add(runtime / 'RELEASE.json')
for row in custody['files']:
    add(row['path'], row['sha256'])
for assignment in plan['assignments']:
    add(assignment['profile']['path'], assignment['profile']['sha256'])
    add(assignment['task']['path'], assignment['task']['sha256'])
    profile = read(assignment['profile']['path'])
    assert 'method' in profile and 'tests' not in profile and 'proposals' not in profile
    assert profile['method'] == read(plan['methodArtifacts'][assignment['arm']]['path'])
    assert profile['runtime']['directory'] == str(runtime) and profile['runtime']['toolCgroup'] is True
    assert profile['model'] == plan['model']
    for key in ['bun', 'python', 'bwrap', 'rg']:
        add(profile['runtime'][key])
    task = read(assignment['task']['path'])
    assert 'deadline' not in task and task['verification'] == 'terminal'
    assert task['total'] == next(row['total'] for row in plan['instances'] if row['id'] == assignment['instance'])
    assert 'RSI arm' not in task['goal'] and 'No method proposal' in task['goal']
    config = read(task['verifier']['programbench']['configuration']['path'])
    image = subprocess.check_output(['docker', 'image', 'inspect', config['image'], '--format={{.Id}}'], text=True, timeout=5).strip()
    assert image == config['image']
    for metadata in [task['environment']['manifest'], task['verifier']['programbench']['bridge'],
                     task['verifier']['programbench']['configuration'], task['verifier']['programbench']['python']]:
        add(metadata['path'], metadata['sha256'])
for arm in plan['arms']:
    add(plan['methodArtifacts'][arm]['path'], plan['methodArtifacts'][arm]['sha256'])
add(plan['r2BasePolicy']['path'], plan['r2BasePolicy']['sha256'])
# Before freezing, qualify the host key and pin only its fingerprint. Raw
# key/info metadata may contain secrets and must never enter the artifact tree.
from credential import preflight
credential = preflight(plan, os.environ.get('OPENAI_API_KEY'))
plan['credentialPreflight']['keyFingerprint'] = credential['keyFingerprint']
create(ROOT / 'CREDENTIAL-VALIDITY.json', credential)
controller.validate_protocol(plan)
for name in ['launch.py', 'run-one.ts', 'endpoint.ts', 'credential.py', 'CREDENTIAL-VALIDITY.json']:
    add(ROOT / name)
for reference in checks.values():
    add(reference['path'], reference['sha256'])
plan['status'] = 'frozen'
plan['frozenAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
create(ROOT / 'PROTOCOL.json', plan)
add(ROOT / 'PROTOCOL.json')
create(ROOT / 'QUALIFICATION.json', {'admitted': True, 'sourceCommit': plan['sourceCommit'], 'workerManifest': ref(runtime / 'RELEASE.json'),
                                   'realModelCallsBeforeLaunch': 0, 'checks': checks, 'rsi': False,
                                   'limitations': 'Mechanism qualification only. The resource fixture uses retained RSI-host naming; no proposals or comparisons execute. Rootfs verification reuses a read-only historical checker on unchanged supply.'})
add(ROOT / 'QUALIFICATION.json')
create(ROOT / 'FROZEN.json', {'version': 1, 'sourceCommit': plan['sourceCommit'], 'sdkDirectory': str(runtime),
                            'bun': read(ROOT / 'profiles/core.json')['runtime']['bun'],
                            'files': [{'path': name, 'sha256': value} for name, value in sorted(files.items())],
                            'links': links, 'supplierDirectories': custody['directories'], 'frozenAt': plan['frozenAt']})
print(json.dumps({'status': 'frozen-not-launched', 'assignments': len(plan['assignments']), 'files': len(files),
                  'links': len(links), 'modelCalls': 0, 'rsi': False}))
