"""Opt-in real user-systemd qualification; never invokes models or Docker.

PROGRAMBENCH_SYSTEMD_QUALIFY=1 python3 -m unittest discover -s research/programbench -p 'test_cohort_systemd.py' -v
Set PROGRAMBENCH_QUALIFICATION_ROOT to retain all controller receipts and RESULT.json.
"""
from pathlib import Path
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

from cohort import Child, Controller, SystemdBackend, birth, read, write
from test_cohort import protocol


@unittest.skipUnless(os.environ.get('PROGRAMBENCH_SYSTEMD_QUALIFY') == '1', 'Explicit zero-model real-systemd qualification')
class RealSystemdTests(unittest.TestCase):
    def test_owned_stubborn_scopes_stop_without_touching_unrelated_scope(self):
        root = Path(os.environ.get('PROGRAMBENCH_QUALIFICATION_ROOT') or tempfile.mkdtemp(prefix='cohort-systemd-'))
        root.mkdir(parents=True, exist_ok=True)
        cohort = root / 'cohort'
        cohort.mkdir()
        settings = protocol()
        settings['cohortToken'] = uuid.uuid4().hex
        settings['shutdown'] = {'graceSeconds': .4, 'killWaitSeconds': 2, 'commandSeconds': 1, 'pollSeconds': .02}
        (cohort / 'run-one.ts').write_text(
            'import sys,signal,time,os\nfrom pathlib import Path\n'
            'signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
            '(Path(__file__).parent / "runs" / sys.argv[1] / "READY").write_text(str(os.getpid()))\n'
            'while True:time.sleep(1)\n')
        control = 'pb-unrelated-' + uuid.uuid4().hex + '.scope'
        control_process = subprocess.Popen(['systemd-run', '--user', '--scope', '--quiet', '--unit', control,
            '--description', control, sys.executable, '-c',
            'import signal,time,sys,os; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); '
            'Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)', str(root / 'CONTROL-READY')],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        control_identity = None
        thread = None
        observed = {}

        def show(unit, properties):
            result = subprocess.run(['systemctl', '--user', 'show', unit, '--property=' + properties],
                                    capture_output=True, text=True, timeout=2, check=False)
            return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)

        try:
            end = time.monotonic() + 5
            while not (root / 'CONTROL-READY').exists() and time.monotonic() < end:
                time.sleep(.02)
            self.assertTrue((root / 'CONTROL-READY').exists())
            control_identity = show(control, 'Id,InvocationID,ControlGroup,ActiveState')
            self.assertEqual(control_identity['ActiveState'], 'active')

            def cancel():
                end = time.monotonic() + 5
                while time.monotonic() < end:
                    if (cohort / 'runs/0-rsi-r1/READY').exists():
                        unit = 'pb-' + settings['cohortToken'] + '-0-rsi-r1.scope'
                        observed['properties'] = show(unit, 'RuntimeMaxUSec,TimeoutStopUSec,InvocationID,ControlGroup')
                        (cohort / 'CANCEL').write_text('Real-systemd zero-model explicit cancellation\n')
                        return
                    time.sleep(.01)

            thread = threading.Thread(target=cancel)
            thread.start()
            started = time.monotonic()
            result = Controller(cohort, settings, SystemdBackend(cohort, settings, {'bun': sys.executable}),
                                reserve_bytes=0).run()
            elapsed = time.monotonic() - started
            thread.join(2)
            self.assertLess(elapsed, 8)
            self.assertTrue(result['cancelled'])
            self.assertTrue(result['admitted'])
            self.assertEqual(result['unacknowledged'], result['admitted'])
            self.assertIn('RuntimeMaxUSec', observed['properties'])
            self.assertEqual(observed['properties']['TimeoutStopUSec'], '400ms')
            survivors = []
            for allocation in result['admitted']:
                receipt = result['cleanup'][allocation]
                self.assertTrue(receipt['scope']['acknowledged'])
                self.assertTrue(receipt['scope']['identityBound'])
                self.assertTrue(receipt['forced'])
                self.assertEqual(receipt['returncode'], -signal.SIGKILL)
                pid = int((cohort / 'runs' / allocation / 'READY').read_text())
                if birth(pid) is not None:
                    survivors.append(pid)
            self.assertEqual(survivors, [])
            after = show(control, 'Id,InvocationID,ControlGroup,ActiveState')
            self.assertEqual(after, control_identity)
            self.assertIsNone(control_process.poll())
            write(root / 'RESULT.json', {'passed': True, 'elapsedSeconds': elapsed, 'modelCalls': 0,
                  'graderCalls': 0, 'survivors': survivors, 'unrelatedControlBefore': control_identity,
                  'unrelatedControlAfter': after, 'scopeProperties': observed['properties'],
                  'controllerFinished': str(cohort / 'FINISHED.json')})
        finally:
            if thread:
                thread.join(6)
            if control_identity:
                current = show(control, 'Id,InvocationID,ControlGroup,ActiveState')
                if current.get('InvocationID') == control_identity['InvocationID'] and current.get('ControlGroup') == control_identity['ControlGroup']:
                    subprocess.run(['systemctl', '--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', control],
                                   timeout=2, check=False, capture_output=True)
            control_process.wait(timeout=3)

    def test_scope_deadline_terminates_without_controller_signals(self):
        root = Path(os.environ.get('PROGRAMBENCH_QUALIFICATION_ROOT') or tempfile.mkdtemp(prefix='cohort-deadline-'))
        root.mkdir(parents=True, exist_ok=True)
        cohort = root / 'independent-deadline'
        cohort.mkdir()
        settings = protocol()
        settings['cohortToken'] = uuid.uuid4().hex
        settings['shutdown'] = {'graceSeconds': .2, 'killWaitSeconds': 2, 'commandSeconds': 1, 'pollSeconds': .02}
        (cohort / 'run-one.ts').write_text(
            'import sys,signal,time,os\nfrom pathlib import Path\n'
            'signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
            '(Path(__file__).parent / "runs" / sys.argv[1] / "READY").write_text(str(os.getpid()))\n'
            'while True:time.sleep(1)\n')
        allocation = settings['assignments'][0]
        directory = cohort / 'runs' / allocation['id']
        directory.mkdir(parents=True)
        started = int(time.time() * 1000)
        admission = {'version': 1, 'id': allocation['id'], 'admissionID': uuid.uuid4().hex,
                     'cohortToken': settings['cohortToken'], 'cohortRoot': str(cohort), 'started': started,
                     'deadline': started + 400,
                     'unit': f"pb-{settings['cohortToken']}-{allocation['id']}.scope",
                     'description': f"ProgramBench {settings['cohortToken']} {allocation['id']} {cohort}"}
        write(directory / 'ADMISSION.json', admission)
        child = Child(allocation, directory, admission, time.monotonic() + .4)
        backend = SystemdBackend(cohort, settings, {'bun': sys.executable})
        backend.preflight(child)
        child.log = (directory / 'controller.log').open('w')
        child.process = backend.launch(child, os.environ.copy())
        try:
            backend.bind(child)
            child.process.wait(timeout=3)
            elapsed = (time.time() * 1000 - started) / 1000
            self.assertLess(elapsed, 2)
            self.assertEqual(child.process.returncode, -signal.SIGKILL)
            closure = backend.closure(child)
            self.assertTrue(closure['acknowledged'])
            self.assertTrue(closure['identityBound'])
            pid = int((directory / 'READY').read_text())
            self.assertIsNone(birth(pid))
            write(root / 'DEADLINE-RESULT.json', {'passed': True, 'elapsedSeconds': elapsed,
                  'zeroModelQualificationOnly': True, 'testAllowanceSeconds': .4,
                  'productionAllowanceChanged': False, 'controllerSignalsSent': 0,
                  'modelCalls': 0, 'graderCalls': 0, 'survivors': [], 'scope': closure})
        finally:
            if child.process.poll() is None:
                backend.signal(child, signal.SIGKILL)
                child.process.wait(timeout=3)
            child.log.close()


if __name__ == '__main__':
    unittest.main()
