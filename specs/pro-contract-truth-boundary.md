# ProContract Truth Boundary

This document records what the current ProContract implementation checks, what
it accepts from a trusted caller, and what an external verifier must establish.
Use the [runbook](pro-contract-runbook.md) for the supported operation path and
the [delivery checklist](pro-contract-delivery.md) to qualify one exact release.
A hash identifies bytes; it does not prove their truth.

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
Final principal evidence has mandatory caller-supplied coordinates, but its
report format and semantic interpretation remain the external adapter's responsibility.

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
     -> failed finite report: repair feedback, no handoff, same attempt
     -> passed finite report: record replay evidence on handoff
  -> verification
  -> principal or external adapter evaluates exact handoff
     -> POST evaluated revision/specHash/subjectHash and evidenceHash to attest
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

`Spec` freezes the trigger, optimization goal, handoff brief, exact prerequisite
revisions, capabilities, budget, evidence policy, and resolution policy.
Execution strategy text belongs to the separate `executionPolicy` binding, not
`Spec`, and cannot change settlement terms or authority. The kernel recomputes its canonical `specHash` at issue
and revision admission. A revision cannot change dependency edges, and only
the issuer can accept it.

The optional replay policy freezes:

- argv, working directory, stdin, timeout, expected exit, and optional exact
  stdout/stderr hash predicates for each check;
- expected hashes for protected regular files;
- exact required artifact paths.

An issued implementation Contract can therefore bind a finite mechanical
precondition without adding task or benchmark concepts to the kernel.

### Handoff and replay

`contract_check` exposes replay as a non-settling search operation when a replay
policy is configured. It captures a subject and stores the replay report, but
the replay result does not invoke a kernel transition or replace the Session. Failed
checks are repair feedback, not a consumed semantic attempt. Successful checks
are observations, not completion or authority to attest. The ordinary tool
action accounting and Contract deadline apply; an explicit action ceiling is
enforced when present. No additional budget is granted.

`contract_report_ready` reserves one shared action when replay is configured,
then captures a content-addressed Snapshot before replay. Reservation still
records usage when no cumulative action ceiling is configured. Its replay is bounded
by the remaining Contract deadline. Reporting blocked or requesting a genuine
revision remains a control operation; it is not a substitute for a free replay.
Replay materializes that exact subject in a fresh temporary tree, rejects paths
that escape the candidate root, runs checks serially with timeouts and bounded
output capture, and inspects protected files and artifacts after execution.

Replay report version 2 commits:

- Contract ID, replay policy hash, and subject hash;
- pass or fail and executor identity/isolation declaration;
- argv, relative cwd, expected and actual exit;
- a content-addressed observation receipt per check, including stdin/output
  hashes and completeness, execution outcome, and predicate match status;
- stdout and stderr hashes plus truncation flags;
- bounded, escaped, candidate-controlled output excerpts for failed checks;
- protected-file existence, observed hash, and expected hash;
- required-artifact existence and file hash when applicable.

The JSON report is hashed and stored under
`<data>/pro-contract/replay/<evidenceHash>.json`. At `contract_report_ready`, a
failed completed replay returns its evidence and subject hashes as repair feedback
without invoking kernel `report-ready`, creating a handoff, or rotating the
semantic attempt. The Contract stays active only while its existing budget and
other lifecycle conditions permit execution. Explicit kernel negative replay
and principal challenges retain their existing semantics. Failure to materialize
the Snapshot or start a check is an institutional availability failure and
escalates instead of fabricating an executor failure. At `contract_check`,
these outcomes return diagnostic feedback without adjudication. Handoff always
replays its own captured subject rather than trusting an earlier check.

Diagnostic excerpts redact values of sensitive-looking environment variables
before bounding the text. They are non-authoritative candidate output, not
verifier instructions. This is not a confidentiality boundary: unknown secrets
printed from files or arbitrary external sources cannot be reliably recognized.

The identifier hashes the exact stored compact `JSON.stringify(report)` bytes.
Reports are created exclusively with read-only file mode; reading verifies the
raw bytes against `evidenceHash`. Observation blobs and receipts also have
content-addressed integrity checks. This detects missing or changed bytes at
that interface, not a privileged rewrite of the whole trusted store.

A matched stdout/stderr predicate proves the observed complete bytes match the
frozen hash. It does not prove that a target statement executed or that behavior
was covered; each observation explicitly records `targetExecution: unobserved`.

The kernel accepts a replay-bearing handoff only when the result names the
frozen replay policy and the captured subject. A replay-configured Contract
cannot be discharged unless the recorded replay passed and still matches both.
Replay evidence cannot itself be reused as the principal evidence hash.

### Budgets and execution identity

Every Contract has an absolute deadline. Optional `turns` and `actions` are
cumulative ceilings across its attempts; omission means no such ceiling, not a
large finite sentinel. Counters remain recorded. Recovery, retry, and Session
replacement do not reset the original deadline or spent counts. Explicit
historical caps retain their meaning. Individual-operation timeouts and
infrastructure fault guards are distinct from cumulative budgets.

A bound executor uses its recorded model and variant. A prompt cannot silently
substitute another model while leaving the binding unchanged. A principal
release records the terminal transition and interrupts work owned by its
receiving process. Use the active server's HTTP route to interrupt that server;
a separate local CLI process cannot interrupt it directly. This is not a
distributed cancellation protocol or proof that arbitrary external
side effects have been undone.

### Final adjudication

The principal must submit the coordinates it actually evaluated:
`revision`, `specHash`, `subjectHash`, and `evidenceHash`. The service does not
fill these from the latest handoff. A late result for handoff A cannot therefore
be relabeled as support for handoff B. Stale coordinates are rejected (HTTP
`409`) without discharging the current Contract. The caller must not "repair"
that rejection by copying newer coordinates onto the old report.

