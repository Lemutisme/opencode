"""Read-only fixed-repeat comparison; never scores, retries or authorizes deployment."""
from pathlib import Path
from fractions import Fraction
import json
import sys


root = Path(sys.argv[1]).resolve()
protocol = json.loads((root / 'PROTOCOL.json').read_text())
status = json.loads((root / 'STATUS.json').read_text())
rows = []
for instance in protocol['instances']:
    sides = {}
    for arm in protocol['arms']:
        values = []
        for repeat in (1, 2):
            assignment = next(row for row in protocol['assignments'] if row['instance'] == instance['id']
                              and row['arm'] == arm and row['repeat'] == repeat)
            file = root / 'runs' / assignment['id'] / 'RESULT.json'
            result = json.loads(file.read_text()) if file.exists() else None
            score = result.get('score') if result else None
            valid = (result and result.get('valid') is True and result.get('outcome') == 'scored'
                     and score and score.get('valid') is True and score.get('total') == instance['total'])
            values.append({'repeat': repeat, 'valid': bool(valid), 'score': score if valid else None,
                           'disposition': result.get('outcome') if result else 'not-terminal',
                           'contract': result.get('contract') if result else None})
        complete = all(row['valid'] for row in values)
        mean = sum((Fraction(row['score']['passed'], row['score']['total']) for row in values), Fraction()) / 2 if complete else None
        sides[arm] = {'repeats': values, 'mean': mean, 'full': complete and all(row['score']['passed'] == row['score']['total'] for row in values)}
    delta = sides['core']['mean'] - sides['r2']['mean'] if all(side['mean'] is not None for side in sides.values()) else None
    rows.append({'instance': instance['id'], 'sides': sides, 'delta': delta})
complete = all(row['delta'] is not None for row in rows)
reasons = ([f"regression:{row['instance']}" for row in rows if row['delta'] is not None and row['delta'] < 0]
           + [f"full-pass-lost:{row['instance']}" for row in rows if row['sides']['r2']['full'] and not row['sides']['core']['full']])
if not complete:
    reasons.append('incomplete-fixed-repeat-evidence')
if not any(row['delta'] is not None and row['delta'] > 0 for row in rows):
    reasons.append('no-strict-improvement')
if not status.get('executionComplete') or status.get('unacknowledged'):
    reasons.append('execution-or-cleanup-incomplete')


def percentage(value):
    return 'UNKNOWN' if value is None else f'{float(value * 100):.4f}%'


print('# Fixed-method V2 / R2 paired diagnostic\n')
print('Status:', status.get('status'), '\n')
print('Same V2 runtime; R2 v5 method is a contemporaneous method control, not the old R2 binary. All tasks are exposed development.\n')
print('| Instance | R2 fixed method | Core fixed method | Core − R2 |')
print('| --- | ---: | ---: | ---: |')
for row in rows:
    print(f"| {row['instance']} | {percentage(row['sides']['r2']['mean'])} | {percentage(row['sides']['core']['mean'])} | {percentage(row['delta'])} |")
print('\nComplete fixed-repeat score evidence:', complete)
print('Panel task-Pareto:', 'PASS' if not reasons else 'NOT ESTABLISHED / FAIL')
print('Reasons:', ', '.join(reasons) or 'none')
if complete:
    for arm in protocol['arms']:
        print(arm, 'task-equal mean:', percentage(sum((row['sides'][arm]['mean'] for row in rows), Fraction()) / len(rows)))
print('\nNo production promotion is authorized: independent fresh confirmation and safety/full-pass protections remain required.')
print('Missing scores remain unknown; no solver or grader was rerun by this analysis.')
