# ProContract: replaceable research and execution methods

This is the implementation guide for `research-execution`, based on
`contract-delivery@431324f412`. It supersedes the historical delivery guide's
shared strategy selection and execution-support dependency semantics. The
[runbook](pro-contract-runbook.md) covers ordinary task operations. Historical
[delivery qualification](pro-contract-delivery.md) and
[extended evaluation](pro-contract-delivery-evaluation.md) remain records of
their original source/binaries, not qualification of this implementation.

The invariant is simple: **replace the method, not the responsibility, evidence,
or history**. One execution primitive runs ordinary tasks and research tasks.
A research result can justify further research without justifying deployment.
The candidate never acquires authority to accept its own result.

## 1. Small kernel, three kinds of durable information

There are no new Kernel commands or research-specific completion state machines.
The existing Contract ledger still owns duty, readiness, attestation, challenge,
and release. The adapters retain:

| Information                | Meaning                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| Contract                   | What remains owed and which exact result has valid support            |
| Version/experiment archive | What ran, what it produced, and what was observed, including failures |
| Role bindings              | Which exact method is authorized for the next task                    |

There are two independent role bindings: `incumbent` and `research_executor`.
`solver` and `generator` remain CLI aliases for text-policy compatibility.
The research target is a task parameter, not a third permanent role:

```text
research executor g modifies target p -> candidate c
incumbent i continues serving
```

`target-version` is an archived **bundle hash**. A bundle's `versionHash` is the
different identity of its executable manifest. Neither ancestry nor generation
provenance automatically creates a result-evidence dependency.

### Execution authorization is not result support

New bindings record `authorization` using the Schema `ExecutionAuthorization`:
the grant's Contract ID, revision, spec hash, subject hash, and attestation ID.
Admission and execution check that exact grant. It is not inserted into
`spec.requires`. `requires` retains its existing meaning: actual evidence
dependencies whose loss should reopen a result.
`contract version run --require pct_result@1` declares such a dependency
explicitly; reading a result through the permitted View does not create one.
A dependency also does not automatically make that Contract readable.

- Switching a role affects **new tasks only**. Existing tasks retain their
  version, model, grant, and original deadline.
- Withdrawing a grant fences further execution under it. It does not invalidate
  a separately accepted task result merely because that method produced it.
- Challenging actual result evidence still reopens dependent responsibility.
- A failed run remains outstanding; a role rollback does not complete it.

Historical text states are projected on read without rewriting old ledgers or
Contracts. Their previously declared `requires` relationships retain their old
semantics, including transitive reopening. A historical shared grant is not
retroactively split into two independent grants. Start a new frozen scope for
new semantics; do not relabel an old experiment.

## 2. One Run, replaceable code

`ProContractRun` admits a normal durable Contract, resolves the selected role
once, and executes its frozen version. Both task and research inputs use:

```text
Run(version, task, permitted View, copied workspace, absolute deadline)
  -> retained artifacts, observations, execution outcome
```

The workflow decides what to investigate, which permitted history to use,
whether to ask for reasoning, and what candidate to generate. The host checks
authority, identity, isolation, and deadlines; it does not implement a fixed
research algorithm or automatically schedule proposed experiments.

### Executable package and protocol

The current package is a **self-contained Bun workflow**, including vendored
dependencies. Freeze records source files and empty directories, entrypoint,
JSON configuration, exact Bun runtime bytes, and the required Linux runtime
libraries. There is no package installation or arbitrary host build step.
Symlinks, hardlinked files, sockets, and unsafe paths are rejected.

The process reads one JSON object from stdin:

```text
version, versionHash, targetVersion?, task, view, deadline, config
```

In this process envelope, `targetVersion` is the target's **executable manifest
hash**, not the CLI's archived bundle hash. It is absent for a text-only target.
The durable Contract retains both identities.

For durable Runs, `task` contains `contractID`, `revision`, `specHash`, and the
user's JSON `input`. `view` contains the explicitly selected archive and Contract
records, prior run observations, retained reasoning responses, and unresolved
reasoning identities. Authorized Contract IDs are read afresh for each
invocation as full current `ProContract.info` records, not artifact bytes or a
redacted summary; omitted Contracts are not exposed. Formal comparison tables
are not included in the archive View.
The principal must also keep sealed information out of permitted experiment
records and task inputs; this projection is not a semantic secrecy classifier.

The executable source is read-only at `/version`; an executable research target
is separately read-only at `/target`. The copied input workspace is writable at
`/workspace`. Emit exactly one JSON output object on stdout; use stderr for logs:

```json
{
  "version": 1,
  "observations": [{ "finding": "unverified observation" }],
  "requests": [],
  "artifacts": ["report.json", "candidate", "strategy.json"]
}
```

