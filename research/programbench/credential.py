"""Host-only credential validity; metadata is never persisted wholesale."""
import datetime
import hashlib
import json
import math
import urllib.parse
import urllib.request


def validate(settings, upstream):
    endpoint = urllib.parse.urlsplit(settings['metadataURL'])
    provider = urllib.parse.urlsplit(upstream)
    if (endpoint.scheme != 'https' or provider.scheme != 'https'
            or endpoint.netloc != provider.netloc or endpoint.path != '/key/info'
            or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment):
        raise ValueError('Credential metadata must use the frozen HTTPS provider origin and /key/info')
    margin = settings.get('marginSeconds')
    if type(margin) is not int or not 900 <= margin <= 3600:
        raise ValueError('Credential validity requires a bounded 900–3600 second schedule margin')
    fingerprint = settings.get('keyFingerprint')
    if fingerprint is not None and (not isinstance(fingerprint, str) or len(fingerprint) != 64
                                    or any(character not in '0123456789abcdef' for character in fingerprint)):
        raise ValueError('Invalid host credential fingerprint')


def qualify(protocol, key, info, now=None):
    """Only return an explicit allow-list; key/info can itself contain secrets."""
    if not key:
        raise ValueError('Host model credential absent')
    settings = protocol['credentialPreflight']
    fingerprint = hashlib.sha256(key.encode()).hexdigest()
    if settings.get('keyFingerprint') not in (None, fingerprint):
        raise ValueError('Host credential differs from its frozen fingerprint')
    if (not isinstance(info, dict) or not {'expires', 'blocked', 'max_budget', 'models'}.issubset(info)
            or info.get('blocked') not in (False, None)):
        raise ValueError('Host credential is blocked or has unknown metadata')
    # Do not impose a monetary execution cap. Reject a key already carrying a
    # finite account cap, rather than pretending it supplies deadline-only work.
    if info.get('max_budget') is not None:
        raise ValueError('Host credential carries a finite monetary cap')
    models = info.get('models')
    if not isinstance(models, list) or (models and protocol['model']['id'] not in models):
        raise ValueError('Frozen model is not admitted by the host credential')
    expires = info.get('expires')
    if not isinstance(expires, str):
        raise ValueError('Credential lifetime cannot be positively verified')
    try:
        expiry = datetime.datetime.fromisoformat(expires)
    except ValueError:
        raise ValueError('Credential expiry is malformed') from None
    if expiry.tzinfo is None:
        raise ValueError('Credential expiry must include a timezone')
    now = now or datetime.datetime.now(datetime.timezone.utc)
    waves = sum(math.ceil(sum(item['repeat'] == repeat for item in protocol['assignments'])
                          / protocol['concurrencyPerBlock']) for repeat in (1, 2))
    required = waves * protocol['secondsPerOriginal'] + settings['marginSeconds']
    if (expiry - now).total_seconds() <= required:
        raise ValueError('Credential does not cover the worst-case frozen cohort schedule')
    return {'version': 1, 'checkedAt': now.isoformat(), 'expires': expiry.isoformat(),
            'keyFingerprint': fingerprint, 'requiredLifetimeSeconds': required,
            'sufficientWorstCaseLifetime': True, 'modelCalls': 0}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError('Credential metadata redirects are not admitted')


def preflight(protocol, key):
    settings = protocol['credentialPreflight']
    validate(settings, protocol['model']['upstream'])
    if not key:
        raise ValueError('Host model credential absent')
    request = urllib.request.Request(settings['metadataURL'], headers={'Authorization': 'Bearer ' + key})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
            payload = response.read(1024 * 1024 + 1)
            if len(payload) > 1024 * 1024:
                raise ValueError('Credential metadata exceeded the individual operation bound')
            metadata = json.loads(payload)
    except Exception:
        # Never include a response, URL with query, request headers or exception
        # containing provider-issued credentials in an operator artifact.
        raise ValueError('Credential metadata query failed; no task was admitted') from None
    if not isinstance(metadata, dict):
        raise ValueError('Credential metadata has an unknown document shape')
    return qualify(protocol, key, metadata.get('info'))
