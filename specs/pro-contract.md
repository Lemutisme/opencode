# ProContract

Operational commands for building OpenCode and running ProContract with
MLE-bench or ProgramBench are in [`pro-contract-runbook.md`](pro-contract-runbook.md).

## Thesis

An agent is a sequence of short-lived executors. Context compaction, process
exit, and model replacement can erase an executor's working state even when a
user's duty remains. Passive memory can influence what a future executor sees,
but it cannot decide whether a duty still exists, whether an effect is
authorized, or whether completion is valid.

ProContract makes those decisions institutional outputs:

> ProContract preserves who may make work count as finished. Within a mediated
> domain, no executor may erase a duty, expand its authority, or certify its own
> completion.

The contract document is not sufficient. A contract exists only when an
institution has exclusive control over recognized state transitions. The
irreducible roles are:

- the issuer owns why and retains explicit release and revision rights;
- the executor owns how and may only petition;
- the verifier produces prescribed testimony;
- the institution owns authoritative status and valid quiescence;
- the auditor may raise unsolicited, signed challenges.

Model intelligence belongs at the edges. Compilation turns intent into a draft;
reconciliation turns changed circumstances into a plan or petition. Neither
operation changes authoritative state. Replacing the model with an arbitrary
or hostile contractor must not break the control plane's invariants.

## Philosophical foundations

### An agent is a succession of temporary selves

An LLM agent has no intrinsic continuity across context compaction, process
exit, model replacement, or a future invocation. Two histories may project to
the same visible context while containing different outstanding duties. A
policy that sees only the projected context cannot act correctly in both
histories. ProContract therefore treats continuity as an external institutional
property, not a psychological property of the model.

This follows the philosophy of intention as a commitment device. An intention
is not merely a current preference; it resists casual reconsideration and
coordinates future action. An ephemeral policy cannot reliably carry that
stability, so the institution carries it on the policy's behalf.

### Memory, obligation, and truth are different routes

```text
past evidence  -> memory       -> future attention
current intent -> contract     -> future duty and authority
future witness -> verification -> authoritative state
```

Passive memory changes what a policy is likely to consider. Proactive memory
changes when an intention should return to attention. A Contract changes what
the institution recognizes as outstanding, permitted, or complete. Retrieval
cannot substitute for normative force: an executor may ignore a memory, but it
cannot make an institutionally conserved duty disappear.

### Contract force comes from institutional monopoly

A document is not a Contract because its schema is expressive. It becomes a
Contract when an institution monopolizes valid state transitions. The executor
may petition, report, and produce candidate artifacts, but it cannot issue a
completion certificate, expand its own authority, or erase its own debt.

ProContract monopolizes recognized finality and delegated authority, not all
physical behavior. This is deliberately narrower than claiming that a local
process cannot misbehave. It means an executor cannot unilaterally make the
institution accept that an obligation vanished, an effect was authorized, or a
claim was proved.

### Contracts are necessarily incomplete

The natural-language goal and its executable verifier cannot be identical. The
verifier freezes a projection of intent, so immutability is both an anti-Goodhart
mechanism and a source of rigidity. The solution is not an arbitrarily clever
initial schema. It is explicit residual control rights: the issuer owns
revision, release, disclosure, and supersession decisions, while the executor
may propose but not approve them.

### ProContract is a feedback institution

Cybernetically, triggers are sensors, the outstanding ledger is controller
state, capabilities are actuators, and verifier results are error signals. A
positive witness may support discharge; a negative witness becomes a challenge
that keeps or renews duty. The distinctive coupling is:

```text
loss of epistemic support -> renewed normative responsibility
```

A truth-maintenance system revises what is currently supported. ProContract
also specifies who must act because support changed, what authority that actor
receives, and why the system may not become quiet before remediation or an
authorized release.

### Artifacts are boundary objects, not truth

Specs, probes, manifests, handoffs, and reports let principals, executors,
verifiers, auditors, and future Sessions coordinate without sharing internal
state. They must be understandable to humans and mechanically traceable, but
their existence does not prove their claims. Institutional type and provenance
give artifacts meaning: a handoff is a petition, an attestation is current
support, and a challenge is a defeater.

