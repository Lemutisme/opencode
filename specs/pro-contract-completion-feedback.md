# ProContract completion feedback — September 6, 2026

## Smallest intervention

Do not add a minimum number of turns, a second completion state machine, or a
model-written declaration of coverage. Compile issuer-owned behavioral
observations into the existing snapshot-bound replay policy:

```text
frozen argv + stdin + observed stdout/stderr/exit
  -> additional replay check, alongside the candidate's own regression suite
  -> mismatch: actionable feedback, same Contract/Session/shared budget
  -> match: candidate may petition independent verification
```

The compiler lives at the ProgramBench execution edge, not in the normative
kernel:

`/home/duozhou/.config/superpowers/worktrees/ProgramBench/submission-conservation/scripts/campaign_observations.py`

`behavioral_replay(observations)` returns one existing `ReplayCheck`. Expected
values and verifier code are embedded in the issuer's argv, not read from a
candidate-editable `validate.sh` or JSON manifest. The existing policy hash binds
that check, and existing replay binds its result to the materialized subject.
Changing an observation later requires a newly authorized policy; the executor
cannot silently remove one by editing its own tests.

The helper validates IDs, argument and stream bounds, exit codes and deadlines.
It uses isolated Python imports, literal argument passing, byte-exact output
comparison, bounded diagnostics, per-case timeouts and process-group cleanup.
It adds no runtime dependency beyond the Python standard library in the selected
ProgramBench images. It is opt-in; no existing campaign profile is modified to
use it automatically. A host can append its return value to
`spec.evidence.replay.checks` when issuing a Contract through the native API.
The strict historical ProgramBench campaign adapter is not silently reversioned.

## What it does not establish

- A frozen observation is only as valid as its source. The compiler validates
  structure, not provenance, semantic completeness, or the verifier's judgment.
- Passing finite observations does not prove that further search is worthless.
  Observation discovery remains a separate task-specific search capability.
- The initial implementation covers deterministic UTF-8 stdin/argv CLI behavior;
  it does not serialize daemon sessions, PTY interactions or filesystem inputs.
- This is not an adversarial sandbox. The cooperative deployment and evidence
  truth boundaries still apply. A failing verifier process can also require
  infrastructure diagnosis; its exit code alone is not semantic ground truth.
- Existing failed-replay continuation repairs are reused, not attributed to this
  new compiler. No P0 policy text, kernel transition, default profile, live
  campaign, or historical result is changed.

## Frozen diagnostic

Artifacts:

`/home/duozhou/run-artifacts/procontract-completion-feedback-20260906-v1/`

The matched arms use identical repaired runtime modules and equal continuation
budgets. One correct synthetic control and one source-derived P0 angle-grinder
checkpoint are tested. The planned six trajectories comprise Luna Max control
and checkpoint pairs, plus a Sol xhigh checkpoint pair. The candidate arm adds
the issuer-owned replay check; the baseline retains the same self-tests without
that check. All final oracle cases remain outside executor mounts and feedback.

This is not a full ProgramBench score or an exact native Session fork. The
checkpoint keeps the same implementation, compile, self-test, README and license
bytes, but omits packaging metadata and non-runtime images. New Sessions receive
the same brief and budget: 40 provider turns, 120 actions, 240 seconds; aggregate
estimated provider-cost circuit breaker $3. All initial and final outcomes must
be reported, including failed and unrun trajectories.

## Pre-inference observations

The eight new angle-grinder reference cases were executed twice with identical
results before inspecting the candidate. No official hidden tests or upstream
implementation files were used. The initial checkpoint passes its own checks
and all three feedback cases, but only four of five separate final cases. This
already limits the hypothesis: a static gate can miss the remaining semantic
error. No final case was moved into feedback after that observation.

The first offline apparatus probe used the image's default UID and failed to
write the mounted copy. `initial-results.json` is retained as an invalid setup
probe. The corrected, matching-UID observations are in
`initial-results-v2.json`; these are not candidate build regressions. Both
no-model, end-to-end clean-control delivery probes pass.

