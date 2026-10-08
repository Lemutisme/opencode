"""One frozen ProgramBench cohort; no retries and no cumulative execution cap.

Usage: python3 cohort.py /absolute/cohort/root
The production backend only signals scopes it created and positively identified.
A backend can be explicitly injected by local, zero-model qualification tests.
"""
from dataclasses import dataclass, field
from pathlib import Path
import argparse
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import time
import uuid


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def create(path, text):
    try:
        with path.open('x') as output:
            output.write(text)
    except FileExistsError:
        return False
    return True


def birth(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except FileNotFoundError:
        return None


def validate_protocol(protocol):
    assignments = protocol['assignments']
    instances = [item['id'] for item in protocol['instances']]
    if len(instances) != 9 or len(set(instances)) != 9:
        raise ValueError('Exactly nine distinct frozen instances required')
    expected = {(instance, repeat) for instance in instances for repeat in (1, 2)}
    observed = {(item['instance'], item['repeat']) for item in assignments}
    if len(assignments) != 18 or len({item['id'] for item in assignments}) != 18 or observed != expected:
        raise ValueError('Exactly two fixed repeats per instance required')
    if any(not re.fullmatch(r'[0-8]-rsi-r[12]', item['id']) for item in assignments):
        raise ValueError('Unsafe or non-RSI allocation name')
    if any(item['id'] != f"{instances.index(item['instance'])}-rsi-r{item['repeat']}" for item in assignments):
        raise ValueError('Allocation names must follow frozen instance order')
    for key, value in {'originalTasks': 18, 'repeatBlocks': 2, 'concurrencyPerBlock': 3,
                       'secondsPerOriginal': 21600}.items():
        if protocol.get(key) != value:
            raise ValueError(f'Frozen coordinate {key} must equal {value}')
    for key in ('providerCountCap', 'toolActionCap', 'requestCountCap', 'monetaryCap'):
        if key not in protocol or protocol[key] is not None:
            raise ValueError(f'{key} must explicitly be null')
    if not re.fullmatch(r'[a-f0-9]{32}', protocol.get('cohortToken', '')):
        raise ValueError('A separately frozen unique cohortToken is required')
    shutdown = protocol['shutdown']
    for key in ('graceSeconds', 'killWaitSeconds', 'commandSeconds', 'pollSeconds'):
        value = shutdown.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError(f'Invalid bounded shutdown setting: {key}')
    if shutdown['graceSeconds'] > 180 or shutdown['killWaitSeconds'] > 30 or shutdown['commandSeconds'] > 10:
        raise ValueError('Shutdown operation exceeds qualification bounds')
    if shutdown['pollSeconds'] > 1:
        raise ValueError('Deadline polling must be at most one second')


@dataclass
class Child:
    allocation: dict
    directory: Path
    admission: dict
    deadline_monotonic: float
    process: object = None
    log: object = None
    identity: dict = field(default_factory=dict)
    errors: list = field(default_factory=list)
    cancellation_sent: bool = False
    forced: bool = False
    closure: dict = field(default_factory=dict)
    endpoint: dict = field(default_factory=dict)

    @property
    def id(self):
        return self.allocation['id']


class SystemdBackend:
    """Never fall back to a shared cgroup or an unverified unit name."""

    def __init__(self, root, protocol, frozen):
        self.root = root
        self.protocol = protocol
        self.frozen = frozen
        self.timeout = protocol['shutdown']['commandSeconds']

    def command(self, args):
        result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=self.timeout, check=False)
        return result

    def inspect(self, child):
        unit = child.admission['unit']
        result = self.command(['systemctl', '--user', 'show', unit,
                               '--property=Id,InvocationID,ControlGroup,ActiveState,LoadState,Description'])
        values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        required = {'Id', 'InvocationID', 'ControlGroup', 'ActiveState', 'LoadState', 'Description'}
        absent = (required.issubset(values) and values['Id'] == unit
                  and values['LoadState'] == 'not-found' and values['ActiveState'] == 'inactive'
                  and values['InvocationID'] == '' and values['ControlGroup'] == '')
        if (result.returncode != 0 and not (result.returncode == 1 and absent)) or not required.issubset(values) or values['Id'] != unit:
            raise RuntimeError('Cannot positively inspect owned scope: ' + result.stderr.strip())
        return values

    def preflight(self, child):
        if self.inspect(child)['LoadState'] != 'not-found':
            raise RuntimeError('Refusing existing scope ' + child.admission['unit'])

    def launch(self, child, env):
        remaining = max(0.001, (child.admission['deadline'] - time.time() * 1000) / 1000)
        args = ['systemd-run', '--user', '--scope', '--quiet', '--unit', child.admission['unit'],
                '--description', child.admission['description'], '-p', 'Delegate=yes',
                '-p', 'OOMPolicy=continue', '-p', 'CPUQuota=400%', '-p', 'MemoryMax=8G',
                '-p', 'TasksMax=1024', '-p', f'RuntimeMaxSec={remaining:.3f}',
                '-p', f"TimeoutStopSec={self.protocol['shutdown']['graceSeconds']}",
                self.frozen['bun'], str(self.root / 'run-one.ts'), child.id,
                str(child.admission['deadline'])]
        return subprocess.Popen(args, cwd=self.root, stdout=child.log, stderr=subprocess.STDOUT, env=env)

    def owned(self, child, values):
        if child.admission['unit'] != f"pb-{self.protocol['cohortToken']}-{child.id}.scope":
            raise RuntimeError('Scope does not belong to this cohort token')
        if read(child.directory / 'ADMISSION.json') != child.admission:
            raise RuntimeError('Durable admission identity changed')
        if values['LoadState'] == 'not-found':
            return False
        if values['Description'] != child.admission['description']:
            raise RuntimeError('Scope description ownership mismatch')
        if not re.fullmatch(r'[a-f0-9]{32}', values['InvocationID']):
            raise RuntimeError('Scope lacks an invocation identity')
        group = values['ControlGroup']
        if not group.startswith('/user.slice/') or not group.endswith('/' + child.admission['unit']):
            raise RuntimeError('Scope does not have an allocation-specific cgroup')
        identity = {'InvocationID': values['InvocationID'], 'ControlGroup': group}
        if child.identity and identity != child.identity:
            raise RuntimeError('Scope invocation or cgroup identity changed')
        if not child.identity:
            child.identity = identity
            write(child.directory / 'SCOPE-OWNERSHIP.json', {**child.admission, **identity,
                  'launcherPID': child.process.pid, 'launcherBirth': birth(child.process.pid)})
        return True

    def bind(self, child):
        end = time.monotonic() + self.timeout
        while time.monotonic() < end:
            values = self.inspect(child)
            # systemd exposes a transient loaded/inactive unit before assigning
            # InvocationID and cgroup. Wait boundedly; never signal it unbound.
            activating = (values['LoadState'] == 'loaded' and values['ActiveState'] in ('inactive', 'activating')
                          and values['Description'] == child.admission['description']
                          and not values['InvocationID'] and not values['ControlGroup'])
            if not activating and self.owned(child, values):
                return
            if child.process.poll() is not None:
                raise RuntimeError('Scope launcher exited before identity binding')
            time.sleep(0.02)
        raise RuntimeError('Scope ownership was not acknowledged at startup')

    def signal(self, child, sig):
        values = self.inspect(child)
        if not self.owned(child, values):
            return
        result = self.command(['systemctl', '--user', 'kill', '--kill-whom=all',
                               '--signal=' + signal.Signals(sig).name, child.admission['unit']])
        if result.returncode != 0:
            # A unit disappearing between inspect and kill is already closed.
            if self.inspect(child)['LoadState'] != 'not-found':
                raise RuntimeError('Owned scope signal failed: ' + result.stderr.strip())

    def closure(self, child):
        values = self.inspect(child)
        if values['LoadState'] == 'not-found':
            return {'acknowledged': child.process.poll() is not None, 'state': 'absent',
                    'identityBound': bool(child.identity)}
        # RuntimeMaxSec leaves a failed unit record after systemd removes its
        # empty cgroup. Match the retained invocation and independently verify
        # that its previously bound cgroup has no live resources.
        if (child.identity and values['ActiveState'] in ('inactive', 'failed')
                and values['ControlGroup'] == ''
                and values['InvocationID'] == child.identity['InvocationID']
                and values['Description'] == child.admission['description']
                and read(child.directory / 'ADMISSION.json') == child.admission):
            group = Path('/sys/fs/cgroup' + child.identity['ControlGroup'])
            empty = not group.exists() or dict(line.split() for line in (group / 'cgroup.events').read_text().splitlines()).get('populated') == '0'
            return {'acknowledged': empty and child.process.poll() is not None,
                    'state': 'inactive-empty', 'identityBound': True, 'identity': child.identity}
        self.owned(child, values)
        return {'acknowledged': False, 'state': values['ActiveState'], 'identity': child.identity}


