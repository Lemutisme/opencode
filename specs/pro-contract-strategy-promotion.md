# Strategy adjudication and the Sol three-task diagnostic

Date: 2026-09-21. Branch: `strategy-promotion`.

## What is implemented

This is an opt-in **policy experiment and comparison primitive**, not a completed
independent Builder–Falsifier system or a demonstrated recursive improvement loop.
The normative Kernel, public APIs, active Contract terms, and existing experiments
are unchanged. Existing unrelated working-tree changes were not included in these
commits.

- `packages/opencode/script/policies/full-pass-falsification-v1.txt` is an immutable
  proposed execution-policy addendum: investigate representation classes, seek
  counterexamples, reconsider representations, and optimize full passes first.
  Its use of “independent” describes the requested probing perspective; it does
  **not** create a separate principal, model context, or protected verifier.
- ProgramBench branch `strategy-promotion`, implementation commit `323aecc`, extends
  the existing pure contrast generator with `value_presence`: omitted values,
  separate empty argv values, and long attached-empty values. It does not execute
  programs, assert equivalence, add task-specific cases, or grant authority.
  The existing task-local strategy helper can select this family. Sol Max is
  admitted explicitly rather than silently substituted for another effort.
- `packages/opencode/script/strategy-promotion.ts` adjudicates externally supplied
  paired records. The legacy `pro-contract-rsi.ts` remains unchanged. This new
  command **does not promote or bind a policy**. Its report explicitly records
  `promotion: false`; caller-supplied hashes are identities, not authentication.

### Comparator

The manifest binds exact UTF-8 policy bytes, hashes, parent, generation, task set,
replicates, evaluator identity, and budget identity. Parent is ancestry metadata,
not a normative `requires` dependency.

A robust full pass requires complete evidence, qualified delivery, and exact
`passed === total` for **every** registered replicate of the task. Preserve the
incumbent's robust full-pass set, then compare lexicographically:

1. Robust full-pass count.
2. Mean delivery-gated pass fraction, using exact rational arithmetic.
3. Cost, only if both higher-priority metrics tie and accounting is complete.

A new full pass can therefore beat a lower mean or greater cost. Retention is an
additional explicitly stated accumulation constraint, not a weighted average.
No global monetary or turn/action ceiling is introduced. Counts here describe
the finite submitted experiment, not an execution allowance.

Missing or incomplete measurements remain unknown and reject adjudication. A
known undelivered result contributes zero only to the explicitly delivery-gated
utility; it cannot count as a full pass. Different test denominators, duplicate or
extra slots, wrong evaluator/budget identities, text/hash conflicts, skipped
generations, interventions, and declared violations reject. Unknown cost is not
zero and cannot win a cost tie. Task/run ordering does not change a valid report.

Run from `packages/opencode`:

```sh
bun script/strategy-promotion.ts manifest.json runs.json report.json
bun test script/strategy-promotion.test.ts script/pro-contract-rsi.test.ts
```

This is a trusted-recorder boundary, not an authenticity or statistical test.
An accepted report alone cannot update canonical state. Current runtime no longer
has the historical `spec.policy`, `requires.policy`, or `contract policy` path;
see `pro-contract-paper/rsi-study.md`. Do not restore those fields merely to make
this experiment look like a promotion loop.

## Frozen three-task run

The three **lowest known absolute scores**, rather than the three largest Terra
regressions, were selected from the 2026-09-21 02:28:15 Sol R2 readout:

| Instance                   | Historical Sol Max |       New Sol Max | Full pass |
| -------------------------- | -----------------: | ----------------: | --------- |
| `danmar__cppcheck.0a5b103` |   109/2126 (5.13%) |  111/2126 (5.22%) | no → no   |
| `ffmpeg__ffmpeg.360a402`   |   207/3041 (6.81%) | 323/3041 (10.62%) | no → no   |
| `cheat__cheat.b8098dc`     |    46/297 (15.49%) |  268/297 (90.24%) | no → no   |

Full passes: **0 → 0**. Equal-task average: **9.1407% → 35.3594%**.
This has **not achieved the primary full-pass objective**.

The new three delivered candidates used 458 provider turns, 490 actions, and a
known native cost subtotal of $31.0184688; the historical three used 419 turns,
450 actions, and $30.1944372. The separately aborted initial launch adds at least
$0.4838108 and three unresolved usage records. All new work's known native
subtotal is therefore $31.5022796, not a provider-invoice-verified final bill.

Coordinates:

- Results: `/home/duozhou/run-artifacts/procontract-sol-strategy-3-20260921-v2`.
- Runtime: exact prior Sol R2 binary, SHA-256
  `1e9bba5e8319eb6a3f00b6cdb279afb460a2b456a14be3d76615c30648b99b6d`.
