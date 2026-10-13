"""Run: python3 -m unittest discover -s research/programbench -p 'test_*.py' -v

No provider/grader calls, no Docker, no fake Popen. Local backend is explicitly
injected; production CLI always validates six-hour protocol and uses systemd.
"""
from pathlib import Path
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from cohort import Controller, SystemdBackend, birth, read, validate_protocol


class LocalBackend:
    def __init__(self, modes=None):
        self.modes = modes or {}
        self.children = []
        self.signals = []

    def preflight(self, child):
        pass

    def launch(self, child, env):
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('local_child.py')),
                                    str(child.directory), self.modes.get(child.id, 'scored')],
                                   stdout=child.log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
        self.children.append(process)
        return process

    def bind(self, child):
        child.identity = {'pid': child.process.pid, 'birth': birth(child.process.pid)}

    def signal(self, child, sig):
        self.signals.append((child.id, sig))
        if child.process.poll() is not None:
            return
        if (child.identity.get('pid') != child.process.pid
                or child.identity.get('birth') != birth(child.process.pid)
                or os.getpgid(child.process.pid) != child.process.pid):
            raise RuntimeError('Local process identity mismatch')
        os.killpg(child.process.pid, sig)

    def closure(self, child):
        return {'acknowledged': child.process.poll() is not None,
                'state': 'absent' if child.process.poll() is not None else 'running'}

    def dispose(self):
        for process in self.children:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)


def protocol():
    return {'cohortToken': '0123456789abcdef0123456789abcdef', 'instances': [{'id': f'task-{i}'} for i in range(9)],
            'assignments': [{'id': f'{i}-rsi-r{repeat}', 'instance': f'task-{i}', 'repeat': repeat, 'profile': {'sha256': 'a' * 64},
                             'task': {'sha256': 'b' * 64}}
                            for i in range(9) for repeat in (1, 2)],
            'originalTasks': 18, 'repeatBlocks': 2, 'concurrencyPerBlock': 3, 'secondsPerOriginal': 21600,
            'providerCountCap': None, 'toolActionCap': None, 'requestCountCap': None, 'monetaryCap': None,
            'shutdown': {'graceSeconds': .2, 'killWaitSeconds': .4, 'commandSeconds': .1, 'pollSeconds': .01}}