def endpoint(child, token):
    """Classify only host-owned terminal evidence, never solver text or a score alone."""
    record = read(child.directory / 'ENDPOINT.json')
    expected = {'version': 1, 'id': child.id, 'cohortToken': token,
                'admissionID': child.admission['admissionID'],
                'instance': child.allocation['instance'], 'deadline': child.admission['deadline'],
                'profileSha256': child.allocation['profile']['sha256'],
                'taskSha256': child.allocation['task']['sha256']}
    if any(record.get(key) != value for key, value in expected.items()):
        raise ValueError('Endpoint does not match this admitted original task')
    if not isinstance(record.get('finished'), (int, float)) or not math.isfinite(record['finished']):
        raise ValueError('Endpoint lacks a valid finish timestamp')
    if record['finished'] < child.admission['started']:
        raise ValueError('Endpoint predates admission')
    artifacts = record.get('artifacts')
    if not isinstance(artifacts, list) or not artifacts:
        raise ValueError('Endpoint has no bound host evidence')
    paths = set()
    kinds = {}
    for reference in artifacts:
        path = Path(reference['path'])
        if (not path.is_absolute() or path.is_symlink() or path.resolve(strict=True) != path
                or not path.is_relative_to(child.directory) or not path.is_file() or path in paths):
            raise ValueError('Endpoint artifact is not a unique canonical allocation file')
        with path.open('rb') as source:
            if hashlib.file_digest(source, 'sha256').hexdigest() != reference['sha256']:
                raise ValueError('Endpoint artifact hash mismatch: ' + str(path))
        paths.add(path)
        kinds.setdefault(reference['kind'], []).append(path)
    for kind, filename in (('admission', 'ADMISSION.json'), ('classification', 'CLASSIFICATION.json')):
        if kinds.get(kind) != [child.directory / filename]:
            raise ValueError('Endpoint missing exact host ' + kind + ' linkage')
    classification = read(child.directory / 'CLASSIFICATION.json')
    if any(classification.get(key) != value for key, value in expected.items()):
        raise ValueError('Classification does not match this admitted original task')
    if classification.get('outcome') != record.get('outcome'):
        raise ValueError('Endpoint and classification outcome disagree')
    if record.get('outcome') in ('execution-fault', 'cancelled'):
        return record
    if record.get('outcome') not in ('scored', 'invalid-official-score'):
        raise ValueError('Unknown endpoint outcome')
    if (classification.get('eligible') is not True or classification.get('errors') != []
            or not classification.get('predicates')
            or any(value is not True for value in classification['predicates'].values())):
        raise ValueError('Host original-endpoint classification did not admit this evidence')
    required = {'native-fence', 'native-ownership', 'native-admission', 'native-handoff', 'verification',
                'official-result', 'official-fence', 'official-wrapper-fence', 'official-subject', 'subject-archive'}
    if not required.issubset(kinds) or kinds.get('result') != [child.directory / 'RESULT.json']:
        raise ValueError('Endpoint lacks complete native/official original-subject linkage')
    cleanup = record.get('cleanup', {})
    if any(cleanup.get(key, {}).get('acknowledged') is not True for key in ('native', 'official')):
        raise ValueError('Endpoint resource cleanup is not positively acknowledged')
    result = read(child.directory / 'RESULT.json')
    if record['outcome'] == 'scored':
        if child.process.returncode != 0 or result.get('valid') is not True:
            raise ValueError('Scored endpoint and process/result disagree')
        return record
    if child.process.returncode not in (0, 1) or result.get('valid') is not False:
        raise ValueError('Invalid official endpoint and process/result disagree')
    return record