## Triggered boundary test

Artifacts:

`/home/duozhou/run-artifacts/procontract-completion-boundary-20260906-v1/`

A separate deterministic executor starts with an incorrect CLI and a vacuous
self-test. Without the independent check, the candidate reaches verification,
but the final oracle rejects it; no authorized completion is fabricated.
With the check, the first readiness request returns a concrete mismatch while
the Contract stays active without a handoff. A prescribed repair then passes and
receives independent attestation. The same Session and one semantic attempt are
retained; all actions still consume the original shared budget.

This demonstrates the intended feedback path using the real native runtime,
snapshot, replay, export and attestation boundary. The repair is scripted, so
this is mechanism evidence, not evidence of improved model capability.

## Model result

Five of six planned trajectories started. The first Sol trajectory encountered
HTTP 502 on its sixth request without usage; the accounting circuit breaker
stopped the experiment and the Sol treatment was not run. Known-usage estimated
cost is $0.240703, excluding the unmetered failed request; this is not an exact
billing total. Neither the failed request nor the skipped arm is a model score.

| Task                               | Model     | Baseline                                           | Issuer-owned observations                   |
| ---------------------------------- | --------- | -------------------------------------------------- | ------------------------------------------- |
| Correct linepack control           | Luna Max  | 3/3 final cases, discharged, 8 turns               | 3/3 final cases, discharged, 8 turns        |
| P0 angle-grinder source checkpoint | Luna Max  | 4/5 final cases, remains in verification, 25 turns | No handoff by deadline, escalated, 23 turns |
| Same angle-grinder checkpoint      | Sol xhigh | Provider HTTP 502; interrupted while active        | Not run after accounting became uncertain   |

No real-model trajectory produced a failed behavioral replay. In particular,
the Luna treatment did not call `contract_check` or `contract_report_ready` at
all. Its outcome cannot identify a harmful or beneficial effect of the extra
check: the intended feedback path never activated. The control pair does not
show extra provider turns, but one replicate does not establish noninferiority.

A separately labelled, post-hoc evaluation preserves and recompiles copies of
all three stopped angle-grinder workspaces with `/workspace` hidden. The Luna
treatment passes 3/5 final cases, versus 4/5 for the Luna baseline and 4/5 for the
interrupted Sol baseline. These are raw conserved artifacts, not authorized
deliveries or ProgramBench scores. The initial checkpoint passed 4/5. There is
no basis for a performance promotion or a claim that additional continuation
preserves unobserved behavior.

The diagnostic worker image retained `/workspace/executable`, contrary to the
brief's statement that a reference was unavailable. Completed tool-call
arguments were audited; no explicit reference-path use was observed. This is
still an apparatus limitation, not proof of isolation. Separate final oracle
inputs were never mounted into the executor or returned as repair feedback.

## Decision

Keep the compiler as an opt-in building block; do not change the P0 default,
publish a leaderboard improvement, or claim model-quality monotonicity. The
smallest useful mechanism is demonstrated: a real counterexample can prevent
handoff and support same-Session repair without new kernel state. The model
experiment does **not** demonstrate a capability improvement.

The limiting observation is useful: three new static checks can all pass while
a separate semantic case still fails. Turning them into a mandatory gate does
not by itself discover that missing behavior. Future improvement must identify
useful new counterexamples and preserve deliverable checkpoints under the shared
budget, rather than merely adding tests or forcing more turns. That is a next
hypothesis, not a feature already implemented here.

Validation: 25 compiler tests; 226 selected ProgramBench adapter tests including
those 25; 56 Core Contract/replay/context/constitution/export tests. Ruff and
documentation formatting pass. Two clean-control and two fault-triggered native
no-model trajectories exercise the real snapshot/export/attestation chain. No
live or historical full campaign was modified.
