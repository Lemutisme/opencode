"""Prepare a NEW fixed-method paired diagnostic. Does not freeze or launch it."""
from pathlib import Path
import datetime
import hashlib
import json
import shutil
import subprocess
import sys
import uuid


ROOT = Path(sys.argv[1]).resolve()
SOURCE = Path(__file__).resolve().parents[2]
SUPPLIER = Path('/home/duozhou/run-artifacts/programbench-essential-r2-nine-20261007')
BUN = Path('/home/duozhou/run-artifacts/essential-rsi-20261007/toolchain/bun')
R2 = Path('/home/duozhou/run-artifacts/procontract-sol-r2-full-20260919/runtime/solver-policy.txt')


def digest(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def ref(file):
    return {'path': str(Path(file).resolve()), 'sha256': digest(file)}


def write(name, value):
    file = ROOT / name
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open('x') as output:
        json.dump(value, output, indent=2)
        output.write('\n')


if (ROOT / 'PROTOCOL-DRAFT.json').exists() or (ROOT / 'PROTOCOL.json').exists() or (ROOT / 'LAUNCH.json').exists():
    raise RuntimeError('Refusing preparation over a previously prepared, frozen or launched root')
prior = json.loads((SUPPLIER / 'PROTOCOL.json').read_text())
assert digest(R2) == 'b382202cc07a74e212a8ab41e47a117a291dce1815e4967125a360a62e76d067'
for old, new in [('cohort.py', 'launch.py'), ('run-one.ts', 'run-one.ts'), ('endpoint.ts', 'endpoint.ts'), ('credential.py', 'credential.py')]:
    shutil.copyfile(SOURCE / 'research/programbench' / old, ROOT / new)
core = json.loads(subprocess.check_output([
    str(BUN), '-e', "import { ProContractTask } from './packages/sdk/src/pro-contract/task.ts'; console.log(JSON.stringify(ProContractTask.evidenceMethod))",
], cwd=ROOT / 'runtime', text=True))
common = ('Use only capabilities admitted in this fixed-method allocation. Keep source and replayable public '
          'regressions in the workspace. Build and validate the delivery before submission; keep disposable build '
          'caches outside the handoff when practical. The supplied reference is a black-box oracle, never a '
          'solution dependency. Do not inspect harness source, private evaluator inputs or upstream implementation. '
          'No method proposal, method replacement or test-time RSI is admitted.')
methods = {
    'r2': {'instructions': R2.read_text() + '\n\n' + common},
    'core': {'instructions': core['instructions'] + '\n\n' + common},
}
for name, method in methods.items():
    write('methods/' + name + '.json', method)
    write('profiles/' + name + '.json', {
        'runtime': {'directory': str(ROOT / 'runtime'), 'bun': str(BUN), 'python': '/usr/bin/python3',
                    'bwrap': '/usr/bin/bwrap', 'rg': '/home/duozhou/run-artifacts/programbench-essential-rsi-3-20261007-v2/toolchain/rg',
                    'toolCgroup': True},
        'model': prior['model'], 'method': method, 'reserveBytes': 64 * 1024**3,
    })
assignments = []
for repeat in (1, 2):
    for index, instance in enumerate(prior['instances']):
        old = next(item for item in prior['assignments'] if item['instance'] == instance['id'] and item['repeat'] == repeat)
        task = json.loads(Path(old['task']['path']).read_text())
        first = 'r2' if (index + repeat) % 2 else 'core'
        arms = [first, 'core' if first == 'r2' else 'r2']
        for offset, arm in enumerate(arms):
            identity = f'{index}-{arm}-r{repeat}'
            goal = task['goal']
            start = goal.index('A method proposal, when the tool schema permits it,')
            end = goal.index('Final official grading is terminal', start)
            goal = goal[:start] + ('This is a fixed-method task. No method proposal, replacement or RSI is admitted. '
                                  'Preserve work and public evidence across checkpoints without resetting the task. ') + goal[end:]
            write('tasks/' + identity + '.json', {**task, 'id': 'pct_' + identity.replace('-', '_'), 'goal': goal})
            assignments.append({'id': identity, 'instance': instance['id'], 'arm': arm, 'repeat': repeat,
                                'order': index * 2 + offset, 'profile': ref(ROOT / 'profiles' / (arm + '.json')),
                                'task': ref(ROOT / 'tasks' / (identity + '.json'))})
plan = {
    'version': 1, 'status': 'draft-not-qualified-not-launched', 'kind': 'fixed-method-v2-kernel-r2-paired-diagnostic',
    'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip(),
    'sourceDirectory': str(SOURCE), 'runtimeDirectory': str(ROOT / 'runtime'),
    'upstream': json.loads((ROOT / 'runtime/RELEASE.json').read_text())['upstream'],
    'model': prior['model'], 'arms': ['r2', 'core'], 'instances': prior['instances'], 'assignments': assignments,
    'originalTasks': 36, 'repeatBlocks': 2, 'concurrencyPerBlock': 3, 'secondsPerOriginal': 21600,
    'providerCountCap': None, 'toolActionCap': None, 'requestCountCap': None, 'monetaryCap': None,
    'formalCandidateComparisons': 0, 'rsi': False, 'performanceRule': 'task-pareto',
    'cohortToken': uuid.uuid4().hex,
    'shutdown': {'graceSeconds': 30, 'killWaitSeconds': 10, 'commandSeconds': 5, 'pollSeconds': 1},
    'methodArtifacts': {arm: ref(ROOT / 'methods' / (arm + '.json')) for arm in methods},
    'r2BasePolicy': ref(R2), 'sharedSafetySuffix': common,
    'solverResources': prior['solverResources'], 'officialGraderResources': prior['officialGraderResources'],
    'referenceCalibration': prior['referenceCalibration'],
    'referenceQualification': ref(SUPPLIER / 'preparation/REFERENCE-RESULTS-v4.json'),
    'historicalReference': ref(SUPPLIER / 'HISTORICAL-REFERENCE.json'),
    'admissionOrder': 'Two arms interleaved per instance; first arm alternates by instance and reverses in repeat two. All repeat one endpoints precede repeat two admission.',
    'taskMeanRule': 'Exact passed/total mean over two fixed repeats per instance and arm; missing evidence remains unknown.',
    'claimScope': 'Exposed nine-task development diagnostic. Same V2 runtime, task-only admission and evidence retention; only fixed method instructions differ.',
    'limitations': [
        'The R2 arm is the recovered v5 fixed method plus the identical shared safety suffix on V2, not the old R2 binary or a faithful replay of unavailable historical Luna trajectories.',
        'All nine instances have prior research exposure. Historical confirmation labels do not make this a fresh blind confirmation study.',
        'Working-frontier guidance is model behavior using ordinary workspace files; the kernel does not interpret arbitrary tool output or certify a model-authored resolved label.',
        'Known reference calibration deficits remain. No ignored-test changes, denominator normalization or synthetic score imputation.',
        'Final official grading is terminal. Private diagnostics never steer further solving. No endpoint or failed allocation is retried.',
        'No deployment promotion is authorized by this development study alone; complete independent confirmation and established-full-pass protection remain required.',
    ],
    'endpointPolicy': {'safelyProvenInvalidOfficialScore': 'unknown-and-continue-independent-assignments',
                       'executionFaultOrUnknownCleanup': 'fail-closed-and-cancel', 'retry': False,
                       'witnessedProviderRefusal': 'unknown-and-continue-independent-assignments'},
    'credentialPreflight': {'metadataURL': prior['model']['upstream'].split('/v1')[0].rstrip('/') + '/key/info',
                            'marginSeconds': 900, 'keyFingerprint': None},
    'cancellation': str(ROOT / 'CANCEL'),
    'preparedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
write('PROTOCOL-DRAFT.json', plan)
write('STATUS.json', {'status': 'draft-not-qualified-not-launched', 'assignments': 36, 'modelCalls': 0})
print(json.dumps({'root': str(ROOT), 'assignments': len(assignments), 'arms': plan['arms'], 'model': prior['model']['id'],
                  'realModelCalls': 0, 'frozen': False}))