The main intellectual anchors are Bratman's account of intention stability;
prospective-memory work on cue detection, intention retrieval, and execution;
Grossman-Hart-Moore incomplete-contract theory and residual control rights;
Ashby's requisite variety and feedback control; Doyle and de Kleer's
truth-maintenance systems; capability security; and event-sourced durable
execution. ProContract does not collapse these traditions into one metaphor.
It uses each for a separate boundary: attention, commitment, authority,
epistemic support, and durable institutional state.

## Engineering principles

1. **Simplicity is the first correctness property.** A human should understand
   each transition in one pass. New tables, status values, helpers, and modules
   require present use, not anticipated reuse.
2. **Use smart edges and a dumb core.** Models may compile intent and reconcile
   changed circumstances. The kernel only validates finite commands,
   attestations, hashes, roles, and state transitions.
3. **Separate attention, authority, and truth.** A trigger may wake an executor
   without authorizing effects. Sandbox exploration may be broad while shared
   effects remain capability-gated. Completion always requires independent
   adjudication.
4. **Conserve obligations by construction.** Session deletion, executor exit,
   retries, escalation, and process failure are not settlement operations.
5. **Do not let the executor self-certify.** Ready is a structured handoff, not
   completion. Only an authorized attestation may discharge a handed-off duty.
6. **Bind every claim to exact identity.** Revision, specification hash,
   artifact or evidence hash, verifier identity, lease, prompt fence, and
   Location are checked at the narrowest relevant boundary.
7. **Keep disclosure separate from validity.** Calibration feedback may be
   executor-visible. Confirmation evidence may be valid but sealed, preventing
   holdout information from entering the policy context.
8. **Make incompleteness explicit.** Unknowns belong in handoff state;
   renegotiation and escalation are normal protocol outcomes, not exceptions.
9. **Treat capacity as part of liveness.** Conservation exposes overload as
   backlog. It does not create infinite executor or creditor attention.
10. **Keep task mechanics in adapters.** Candidate layouts, cleanroom images,
    test profiles, coverage dimensions, and artifact stores do not belong in
    the normative kernel.
11. **Prefer real paths over mocks.** Verify transitions, database projection,
    HTTP boundaries, generated clients, scheduler recovery, Session context,
    tool mediation, and compiled binaries in proportion to their risk.
12. **State claims narrowly.** Enforced invariants are not theorems about host
    integrity, verifier correctness, solvability, or unconditional liveness.

Three practical tests guide architecture:

```text
Could a human contractor replace the LLM and the protocol still type-check?
Can a fresh reader trace a CLI/API command to state, effect, metric, and test?
Can the same behavior be implemented with fewer concepts or less code?
```

If the first answer is no, correctness depends on model cooperation. If the
second answer is no, hidden control flow has defeated auditability. If the third
answer is yes, the implementation is not yet simple enough.

## Normative kernel

The kernel is a pure, total, deterministic transition:

```text
transition(state, authorized command, finite attestation)
  -> next state, decision, event
```

Illegal commands return a rejection event and leave authoritative state
unchanged. Verifier execution is outside the kernel: an external runner may
fail or hang, but it can only give the kernel a finite attestation.
Transport authentication happens before this transition. The current local
institution exposes role-specific methods rather than a caller-selected actor;
cross-host signatures remain future work.

The first invariant is obligation conservation:

```text
an outstanding duty remains outstanding
or ends through an authorized discharge, release, accepted transfer,
or conserving supersession
```

Escalation is routing, not settlement. It does not make a scope quiet. A
transfer remains `handoff_pending` until the receiving ledger acknowledges the
new duty.

The status names the lifecycle directly:

```text
dormant      -> active
active       -> verification | escalated
verification -> discharged | dormant | escalated
escalated    -> dormant
```

`released` is the issuer-authorized terminal alternative. Only `active`
authorizes executor effects; verification is a normal phase, not an escalation.
The database migration converts the earlier implicit escalation combinations
once, so runtime authorization does not carry compatibility branches.

Quiescence is relative to an immutable ledger frontier, never a permanent
claim. The current API returns an unsigned snapshot containing the scope,
frontier, ledger hash, and scoped state hash. A portable certificate would add:

```text
quiet certificate = scope + ledger frontier + state hash + constitution hash
```

The current snapshot is locally auditable, not a signed certificate. A later
admission produces a new frontier and does not contradict an older snapshot.

The kernel adjudicates evidence that is already materialized. Its eventual
evidence language should stay finite and mechanical: `all-of`, `k-of-n`,
`signed-by`, `hash-equals`, `threshold`, `revision-is`, and `not-revoked`.
Version 1 accepts issuer attestations bound to:

