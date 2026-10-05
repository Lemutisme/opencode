# ProContract with opt-in RSI: delivery scope

This release path is a **local, cooperative CLI/API product**: durable task
responsibility plus explicitly authorized strategy succession. It is not an
autonomous capability-gain claim, a distributed execution system, or an
OS-enforced principal/executor security boundary.

The [runbook](pro-contract-runbook.md) gives build and task-operation commands.
The [truth boundary](pro-contract-truth-boundary.md) defines trusted inputs.
Historical cohorts and their frozen protocols remain unchanged.

## Small core, explicit adapters

There is one responsibility state machine. Execution, evaluation, and strategy
selection do not introduce a second completion authority:

| Component                  | Owns                                                                   | Does not own                                      |
| -------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| Pure Contract kernel       | Frozen terms, exact adjudication coordinates, duty reopening           | Model calls, benchmark execution, report truth    |
| OpenCode binding/runner    | Location, model, execution text, Session, accounting and deadline      | Principal approval or acceptance criteria         |
| External verifier/recorder | Task checks, finite reports, raw scores and provenance                 | Kernel transitions or new authority               |
| Strategy adapter           | Scoped protocol, selected bundle, ordinary support Contracts, rollback | Silent global upgrade or new acceptance semantics |

`executionPolicy` is strategy text on an immutable execution binding. It is not
a field in `Spec`. Selected support becomes a normal exact-revision requirement
on a newly issued consumer. Solver and generator roles select different text
from the same bundle; they do not gain different principal privileges.

Attestation requires the caller's evaluated `revision`, `specHash`,
`subjectHash`, and `evidenceHash`. An old report cannot be attached to a newer
subject by letting the server supply current coordinates. Same-revision,
same-subject re-adjudication remains possible: this is an object-coordinate
boundary, not a separate acceptance-generation identity.

Every execution keeps an absolute deadline. Turn/action ceilings are optional;
when omitted, counters still advance and no finite sentinel is substituted.
Existing explicitly capped Contracts retain their caps. Individual-operation
timeouts, cancellation, and infrastructure guards remain in force.

## Strategy operation

Strategy selection is opt-in, principal-local, and scoped. It does not appear
as an automatic default for every interactive Session or as a claim that the
runtime rewrites itself. Use the same state directory as the Contract service.
Do not expose the local principal CLI or its database to an untrusted executor.

### Freeze the protocol and seed

Create a seed `strategy.json`:

```json
{
  "version": 1,
  "solver": "Preserve the user's acceptance criteria; test meaningful counterexamples before reporting readiness.",
  "generator": "Produce a successor strategy.json from permitted development evidence; do not weaken safety, acceptance, or the frozen evaluation protocol."
}
```

The bundle has exactly `version`, `solver`, and `generator`. Both texts must be
nonempty, contain no NUL, and be at most 64 KiB each. No executable patch, model
change, or new tool authority is implied by selecting the text.

A version-1 protocol contains:

- `performanceRule: "task-pareto"`;
- `evaluatorHash`: 64 lowercase hexadecimal SHA-256 characters;
- a fixed `tests` array, each with unique `id` and positive integer `total`;
- performance tests additionally name `performance.panel` (`development` or
  `confirmation`), `task`, and `replicate`;
- nonempty development and confirmation panels, with at least two distinct,
  fixed replicates for each task within its panel;
- at least one non-performance safety test;
- optional `requiredFull`: exact `panel:task` identities required to remain full.

Freeze evaluator, task/repeat manifest, budgets, isolation, feedback visibility,
and stopping conditions before generating or evaluating candidates. Protocol
shape checks do not freeze external infrastructure for you. A changed protocol
requires a new scope, not a hot update or retrospective "preregistration".

Authorize after writing and independently reviewing `protocol.json` and the
seed `strategy.json`:

```bash
"$OPENCODE_BIN" contract strategy authorize --scope strategy-example \
  --protocol "$ARTIFACT_ROOT/protocol.json" \
  --bundle "$ARTIFACT_ROOT/seed/strategy.json" \
  > "$ARTIFACT_ROOT/strategy-state.json"
"$OPENCODE_BIN" contract strategy show strategy-example
"$OPENCODE_BIN" contract strategy bind strategy-example --role generator
```

The initial seed is an explicit principal authorization, **not** a measured
improvement. Keep its bundle and the protocol under content-addressed records.
The strategy state exposes the canonical `protocolHash` and selected
`bundleHash`; use those values rather than hashing differently formatted JSON.

### Generate, evaluate, and use a successor

1. Authorize the frozen protocol and seed with `contract strategy authorize`.
2. Issue a generator Contract with `--strategy <scope> --strategy-role generator`.
   Its goal must request a regular `strategy.json` in the candidate root.
3. Export and independently inspect its exact handoff. A promotion proposal
   must name the generator Contract, revision, and subject. The adapter checks
   the selected generator binding, required support, and that the proposed
   bundle equals `strategy.json` from that captured subject.
4. Use `contract strategy propose` to create the ordinary promotion Contract.
   Generation is provenance, not evidence of improvement.
