# ProContract: evidence admission before stronger completion claims

Status: design proposal, 2026-09-07. No runtime implementation, completed formal proof, or performance improvement is claimed by this document.

## Decision

Keep the settlement kernel small. The next capability-oriented change should be a host-owned, scope-aware evidence admission and feedback boundary, initially in the ProgramBench adapter. Reuse snapshot binding, replay feedback, authorized challenge, and existing budgets. Do not add a general proof language, mandatory architecture approval, or compulsory provider-turn floor.

Formalization defines which authority transitions are allowed. It does not establish that an experimental observer measures the intended behavior or that a selected evaluator measures real utility. Gödel and Löb constrain particular formal self-justification demands; they are not explanations for the finite, reproducible protocol and terminal-state mistakes found in the trajectory audit.

## Current implementation boundary

`specs/pro-contract-truth-boundary.md` explicitly separates exact attestation coordinates from the validity and origin of principal evidence. At present, a principal `evidenceHash` is not itself a prescribed, checked report interface. Its inequality with the replay evidence hash does not establish evaluator independence.

The frozen ProgramBench delivery claim promises the exact handoff and successful compile/regression replay, not universal behavioral compatibility. Low external scores therefore do not by themselves refute kernel integrity. A stronger behavior claim requires a correspondingly stronger, explicit evidence policy; do not retroactively change the meaning of historical discharge.

Audit evidence lives in `/home/duozhou/run-artifacts/procontract-trajectory-audit-20260907-v1/REPORT.md`. These inspected tasks and external failures are diagnostic/development evidence, not a clean generalization test set for subsequent changes.

## Three separate responsibilities

1. The executor proposes programs, probes, observers, fixtures, and evaluator changes. Its working candidate may regress while exploring another representation.
2. A host-controlled task verifier executes approved measurement profiles, records observations, checks exact candidates, and returns concrete counterexamples or an explicit inability to conclude.
3. The settlement kernel checks the authority and support required for a particular claim and exact object. It does not infer universal correctness from an experimental pass.

A small authority kernel is not the whole trusted computing base for every claim. Observer interpretation, evaluator validity, execution isolation, and external-world assumptions remain explicit dependencies of the claims that rely on them.

## Evidence admission

An experimental receipt must identify the claim/revision and exact candidate, the approved evaluation profile, the exact case-set snapshot, the report bytes, and the authenticated producer. The evaluation profile identifies the reference, executable entrypoint, environment, interaction semantics, observer, and comparison rule. Use content-addressed references rather than repeatedly projecting these details into the executor context.

Every required coordinate must cause a real admission decision:

| Mismatch | Required disposition |
| --- | --- |
| Report names an older subject | Do not support the current candidate |
| A test-only entrypoint or environment replaces the production path | Do not treat it as production-path evidence |
| Observer or comparator changes | Require authorized admission under the existing transition rules |
| Claimed report is missing or its digest does not match | Evidence unavailable; do not accept a bare pass assertion |
| A new evaluator approves its own adoption without existing authorization | Reject that adoption route |
| An accepted counterexample disappears from the required case set without authorized retirement | Do not grant current eligibility on that basis |

This is not an instruction to accept whatever fields a candidate writes into JSON. The host must obtain the receipt through an authenticated execution boundary, check its bytes and coordinates, and apply the approved decision rule. A signature authenticates the producer, not the semantic truth of the report.

Use restricted, operational claims first: for example, the exact candidate agrees with an identified reference on a specified collection of experiments under a specified observer. A general principal judgment may remain possible, but must be represented as such rather than silently inheriting the strength of a mechanical proof.

## Measurement validity

Raw observations and their interpretations are distinct artifacts. Reinterpreting an old terminal stream with a corrected observer need not repeat the original experiment, but it creates a new derived result and may invalidate earlier conclusions. Never rewrite the historical raw observation.

Positive controls alone are insufficient. A comparator that always returns pass can pass reference-against-reference checks. Before admitting a measurement profile, combine positive controls with deliberately distinguishable negative controls: corrupted frame length, missing request, omitted terminal update, or a changed assertion. These are empirical checks of the observer, not a proof of universal observer correctness.

Production-path evidence should cover an actual normal interaction, not only help, parser errors, or an executor-invented standalone mode. Preserve environment unavailability as a concrete limitation. A fake peer may validly measure a client handshake without establishing the full daemon's semantics; the claim must retain that scope.

## Feedback without freezing search

Do not require every intermediate edit to preserve every regression. Separate exploratory working state from a candidate adopted for delivery:

```text
working candidate -> host evaluation -> eligible checkpoint
       ^                 |
       +-- counterexample or measurement limitation
```

Case growth must not require a Contract revision for every probe. Freeze the case-admission and retirement rules at authorization; record each admitted case and bind each evaluation to the case-set snapshot it used. A final eligibility decision must account for required evidence that arrived after an earlier check, using the existing serialized authority boundary or an equivalent exact-version check.