```text
contract ID + revision + specification hash + artifact hash + verifier identity
```

The issuer attestation and discharge are one atomic institutional transition.
The executor cannot submit evidence or discharge the contract.

Failed verification is also an institutional transition. The challenger names
the evaluated revision and handoff subject; the kernel rejects a mismatch
instead of inferring the target from arrival order. An accepted challenge binds
its negative witness to that exact claim and keeps the obligation outstanding:

```text
executor-visible challenge -> dormant -> wake with feedback
sealed challenge           -> escalated, no automatic wake
```

Sealed challenges let a confirmation evaluator reject completion without
leaking holdout evidence into the executor policy. Challenging a historical
discharge never deletes its attestation; it removes current support and admits
new work. The current kernel conservatively rejects that transition when the
old evidence already supports a running or discharged dependent. Dependency
invalidation and remediation closure remain future truth-maintenance work.

Executor completion is a petition, not an attestation. `report-ready` records a
structured handoff containing the claimed result, every known unresolved
assumption, and its time. It pauses execution for adjudication but cannot make
the scope quiet. `report-ready` moves `active` to `verification`; the kernel
rejects discharge unless that handoff exists;
principal evidence alone cannot bypass the executor-to-verifier boundary.
Successful discharge retains the accepted handoff for downstream readers. A
challenge clears current handoff support while immutable ledger history keeps
the earlier claim attributable.

## Contract document

The human-facing document is:

```text
trigger       future condition that should restore attention
goal          intent shown to the executor
brief         issuer-authored context the future executor must retain
requires      exact upstream Contract revisions that must be evidenced first
delegation    authority granted after activation
budget        risk, cost, retry, and time bounds
verifier      evidence policy for discharge
resolution    expiry, revision, release, transfer, and escalation rights
```

`requires` edges are fixed when a Contract is issued. They may name only an
already issued Contract from the same issuer at its exact revision, so the
dependency graph is acyclic by construction. Adaptation appends a new Contract
and explicitly releases the obsolete one; revision cannot silently rewire the
graph. Revision, resume, and release of an upstream Contract are rejected while
an outstanding Contract still requires it. A waiting Contract escalates if its
deadline passes.

This gives the minimal graph its safety argument: every prerequisite precedes
its dependent in issuance order, and immutable edges therefore cannot form a
cycle. Activation rechecks the exact revision and attestation in the same
transaction that changes status. Upstream replacement cannot invalidate a live
edge, and an unresolved wait becomes a visible escalation rather than silent
quiescence.

The kernel commits to the complete document by hash. The goal is necessarily
informal; the verifier is its executable projection. Their gap is construct
validity risk. Freezing a verifier prevents opportunistic goal weakening but
also freezes an imperfect proxy, so revision must be a first-class, cheap
petition from the first release. Only the issuer may accept it.

Useful telemetry includes revision and escalation reasons, unresolved age, and
the rate at which an executor wakes without enough context to reconcile the
document with the world. Escalation rate is not a direct measure of construct
validity: it also includes capacity, authority, context, and realizability
failures.

## Operational method

The normal control loop is:

```text
principal intent
  -> compile a self-contained Contract draft
  -> issue and persist an outstanding obligation
  -> wait for a deterministic trigger or prerequisite evidence
  -> atomically validate readiness and activate
  -> claim a fenced, expiring attempt
  -> reconcile the immutable Contract with the current world
  -> explore inside delegated authority
  -> report blocked work, petition revision, or hand off a candidate claim
  -> verify independently
  -> attest and discharge, or challenge and preserve duty
  -> issue a quiet snapshot only when no scoped duty remains outstanding
```

Compilation is an intentional compression boundary. The Contract cannot retain
all issuance-time context, so the issuer chooses a goal, brief, evidence policy,
and assumptions that a future executor can reconcile without reconstructing the
entire conversation. Failures caused by an insufficient brief are measured as
reconciliation-context failures rather than silently attributed to planning.
OpenCode preserves the latest user request verbatim in the approved brief, so a
model-authored summary can compress context but cannot erase its source intent.
For open-ended optimization, that brief also names the evaluation protocol,
required exploration, any user-provided quality floor, the stopping rule, and
known assumptions. Missing quality criteria remain visible for principal
approval rather than being replaced with an executor-invented proxy.

