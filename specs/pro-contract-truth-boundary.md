# ProContract Truth Boundary

This audit records what the current ProContract institution checks itself, what
it accepts from a trusted caller, and what remains the responsibility of an
external verifier. It describes the runtime retained on
`procontract-strength` after the default execution policy was removed. It does
not claim that a hash proves the truth of the bytes it names.

## Result

The current institution has a strong coordinate boundary and an intentionally
open semantic boundary.

It deterministically prevents an admitted executor command from discharging a
Contract, changing frozen terms, or substituting a stale revision or subject.
It also makes replay failure, challenge, and lost dependency support durable.
It does not determine whether principal evidence is authentic, whether a task
verifier is valid, or whether an opaque `evidenceHash` settles the frozen
claim. Those decisions currently occur before the principal attestation route
is called.

The desired boundary remains:

```text
external mechanical verifier
  -> finite content-addressed attestation
  -> total deterministic kernel decision
  -> discharge or explicit rejection
```

The first arrow is only fully implemented for the subordinate replay report.
Final principal evidence crosses it by convention rather than by a prescribed
report contract.

## Current path

```text
principal-approved Spec
  -> canonical specHash
  -> durable Contract and execution binding
  -> dedicated active Session
  -> contract_report_ready(summary, uncertainties)
  -> institution captures exact Location Snapshot as subjectHash
  -> optional frozen replay runs on that Snapshot
     -> unavailable: escalate
     -> failed finite report: durable visible challenge, return dormant
     -> passed finite report: record replay evidence on handoff
  -> verification
  -> principal or external adapter evaluates exact handoff
     -> POST opaque evidenceHash to attest
     -> or POST exact revision/subject plus evidenceHash to challenge
  -> kernel validates coordinates and authority
  -> discharge, explicit rejection, or challenge-driven reopening
```

The executor supplies only its petition summary and uncertainties at handoff.
The Location-scoped tool obtains its binding, captures the Snapshot, invokes
the replay service with the frozen policy, and submits an institution-authored
`report-ready` command. The executor cannot supply a `subjectHash`, replay pass
bit, replay evidence hash, attestation, or challenge through that tool.

## Enforced checks

### Frozen terms

`Spec` freezes the trigger, optimization goal, optional future policy, handoff
brief, exact prerequisite revisions, capabilities, budget, evidence policy,
and resolution policy. The kernel recomputes its canonical `specHash` at issue
and revision admission. A revision cannot change dependency edges, and only
the issuer can accept it.

The optional replay policy freezes:

- argv, working directory, timeout, and expected exit for each check;
- expected hashes for protected regular files;
- exact required artifact paths.

An issued implementation Contract can therefore bind a finite mechanical
precondition without adding task or benchmark concepts to the kernel.

### Handoff and replay

`contract_report_ready` captures a content-addressed Snapshot before replay.
Replay materializes that exact subject in a fresh temporary tree, rejects paths
that escape the candidate root, runs checks serially with timeouts and bounded
output capture, and inspects protected files and artifacts after execution.

Replay report version 1 commits:

- Contract ID, replay policy hash, and subject hash;
- pass or fail;
- argv, relative cwd, expected and actual exit;
- stdout and stderr hashes plus truncation flags;
- protected-file existence, observed hash, and expected hash;
- required-artifact existence and file hash when applicable.

The JSON report is hashed and stored under
`<data>/pro-contract/replay/<evidenceHash>.json`. A failed completed replay is
negative evidence. Failure to materialize the Snapshot or start a check is an
institutional availability failure and escalates instead of fabricating an
executor failure.

The identifier hashes compact `JSON.stringify(report)` bytes. `writeJson`
stores an equivalent pretty JSON value, so the raw stored-file hash need not
equal `evidenceHash`; consumers must decode and canonically re-encode the value
before checking that identifier.

The kernel accepts a replay-bearing handoff only when the result names the
frozen replay policy and the captured subject. A replay-configured Contract
cannot be discharged unless the recorded replay passed and still matches both.
Replay evidence cannot itself be reused as the principal evidence hash.

### Final adjudication

Discharge is a total kernel transition. It requires:

- status `verification` and a current handoff;
- no pending revision;
- a new attestation ID;
- the exact Contract revision and `specHash`;
- the exact handoff `subjectHash`;
- a supporting replay result when replay was frozen;
- an actor and attestation verifier equal to the issuer;
- a principal evidence hash distinct from replay evidence when replay exists.

An illegal command returns the original state object and a durable rejected
decision. Accepted state, attestation insertion, the command decision, and the
global hash-chain frontier are written in one immediate database transaction.

### Challenge and responsibility closure

Only the issuer can challenge a Contract in `verification` or `discharged`,
and the challenge must name its exact revision and handoff subject. A visible
challenge returns the source Contract to `dormant`; a sealed challenge moves it
to `escalated` without disclosing a summary to the executor. Both remove its
current handoff and attestation support.

The same transition finds transitive dependents. Every live affected dependent
becomes escalated and loses current handoff and attestation support. Historical
attestation rows and ledger events remain. Negative evidence therefore renews
responsibility instead of erasing history.

## Trusted inputs and open semantics

