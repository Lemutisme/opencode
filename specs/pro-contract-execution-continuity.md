# ProContract execution continuity

## Decision

Keep the duty stable and the executor replaceable. Do not turn a transport
identity into an acceptance condition, and do not weaken acceptance to make
recovery work. This repair changes the ProgramBench integration, not the
ProContract kernel, the behavioral policy, or the model prompt.

## Four instances of the same identity error

1. The observer required a larger semantic attempt number whenever the prompt
   or Session changed. Native same-attempt continuation changes the prompt;
   reclaiming an expired, spent lease can also replace the Session without
   consuming another semantic attempt. Both were incorrectly rejected.
2. Progress recovery required the old progress record's Session to be the
   current Session. Recorded usage belongs to the duty, not to the worker that
   happened to produce it.
3. Delivery compared the current Session transcript with the aggregate history
   of every observed attempt. After a legitimate Session replacement, these are
   different objects even when neither has changed.
4. A restart during packaging or preflight reused the original issue response
   as its handoff. An issue-time `active` or `dormant` state is not the later
   frozen verification state.

## The minimal boundary

For this fixed-issue campaign adapter, let the frozen execution coordinates be
`A = (contractID, revision, location, model, executionPolicy)`, the transport
coordinates be `E = (sessionID, promptID)`, and the cumulative reservations be
`U = (attempts, turnsUsed, actionsUsed)`.

During search, a validated observation from the native contract-scoped execution
endpoint is compatible when `A` is unchanged and every component of `U` is
nondecreasing. `E` need not be unchanged. An attempt number is not a worker
generation number. The observer applies this check on every observation, not
only when transport coordinates change.

This is a compatibility check on a trusted native observation, not an independent
proof that arbitrary executor-supplied coordinates are authorized. The native
binding store owns replacement and fences retired Sessions. An authorized
revision or model/policy change needs its own protocol; this fixed campaign
adapter does not infer such permission from a new Session or attempt number.

On progress recovery, the duty must still match, the historical Session identity
must be structurally valid, and native reservations must cover the persisted
turn/action totals. Generation, retained messages, and recorded cost must still
reconcile. Replacement does not reset recorded usage or purchase another budget.

At delivery, freeze the object instead of relaxing comparisons:

- Restore contract, execution, and quiet observations from the frozen verification
  record, not the admission response.
- Keep exact Session/prompt, subject, replay, package, and principal-report checks.
- Keep aggregate duty history for accounting, but compare the restarted native
  Session with its own frozen transcript.

The only added persisted field is `sessionMessageCount` in version 2 of the
adapter's verification observation. The existing history merge places the
current Session at the end of aggregate history. The count identifies that exact
suffix, including an empty suffix, without copying another transcript. Deleting,
adding, editing, or reordering current-Session messages still fails closed.
Version 1 remains readable with its original whole-transcript comparison.
There is no new kernel state, public API, search gate, or repeated model guidance.

## Validation scope

Regression coverage includes same-attempt prompt continuation, lease-driven
Session replacement, observer recovery after committed usage, and restart before
preflight commit. The positive cases retain all three observed provider records,
their tokens and recorded cost, and reach exactly one principal attestation.
Negative cases cover frozen model/policy/duty drift, counter rollback, corrupt
progress, post-handoff Session/prompt replacement, and transcript mutation.

`packages/core/test/pro-contract.test.ts` exercises the real Core binding store
and contract ledger. Same-attempt continuation and lease recovery preserve the
duty and its cumulative reservations. Retired Sessions cannot spend, stale
dispatches cannot consume another attempt, and exhausting the remaining budget
escalates rather than silently completes the duty.

ProgramBench's `tests/test_campaign_procontract.py` exercises the adapter's
observation, accounting, recovery, and independent settlement boundaries. Run
`bun test test/pro-contract.test.ts` from `packages/core` for the native invariant,
and `python -m pytest tests/test_campaign_procontract.py` from a ProgramBench
checkout for adapter coverage.

These checks establish specific lifecycle repairs, not a ProgramBench score
increase or model-quality monotonicity. They do not prove that all provider
billing has been observed, that finite evidence establishes semantic completeness,
or that a cooperative local deployment is adversarially isolated. A performance
claim still needs a newly frozen matched comparison that counts failures and all
costs.