OpenCode exposes that compiler as `contract_propose`. The model supplies an
existing Contract specification; the Session permission boundary binds
approval to its exact hash before the shared issuer path persists it. Normal sessions ask the user,
while an explicit auto-permission mode supplies standing approval. Rejection
creates no obligation, and the executor never receives direct issue authority.
Legacy and V2 Session registries expose the same proposal name and converge on
the same `ProContractOpenCode.issue` operation; the legacy adapter carries no
separate lifecycle semantics.
Legacy primary Sessions persist one formation decision before their first
effectful tool: `contract_propose` delegates the work, while
`contract_continue` records why it is ordinary single-Session work. Read-only
exploration remains available before that decision. Work whose artifact is
evaluated after the Session is Contract work even when execution itself is
synchronous; `contract_continue` requires both work and validation to finish in
the current Session and cannot replace an issued Contract. Proposal deadlines
are absolute Unix timestamps; past drafts receive the standard 24-hour deadline
before the exact normalized specification is ratified. Model-authored proposals
also receive a 1000-turn and 10000-action autonomy floor before approval. These
budgets are total across all attempts, leaving verification and remediation
headroom while the principal still approves the exact expanded authority.
The existing permission UI shows the exact goal, delegated authority, budget,
dependencies, evidence policy, and specification hash. Headless `--auto` uses
the same permission event and issuer path; it does not bypass adjudication.
After issuance, process-local questions remain fenced; blocked work and proposed
term changes use the durable Contract channels instead.

### Handoff and justification artifacts

An executor handoff contains a concise claim, known unresolved assumptions, and
an institution-captured subject hash. Larger task artifacts remain adapter-owned and should form a
content-addressed justification bundle:

```text
claim + assumptions + witnesses + unknowns + provenance + disclosure policy
```

For a differential-testing adapter, that bundle may materialize exact argv,
stdin, environment, fixture hashes, exit status, stdout, stderr, timeout, and
reference identity. The kernel stores and reasons about the evidence identity;
it does not parse task-specific files or assume that more probes imply better
construct coverage.

The empirical method therefore distinguishes:

```text
number of observations != coverage of relevant state dimensions
```

A coverage matrix, uncertainty ledger, or value-of-information policy may help
the compiler choose experiments, but those remain replaceable edge strategies.
They are not normative Contract fields.

### Adaptive graphs

Existing Contracts are graph nodes and immutable `requires` entries are
revision-bound prerequisite edges. New work extends the graph by issuing new
nodes; it does not mutate old edges. This append-only rule gives acyclicity by
issuance order and makes adaptation attributable.

The graph is deliberately not a generic workflow engine. No automatic planner
is assumed. A compiler may propose decomposition when independent artifacts,
parallelism, or verification justify the coordination cost. A single Contract
is preferable when decomposition would only create bureaucracy.

### Layer ownership

```text
normative core   duty, authority, handoff, attestation, challenge, quiescence
OpenCode adapter Session, model, tools, Location, lease, budgets, prompt fence
compiler         drafting, coverage hypotheses, decomposition, stop policy
verifier adapter artifact execution, provenance, content-addressed witness
task harness     cleanroom, candidate layout, evaluator profile, test split
```

This separation lets ProContract remain general. ProgramBench concepts,
repository-specific probes, and evaluator containers may validate an adapter,
but they cannot become hidden requirements of the core protocol.

## Epistemic support

Institutional history, justifications, and current knowledge are different:

```text
H = immutable history
J = justification graph
K = currently supported authoritative facts
```

A historical discharge is never deleted. If its justification loses support,
the discharge becomes epistemically unsupported while remaining a historical
fact. A standing governance rule may then admit a new remediation duty:

```text
support loss + mandate still valid -> new remediation obligation
```

This is the addition beyond a truth-maintenance system: loss of epistemic
support has a normative consequence. Dependency edges must state their
semantics, such as `depends_on_claim`, `uses_artifact`,
`requires_current_revision`, or `assumes_environment`; supersession alone does
not imply that an old fact became false.