| Input or boundary | Current owner | Institution checks | Institution does not check |
| --- | --- | --- | --- |
| Goal, claim, replay policy, protected hashes | Principal at proposal/issue | Canonical `specHash`, shape, finite replay structure, immutable revision rules | Whether the claim is useful, the policy is sufficient, protected bytes are a sound oracle, or the stopping rule is valid |
| `subjectHash` at executor handoff | Location Snapshot service | Replay and attestation must name it exactly | That the configured Location contains every real-world object relevant to the claim |
| Replay process and report | In-process replay service plus host | Frozen policy/subject, path containment, exits, file observations, content hash | Network isolation, clean environment, credential isolation, image/toolchain identity, verifier executable identity, signatures, or task-level adequacy |
| Principal `evidenceHash` | Authenticated HTTP caller or local CLI | Nonempty, exact attestation coordinates, issuer role, distinct from replay hash | Report availability, bytes matching the hash, report schema, pass rule, verifier origin, signature, independence beyond hash inequality, or whether it settles `evidence.claim` |
| Challenge `evidenceHash`, disclosure, summary | Authenticated HTTP caller or local CLI | Current revision/subject, issuer role, disclosure/summary consistency | Report availability, evaluator authenticity, or truth of the negative result |
| `evaluatorHash` and `EvaluationReport` | External evaluation adapter | Evaluation ID/dependency/executor coordinates and delivery revision/subject | That the hash names the running evaluator, the report came from it, or its `passed` value follows a frozen rule |
| HTTP principal identity | Server-wide Basic auth | One configured username/password when enabled | Per-verifier roles, route-scoped credentials, report signatures, or separation among authenticated callers |
| Local CLI principal identity | Process and filesystem boundary | Local service constructs fixed `local-owner` role | OS-level separation from an executor that can reach the same control process or state |
| Database ledger | Local institution process | Transactional state/event/head consistency while writing | External checkpoint, signature, remote witness, or tamper detection after a trusted database rewrite |

An explicitly unsecured server grants its callers principal authority. Embedded
routes are likewise a same-process convenience boundary, not an adversarial
principal boundary. These modes are valid for local mechanism tests but cannot
support a claim that an untrusted executor is unable to reach principal routes.

## External evaluation adapter

The existing `issueEvaluation` and `settleEvaluation` path gives an external
evaluation a durable obligation and binds its identity to the delivery ID,
delivery revision, subject, and a caller-provided `evaluatorHash`. It correctly
reopens a delivery on a failed report and can discharge a separate evaluation
Contract on a passing report.

It is still an orchestration adapter, not a mechanical verifier boundary.
`settleEvaluation` receives the already-parsed report, pass bit, evidence hash,
disclosure, summary, and time from its caller. It does not retrieve a report by
hash, execute the named evaluator, authenticate report origin, or recompute a
decision from frozen observations.

## Minimum next verifier experiment

Do not add a general evidence DSL. First close one small lifecycle using the
existing replay structures and a verifier report whose format is local to the
experiment.

The external verifier should receive or fetch:

```text
contractID
revision
specHash
subjectHash
evidence.claim
frozen replay policy hash and replay evidence hash, when configured
verifier executable or manifest hash
```

It should emit a finite canonical report containing those coordinates, its
observations, and one deterministic pass/fail decision. The adapter should
persist the report, recompute its content hash, refetch the Contract immediately
before mutation, and then choose exactly one action:

```text
matching current coordinates + pass -> principal attestation
matching current coordinates + fail -> subject-bound challenge
stale/mismatched coordinates         -> no authoritative mutation
verifier unavailable                 -> no fabricated pass or fail
```

For the first native-Linux lifecycle, a wrong subject or stale revision is the
required negative control. It must leave the authoritative Contract state
unchanged and append an explicit rejected decision if it reaches the kernel.

Only after one real verifier cannot be represented by the existing frozen
replay policy plus a content-addressed external report should the public
evidence vocabulary be extended. Any future extension should preserve verifier
execution outside the pure kernel and make the kernel consume only finite,
decoded data.

## Evidence for this audit

Implementation paths:

- `packages/schema/src/pro-contract.ts`
- `packages/core/src/pro-contract/kernel.ts`
- `packages/core/src/pro-contract/replay.ts`
- `packages/core/src/pro-contract.ts`
- `packages/core/src/tool/contract-control.ts`
- `packages/protocol/src/groups/pro-contract.ts`
- `packages/server/src/handlers/pro-contract.ts`
- `packages/server/src/middleware/authorization.ts`
- `packages/opencode/src/cli/cmd/contract.ts`

Focused tests establish the bounded claims above:

- `ProContract kernel > rejects executor testimony and preserves authoritative state`
- `ProContract kernel > turns challenged evidence into renewed duty without erasing history`
- `ProContract kernel > turns unsupported dependents into principal-owned remediation`
- `ProContract kernel > keeps sealed verifier evidence away from automatic execution`
- `ProContract kernel > requires matching replay evidence before principal discharge`
- `ProContract replay verifier > replays one frozen subject outside the candidate Location`

They do not establish verifier validity, principal credential isolation,
semantic adequacy of a claim, or authenticity of opaque external evidence.