These are object coordinates, not a handoff-generation identifier. Re-adjudicating
the same revision and subject after a challenge is allowed. Challenge withdraws
current Contract support, not an arbitrary historical acceptance record.

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

| Input or boundary                             | Current owner                                             | Institution checks                                                                               | Institution does not check                                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal, claim, replay policy, protected hashes  | Principal at proposal/issue                               | Canonical `specHash`, shape, finite replay structure, immutable revision rules                   | Whether the claim is useful, the policy is sufficient, protected bytes are a sound oracle, or the stopping rule is valid                                                        |
| `subjectHash` at executor handoff             | Location Snapshot service                                 | Replay and attestation must name it exactly                                                      | That the configured Location contains every real-world object relevant to the claim                                                                                             |
| Replay process and report                     | In-process replay service plus host                       | Frozen policy/subject, path containment, exits, file observations, content hash                  | Network isolation, clean environment, credential isolation, image/toolchain identity, verifier executable identity, signatures, or task-level adequacy                          |
| Principal `evidenceHash`                      | Authenticated HTTP caller or local CLI                    | Nonempty, exact attestation coordinates, issuer role, distinct from replay hash                  | Report availability, bytes matching the hash, report schema, pass rule, verifier origin, signature, independence beyond hash inequality, or whether it settles `evidence.claim` |
| Challenge `evidenceHash`, disclosure, summary | Authenticated HTTP caller or local CLI                    | Current revision/subject, issuer role, disclosure/summary consistency                            | Report availability, evaluator authenticity, or truth of the negative result                                                                                                    |
| `evaluatorHash` and `EvaluationReport`        | External evaluation adapter                               | Evaluation ID/dependency/executor coordinates and delivery revision/subject                      | That the hash names the running evaluator, the report came from it, or its `passed` value follows a frozen rule                                                                 |
| HTTP principal identity                       | Principal mutation middleware plus server-wide Basic auth | Mutation is denied when auth is absent; one configured username/password is checked when enabled | Per-verifier roles, distinct principal credentials, report signatures, or separation among authenticated callers                                                                |
| Local CLI principal identity                  | Process and filesystem boundary                           | Local service constructs fixed `local-owner` role                                                | OS-level separation from an executor that can reach the same control process or state                                                                                           |
| Database ledger                               | Local institution process                                 | Transactional state/event/head consistency while writing                                         | External checkpoint, signature, remote witness, or tamper detection after a trusted database rewrite                                                                            |

An explicitly unsecured server permits read-only Contract observation but
denies principal mutations. Embedded routes are likewise unable to mutate
Contracts without configured authentication. A single authenticated process is
still a convenience boundary, not an adversarial principal boundary: these
modes cannot support a non-bypass claim when an untrusted executor can recover
the server credential or reach the plane database directly.

## Opt-in strategy promotion

The strategy adapter chooses execution text for explicitly opted-in future
Contracts. It uses ordinary Contracts for candidates, evaluations, and selection
support; it adds no privileged kernel transition. Selected policy support is
recorded as ordinary exact-revision requirements. Challenged or withdrawn
support cannot remain authority for new issuance, and existing dependents use
the normal responsibility-closure rules.

The task-pareto comparator operates on complete records under a separately
frozen protocol: fixed repeats per `(panel, task)`, no task-mean regression, at least one
strict improvement, and retained safety and established-full-pass protections.
All ties do not promote. Recorded scores and safety observations are trusted
adapter inputs; checking their structure does not authenticate the evaluator
or independently measure capability. A successful bind proves selection took
effect, not that recursive improvement has been demonstrated.

## External evaluation adapter

The existing `issueEvaluation` and `settleEvaluation` path gives an external
evaluation a durable obligation and binds its identity to the delivery ID,
delivery revision, subject, and a caller-provided `evaluatorHash`. Settlement
requires an already independently attested, discharged Delivery with the exact
handoff; it does not replace initial Delivery attestation. It correctly
reopens a delivery on a failed report and can discharge a separate evaluation
Contract on a passing report.

It is still an orchestration adapter, not a mechanical verifier boundary.
`settleEvaluation` receives the already-parsed report, pass bit, evidence hash,
disclosure, summary, and time from its caller. It does not retrieve a report by
hash, execute the named evaluator, authenticate report origin, or recompute a
decision from frozen observations.

## External verifier contract

Keep verifier-specific formats outside the kernel. Use the existing replay
structures and a finite, content-addressed external report.

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

For each release qualification, a wrong subject or stale revision is a
required negative control. It must leave the authoritative Contract state
unchanged and append an explicit rejected decision if it reaches the kernel.

Only after one real verifier cannot be represented by the existing frozen
replay policy plus a content-addressed external report should the public
evidence vocabulary be extended. Any future extension should preserve verifier
execution outside the pure kernel and make the kernel consume only finite,
decoded data.

## Implementation and validation pointers

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

The focused test suite includes these checks. A list of test names is not a
release pass record; record actual commands, results, and the exact source
revision in the delivery report:

- `ProContract kernel > rejects executor testimony and preserves authoritative state`
- `ProContract kernel > turns challenged evidence into renewed duty without erasing history`
- `ProContract kernel > turns unsupported dependents into principal-owned remediation`
- `ProContract kernel > keeps sealed verifier evidence away from automatic execution`
- `ProContract kernel > requires matching replay evidence before principal discharge`
- `ProContract replay verifier > replays one frozen subject outside the candidate Location`

They do not establish verifier validity, principal credential isolation,
semantic adequacy of a claim, or authenticity of opaque external evidence.