Relevant foundations are Doyle's
[TMS](https://www.sciencedirect.com/science/article/pii/0004370279900080) and de
Kleer's
[ATMS](https://www.sciencedirect.com/science/article/pii/0004370286900809).

## Liveness and capacity

The system guarantees conservation by construction. Outcome liveness is
conditional on a running scheduler, terminating verifier, available executor,
and responsive escalation target. Every nonterminal record must therefore have
one of:

- pending work with a deadline;
- a leased attempt with expiry and heartbeat;
- a pending verification with timeout;
- a durable `next_action_at`.

Startup compensation reclaims expired leases and revisits overdue actions. A
local process cannot provide wall-clock liveness while it is stopped; that
requires a daemon or hosted plane.

One failed scheduler cycle is logged and retried; it cannot silently terminate
the process-local attention loop.

Conservation turns forgotten work into visible debt. Capacity must reserve room
for both new admissions and bursts of remediation after evidence invalidation:

```text
backlog drift = admissions + reactivations - settlements
```

Executor workload and creditor attention are separate limits. A rejected
petition receives a durable rejection decision; an externally existing duty
must be admitted, preempt lower-risk work, or create a capacity-deficit duty.

## Relation to memory and durable execution

Passive memory changes the context used by a policy. Proactive memory changes
what should re-enter attention in the future. Contract state changes what the
institution recognizes as outstanding, authorized, or settled:

```text
factual memory       -> relevant context
proactive memory     -> future attention
contract             -> duty, authority, and valid finality
```

Future attention rules can use the same obligation channel without turning all
facts into contracts:

```text
proactive memory = attention projection of outstanding obligations
```

The evidence policy must distinguish enqueue, endpoint delivery, principal
acknowledgement, and downstream action. A delivery receipt does not prove that
a person noticed a message. Requiring acknowledgement provides stronger
evidence but consumes creditor capacity and needs a terminal policy for an
unresponsive recipient.

Durable workflow systems persist process execution and normally trust their
workers. ProContract persists the duty independently of every process and
treats the executor as untrusted. That premise adds the pieces a workflow
engine does not ordinarily need: delegated capabilities, independent
attestation, candidate versus authoritative state, and policy-independent
settlement. A workflow engine may implement timers and retries for the plane,
but it is not the normative kernel.

## Security boundary

ProContract monopolizes recognized finality and capability issuance, not
physical behavior. Enforcement is scoped to effect points that participate in
the protocol:

```text
applied effect -> institution-authorized capability + valid fence
```

The plane holds truth; an adapter holds muscle. The adapter validates the
contract, revision, lease owner, lease expiry, prompt fence, location, and
budget immediately before an effect. A process running as the same
operating-system user can still bypass an
in-process adapter. Strong enforcement requires a separate authority domain,
such as an isolated worktree and promotion service, repository protection, or
an external API that validates the capability.

Hash-chained logs and externally retained checkpoints provide witnessed-prefix
integrity. They do not provide complete mediation or host integrity.

### Principal isolation

Local in-process mode is cooperative. A server password in the executor's
environment, an unsecured loopback endpoint, or a writable plane database does
not separate principal authority from a shell-capable executor. In that mode
the enforced claim is limited to normal tool-path transitions.

Adversarial non-bypass requires a deployment boundary with all of the following:

- the plane database and principal credential are absent from the executor
  filesystem, environment, and process namespace;
- executor effects run through a worker identity that can present attempt
  capabilities but cannot authenticate principal commands;
- the principal endpoint rejects that worker identity even when it can reach
  the endpoint over the network;
- only finite handoff subjects and verifier testimony cross back into the
  plane.

These are deployment invariants, not prompt rules. OpenCode must not claim
strong principal/executor separation until an adapter declares and tests that
authority-domain boundary.

## Benefits and limits

ProContract does not improve local coding ability or scientific taste. It
improves capability realization over time:

- duties survive context, session, process, and executor replacement;
- bounded delegation permits more asynchronous autonomy;
- an executor cannot turn its own claim into recognized completion;
- justification-bound facts limit downstream error propagation;
- backlog, age, support loss, and overload become measurable;
- structured failure records separate trigger, context, execution, verifier,
  specification, and capacity failures;
- multiple agents and harnesses can cooperate through the same duty protocol.

The costs are specification debt, proxy freezing, latency, verifier risk,
creditor attention, and unbounded backlog when admission exceeds settlement.

## Evaluation methodology

ProContract has structural and empirical claims that must not be conflated.

Structural tests can establish that accepted transitions conserve duty,
executor testimony cannot discharge, stale leases are fenced, sealed evidence
is not injected into executor context, and quiet snapshots remain false while a
duty is outstanding. They cannot establish that the model finds better code or
that a verifier represents the user's true goal.

Capability evaluation should separate at least three estimands:

```text
ordinary execution - no execution
  = value of an additional model invocation

ProContract execution - matched ordinary execution
  = incremental value of durable trigger, context, authority, and verification

verified promotion - candidate claim
  = value of the independent truth boundary
```

For causal comparisons, arms share the same frozen parent artifact, model,
variant, prompt information, tools, Location, cleanroom, maximum compute,
reference interface, packaging, and evaluator. Only the institutional envelope
differs. Actual token use may be an outcome when maximum budgets are equal.
Score, solved rate, latency, tokens, actions, retries, challenges, regressions,
and unresolved age are all reported.

### Calibration and confirmation

Detailed verifier feedback is allowed on calibration instances. Prompt,
compiler, and policy changes derived from those instances are frozen before
confirmation. Confirmation or holdout instances are disjoint and evaluated
once; failed evidence is sealed and cannot drive remediation on the same
holdout. A rounded score is not equivalent to solved, and a failed confirmation
remains outstanding rather than being promoted.

Every evaluation records:

- source commit and dirty-state or binary hash;
- exact model, variant, prompt, Contract Spec, and spec hash;
- initial and final artifact hashes;
- cleanroom and evaluator identities;
- turns, actions, tokens, wall time, attempts, and reference usage;
- Contract event frontier, ledger hash, handoff, attestation, challenge, and
  final quiescence;
- evaluator errors, warnings, branch failures, and filtered score.

Experimental feedback has repeatedly shown that internal probes can all pass
while independent evaluation still finds large semantic gaps. The correct
conclusion is not that probes are useless; it is that handoff is a fallible
claim and construct coverage belongs to verifier and compiler quality. The
institution's contribution is to prevent that fallible claim from silently
becoming accepted truth.

### Validity limits

No performance conclusion is generalized from one stochastic sample, one
instance, unmatched compute, a changed prompt, or a previously observed
holdout. Environment deviations such as emulated architectures, writable
network egress, mutable evaluators, or uncommitted adapters are reported and
exclude acceptance-grade claims even when the run is operationally useful.

## OpenCode design

The contract plane is logically independent of any harness. It should be a
portable kernel with a durable daemon implementation and small adapters.
OpenCode is an execution adapter, not the owner of contract truth.

Harness suitability should be evaluated on three independent substrates:

- trigger support for time and external state;
- effect and verification chokepoints;
- a ledger the executor cannot rewrite.

No single substrate is a substitute for the other two.

OpenCode already provides the useful enforcement substrate:

- `SessionExecution` routes durable Session work to a Location;
- `PermissionV2` and the tool registry provide an effect chokepoint;
- `ProjectCopy` can create a candidate worktree;
- `Snapshot` can bind evidence to content;
- System Context can present an active contract across compaction.

Its current process-local wake and background-job mechanisms do not provide
wall-clock liveness, and unrestricted shell execution cannot express a strong
delegation boundary.

Filesystem capabilities expose tools inside the Contract Location; they do not
disable the existing external-directory fence. Adapters place read-only inputs
and writable candidate state inside that Location while keeping control-plane
state, credentials, and authoritative promotion outside it.

The intended flow is:

```text
plane activates duty
  -> OpenCode binding reserves a bounded attempt
  -> adapter creates a dedicated Session for that semantic attempt
  -> active contract is rendered as privileged System Context
  -> adapter claims a durable lease fenced by revision and prompt ID
  -> tool effect points validate the process owner and current fence
  -> executor reports ready or blocked work, or submits a revision petition
  -> ready work records a structured handoff and enters verification
  -> failed verification records a visible or sealed challenge
  -> visible challenge closes the old attempt and wakes a fresh Session from authoritative state
  -> plane adjudicates and records the transition
  -> principal submits evidence
```

Each contract Session is a replaceable execution venue. Provider retries reuse
the current Session; challenges, revisions, lost leases, and execution that ends
without handoff start a fresh semantic attempt. Deleting, reverting, compacting,
or ending any Session cannot settle the duty. Contract authority never appears
in model input or tool arguments.
Every new semantic attempt begins by reconciling the existing candidate state:
it inspects and reuses valid files, artifacts, and completed checks before new
exploration. Rotation therefore changes the executor, not ownership of work
already materialized in the Location.
Durable message or context-snapshot decode failures also replace the Session;
provider, model-availability, and transient infrastructure failures retry the
current semantic attempt.

Every current and retired Contract Session has an indexed durable reservation.
Rotation changes the active binding without returning an old Session ID to the
ordinary OpenCode permission domain.

Blocked work is an institutional event, not a transient tool result. Its reason
is retained in the ledger, changes the semantic-attempt context, and is supplied
to the fresh Session that resumes the obligation.

Visible verifier feedback uses that same ledger rather than a second memory
store. An active attempt receives the accepted challenge summaries for its
current revision in event order. They are labeled as diagnostic history; only
the Contract specification defines authoritative terms.

Ready work captures the Location snapshot before recording handoff. Principal
evidence can discharge only when its attestation names that exact subject hash;
later workspace mutations do not change what was accepted.
OpenCode therefore fails handoff closed when the Location cannot produce a
content-addressed snapshot.

The execution binding must name its model explicitly. A proactive attempt may
fail closed when that model or credential is unavailable, but it must never
silently select another provider. Contract Sessions are permanently reserved
for the current Session runner; legacy prompt, command, and shell entrypoints
must reject them before recording input or producing effects.

OpenCode issuer entrypoints share one adapter operation that issues the
normative Contract before creating its execution binding. A rejected issue
never creates a binding; an accepted retry reconciles both records idempotently.

### Candidate promotion

Candidate state belongs to the harness adapter, not the normative Contract.
The Contract only decides whether the adapter's promotion witness is sufficient.
For a baseline artifact `B` and proposed artifact `C`, a performance-oriented
adapter should require a finite non-regression witness such as:

```text
compile(C)
and smoke(C)
and observed_probes(C) includes observed_probes(B)
and timeouts(C) <= timeouts(B)
```

Reference probes, seeds, exit codes, stdout, and stderr must be durable adapter
evidence. A reviewer may mutate `C` in an isolated candidate workspace, but it
cannot overwrite `B` or declare promotion. ProgramBench-specific packaging,
cleanroom images, and test splits remain entirely outside Contract state.

### Delivery plan

Each slice must be usable and independently testable. Do not add a generic
workflow framework.

1. **Implemented:** normative kernel with atomic principal discharge, issuer
   release, executor revision petition, and scoped quiescence snapshot.
2. **Implemented:** durable projection, global append-only hash chain, recorded
   rejection decisions, principal HTTP routes, and generated Client bindings.
3. **Implemented:** normative Contract state and OpenCode execution binding are
   stored separately; accepted duties are bound idempotently and rejected
   issues cannot leave orphan bindings. A crash between those writes leaves a
   visible missing-binding escalation for explicit recovery. Durable
   leases, explicit model binding, semantic-attempt Session rotation,
   revision/prompt fencing, startup reclamation,
   privileged context, explicit read/write/process capability mediation,
   cumulative turn/action budgets, bounded semantic attempts, escalation, Contract-only
   control tools, and legacy execution rejection are enforced.
4. A ProgramBench adapter may later own candidate cleanrooms, submissions, and
   frozen evaluator attestations. None of those concepts belong in Contract
   state.
5. A running server provides lease heartbeat and reclamation across competing
   local processes. Hosted wall-clock liveness while every process is stopped
   remains future infrastructure work.
6. **Implemented:** immutable revision-bound prerequisites, atomic readiness
   validation, structured handoff with unresolved assumptions, discharge
   gating, deadline escalation, evidence-bearing dependency context, and
   durable visible/sealed verification challenges. Automatic planning,
   dependency invalidation, supersession lineage, typed epistemic edges, and
   remediation closure remain future work.
7. A second harness adapter to test that the protocol is not OpenCode-specific.
8. A separate plane/worker deployment must isolate principal credentials and
   storage before OpenCode claims adversarial executor non-bypass.

The current slice provides the explicit eight-part Spec, a durable institution,
a separate OpenCode binding, a one-second lease scheduler, bounded per-attempt
Sessions whose effects require explicit authority, generated clients, CLI
commands, structured handoff, challenge, and a TUI Contract inspection and
principal-decision flow. HTTP follows the server's normal auth
boundary: with a password, authenticated callers are the principal; an
explicitly unsecured server grants its callers principal authority. The HTTP
payload cannot select issuer, executor, or verifier roles. Local CLI commands
call the institution directly as the local principal.
