# ProContract Constitution

This document is the admission rule for ProContract Core. It starts from the
problem that survives every executor, model, verifier, and task substitution:

> An executor must not be able to erase its duty, expand its authority, or make
> its own candidate count as recognized completion. When support is defeated,
> responsibility must become outstanding again under an identified owner.

ProContract is an institution for authority and finality. It is not a planner,
benchmark controller, replay format, or capability-improvement algorithm.

## Axioms

### Temporary executors cannot own continuity

Sessions, processes, contexts, models, and human contractors are replaceable.
Their deletion or failure cannot settle an admitted duty.

### Finality requires an authority distinct from execution

The executor may report, hand off a candidate, or petition different terms. It
cannot attest, release, revise, or discharge the duty it executes.

### Authority is exact and bounded

Effects are recognized only while the exact duty revision is active and the
presented delegation is current. Replacing a Session or transport cannot expand
that delegation or reset a shared ceiling.

### Truth is support, not an artifact's existence

A candidate is an exact subject-bound petition. A finite attestation supports a
frozen claim; it does not prove every meaning of the goal. A challenge is a
defeater that removes current support without deleting history.

### Lost support renews responsibility

When live downstream recognition depends on challenged support, affected duties
must become outstanding or issuer-owned remediation in the same authoritative
transition.

### Institutional decisions are auditable

Accepted and rejected commands produce immutable events. Quiescence is scoped
to one ledger frontier and can be invalidated only by a later admitted event.

## Minimal algebra

The kernel is a pure total reducer:

```text
transition(state, authenticated command, finite evidence reference)
  -> next state, decision, event
```

Illegal commands preserve the input state and return a rejected event.

The irreducible state contains:

- duty ID, scope, revision, terms identity, issuer, and executor;
- status and current candidate subject, if any;
- current support/attestation references and immutable dependency edges;
- pending issuer decision or escalation routing when outstanding work cannot
  execute;
- an append-only decision frontier.

The irreducible transition vocabulary is:

```text
issue
activate
report-ready
report-blocked
petition-revision
decide-revision
discharge
challenge
escalate
resume
release
```

Only `discharged` and issuer-authorized `released` are quiet. `escalated` is
routing, not settlement.

## Kernel invariants

1. **Obligation conservation** — process, Session, executor, retry, and
   escalation events cannot settle a duty.
2. **Residual control** — only the issuer may approve revision/release; only
   prescribed testimony may support discharge.
3. **No self-certification** — issuer and executor are distinct, and executor
   testimony cannot become an attestation.
4. **Exact identity** — revision, terms, candidate subject, evidence, and
   dependency identities match at every authority-changing transition.
5. **Effect authority** — only the current active revision may spend its bound
   delegation and shared limits.
6. **Responsibility closure** — accepted challenge atomically removes current
   support from affected live dependents and assigns remediation.
7. **Historical integrity** — a challenge never deletes earlier decisions or
   attestations; it changes current support.
8. **Auditable rejection** — a rejected command leaves materialized state
   unchanged and remains in the decision ledger.
9. **Frontier-relative quiet** — quiet names a scope, state identity, and ledger
   frontier, never an eternal fact.

## Layer ownership

```text
normative kernel
  duty identity, roles, status, candidate/support identity,
  dependencies, challenge closure, decision, quiet

institution store and authority boundary
  authenticated commands, atomic projection + append-only ledger,
  principal/worker identities, checkpoint/signature

execution adapter
  Session/model/process, effect capabilities, leases/fences,
  concrete budget counters, recovery, interruption

compiler
  natural-language goal/brief, decomposition, trigger interpretation,
  exploration allocation, implementation and stopping policy

verifier adapter
  replay commands, files, proofs, rubrics, test images,
  canonical report and provenance validation

governance/search adapters
  evaluated-delivery composition, policy artifacts, selection,
  assurance succession, RSI/search DAGs
```

Core may bind the identities of adapter-owned manifests. It must not interpret
their task-specific mechanics unless removing that interpretation would violate
a kernel invariant.

## Admission tests for Core

A concept belongs in ProContract Core only if removing it would permit at least
one of the following:

- a live duty becomes quiet without authorized settlement;
- an executor gains or spends authority it was not delegated;
- a stale or substituted candidate/evidence identity is accepted;
- an executor makes its own completion authoritative;
- challenged support leaves recognized dependent support without an owner;
- an accepted or rejected authority-changing command becomes unauditable.

If removal changes only which hypothesis is tried, benchmark score, prompt
style, scheduling efficiency, replay implementation, or search order, the
concept belongs at an edge.

Three substitution checks also apply:

1. A human contractor can replace the LLM without changing kernel semantics.
2. A non-filesystem verifier can replace argv/file replay without changing
   settlement semantics.
3. A second execution adapter can replace OpenCode without changing the command
   reducer.

## Transitional debt in the current slice

The present public Schema/Service still exposes adapter-specific concepts:

- `filesystem.read`, `filesystem.write`, and `process.execute` capabilities;
- provider-turn and tool-action budget units;
- argv/cwd/protected-file/artifact replay policy;
- special execution-policy dependency semantics;
- evaluated-delivery constructors on the core service.

These remain supported until compatibility migrations exist. Their presence is
not evidence that they are constitutional kernel concepts.

The current local deployment is also cooperative. Strong non-bypass is not
established until the executor cannot access principal credentials, mutation
routes, the plane database, or verifier evidence storage.

## Change gate

Every ProContract Core change must state:

- the invariant it enforces;
- the counterexample possible without it;
- why an adapter/composition cannot enforce the same boundary;
- the focused pure-kernel test;
- the real boundary/integration test;
- the added concepts and deleted concepts/branches.

Performance evidence may justify compiler, executor, or verifier changes. It
cannot by itself justify new authority-changing kernel semantics.