Artifact paths are normalized, workspace-relative paths. For a successor,
`candidate/` contains its source and `strategy.json` contains its solver and
generator policy text. The host freezes that source, then checks that the
proposed executable exactly matches the retained candidate artifacts. A
version-1 generated text bundle can be paired with frozen source using default
`null` configuration. Non-default configuration must already be committed by
the generated version-2 bundle's `versionHash`.

Run receipts bind the executable, request, original input workspace, trusted
supervisor identity, timestamps, exit outcome, output, and artifact manifest.
The Contract handoff names the receipt's subject hash. Export verifies retained artifact bytes before copying
to a **new** directory; it never overwrites an existing export. Input capture
publishes its own checksummed, request-bound manifest before candidate execution.
Explicit recovery reuses the first successfully captured, verified input even
when the invocation never published a final receipt. It does not substitute later edits to the
external workspace or carry forward unrecorded scratch mutations. A partial or
corrupted capture is not evidence that the original input was safely retained.

### Optional native reasoning, not another provider loop

An explicitly model-authorized Run may emit this item in `requests`:

```json
{ "type": "reason", "id": "diagnosis-1", "prompt": "Compare these two explanations..." }
```

The host durably names this request before issuing it through the existing V2
Session admission, execution coordinator, and runner. Each request is a single
text-only provider observation: no tools, candidate-selected agent, extra
filesystem authority, or acceptance authority. The candidate receives the
retained **unverified** response in the next invocation and decides what to do
next. There is no new in-memory provider/tool loop. A completed request ID cannot
be reused to obtain fresh work. No cumulative research request cap is implied
by the single-observation operation shape.

Without `--model`, a `reason` request fails rather than obtaining implicit
provider access. Malformed reasoning requests fail. Other requests, including
claims to adopt a version, remain recorded proposals and are not executed.

## 3. Principal workflow

Use the same isolated durable state exports as the runbook, outside all candidate
source/workspace directories. Executable operation currently requires **Linux
x64, Bun, and `/usr/bin/bwrap` with the required user-namespace support**. An
unavailable sandbox fails closed; there is no unsandboxed fallback.

Freeze a small self-contained workflow and authorize a seed:

```bash
"$OPENCODE_BIN" contract version freeze \
  --directory "$METHOD_SOURCE" --entrypoint workflow.ts \
  > "$ARTIFACT_ROOT/v0.json"
V0=$(jq -er '.versionHash' "$ARTIFACT_ROOT/v0.json")
jq -n --arg hash "$V0" \
  '{version:2,versionHash:$hash,solver:"Solve the authorized task.",
    generator:"Investigate the stated question; preserve negative findings."}' \
  > "$ARTIFACT_ROOT/seed.json"
"$OPENCODE_BIN" contract strategy authorize --scope "$SCOPE" \
  --protocol "$ARTIFACT_ROOT/protocol.json" --bundle "$ARTIFACT_ROOT/seed.json"
"$OPENCODE_BIN" contract strategy bind "$SCOPE" --role research_executor \
  > "$ARTIFACT_ROOT/research-binding.json"
TARGET=$(jq -er '.identity.bundleHash' "$ARTIFACT_ROOT/research-binding.json")
```