5. The external evaluator runs the complete frozen baseline/candidate manifest
   and stores a finite evidence record. Submit it with `contract strategy settle`.
6. Inspect `contract strategy show` and `contract strategy bind`. An eligible
   settlement selects the supported successor; a rejected comparison does not.
7. Issue a **new** solver or generator Contract with `--strategy <scope>`.
   Confirm its recorded `executionPolicy` and support requirement match the
   selection. Existing bindings remain unchanged.

For step 2, issue from the generator's candidate Location:

```bash
"$OPENCODE_BIN" contract issue --id pct_generator_example \
  --scope strategy-example \
  --goal "Produce strategy.json containing a successor solver/generator bundle under the frozen protocol" \
  --model "$MODEL" --variant "$VARIANT" --write --deadline "$DEADLINE_ISO" \
  --strategy strategy-example --strategy-role generator
```

For steps 3–5, after the generator has a handoff and its exported bundle is
available at `$ARTIFACT_ROOT/generated/strategy.json`:

```bash
"$OPENCODE_BIN" contract show pct_generator_example |
  jq '{contractID:.id,revision:.revision,subjectHash:.handoff.subjectHash}' \
  > "$ARTIFACT_ROOT/generation.json"
"$OPENCODE_BIN" contract strategy show strategy-example > "$ARTIFACT_ROOT/strategy-state.json"
SELECTION_REVISION=$(jq -er '.revision' "$ARTIFACT_ROOT/strategy-state.json")

"$OPENCODE_BIN" contract strategy propose --scope strategy-example \
  --expected-revision "$SELECTION_REVISION" \
  --bundle "$ARTIFACT_ROOT/generated/strategy.json" \
  --generation "$ARTIFACT_ROOT/generation.json" \
  > "$ARTIFACT_ROOT/promotion.json"
PROMOTION_ID=$(jq -er '.id' "$ARTIFACT_ROOT/promotion.json")

# Run the independently frozen evaluator and archive its real observations first.
"$OPENCODE_BIN" contract strategy settle "$PROMOTION_ID" \
  --evidence "$ARTIFACT_ROOT/evidence.json" \
  > "$ARTIFACT_ROOT/settlement.json"
"$OPENCODE_BIN" contract strategy bind strategy-example --role solver
```

A complete but ineligible comparison prints its decision/state and exits `2`;
do not treat that as promotion. Malformed or incomplete evidence fails admission.
The proposal's JSON `spec.brief` records `protocolHash`, `baselineHash`, and
`candidateHash` for the external recorder.

`--strategy-role` defaults to `solver`. `--strategy` cannot be combined with
`--execution-policy`. Explicit execution text is useful for a one-off principal
choice but is not evidence-backed strategy selection.

Evaluation evidence uses:

```text
protocolHash   exact authorized protocol
candidateHash  proposed canonical bundle
baselineHash   currently selected canonical bundle
receiptHash    external recorder's archived receipt
rows           candidate observations
baseline       incumbent observations
```

Each observation is `{id, passed, total, valid}`. Both tables must contain
exactly the frozen tests, with no duplicates, missing rows, changed denominator,
or invalid result. Hashes are lowercase 64-character hexadecimal strings.
The CLI/service validates identity and structure; it does not fetch the receipt,
authenticate the evaluator, or independently reproduce the scores. The trusted
recorder must check raw artifacts, model/budget coordinates, isolation, and
provenance before submission. Missing evidence is an infrastructure error,
not a zero score or a failed candidate.

For complete evidence, promotion requires:

- all safety tests pass for both baseline and candidate;
- every `(panel, task)` mean over its fixed repeats is nondecreasing;
- at least one such mean strictly improves, however small the improvement;
- previously established and explicitly required full passes are retained.

Panels may contain different task sets; scores are never pooled across panels
to hide a regression. The comparison uses exact rational values rather than
rounded scores. All ties
retain the incumbent. There is no one-percentage-point hurdle and no implicit
cost/turn/request ceiling. Do not feed sealed confirmation details into candidate
search. A performance failure cannot be converted into a pass by changing the
manifest, repeats, or rule after seeing the data.

### Withdrawal and rollback

`contract strategy revoke` withdraws the selected ordinary Contract's support.
It preserves historical records, fences new binding, and invokes normal
transitive responsibility reopening for existing dependents. It does not
atomically cancel arbitrary external processes across machines.

For explicit withdrawal and then rollback, read the new selection revision
between mutations:

```bash
SELECTION_REVISION=$("$OPENCODE_BIN" contract strategy show strategy-example | jq -er '.revision')
"$OPENCODE_BIN" contract strategy revoke strategy-example \
  --expected-revision "$SELECTION_REVISION" --evidence-hash "$REVOCATION_EVIDENCE_HASH"
SELECTION_REVISION=$("$OPENCODE_BIN" contract strategy show strategy-example | jq -er '.revision')
"$OPENCODE_BIN" contract strategy rollback strategy-example \
  --expected-revision "$SELECTION_REVISION"
```