- Frozen runner: `/home/duozhou/ProgramBench-strategy-promotion`, detached at
  `323aecc2f0f14b24e8e45ac8beaa3180403e0de3` after execution to preserve its sources.
- Test-only follow-up branch: `/home/duozhou/ProgramBench-strategy-promotion-dev`,
  `092dec5` updates the old test that incorrectly still expected Sol Max rejection.
- Deployed policy: prior v5 text plus this addendum, SHA-256
  `7477d15b224eb6333d52c93c3bdc733d34680cb826846e3fa28710622ad0bad2`.
- Three concurrent fresh inference tasks, six-hour absolute deadline per instance;
  no cumulative provider-turn, action, request, or monetary caps. Individual
  operations and infrastructure guards remain bounded.
- `readout.py` checks frozen package hashes, common official test maps, candidate
  executable hashes, exact policy in issue/binding/first provider request, and
  native evaluator validity. `VALIDATED_RESULTS.json`, `TRAJECTORY_AUDIT.json`,
  `ACCOUNTING.json`, and `RESOURCE_CLOSURE.json` retain the evidence.

The baseline and new scorer/recovery profiles differ. In particular the retained
baseline FFmpeg recompiled executable hash differs from native delivery; we do
not retrospectively reclassify delivery. This is a descriptive source-score
comparison, not a matched causal experiment. `GATE_REPORT.json` **rejects** the
actual mixed evaluator identities rather than inventing one shared identity to
authorize promotion. No canonical strategy was updated.

## What the trajectories actually show

All three stayed at Contract revision 1 / semantic attempt 1. All used the same
Session for construction and self-authored falsification. None called the bundled
`strategy_probe.py` or `contrasts.py`. The observed gains therefore cannot be
attributed to that helper, independent contexts, or automatic strategy selection.

- Cheat's self-authored batch at message 105 found 34 discrepancies in 129 cases;
  a later parser batch found two more. The candidate changed following these
  observations. This is evidence of counterexample-driven local repair, not of
  transferable strategy learning. One stochastic rerun cannot identify the
  policy's causal effect.
- Cppcheck declared 1,238 final candidate/reference tuples matching, yet only
  111/2126 official assertions passed. Early reference observations repeatedly
  reported missing `std.cfg`; the final candidate reproduced that setup failure.
  This is a reference-environment adequacy problem worth qualifying independently,
  not evidence that another thousand parser probes will recover static analysis.
- FFmpeg's self-authored WAV-class probes exposed float conversion discrepancies,
  and repairs followed. Partial behavioral coverage improved, but most official
  behavior remains unimplemented. It is not near a full pass.

## Preserved operational failures

1. The initial launch put a generated local server password in the tmux command
   arguments. It was explicitly cancelled; artifacts and incomplete usage remain
   under `procontract-sol-strategy-3-20260921`. The fresh launch generates a new
   password inside its script, not in argv. No credential value belongs in reports.
2. A stopped-container name collision blocked the fresh launch before provider
   work. Only the exactly owned, already-stopped initial containers were removed;
   the pre-provider failure was retained before an explicit infrastructure retry.
3. Scoring initially lacked an offline wheelhouse, then hit wheelhouse directory
   permissions. A private copy with readable directory modes was used. Missing
   evaluator tags caused two further zero-test attempts. All failed scoring
   artifacts remain. The final separate `scoring-retry3-20260921` evaluated the
   unchanged frozen candidates with exact recreated image tags; no valid-negative
   tests or model candidates were rerun after seeing these scores.

Historical running Sol R2 scoring containers, source, configuration, and budgets
were not altered. This diagnostic's inference/evaluation processes are closed.

## Validation and remaining work

- OpenCode: **31 tests passed**, including unchanged legacy RSI gate tests.
- ProgramBench: **462 tests passed** on the test-only successor checkout, covering
  contrast generation, strategy probes, deadline-only continuation/termination,
  admission, and campaign configuration. The initial broader check found one
  obsolete expected-rejection test; production code was not changed to hide it.
- `bun typecheck` from `packages/opencode` still fails in the pre-existing,
  unrelated `packages/core/src/effect/provider-transport.ts:66` stream type mismatch.

Still **not implemented or demonstrated**: a fresh-context isolated Falsifier,
trusted counterexample delivery back to a Builder, a policy-generating successor,
or evidence-authorized canonical-policy binding. These three exposed-task reruns
cannot stand in for that mechanism. The next experiment needs a real isolated
falsification boundary and a qualified reference environment before more paid
cohorts, followed by fresh private/confirmation data. Do not feed these official
test failures into another candidate and call it independent confirmation.