`protocol.json` is independently frozen before search: version 1, task-pareto,
evaluator hash, fixed development and confirmation tasks/repeats, safety tests,
and any required full-pass identities. Its format is unchanged from the
[historical protocol specification](pro-contract-delivery.md#freeze-the-protocol-and-seed).
Seed authorization is a principal choice, not evidence of improvement.

Run one research task; the task JSON's meaning belongs to the workflow:

```bash
DEADLINE_ISO=$(bun -e 'console.log(new Date(Date.now() + 6*60*60*1000).toISOString())')
"$OPENCODE_BIN" contract version run --id pct_research_one \
  --scope "$SCOPE" --role research_executor \
  --target-version "$TARGET" --task "$ARTIFACT_ROOT/task.json" \
  --workspace "$WORKSPACE" --deadline "$DEADLINE_ISO" \
  > "$ARTIFACT_ROOT/run-one.json"
```

Add `--view permitted-view.json` to select `versionHashes`, `experimentIDs`, and
optional `contractIDs`; the default View exposes no archived or other Contract
records. Add `--model provider/model` and optionally
`--variant` only when native reasoning is authorized. Omitting those flags
runs offline. The same command with `--role incumbent` executes ordinary work.

Archive the exact generated candidate **without creating a promotion duty**:

```bash
RUN_ID=$(jq -er '.run.id' "$ARTIFACT_ROOT/run-one.json")
jq '{contractID:.contract.id,revision:.contract.revision,
     subjectHash:.contract.handoff.subjectHash,runID:.run.id}' \
  "$ARTIFACT_ROOT/run-one.json" > "$ARTIFACT_ROOT/generation-one.json"
"$OPENCODE_BIN" contract version export "$RUN_ID" \
  --directory "$ARTIFACT_ROOT/generation-one"
"$OPENCODE_BIN" contract version freeze \
  --directory "$ARTIFACT_ROOT/generation-one/candidate" --entrypoint workflow.ts \
  > "$ARTIFACT_ROOT/v1.json"
V1=$(jq -er '.versionHash' "$ARTIFACT_ROOT/v1.json")
jq --arg hash "$V1" '{version:2,solver,generator,versionHash:$hash}' \
  "$ARTIFACT_ROOT/generation-one/strategy.json" > "$ARTIFACT_ROOT/bundle-one.json"
REV=$("$OPENCODE_BIN" contract strategy show "$SCOPE" | jq -er '.revision')
"$OPENCODE_BIN" contract strategy archive --scope "$SCOPE" \
  --expected-revision "$REV" --bundle "$ARTIFACT_ROOT/bundle-one.json" \
  --generation "$ARTIFACT_ROOT/generation-one.json" --target-version "$TARGET"
```

The example assumes default candidate configuration; do not overwrite a
generated non-default manifest identity. Read the canonical candidate bundle
hash from `contract strategy show`, under `versions`, rather than hashing
formatted JSON. The artifact match rejects substituted code, text, target, or
generation provenance.

For research-only continuation, first independently review the candidate and
perform cheap offline startup qualification:

```bash
"$OPENCODE_BIN" contract version qualify "$V1" \
  --task "$ARTIFACT_ROOT/qualification-task.json" --workspace "$WORKSPACE" \
  --deadline "$DEADLINE_ISO" > "$ARTIFACT_ROOT/qualification-one.json"
jq '.qualification' "$ARTIFACT_ROOT/qualification-one.json" \
  > "$ARTIFACT_ROOT/research-qualification.json"
REV=$("$OPENCODE_BIN" contract strategy show "$SCOPE" | jq -er '.revision')
"$OPENCODE_BIN" contract strategy select-research --scope "$SCOPE" \
  --expected-revision "$REV" --bundle-hash "$CANDIDATE_BUNDLE_HASH" \
  --qualification "$ARTIFACT_ROOT/research-qualification.json"
```

Startup success is not a safety theorem or deployment evidence. This command is
an explicit principal authorization to spend research effort, not a claim that
the candidate is a better researcher. The incumbent remains unchanged.

Run the next research task using the same `version run` command with a new
Contract ID and an explicit target. The selected **v1 code** now runs; the host
does not continue using v0 while merely attributing the output to v1.

When development evidence warrants independent confirmation, use
`contract strategy propose` with the same candidate arguments as `archive`.
Its ordinary promotion Contract freezes comparison against the **incumbent**,
not necessarily the research target or generator. Submit the complete external
record with `contract strategy settle <contractID> --evidence evidence.json`.
Eligible settlement changes only `incumbent`; selecting that version as the
research executor remains a separate authorization.

Formal adoption retains task-pareto: no task mean regression over fixed repeats,
at least one strict improvement, all ties retain the incumbent, complete
development/confirmation evidence, safety, and established-full-pass protection.
The host validates coordinates and the rule; the independent recorder remains
responsible for authentic measurements. Do not use startup/replay scores as
substitutes for fresh confirmation, repeatedly expose sealed tests to search,
or alter a frozen protocol after results. A changed protocol needs a new scope.

## 4. Research completion is not adoption

`contract strategy record-experiment` archives a source-bound record without
accepting its conclusion. Records contain the question, hypothesis,
intervention, observations, conclusion, outcome (`supported`, `unsupported`,
`inconclusive`, or `failed`), evidence hash, executor/target/candidate identities,
and exact source/run accounting. Archive retention does not make a statement
true. `contract strategy view` exposes only explicitly selected records.

For executable research, the experiment's `budget.startedAt` and `finishedAt`
must match its referenced invocation, not necessarily the full multi-invocation
study. Do not report that interval as total research cost. Use
`contract version show` to inspect all `runs`, `responses`, and `reasoning`
identities, including their referenced native Contract/Session accounting.
Pending runs and unresolved provider work remain unknown, not zero-cost or
successful observations.

After independent review, `contract strategy complete-research --scope ...
--expected-revision ... --generation generation.json --experiment experiment.json`
attests the exact research handoff and retains the experiment atomically. It
does not change either role. This can complete an honest negative report duty;
it does not prove absence of benefit, fulfill a broader improvement goal, or
turn a failed execution into completed research. Ordinary task acceptance uses
the existing coordinate-bound `contract attest` path.

## 5. Failure, withdrawal, and recovery

Run identities and native request identities are retained before execution.
Startup errors, malformed outputs, cancellation, and deadline outcomes remain
inspectable, not fabricated zero scores. An incomplete receipt is pending, not
permission to rerun it on observation or process restart.

A trusted supervisor runs outside the candidate PID namespace. It enforces the
original absolute deadline and terminates its owned sandbox after host death,
including host `SIGKILL`; candidate code cannot replace this supervisor. A host
crash may still leave no final receipt. Cleanup is not acceptance, an invented
exit result, or permission to replay an uncertain operation.

```bash
"$OPENCODE_BIN" contract version show pct_research_one
"$OPENCODE_BIN" contract version resume pct_research_one
"$OPENCODE_BIN" contract release pct_research_one --reason "Principal cancelled this task"
```

`resume` is an explicit decision to continue outstanding work on the same task.
It creates a new invocation when execution is still needed, retains prior
failures, and preserves the original version, grant, task, and deadline. It
reuses verified captured input from completed or pending invocations. An
invocation whose input was never captured cannot supply a restored workspace.
If no input was captured, explicit recovery reads the original authorized
directory; input bytes are not frozen at Contract admission. Incomplete capture
markers or corrupted retained input fail closed rather than silently recapturing.
It cannot silently retry already-consumed native provider work. An unresolved
provider request requires a new explicit workflow request identity rather than
replay of an uncertain external action. No read operation
or restart adds time or issues fresh provider work.

`strategy revoke` and `strategy rollback` each take `--role` and the current
`--expected-revision`; revocation additionally requires `--evidence-hash`.
Rollback selects still-supported history for that role. It does not revive a
withdrawn grant, erase trials, undo external side effects, or rewrite existing
bindings. A task bound to a withdrawn grant remains fenced even after selecting
another incumbent. Resuming that duty under another method needs an explicit
future handoff design, not silent rebinding.

## 6. Qualification and limits

The mechanism acceptance scenario is a real process chain:

```text
v0 runs research -> v1 archived but not deployed
  -> independent research-use grant -> v1's changed control flow produces v2
  -> independent v2 versus incumbent v0 comparison -> new tasks use v2
```

The process fixture also checks failed-run recovery, negative research
completion without adoption, forged provenance rejection, and preservation of
accepted results after method withdrawal. See
[`pro-contract-research-process.test.ts`](../packages/opencode/test/cli/serve/pro-contract-research-process.test.ts).
The source fixtures are deterministic mechanisms, not paid model-quality
measurements or evidence that a successor is better at generating successors.
That claim requires the separately controlled same-starting-point experiment.
The [qualification record](pro-contract-research-qualification.md) identifies
the implementation, binary, validation commands, and bounded delivery claims.

Run package checks from their package directories. Relevant suites include
Core's `pro-contract-policy`, `pro-contract-authorization`,
`pro-contract-authorization-scheduler`, `pro-contract-version`,
`pro-contract-version-security`, `pro-contract-run`, and `pro-contract-reason`,
plus OpenCode's `contract-version` and research process suites. Regenerate the
Client and SDK after public API changes. Record exact commands, failures,
source/dirty state, and binary identity; old release totals are not new passes.

The implemented surface is deliberately bounded:

- The workflow sandbox exposes no ambient host credentials, responsibility
  database, evaluator directory, or host network. The principal must exclude
  secrets from the source, workspace, task, configuration, and permitted View
  supplied to it; those inputs are intentionally readable. The host, Linux
  kernel, Bun, bubblewrap, and principal remain trusted. The ordinary cooperative
  `contract issue` path does **not** acquire this sandbox merely by selecting
  strategy text.
- Packages/workspaces/artifact snapshots are guarded at 128 MiB and 10,000
  entries; protocol input/output and runtime capture also have operation-size
  guards. These are infrastructure protections, not cumulative experiment
  budgets. Six-hour deadline-only experiments retain complete accounting and
  existing explicit historical count caps are not rewritten.
- The supervisor provides process ownership, deadline enforcement, and cleanup,
  not cgroup memory, PID, or scratch-disk DoS protection. Use external
  resource containment for hostile workloads; do not claim general adversarial
  hosting or cross-platform qualification.
- This replaces vendored workflow code and policy, not an arbitrary full
  OpenCode binary, model weights, server, Kernel, or evaluation authority.
  There is no automatic network dependency installation or full-binary OTA.
- No autonomous benchmark scheduler, unlimited holdout querying, paid-model
  capability improvement, or sustained RSI gain follows from the mechanism
  tests. Research wisdom remains replaceable; accepting and deploying its
  outputs remains an independent decision.