`REVOCATION_EVIDENCE_HASH` is the lowercase SHA-256 of the archived negative
report. Rollback fails if no earlier selection retains support.

`contract strategy rollback` requires the expected selection revision and
chooses an earlier still-supported selection. It does not repair unsupported
history or silently refresh stale authorization. Inspect the returned state,
then issue new opted-in work. `show` is observation; `bind` resolves the exact
current role text and requirement, not a mutation of an existing executor.

A stopped generator, failed comparison, stale selection revision, invalid
receipt, or withdrawn support must not be relabeled as a successful promotion.

## Release qualification

Record one source revision plus any dirty patch, generated-client identity,
binary SHA-256, environment, commands, exit codes, and exact artifacts. A build
or test from another worktree is not a pass for this release. Do not infer
completion from this checklist; append the actual validation record.

| Gate                 | Required observation                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build and types      | Package-level `bun typecheck`; regenerated Client/SDK when required; host binary starts                                                           |
| Task lifecycle       | Public issue → actual Session/provider/tool path → frozen handoff → independent report → coordinate-bound attestation → quiet                     |
| Stale evidence       | Evaluate A, replace with B, submit A coordinates: reject without discharging B; matching B coordinates can settle                                 |
| Execution identity   | Bound model/variant cannot silently change; actual next request uses the recorded identity                                                        |
| Deadline/accounting  | Continue beyond former cumulative ceilings; retain usage and original deadline across recovery; stop at deadline; retain explicit historical caps |
| Cancellation/restart | Release interrupts local active work; durable state recovers without invented completion or extra budget                                          |
| Promotion            | Generated bundle matches captured subject; complete positive comparison selects it; new solver and generator bindings consume its exact text      |
| Negative promotion   | Ties, task regression, lost full pass, failed safety, incomplete evidence, wrong lineage, and stale revision cannot select                        |
| Withdrawal           | Revoke fences new consumers; affected duty reopens; explicit rollback selects supported history                                                   |

Mechanism tests may use a deterministic provider and synthetic evaluator
observations. They validate execution and governance wiring, **not** model
capability, evaluator truth, or sustained recursive gains. A real performance
claim additionally needs separately frozen development/confirmation evidence
and full provenance under the declared benchmark protocol. No paid campaign
is implied by building or qualifying this product.

### Local qualification, 2026-10-05

The delivery branch merges upstream `907b3bc518fa48e90e8ec24dd327d13eee71c36c`.
The original working directory and frozen cohorts were not modified. Qualification
used Bun 1.3.14 on Linux x64; dependency installation used Node 24.21.0.

| Check                                         | Observed result                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Core full suite                               | 1,363 passed, zero failed, 168 files                                                |
| Schema / Client full suites                   | 23 / 16 passed, zero failed                                                         |
| LLM executor and Responses regressions        | 76 passed, zero failed                                                              |
| OpenCode HTTP and historical comparison gates | 35 passed, zero failed                                                              |
| Strategy CLI process tests                    | 2 passed, zero model calls                                                          |
| Native lifecycle and strategy process suite   | 4 passed from source and 4 passed against the compiled binary                       |
| Typechecks                                    | Schema, Protocol, Core, Server, Client, SDK Next, LLM, OpenCode and TUI passed      |
| Generated state                               | Client and legacy SDK regenerated; database migration check passed                  |
| Host build                                    | Linux x64 binary with embedded Web UI; version and command help smoke checks passed |

The process suite exercises two actual scripted-provider generations, successor
policy on the provider wire, explicit rollback, independent finite verification,
restart, stale-evidence rejection, deadline termination and cancellation. These
are mechanism observations only. The entire monorepo, every operating system,
and adversarial isolation have not been qualified by this record.

The distribution's `RELEASE.json` binds the final source commit, binary and model
catalog hashes, build coordinates, and qualification commands. Preserve it with
the executable; do not substitute a binary from a historical cohort.

## Compatibility and limits

- Attestation clients must now send all four evidence coordinates. Regenerate
  clients; do not preserve an evidence-hash-only call that guesses the subject.
- General CLI defaults remain 24 hours / four turns / 32 actions without an
  explicit `--deadline`. With `--deadline`, omitted caps stay absent. Future
  ProgramBench protocols explicitly select six-hour-only and qualify all layers.
- Strategy authorization/settlement uses ordinary principal Contracts. A new
  promotion proposal currently inherits the general 24-hour adjudication
  deadline; arrange external evaluation within that window. This is not a
  permission to change any already-issued deadline or a running cohort.
- Historical `spec.policy`, requirement `policy` flags, and `contract policy`
  configuration are not the current operation path. Existing experiment reports
  are historical evidence, not current installation instructions.
- Principal identity is local process authority or the configured authenticated
  server principal, not per-verifier identity, signatures, or OS non-bypass.
- Session coordination and cancellation are process-local, not clustered.
- Kernel support is Contract/object-bound, not arbitrary historical acceptance
  record withdrawal. Report authenticity and semantic adequacy remain external.