class CohortTests(unittest.TestCase):
    def test_paired_fixed_methods_require_every_task_arm_repeat_and_exact_order(self):
        value = protocol()
        value['arms'] = ['r2', 'core']
        value['originalTasks'] = 36
        value['assignments'] = [
            {**item, 'arm': arm, 'id': item['id'].replace('-rsi-', '-' + arm + '-'),
             'order': int(item['id'].split('-')[0]) * 2 + index}
            for item in value['assignments'] for index, arm in enumerate(value['arms'])]
        validate_protocol(value)
        duplicate = {**value, 'assignments': value['assignments'][:-1] + [value['assignments'][0]]}
        with self.assertRaises(ValueError):
            validate_protocol(duplicate)
        with self.assertRaises(ValueError):
            validate_protocol({**value, 'assignments': value['assignments'][:-1]})
        reordered = [dict(item) for item in value['assignments']]
        reordered[-1]['order'] = 0
        with self.assertRaises(ValueError):
            validate_protocol({**value, 'assignments': reordered})

    def test_paired_fixed_methods_execute_all_slots_in_the_frozen_counterbalanced_order(self):
        value = protocol()
        value['arms'] = ['r2', 'core']
        value['originalTasks'] = 36
        value['assignments'] = [
            {**item, 'arm': arm, 'id': item['id'].replace('-rsi-', '-' + arm + '-'),
             'order': int(item['id'].split('-')[0]) * 2 + index}
            for item in value['assignments'] for index, arm in enumerate(
                value['arms'] if item['repeat'] == 1 else list(reversed(value['arms'])))]
        validate_protocol(value)
        controller = self.controller(settings=value)
        result = controller.run()
        self.assertTrue(result['complete'])
        expected = [item['id'] for repeat in (1, 2) for item in sorted(
            [row for row in value['assignments'] if row['repeat'] == repeat], key=lambda row: row['order'])]
        self.assertEqual(result['admitted'], expected)
        self.assertEqual(len(result['completed']), 36)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cohort-test-')
        self.root = Path(self.temporary.name)
        self.backends = []

    def tearDown(self):
        for backend in self.backends:
            backend.dispose()
        self.temporary.cleanup()

    def controller(self, backend=None, settings=None):
        backend = backend or LocalBackend()
        self.backends.append(backend)
        return Controller(self.root, settings or protocol(), backend, reserve_bytes=0)

    def cancel_when_ready(self, *, repeat=False):
        result = {}

        def cancel():
            end = time.monotonic() + 3
            while time.monotonic() < end:
                if (self.root / 'runs/0-rsi-r1/READY').exists():
                    marker = self.root / 'CANCEL'
                    marker.write_text('Operator requested cancellation\n')
                    result['mtime'] = marker.stat().st_mtime
                    if repeat:
                        for _ in range(8):
                            time.sleep(.025)
                            # Persistent marker is observed on every cancellation poll.
                            if (self.root / 'STATUS.json').exists():
                                result.setdefault('statuses', []).append(read(self.root / 'STATUS.json')['status'])
                    return
                time.sleep(.005)

        thread = threading.Thread(target=cancel)
        thread.start()
        return thread, result

    def test_fixed_design_and_all_real_subprocesses_complete(self):
        validate_protocol(protocol())
        controller = self.controller()
        result = controller.run()
        self.assertTrue(result['complete'])
        self.assertTrue(result['executionComplete'])
        self.assertEqual(len(controller.backend.children), 18)
        self.assertEqual(result['admitted'][:9], [f'{i}-rsi-r1' for i in range(9)])
        self.assertEqual(result['admitted'][9:], [f'{i}-rsi-r2' for i in range(9)])
        self.assertFalse(result['unacknowledged'])

    def test_acknowledged_invalid_score_does_not_cancel_siblings(self):
        result = self.controller(LocalBackend({'0-rsi-r1': 'invalid'})).run()
        self.assertTrue(result['executionComplete'])
        self.assertFalse(result['complete'])
        self.assertEqual(result['unknown'], ['0-rsi-r1'])
        self.assertEqual(len(result['completed']), 17)
        self.assertFalse(result['cancelled'])
        self.assertEqual(read(self.root / 'STATUS.json')['status'], 'complete-with-unknown')

    def test_invalid_score_with_missing_cleanup_fails_closed(self):
        result = self.controller(LocalBackend({'0-rsi-r1': 'unack', '1-rsi-r1': 'ignore'})).run()
        self.assertTrue(result['cancelled'])
        self.assertFalse(result['executionComplete'])
        self.assertIn('0-rsi-r1', result['unacknowledged'])
        self.assertFalse(result['unknown'])
        self.assertLess(len(result['admitted']), 18)

    def test_missing_endpoint_fails_closed(self):
        result = self.controller(LocalBackend({'0-rsi-r1': 'missing'})).run()
        self.assertTrue(result['cancelled'])
        self.assertIn('0-rsi-r1', result['unacknowledged'])

    def test_term_ignoring_child_is_killed_with_bounded_first_cancel_clock(self):
        controller = self.controller(LocalBackend({'0-rsi-r1': 'ignore'}))
        thread, cancellation = self.cancel_when_ready(repeat=True)
        started = time.monotonic()
        result = controller.run()
        thread.join(timeout=2)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(result['cancelledAt'], cancellation['mtime'])
        self.assertEqual(read(self.root / 'CANCELLATION.json')['requested'], cancellation['mtime'])
        self.assertEqual((self.root / 'CANCEL').stat().st_mtime, cancellation['mtime'])
        self.assertIn('cancelling', cancellation['statuses'])
        self.assertIn(('0-rsi-r1', signal.SIGKILL), controller.backend.signals)
        self.assertTrue(result['cleanup']['0-rsi-r1']['scope']['acknowledged'])
        # A killed process is not native/official cleanup evidence.
        self.assertIn('0-rsi-r1', result['unacknowledged'])

    def test_original_deadline_is_enforced_even_without_cancel_marker(self):
        settings = protocol()
        settings['secondsPerOriginal'] = .15  # Test injection only; production validator rejects this.
        controller = self.controller(LocalBackend({'0-rsi-r1': 'ignore'}), settings)
        started = time.monotonic()
        result = controller.run()
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertIn('deadline reached', result['failure'])
        self.assertTrue(result['cleanup']['0-rsi-r1']['scope']['acknowledged'])

    def test_exception_after_launch_still_has_bounded_cleanup(self):
        class BindingFailure(LocalBackend):
            def bind(self, child):
                super().bind(child)
                raise RuntimeError('Qualification injects bind fault after real Popen')

        result = self.controller(BindingFailure({'0-rsi-r1': 'ignore'})).run()
        self.assertTrue(result['cancelled'])
        self.assertEqual(result['admitted'], ['0-rsi-r1'])
        self.assertTrue(result['cleanup']['0-rsi-r1']['scope']['acknowledged'])

    def test_cancellation_during_bind_does_not_admit_later_originals(self):
        root = self.root

        class CancellingBind(LocalBackend):
            def bind(self, child):
                super().bind(child)
                (root / 'CANCEL').write_text('Operator cancelled while startup was binding')

        controller = self.controller(CancellingBind())
        result = controller.run()
        self.assertEqual(result['admitted'], ['0-rsi-r1'])
        self.assertEqual(len(controller.backend.children), 1)
        self.assertFalse((root / 'runs/1-rsi-r1/ADMISSION.json').exists())

    def test_cancellation_during_preflight_does_not_spawn_or_admit(self):
        root = self.root

        class CancellingPreflight(LocalBackend):
            def preflight(self, child):
                (root / 'CANCEL').write_text('Operator cancelled during preflight')

        controller = self.controller(CancellingPreflight())
        result = controller.run()
        self.assertEqual(result['admitted'], [])
        self.assertEqual(len(controller.backend.children), 0)
        self.assertFalse((root / 'runs/0-rsi-r1/ADMISSION.json').exists())

    def test_uncertain_ownership_never_kills_target_and_records_uncertainty(self):
        class Uncertain(LocalBackend):
            def signal(self, child, sig):
                raise RuntimeError('Identity mismatch: do not signal')

        controller = self.controller(Uncertain({'0-rsi-r1': 'ignore'}))
        thread, _ = self.cancel_when_ready()
        result = controller.run()
        thread.join(timeout=2)
        self.assertIsNone(controller.backend.children[0].poll())
        self.assertIn('0-rsi-r1', result['unacknowledged'])
        self.assertFalse(result['cleanup']['0-rsi-r1']['scope']['acknowledged'])
        self.assertEqual(read(self.root / 'STATUS.json')['running'], ['0-rsi-r1'])

    def test_uncertain_resource_query_never_claims_cleanup(self):
        class QueryFailure(LocalBackend):
            def closure(self, child):
                raise RuntimeError('Resource inventory unavailable')

        result = self.controller(QueryFailure()).run()
        self.assertTrue(result['cancelled'])
        self.assertTrue(result['unacknowledged'])
        self.assertFalse(result['executionComplete'])

    def test_identity_hash_and_classifier_uncertainty_fail_closed(self):
        original = self.root
        for mode in ('wrong-binding', 'wrong-artifact', 'wrong-classification'):
            with self.subTest(mode=mode):
                self.root = original / mode
                self.root.mkdir()
                result = self.controller(LocalBackend({'0-rsi-r1': mode})).run()
                self.assertTrue(result['cancelled'])
                self.assertIn('0-rsi-r1', result['unacknowledged'])
                self.assertFalse(result['unknown'])
        self.root = original

    def test_refusal_continues_only_under_a_separately_frozen_no_retry_policy(self):
        settings = protocol()
        settings['endpointPolicy'] = {'witnessedProviderRefusal': 'unknown-and-continue-independent-assignments', 'retry': False}
        validate_protocol(settings)
        result = self.controller(LocalBackend({'0-rsi-r1': 'refusal'}), settings).run()
        self.assertFalse(result['complete'])
        self.assertTrue(result['executionComplete'])
        self.assertFalse(result['cancelled'])
        self.assertEqual(result['unknown'], ['0-rsi-r1'])
        self.assertEqual(len(result['admitted']), 18)
        self.assertEqual(len(set(result['admitted'])), 18)
        self.assertEqual(result['unacknowledged'], [])

    def test_refusal_defaults_to_fail_closed_without_preregistration(self):
        result = self.controller(LocalBackend({'0-rsi-r1': 'refusal'})).run()
        self.assertTrue(result['cancelled'])
        self.assertFalse(result['executionComplete'])
        self.assertEqual(result['unknown'], [])
        self.assertLess(len(result['admitted']), 18)

    def test_refusal_policy_never_admits_a_retry(self):
        settings = protocol()
        settings['endpointPolicy'] = {'witnessedProviderRefusal': 'unknown-and-continue-independent-assignments', 'retry': True}
        with self.assertRaisesRegex(ValueError, 'never authorize a retry'):
            validate_protocol(settings)

    def test_frozen_coordinates_reject_count_caps_and_shortened_budget(self):
        for key, value in [('secondsPerOriginal', 10), ('requestCountCap', 1000000),
                           ('monetaryCap', 999999), ('concurrencyPerBlock', 4)]:
            settings = protocol()
            settings[key] = value
            with self.assertRaises(ValueError):
                validate_protocol(settings)

    def test_systemd_ownership_requires_exact_cohort_scope(self):
        controller = self.controller()
        # Ownership logic is real; only inspect input is deterministic here.
        child_root = self.root / 'ownership'
        child_root.mkdir()
        from cohort import Child, write
        admission = {'unit': 'user@1000.service', 'description': 'shared user group'}
        child = Child({'id': '0-rsi-r1'}, child_root, admission, time.monotonic())
        write(child_root / 'ADMISSION.json', admission)
        backend = SystemdBackend(self.root, protocol(), {'bun': '/not-used'})
        with self.assertRaisesRegex(RuntimeError, 'cohort token'):
            backend.owned(child, {'LoadState': 'loaded'})


if __name__ == '__main__':
    unittest.main()