class Controller:
    def __init__(self, root, protocol, backend, *, reserve_bytes=64 * 1024 ** 3):
        self.root = Path(root).resolve()
        self.protocol = protocol
        self.backend = backend
        self.reserve_bytes = reserve_bytes
        self.children = []
        self.admitted = []
        self.completed = []
        self.unknown = []
        self.closed = {}
        self.failure = None
        self.cancelled_at = None
        self.cancelled_monotonic = None
        self.signal_requested = None
        self.repeat = 1
        self.queue = []
        self.shutdown = protocol['shutdown']

    def cancel(self, reason):
        # Signal handlers only set a flag. All I/O and child work occurs in this loop.
        if self.cancelled_at is None:
            marker = self.root / 'CANCEL'
            create(marker, reason + '\n')
            self.cancelled_at = marker.stat().st_mtime
            self.cancelled_monotonic = time.monotonic()
            write(self.root / 'CANCELLATION.json', {'requested': self.cancelled_at,
                  'observed': time.time(), 'reason': reason,
                  'graceSeconds': self.shutdown['graceSeconds']})
        self.queue = []
        for child in self.children:
            if child.cancellation_sent:
                continue
            child.cancellation_sent = True
            campaign = child.directory / 'campaign'
            campaign.mkdir(exist_ok=True)
            create(campaign / 'CANCEL', 'Cancelled by owning cohort: ' + reason + '\n')
            try:
                self.backend.signal(child, signal.SIGTERM)
            except Exception as error:
                child.errors.append('TERM not acknowledged: ' + str(error))

    def fail(self, message):
        self.failure = self.failure or str(message)
        self.cancel(self.failure)

    def admit(self, allocation):
        if self.signal_requested or (self.root / 'CANCEL').exists():
            self.cancel('Explicit cohort cancellation')
            return
        if shutil.disk_usage(self.root).free < self.reserve_bytes:
            raise RuntimeError('64 GiB infrastructure reserve')
        directory = self.root / 'runs' / allocation['id']
        directory.mkdir(parents=True, mode=0o700)
        started = int(time.time() * 1000)
        token = self.protocol['cohortToken']
        admission = {'version': 1, 'id': allocation['id'], 'admissionID': uuid.uuid4().hex,
                     'cohortToken': token, 'cohortRoot': str(self.root), 'started': started,
                     'deadline': started + self.protocol['secondsPerOriginal'] * 1000,
                     'unit': f"pb-{token}-{allocation['id']}.scope",
                     'description': f"ProgramBench {token} {allocation['id']} {self.root}"}
        child = Child(allocation, directory, admission,
                      time.monotonic() + self.protocol['secondsPerOriginal'])
        self.backend.preflight(child)
        if self.signal_requested or (self.root / 'CANCEL').exists():
            self.cancel('Explicit cohort cancellation')
            return
        write(directory / 'ADMISSION.json', admission)
        child.log = (directory / 'controller.log').open('w')
        env = {**os.environ, 'PROCONTRACT_COHORT_TOKEN': token,
               'PROCONTRACT_ALLOCATION_ID': child.id,
               'PROCONTRACT_ADMISSION_ID': admission['admissionID']}
        try:
            child.process = self.backend.launch(child, env)
        except BaseException:
            child.log.close()
            raise
        # Register immediately: failures while binding ownership also enter bounded cleanup.
        self.children.append(child)
        self.admitted.append(child.id)
        self.backend.bind(child)

    def observe(self, child):
        try:
            child.closure = self.backend.closure(child)
        except Exception as error:
            child.closure = {'acknowledged': False, 'error': str(error)}
        return child.closure.get('acknowledged') is True

    def retire(self, child):
        child.log.close()
        self.children.remove(child)
        receipt = {'id': child.id, 'returncode': child.process.poll(), 'scope': child.closure,
                   'forced': child.forced, 'errors': child.errors, 'endpoint': child.endpoint,
                   'finished': time.time()}
        self.closed[child.id] = receipt
        write(child.directory / 'CONTROLLER-CLEANUP.json', receipt)

    def collect(self):
        for child in list(self.children):
            if child.process.poll() is None:
                continue
            if not self.observe(child):
                self.fail('Unacknowledged scope after launcher exit: ' + child.id)
                continue
            try:
                child.endpoint = endpoint(child, self.protocol['cohortToken'])
                if child.endpoint['outcome'] not in ('scored', 'invalid-official-score'):
                    self.fail('Original execution fault: ' + child.id + ': ' + child.endpoint['outcome'])
            except Exception as error:
                child.errors.append('Endpoint: ' + str(error))
                self.fail('Incomplete original endpoint: ' + child.id + ': ' + str(error))
            if child.endpoint.get('outcome') == 'scored':
                self.completed.append(child.id)
            if child.endpoint.get('outcome') == 'invalid-official-score':
                self.unknown.append(child.id)
            self.retire(child)

    def status(self):
        write(self.root / 'STATUS.json', {'status': 'cancelling' if self.cancelled_at is not None else
              ('running' if self.children else 'between-blocks'), 'repeatBlock': self.repeat,
              'admitted': self.admitted, 'running': [child.id for child in self.children],
              'queued': [item['id'] for item in self.queue], 'completed': self.completed,
              'unknown': self.unknown, 'failure': self.failure,
              'cancelled': self.cancelled_at is not None, 'cancelledAt': self.cancelled_at,
              'updated': time.time()})

    def drain(self):
        # All children share one first-cancellation clock; no per-child 180 s waits.
        grace_end = self.cancelled_monotonic + self.shutdown['graceSeconds']
        while self.children and time.monotonic() < grace_end:
            self.collect()
            self.status()
            time.sleep(min(self.shutdown['pollSeconds'], max(0, grace_end - time.monotonic())))
        for child in self.children:
            child.forced = True
            try:
                self.backend.signal(child, signal.SIGKILL)
            except Exception as error:
                child.errors.append('KILL not acknowledged: ' + str(error))
        kill_end = time.monotonic() + self.shutdown['killWaitSeconds']
        while self.children and time.monotonic() < kill_end:
            self.collect()
            self.status()
            time.sleep(min(self.shutdown['pollSeconds'], max(0, kill_end - time.monotonic())))
        # Do not claim gone merely because the controller gave up waiting.
        for child in list(self.children):
            self.observe(child)
            self.retire(child)

    def run(self):
        previous = {}
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, lambda number, _frame: setattr(self, 'signal_requested', number))
        try:
            for repeat in (1, 2):
                self.repeat = repeat
                self.queue = sorted([item for item in self.protocol['assignments'] if item['repeat'] == repeat],
                                    key=lambda item: int(item['id'].split('-')[0]))
                while self.queue or self.children:
                    if self.signal_requested or (self.root / 'CANCEL').exists():
                        self.cancel('Explicit cohort cancellation')
                    if self.cancelled_at is not None:
                        break
                    self.collect()
                    if self.cancelled_at is not None:
                        break
                    for child in self.children:
                        if time.monotonic() >= child.deadline_monotonic or time.time() * 1000 >= child.admission['deadline']:
                            self.fail('Original task deadline reached: ' + child.id)
                            break
                    while self.queue and len(self.children) < self.protocol['concurrencyPerBlock'] and self.cancelled_at is None:
                        self.admit(self.queue.pop(0))
                    self.status()
                    time.sleep(self.shutdown['pollSeconds'])
                if self.cancelled_at is not None:
                    break
        except BaseException as error:
            self.fail(str(error))
        finally:
            # No blocking Popen.wait and no unbounded repeated graceful cancellation.
            try:
                if self.children:
                    self.cancel(self.failure or 'Controller closing')
                    self.drain()
            except BaseException as error:
                self.failure = self.failure or str(error)
                for child in list(self.children):
                    child.errors.append('Cleanup raised: ' + str(error))
                    try:
                        self.backend.signal(child, signal.SIGKILL)
                    except Exception as cleanup_error:
                        child.errors.append('Final KILL not acknowledged: ' + str(cleanup_error))
                    self.observe(child)
                    self.retire(child)
            finally:
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
                unacknowledged = [name for name, receipt in self.closed.items()
                                  if receipt['scope'].get('acknowledged') is not True
                                  or any(receipt['endpoint'].get('cleanup', {}).get(key, {}).get('acknowledged') is not True
                                         for key in ('native', 'official'))]
                complete = len(self.completed) == len(self.protocol['assignments']) and self.cancelled_at is None
                execution_complete = (len(self.completed) + len(self.unknown) == len(self.protocol['assignments'])
                                      and self.cancelled_at is None and not unacknowledged)
                result = {'finished': time.time(), 'failure': self.failure,
                          'cancelled': self.cancelled_at is not None, 'cancelledAt': self.cancelled_at,
                          'complete': complete, 'scoresComplete': complete, 'executionComplete': execution_complete,
                          'admitted': self.admitted, 'completed': self.completed, 'unknown': self.unknown,
                          'unacknowledged': unacknowledged, 'cleanup': self.closed}
                write(self.root / 'FINISHED.json', result)
                write(self.root / 'STATUS.json', {**result, 'status': 'complete' if complete else
                      ('complete-with-unknown' if execution_complete else 'closed-incomplete'),
                      'running': [name for name, receipt in self.closed.items()
                                  if receipt['scope'].get('acknowledged') is not True], 'updated': time.time()})
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', nargs='?', type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    root = args.root.resolve()
    protocol = read(root / 'PROTOCOL.json')
    frozen = read(root / 'FROZEN.json')
    validate_protocol(protocol)
    if read(root / 'QUALIFICATION.json').get('admitted') is not True:
        raise RuntimeError('Qualification not admitted')
    for reference in frozen['files']:
        with Path(reference['path']).open('rb') as source:
            if hashlib.file_digest(source, 'sha256').hexdigest() != reference['sha256']:
                raise RuntimeError('Frozen input changed: ' + reference['path'])
    if (root / 'LAUNCH.json').exists() or (root / 'CANCEL').exists():
        raise RuntimeError('Refusing replay or cancelled admission')
    if not os.environ.get('OPENAI_API_KEY'):
        raise RuntimeError('Host model credential absent')
    if not create(root / 'LAUNCH.json', json.dumps({'started': time.time(), 'pid': os.getpid(),
                  'birth': birth(os.getpid()), 'source': protocol['sourceCommit'], 'model': protocol['model'],
                  'cohortToken': protocol['cohortToken'], 'originalTasks': 18, 'modelCallsBeforeLaunch': 0}, indent=2) + '\n'):
        raise RuntimeError('Refusing concurrent launch')
    result = Controller(root, protocol, SystemdBackend(root, protocol, frozen)).run()
    return 0 if result['executionComplete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
