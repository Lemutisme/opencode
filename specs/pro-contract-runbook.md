# ProContract operations

Use one checkout and its generated client for the entire lifecycle. This is the
current native operation path, not a recipe for replaying historical benchmark
cohorts. See [research and execution methods](pro-contract-research-execution.md),
[historical delivery qualification](pro-contract-delivery.md), the
[truth boundary](pro-contract-truth-boundary.md), and the
[experiment index](pro-contract-experiments.md).

## 1. Boundary and prerequisites

```text
ProContract       freezes duty, binds execution, records handoff and adjudication
Task adapter      exports the exact candidate, runs evaluation, stores reports
External verifier owns task-specific truth, private tests, and scores
Principal         approves issuance, attestation, selection, release, and rollback
```

Ordinary local Session execution is cooperative. A shared OS user, process environment, or
database is not an adversarial isolation boundary. Keep credentials, OpenCode
state, private evaluators, and reports outside the writable candidate Location.
For untrusted executors, provide separate OS/container identities, restricted
mounts, network policy, and a principal service they cannot access. A hash alone
neither authenticates a verifier nor proves a result. The separate
`contract version` workflow path uses a fail-closed Linux x64 bubblewrap sandbox;
see its [specific boundary and limits](pro-contract-research-execution.md#6-qualification-and-limits).
It does not sandbox ordinary `contract issue` tasks or qualify arbitrary
replacement OpenCode binaries.

Prerequisites for local operation: Bun, Git, `curl`, and `jq`. For source installs,
use Node 24 LTS for dependency native-build hooks; the compiled binary does not
require Node. Historical CLI qualification used Bun 1.3.14 and Node 24.21.0;
record the versions for the current build separately. Benchmark tools
and containers belong to the external adapter, not the Contract schema.

```bash
export OPENCODE_REPO=/path/to/opencode
export WORKSPACE=/path/to/candidate
export ARTIFACT_ROOT=/path/to/release-artifacts
export MODEL=provider/model
export VARIANT=high
mkdir -p "$ARTIFACT_ROOT"
```

## 2. Build one revision

The repository default branch is `dev`. Record the actual source and dirty
state; a branch name is not a release identity.

```bash
cd "$OPENCODE_REPO"
git rev-parse HEAD > "$ARTIFACT_ROOT/source-revision.txt"
git status --short > "$ARTIFACT_ROOT/source-status.txt"
bun install --frozen-lockfile

cd "$OPENCODE_REPO/packages/core"
bun typecheck
bun test test/pro-contract.test.ts test/session-runner.test.ts test/location-layer.test.ts

cd "$OPENCODE_REPO/packages/client"
bun typecheck

cd "$OPENCODE_REPO/packages/opencode"
bun typecheck
bun test test/server/httpapi-pro-contract.test.ts
bun run script/build.ts --single --skip-install
```

Set `OPENCODE_BIN` to the host binary printed by the build. For Linux x64:

```bash
export OPENCODE_BIN="$OPENCODE_REPO/packages/opencode/dist/opencode-linux-x64/bin/opencode"
"$OPENCODE_BIN" --version
sha256sum "$OPENCODE_BIN" > "$ARTIFACT_ROOT/binary.sha256"
```

The build replaces `packages/opencode/dist`; do not rebuild a binary used by a
running or frozen cohort. If the public Protocol or Server `HttpApi` changes,
run `bun run generate` in `packages/client`, never edit generated files by hand.
Regenerate the legacy JavaScript SDK with `./packages/sdk/js/script/build.ts`
when its public API changes.

## 3. Run the durable service

Use a dedicated durable state directory outside the candidate Location. For
release qualification, choose a fresh directory rather than a running cohort's
state. Export the **same** paths in the server and every principal CLI terminal:

```bash
export OPENCODE_STATE_ROOT=/path/to/opencode-release-state
export XDG_DATA_HOME="$OPENCODE_STATE_ROOT/data"
export XDG_STATE_HOME="$OPENCODE_STATE_ROOT/state"
export XDG_CONFIG_HOME="$OPENCODE_STATE_ROOT/config"
export XDG_CACHE_HOME="$OPENCODE_STATE_ROOT/cache"
mkdir -p -m 700 "$OPENCODE_STATE_ROOT" \
  "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
```

Configure provider access for this isolated environment before execution.
Omitting these exports uses the user's existing default state and can mix
release revisions or experiments. Supply the principal secret through your
supervisor; do not commit it or place it in candidate-visible configuration.

```bash
: "${OPENCODE_SERVER_PASSWORD:?Set a principal-only server password}"
export OPENCODE_SERVER_USERNAME="${OPENCODE_SERVER_USERNAME:-opencode}"
export API=http://127.0.0.1:4096

cd "$WORKSPACE"
"$OPENCODE_BIN" serve --hostname 127.0.0.1 --port 4096 --print-logs
```

In another principal terminal with those credentials:

```bash
api() {
  curl --fail-with-body --silent --show-error --max-time 30 \
    --user "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" "$@"
}
api "$API/global/health"
```

Use systemd, launchd, or a container supervisor for unattended service. Probe
`/global/health`; a live PID alone does not establish progress. Restart with the
same durable state after infrastructure failure. Use container init/reaping and
bounded process operations. Do not start a second scheduler.

`contract sweep` runs one recovery/dispatch cycle against local durable state;
it is not a replacement for the long-running service. Recovery checks deadlines,
leases, and pending dispatch without granting new authority or budget. Never
open a live SQLite WAL through a separate host SQLite client: inspect via HTTP,
or stop the service before copying state.

## 4. Issue and inspect

### Interactive admission

Start a primary Session with an explicit model:

```bash
cd "$WORKSPACE"
"$OPENCODE_BIN" . --model "$MODEL"
```

For durable follow-up or evidence-gated work, `contract_propose` presents the
exact terms and `specHash` for principal confirmation. Rejecting the proposal
creates no Contract or execution binding. Ordinary work need not create a
Contract. `--auto` does not grant principal governance authority; unattended
adapters must issue their frozen Contract themselves.

The goal, brief, capabilities, dependencies, evidence, and budget are terms.
Execution strategy is separate: `executionPolicy` is binding data, not
`spec.policy`, a requirement flag, or a change to the user goal. A strategy
cannot expand authority or weaken acceptance. The former `contract policy`
configuration path is not supported; use the opt-in strategy path below.

### Manual CLI issue

For local principal operation, `--deadline` selects deadline-only execution
unless `--turns` or `--actions` is explicitly supplied:

```bash
cd "$WORKSPACE"
DEADLINE_ISO=$(bun -e 'console.log(new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString())')
"$OPENCODE_BIN" contract issue \
  --scope example-run \
  --goal "Implement the approved behavior and preserve compatibility" \
  --model "$MODEL" --variant "$VARIANT" --write \
  --deadline "$DEADLINE_ISO"
```

Without `--deadline`, the general-purpose defaults remain 24 hours, four
provider turns, and 32 actions. These are not the future ProgramBench profile.
Use HTTP when the issue payload must include explicit replay/evidence terms.
Do not issue the same task twice through CLI and HTTP.

### Explicit HTTP issue

For precise unattended terms, issue through authenticated HTTP. This alternative example
uses a six-hour absolute deadline and **omits** cumulative turn/action caps:

```bash
DEADLINE=$(bun -e 'console.log(Date.now() + 6 * 60 * 60 * 1000)')
PROVIDER=${MODEL%%/*}
MODEL_ID=${MODEL#*/}

jq -n \
  --arg directory "$WORKSPACE" \
  --arg provider "$PROVIDER" \
  --arg model "$MODEL_ID" \
  --arg variant "$VARIANT" \
  --argjson deadline "$DEADLINE" \
  '{
    id:"pct_example",
    scope:"example-run",
    goal:"Implement the requested behavior and preserve the stated compatibility requirements",
    brief:"Use the original task as the acceptance source; record unresolved assumptions",
    location:{directory:$directory},
    model:{providerID:$provider,id:$model,variant:$variant},
    authority:["filesystem.read","filesystem.write","process.execute"],
    budget:{deadline:$deadline},
    evidence:{type:"principal",claim:"The exact handoff satisfies the approved task checks"}
  }' > "$ARTIFACT_ROOT/issue.json"

api -X POST -H 'content-type: application/json' \
  "$API/api/contract" --data-binary "@$ARTIFACT_ROOT/issue.json" |
  tee "$ARTIFACT_ROOT/issued.json"

api "$API/api/contract/pct_example" | jq .
api "$API/api/contract/pct_example/execution" | jq .
api "$API/api/contract/quiet?scope=example-run" | jq .
```

Before issuance, add honest finite build/test checks and exact user-named
artifact paths to `evidence.replay` when they represent the promised delivery.
Do not guess internal source filenames or equate file existence with behavior.
For example, a package that promises a build may freeze:

```json
{
  "type": "principal",
  "claim": "The exported artifact meets the approved behavior and packaging checks",
  "replay": {
    "checks": [{ "argv": ["bun", "run", "build"], "timeout": 120000, "exit": 0 }],
    "protected": [],
    "artifacts": ["dist/app"]
  }
}
```

Each replay check has its own timeout (at most ten minutes) and is also bounded
by the remaining original deadline. A completed failed check is repair feedback;
unavailable verification is not fabricated pass/fail evidence.

Omitted caps mean no cumulative cap, not disabled accounting. Explicit `turns`
and `actions` retain their historical enforcement across attempts. A retry,
Session replacement, or restart must not reset the original deadline. Generic
issuance defaults are not a benchmark protocol; always send the frozen budget
for experiments. Future ProgramBench cohorts use six-hour-only budgets unless
explicitly instructed otherwise, and must independently qualify their runner,
gateway, usage, and reporting layers. Do not change a running cohort.

The bound model/variant cannot be silently replaced by a prompt. New model or
strategy experiments require an explicitly issued binding, not edits to a live
Contract.

## 5. Handoff, verification, and cancellation

```text
dormant -> active -> verification -> discharged
visible challenge -> dormant remediation
sealed challenge or unsupported dependency -> escalated
principal release -> released
```

Executors can use `contract_check`, `contract_report_ready`,
`contract_report_blocked`, and `contract_propose_revision`. They cannot attest,
challenge, release, or approve their own revisions. Readiness captures an exact
Snapshot; an earlier passing check does not authorize a changed candidate.
Checks and retries remain within the same shared accounting/deadline.

A revision petition pauses execution pending a principal decision. Deny
`contract_revision` in unattended adapter policy unless a separately trusted
revision policy exists. Deny `external_directory` unless explicitly delegated;
an interactive permission wait is not a process timeout.

### Evaluate the captured subject

Fetch coordinates **before evaluation**, save them with the report, and export
the exact handoff through the local principal CLI:

```bash
api "$API/api/contract/pct_example" > "$ARTIFACT_ROOT/handoff.json"
REVISION=$(jq -er '.data.revision' "$ARTIFACT_ROOT/handoff.json")
SPEC_HASH=$(jq -er '.data.specHash' "$ARTIFACT_ROOT/handoff.json")
SUBJECT=$(jq -er '.data.handoff.subjectHash' "$ARTIFACT_ROOT/handoff.json")

"$OPENCODE_BIN" contract export pct_example "$ARTIFACT_ROOT/subject"
```

The verifier must check that the exported subject is the recorded subject,
use the frozen criteria, and persist its finite report outside the executor.
Run task-specific evaluation there; do not infer pass from the existence of a
report or from a successful build alone.

### Attest only the evaluated coordinates

After a passing result:

```bash
EVIDENCE_HASH=$(sha256sum "$ARTIFACT_ROOT/verifier-report.json" | awk '{print $1}')
jq -n \
  --argjson revision "$REVISION" \
  --arg specHash "$SPEC_HASH" \
  --arg subjectHash "$SUBJECT" \
  --arg evidenceHash "$EVIDENCE_HASH" \
  '{revision:$revision,specHash:$specHash,subjectHash:$subjectHash,evidenceHash:$evidenceHash}' \
  > "$ARTIFACT_ROOT/attestation.json"

api -X POST -H 'content-type: application/json' \
  "$API/api/contract/pct_example/attestation" \
  --data-binary "@$ARTIFACT_ROOT/attestation.json"
```

A stale revision, specification, or subject returns `409`; it must not discharge
the current handoff. Do not retry an old result by substituting new coordinates.
Re-evaluate the new handoff instead. The server checks coordinates and authority,
not report authenticity or semantic validity.

For a failed result with permitted repair feedback, hash that failed report:

```bash
EVIDENCE_HASH=$(sha256sum "$ARTIFACT_ROOT/verifier-report.json" | awk '{print $1}')
api -X POST -H 'content-type: application/json' \
  "$API/api/contract/pct_example/challenge" \
  --data-binary "$(jq -n \
    --argjson revision "$REVISION" \
    --arg subjectHash "$SUBJECT" \
    --arg evidenceHash "$EVIDENCE_HASH" \
    '{revision:$revision,subjectHash:$subjectHash,evidenceHash:$evidenceHash,
      disclosure:"executor",summary:"Independent verification failed; repair the recorded invariant"}')"
```

For sealed/holdout failures, use `disclosure:"sealed"` and omit `summary`.
Do not adapt against that same holdout. Verifier failure or unavailability is
not success and is not permission to fabricate a negative report.

To cancel responsibility explicitly:

```bash
api -X POST -H 'content-type: application/json' \
  "$API/api/contract/pct_example/release" \
  --data-binary '{"reason":"Principal cancelled this task"}'
```

The HTTP release above also interrupts Session execution in that serving
process. A separate local `contract release` process can record release but
cannot immediately interrupt another server PID; use that server's HTTP route
for active cancellation. This is not a clustered cancellation guarantee or reversal of completed external effects. Deadline
expiry and infrastructure interruption do not count as successful delivery.
`quiet` means no outstanding Contracts in the scope; released work is not
successful work.

### Durable external evaluation

If evaluating the delivery is itself an obligation, use an ordinary dependent
Evaluation Contract rather than hiding work after the Delivery Contract ends.
Issue may happen before Delivery finishes; settlement requires Delivery already
independently attested and discharged with the exact handoff. This is a later
dependent evaluation, not a replacement for initial Delivery attestation:

```bash
"$OPENCODE_BIN" contract evaluation issue pct_delivery \
  --evaluator-hash sha256:frozen-evaluator \
  --deadline "$EVALUATION_DEADLINE_ISO"
"$OPENCODE_BIN" contract evaluation settle "$EVALUATION_CONTRACT_ID" \
  --report "$ARTIFACT_ROOT/evaluation.json"
```

The report contains `version:1`, `deliveryContractID`, `deliveryRevision`,
`subjectHash`, `evaluatorHash`, `passed`, `disclosure`, and `summary`.
The adapter owns these observations. The evaluation executor has no filesystem
or process authority and cannot be scheduled as an OpenCode executor. A failed
report challenges the exact delivery; Evaluation remains outstanding.

## 6. Opt-in research and strategy improvement

Candidate generation, evaluation, and role selection stay outside the pure
Kernel. The strategy service records scoped grants, exact evidence, archived
versions/experiments, and role-specific selection. It does not run a benchmark
or grant itself principal authority. `incumbent` and `research_executor` are
independent; the modified target version is a task parameter.

```text
principal authorizes a frozen protocol
  -> research executor runs an ordinary research Contract
  -> exact candidate and observations enter the archive
  -> independent research-use grant may select a non-deployed candidate
  -> its actual code can conduct the next research task
  -> independent development/confirmation evidence gates incumbent adoption
  -> new tasks use the selected method; old bindings and valid results persist
```

Use `contract strategy` with `contract version` for executable workflows, not the historical standalone
`script/pro-contract-rsi.ts` gate or removed `contract policy` configuration.
The [research/execution guide](pro-contract-research-execution.md#3-principal-workflow)
specifies current commands and exact input identities. Version-1 text bundles
remain usable through `contract issue --strategy ...`; executable version-2
bundles must use `contract version run`, not a text-only Session binding.

`performanceRule:"task-pareto"` compares each `(panel, task)` mean over its fixed
repeats; development gains cannot mask a confirmation regression.
No task mean may regress, at least one must strictly improve, and all ties do
not promote. Complete development/confirmation records, safety checks, and
established-full-pass protection remain mandatory. Do not impose a one
percentage-point margin or new cumulative cost/count caps unless explicitly
requested. Freeze a new protocol for a changed rule; never relabel post-hoc
readmission as preregistered evidence.

Strategy text is `executionPolicy`, separate from immutable user intent. New
bindings carry an exact `authorization`, not an automatically injected
`spec.requires` dependency. Withdrawal fences execution, not independently
accepted results; actual evidence dependencies still propagate challenges.
Historical bindings keep their originally declared requirements and semantics.
No default global policy is silently installed, and existing bindings are not
rewritten on selection or rollback. A withdrawn old binding requires an explicit
handoff design before another method could resume it. A negative study can
complete its report duty without deployment. None of these mechanism properties
proves sustained capability gains.

## 7. Benchmark and release records

Benchmark layouts, private tests, evaluator images, and score normalization
remain adapter-owned. Consult the external ProgramBench harness runbook and
[deadline-only requirements](programbench-deadline-only.md) before launching a
new cohort. Historical experiment documents describe their frozen versions;
they do not qualify this release or authorize changing those runs. macOS/QEMU
calibration cannot substitute for a declared native-Linux result.

Archive at least:

- source revision/dirty patch, binary hash, generated-client identity;
- original task, frozen protocol, budget, model, variant, and environment;
- issue payload, execution binding, revisions, exact subjects, and exports;
- complete verifier reports and hashes, visibility/sealing decisions;
- raw usage, failed/accepted requests, missing usage, turns/actions, wall time;
- strategy authorization, candidate/generator lineage, comparison and selection;
- challenge/release/rollback receipts, final Contract state, and quiet result.

Store state and artifacts outside the candidate. Preserve all historical
artifacts and record deviations instead of editing frozen source or protocols.
Mechanism qualification, measured task performance, and adversarial isolation
are separate claims. Complete the release checklist before describing any of
them as delivered.
