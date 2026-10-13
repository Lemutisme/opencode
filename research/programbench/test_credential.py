"""Zero-model regression tests for the reusable host-only validity gate."""
import datetime
import json
import unittest
from credential import qualify, validate
from test_cohort import protocol


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.datetime(2026, 10, 13, tzinfo=datetime.timezone.utc)
        self.protocol = protocol()
        self.protocol['model'] = {'id': 'scripted', 'upstream': 'https://provider.test/v1'}
        self.protocol['credentialPreflight'] = {'metadataURL': 'https://provider.test/key/info',
                                                'marginSeconds': 900, 'keyFingerprint': None}
        self.metadata = {'expires': (self.now + datetime.timedelta(days=10)).isoformat(),
                         'max_budget': None, 'blocked': False, 'models': [],
                         'key': 'secret-in-response', 'arbitrary': {'nested': 'secret-in-response'}}

    def test_sanitized_evidence_and_exact_schedule(self):
        evidence = qualify(self.protocol, 'test-only-key', self.metadata, self.now)
        self.assertEqual(evidence['requiredLifetimeSeconds'], 36 * 3600 + 900)
        self.assertNotIn('test-only-key', json.dumps(evidence))
        self.assertNotIn('secret-in-response', json.dumps(evidence))
        self.assertEqual(evidence['modelCalls'], 0)
        self.assertTrue(evidence['sufficientWorstCaseLifetime'])
        self.protocol['assignments'] *= 2
        self.assertEqual(qualify(self.protocol, 'test-only-key', self.metadata, self.now)['requiredLifetimeSeconds'], 72 * 3600 + 900)

    def test_expiry_authentication_caps_and_model_access_fail_before_admission(self):
        for change in [{'expires': self.now.isoformat()}, {'blocked': True}, {'max_budget': 1},
                       {'models': ['different-model']}, {'models': None}, {'expires': None},
                       {'expires': '2026-10-20T00:00:00'}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                qualify(self.protocol, 'test-only-key', {**self.metadata, **change}, self.now)
        with self.assertRaisesRegex(ValueError, 'absent'):
            qualify(self.protocol, '', self.metadata, self.now)
        self.protocol['credentialPreflight']['keyFingerprint'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'fingerprint'):
            qualify(self.protocol, 'test-only-key', self.metadata, self.now)

    def test_origin_and_schedule_margin_are_frozen(self):
        settings = self.protocol['credentialPreflight']
        validate(settings, self.protocol['model']['upstream'])
        for change in [{'metadataURL': 'https://other.test/key/info'}, {'metadataURL': 'http://provider.test/key/info'},
                       {'metadataURL': 'https://provider.test/key/info?key=secret'}, {'marginSeconds': 0}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate({**settings, **change}, self.protocol['model']['upstream'])


if __name__ == '__main__':
    unittest.main()