Keep these propositions distinct:

- Historical fact: candidate x passed case set E at time t.
- Current qualification: candidate x satisfies the currently authorized eligibility rule and its currently required support.

Adding cases does not make the historical execution record false. A newly admitted counterexample may nevertheless remove current completion eligibility under the authorized rule. Corrected or retired evidence can also change eligibility without changing the program bytes.

The executor cannot erase a known gap by omitting it from `uncertainties`. Conversely, lack of evidence is not automatically a counterexample. Return pass, a scoped counterexample, or an explicit inability to conclude; route operational unavailability separately from behavioral failure.

An incumbent is only best under a named comparison protocol. Reevaluate old and new candidates under the same protocol after evaluator changes; do not compare cached scores from different standards. Authorized tradeoffs and evidence correction remain possible. Budget expiry preserves the best available artifact and uses the pre-authorized stopping/release/escalation rules; it does not silently strengthen or discharge a different claim.

## Proposed theory targets

These are targets, not established results about the deployed implementation.

1. **Necessary history distinction.** Construct two histories with identical artifacts and raw test results but different current authorization or admitted support. If a decision function sees only the shared observations, it cannot distinguish the required dispositions. This motivates retained state; it neither proves that this schema is uniquely minimal nor that only ProContract can implement it.
2. **Policy-independent settlement integrity.** Under authority isolation, exact object binding, atomic durable updates, and admission of support changes, prove that every accepted transition preserves the chosen invariant for arbitrary executor policies. The implementation refinement must cover recovery, concurrency, revision, and transitive support withdrawal, not just the happy-path reducer.
3. **No unapproved trust expansion.** A change of verifier, observer, or admission rule must be authorized under the previously active regime. A new regime's favorable self-assessment alone cannot supply that authorization. Checking a particular transition changes the proof obligation; it does not solve general Löbian reflection.
4. **Scoped incumbent preservation.** Under a fixed, valid, deterministic comparison protocol, selecting an incumbent only when it satisfies the approved dominance rule preserves the corresponding observed score or required-case set. This is not a guarantee about hidden tests, universal utility, or stronger models.

Safety does not imply progress. Eventual delivery additionally requires resources, scheduling, usable verification, and an executor capable of finding an eligible result. A controller that cannot proceed should retain responsibility and report the limitation instead of looping indefinitely or claiming success.

## First implementation and experiments

First implement the narrow receipt-to-attestation adapter and trusted replay of independently admitted cases. Keep task-specific observation in the verifier; keep general authority semantics out of task scripts. Protect verifier inputs and principal credentials with an actual execution boundary, not only a post-run hash check.

Use the existing trajectory-derived defects for zero-inference checks of feedback correctness. Then freeze a new paired experiment, without changing the model, budget, or benchmark task access between comparable arms:

| Arm | Observation interface | Case maintenance |
| --- | --- | --- |
| A | Existing | Executor-managed |
| B | Improved semantic observer | Executor-managed |
| C | Existing | Host-admitted and retained |
| D | Improved semantic observer | Host-admitted and retained |

Count all observation, verification, inference, and recovery costs. Report valid delivery and behavior scores alongside unresolved-counterexample loss, adopted-checkpoint regressions, false rejection, and recovery cost. Zero unsupported acceptance alone is insufficient. The observation factor and authority/retention factor must not be conflated.

For architecture claims, include a reasonably configured CI/persistent-workflow baseline with comparable immutable fixtures, snapshot binding, and lifecycle handling. Counterexample-guided search and independent checking are not new by themselves. Any ProContract contribution must be demonstrated in the continuity and scope of obligations/support, implementation size/portability, or measured benefit and cost.

Do not begin evaluator succession or a new full-cohort run until the admission and feedback boundary passes these local checks. Remove only the already-cancelled monetary cap in future authorized runs; retain the other approved limits.

## Primary references checked

- Lean Language Reference, “Validating a Lean Proof”: trusted problem statements, axiom auditing, sandboxed proof construction, and external checking; `https://lean-lang.org/doc/reference/latest/ValidatingProofs/`.
- Archive of Formal Proofs, “Gödel's Incompleteness Theorems”: machine-checked incompleteness and Löb results with specified proof-theoretic conditions; `https://isa-afp.org/entries/Incompleteness.html`.
- seL4, “What the Proofs Assume”: explicit assumptions connecting formal models and implementations to the physical world; `https://sel4.systems/Verification/assumptions.html`.
- Yudkowsky and Herreshoff, “Tiling Agents for Self-Modifying AI, and the Löbian Obstacle”: formal self-trust requirements and alternative constructions; `https://intelligence.org/files/TilingAgents.pdf`.
- Solar-Lezama, program synthesis lecture on counterexample-guided inductive synthesis: learner/checker interaction and dependence on the checker's strength; `https://people.csail.mit.edu/asolar/SynthesisCourse2020/Lecture10.htm`.
