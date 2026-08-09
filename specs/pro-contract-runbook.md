# ProContract Evaluation Runbook

This runbook covers the local OpenCode build, interactive and unattended
ProContract operation, one-competition MLE-bench calibration, and ProgramBench
candidate evaluation. It is intentionally operational. The normative design is
in [`pro-contract.md`](pro-contract.md). Non-default controller experiments are
indexed in [`pro-contract-experiments.md`](pro-contract-experiments.md).

## 1. Operating boundary

Keep these responsibilities separate:

```text
OpenCode / ProContract
  intent proposal, ratification, durable obligation, execution attempts,
  subject-bound handoff, challenge, attestation, and quiescence

Benchmark adapter
  cleanroom layout, candidate packaging, structural preflight, evaluator
  invocation, and conversion of a verifier result into attest/challenge

External evaluator
  private labels/tests and the final score
```

Do not add MLE-bench datasets, ProgramBench candidate profiles, Docker layout,
or test commands to the ProContract schema.

The current deployment is cooperative: the plane, executor, credentials, and
database may share one OS user. Do not claim adversarial non-bypass. Never open
a live SQLite WAL with a host-side SQLite client; inspect state through HTTP, or
stop the server before copying the database.

An unattended adapter must deny `external_directory` unless the Contract
explicitly delegates it. Otherwise a mistyped workdir can wait forever on an
interactive permission request before the shell timeout begins.

## 2. Repository layout and prerequisites

The commands below assume sibling repositories:

```text
Projects/
  opencode/
  ProgramBench/
  MLE-bench/
```

Set paths once:

```bash
export PROJECTS="$HOME/Documents/Projects"
export OPENCODE_REPO="$PROJECTS/opencode"
export PROGRAMBENCH_REPO="$PROJECTS/ProgramBench"
export MLEBENCH_REPO="$PROJECTS/MLE-bench"
export ARTIFACT_ROOT="$PROJECTS/run-artifacts"
export MODEL='openai/gpt-5.5'
export VARIANT='high'
mkdir -p "$ARTIFACT_ROOT"
```

Required tools:

```bash
command -v git
command -v docker
command -v uv
command -v bun || test -x "$HOME/.bun/bin/bun"
docker version
```

Use Python 3.12 for MLE-bench. On macOS, Linux/amd64 containers run under
emulation and results are calibration-only unless reproduced on the declared
Linux environment.

## 3. Build OpenCode

The repository default branch is `dev`; this ProContract work currently lives
on `semantic-attempts`.

```bash
cd "$OPENCODE_REPO"
git status --short
git branch --show-current
export PATH="$HOME/.bun/bin:$PATH"
bun install
```

Run typechecks and the focused ProContract tests from package directories:

```bash
cd "$OPENCODE_REPO/packages/core"
bun typecheck
bun test test/pro-contract.test.ts test/session-runner.test.ts test/location-layer.test.ts

cd "$OPENCODE_REPO/packages/opencode"
bun typecheck
bun test test/server/httpapi-pro-contract.test.ts
```

Build and smoke-test only the current host binary:

```bash
cd "$OPENCODE_REPO/packages/opencode"
bun run script/build.ts --single --skip-embed-web-ui --skip-install
```

On Apple Silicon the binary is:

```bash
export OPENCODE_BIN="$OPENCODE_REPO/packages/opencode/dist/opencode-darwin-arm64/bin/opencode"
"$OPENCODE_BIN" --version
```

Build all cross-platform binaries when a Linux benchmark container needs its
own binary:

```bash
cd "$OPENCODE_REPO/packages/opencode"
bun run script/build.ts --skip-embed-web-ui --skip-install

export OPENCODE_LINUX_X64="$OPENCODE_REPO/packages/opencode/dist/opencode-linux-x64/bin/opencode"
export OPENCODE_LINUX_ARM64="$OPENCODE_REPO/packages/opencode/dist/opencode-linux-arm64/bin/opencode"
```

The build script deletes `packages/opencode/dist` before rebuilding.

## 4. ProContract interaction

### 4.1 Preferred interactive formation

Start OpenCode with an explicit model so an approved proposal can bind the same
model to the future Contract Session:

```bash
cd /path/to/workspace
"$OPENCODE_BIN" . --model "$MODEL"
```

Describe the task naturally. For future-triggered, asynchronous, multi-Session,
durable-follow-up, or evidence-gated work, the model can call
`contract_propose`. OpenCode displays the exact goal, authority, budget,
dependencies, evidence policy, and `specHash`.

Ordinary work proceeds directly. When future attention or later adjudication is
needed, a primary Session may voluntarily propose one Contract; duplicate
proposals after delegation are rejected. An implementation proposal promising a build
command or user-named output artifact is incomplete unless its evidence includes
finite replay checks and every user-named artifact path. Do not guess source
filenames before implementation; a build check covers its inputs. Proposal
admission rejects artifact paths absent from the original request.

The human choices are:

```text
Confirm and start     issue the exact displayed specification
Revise                reject with correction feedback
Continue normally     create no Contract
```

Rejecting a proposal creates neither a Contract nor an execution binding.

A proposal may bind one previously discharged Contract as its execution policy
by setting `policy: true` on that requirement. OpenCode injects the policy
Contract's exact `spec.policy` and evidence identities into the dedicated
Session. A Policy Contract keeps its current ratification work in `goal` and
the future execution rule in `policy`; the two must not be conflated. The policy
is part of the approved `specHash`, applies only to the new Contract, and cannot
override its authority or settlement terms. Challenging the Policy Contract
invalidates its dependent support through the normal remediation path.

To retain one principal-selected policy for future natural-language proposals,
select it in the location's `opencode.json` after its Contract is discharged:

```bash
opencode contract policy pct_policy_example --config ./opencode.json
```

The command fails unless the exact Contract is discharged with a current
handoff and attestation, then prints the specification, subject, evidence, and
attestation identities written into the selection. Its resulting configuration
is equivalent to:

```json
{
  "contract_policy": {
    "contractID": "pct_policy_example",
    "revision": 1,
    "policy": true
  }
}
```

The setting is a default compiler input, not an authority grant. An explicit
policy in a proposal overrides it, every inherited edge remains visible in the
approval UI, and a challenged default causes new issuance to fail closed.
Delete the setting to clear it or replace the exact ID and revision after a new
policy is independently discharged. Existing Contracts keep their frozen
policy edge.

```bash
opencode contract policy --clear --config ./opencode.json
```

### 4.2 Unattended formation

Keep a server alive after the initial Session exits:

```bash
export PORT=4096
export WORKSPACE=/path/to/workspace
export RUN_LOG="$ARTIFACT_ROOT/opencode-server-$(date +%Y%m%d-%H%M%S).log"

cd "$WORKSPACE"
supervise_opencode() {
  child=
  trap 'test -z "$child" || kill "$child" 2>/dev/null; exit' INT TERM
  while true; do
    "$OPENCODE_BIN" serve --hostname 127.0.0.1 --port "$PORT" --print-logs &
    child=$!
    failures=0
    while kill -0 "$child" 2>/dev/null; do
      sleep 5
      if curl --max-time 5 -fsS "http://127.0.0.1:$PORT/global/health" >/dev/null; then
        failures=0
      else
        failures=$((failures + 1))
      fi
      test "$failures" -lt 3 || kill "$child" 2>/dev/null
    done
    wait "$child" || true
    child=
  done
}
supervise_opencode >"$RUN_LOG" 2>&1 &
export OPENCODE_SERVER_PID=$!

until curl --max-time 5 -fsS "http://127.0.0.1:$PORT/global/health" >/dev/null; do sleep 1; done

"$OPENCODE_BIN" run \
  --attach "http://127.0.0.1:$PORT" \
  --dir "$WORKSPACE" \
  --model "$MODEL" \
  --variant "$VARIANT" \
  --auto \
  "<original task instruction>"
```

`--auto` supplies standing approval only for executor actions. It rejects
Contract formation and every other principal governance decision. An unattended
benchmark adapter must issue its frozen Contract before starting the executor.

For autonomous benchmark claims, the trusted adapter owns issuance. Model
proposal behavior is a separate interactive metric, not benchmark authority.

### 4.3 Manual issue and inspection

Manual issue uses the current directory as the execution Location:

```bash
cd "$WORKSPACE"
"$OPENCODE_BIN" contract issue \
  --id pct_example \
  --scope example-run \
  --goal "Maximize the requested artifact's quality within the approved budget" \
  --claim "The exact artifact satisfies the frozen delivery checks" \
  --brief "Preserve unresolved assumptions in the handoff" \
  --model "$MODEL" \
  --variant "$VARIANT" \
  --write \
  --turns 100

"$OPENCODE_BIN" contract list --scope example-run
"$OPENCODE_BIN" contract show pct_example
"$OPENCODE_BIN" contract quiet example-run
"$OPENCODE_BIN" contract export pct_example ./exact-subject
```

The current manual CLI overrides provider turns only; its default action budget
remains `32`. Use model-authored `contract_propose` or the HTTP issue payload
when a long run needs an explicit larger action budget.

`contract quiet` exits with code `2` while obligations remain outstanding.

### 4.4 Live HTTP control

Use HTTP while the server is running:

```bash
export API="http://127.0.0.1:$PORT"

curl -fsS "$API/api/contract?scope=example-run" | jq .
curl -fsS "$API/api/contract/pct_example" | jq .
curl -fsS "$API/api/contract/pct_example/execution" | jq .
curl -fsS "$API/api/contract/quiet?scope=example-run" | jq .
```

Lifecycle:

```text
dormant -> active -> verification -> discharged
active/verification -> escalated
visible challenge -> dormant -> active in a fresh Session
issuer release -> released
```

The executor may call:

```text
contract_report_ready
contract_report_blocked
contract_propose_revision
```

A revision petition pauses executor turns, actions, leases, and retries until
the principal decides it through the existing permission boundary. Approval
accepts the proposed revision; rejection keeps the original Contract and
resumes the same semantic attempt. Headless benchmark policy should explicitly
deny `contract_revision` unless it has a separate, trusted revision policy;
`--auto` otherwise approves permission requests by design.

Only the principal path may attest, challenge, release, decide a revision, or
resume an escalation.

### 4.5 Attest or challenge an exact handoff

Read the current revision and frozen subject:

```bash
curl -fsS "$API/api/contract/pct_example" > /tmp/pct_example.json
REVISION=$(jq -r '.data.revision' /tmp/pct_example.json)
SUBJECT=$(jq -r '.data.handoff.subjectHash' /tmp/pct_example.json)
```

Create a content-addressed verifier report:

```bash
if command -v sha256sum >/dev/null; then
  export EVIDENCE_HASH="$(sha256sum verifier-report.json | awk '{print $1}')"
else
  export EVIDENCE_HASH="$(shasum -a 256 verifier-report.json | awk '{print $1}')"
fi
```

Attest only if the preregistered policy passed:

```bash
curl -fsS -X POST \
  -H 'content-type: application/json' \
  "$API/api/contract/pct_example/attestation" \
  -d "$(jq -n --arg evidenceHash "$EVIDENCE_HASH" '{evidenceHash:$evidenceHash}')" | jq .
```

Submit a visible challenge when actionable feedback may return to the executor:

```bash
curl -fsS -X POST \
  -H 'content-type: application/json' \
  "$API/api/contract/pct_example/challenge" \
  -d "$(jq -n \
    --argjson revision "$REVISION" \
    --arg subjectHash "$SUBJECT" \
    --arg evidenceHash "$EVIDENCE_HASH" \
    --arg summary "Independent verification failed; preserve passing behavior and repair the reported invariant." \
    '{revision:$revision,subjectHash:$subjectHash,evidenceHash:$evidenceHash,disclosure:"executor",summary:$summary}')" | jq .
```

For holdout or official-test failures, use `disclosure: "sealed"`, omit
`summary`, and do not continue adaptive evaluation against the same holdout.

### 4.6 Harness replay verifier

Before adding a task-specific adapter, use the optional harness replay policy
for finite repository checks. The policy is part of `spec.evidence`, so
ratification freezes its argv, expected exits, protected file hashes, required
artifacts, and ten-minute-per-check maximum timeout:

```json
{
  "type": "principal",
  "replay": {
    "checks": [
      { "argv": ["bun", "typecheck"], "timeout": 120000, "exit": 0 },
      { "argv": ["bun", "test"], "timeout": 600000, "exit": 0 }
    ],
    "protected": [],
    "artifacts": ["dist/app"]
  }
}
```

At `contract_report_ready`, OpenCode captures the candidate subject,
materializes that exact tree into a temporary worktree, runs the checks there,
and stores a hashed finite report under the control-plane data directory. A
completed check that returns the wrong exit, a protected-file mismatch, or a
missing artifact becomes an executor-visible, subject-bound challenge. Failure
to materialize or start the verifier escalates the Contract without creating a
new executor attempt. A pass is recorded in the handoff and is required before
the principal can attest; replay does not replace principal judgment in this
conservative policy.

A replay-passing handoff proceeds to verification with every reported material
uncertainty preserved. Uncertainty never triggers executor self-review; unknown
blind spots require an actual verifier or principal challenge. Principal
attestation must cite evidence independent of the replay report.

Replay inherits the verifier process environment and network namespace. It
isolates filesystem mutations from the candidate but does not provide host or
credential isolation. Files named in `protected` must be regular files with the
approved SHA-256; candidate-owned tests that are not protected remain a weak
proxy.

### 4.7 Automatic task verifier adapter

Automatic verification belongs to the task adapter, not the Contract kernel.
Run the adapter as a supervised process that repeatedly:

```text
GET contracts in verification
  -> fetch the exact revision, specHash, subjectHash, and execution binding
  -> run the preregistered verifier policy
  -> persist and hash a finite verifier report
  -> POST attestation or subject-bound challenge
```

An adapter may use a simple polling loop around the existing API:

```bash
while sleep 1; do
  curl -fsS "$API/api/contract" |
    jq -r '.data[] | select(.status == "verification") | .id'
done | while read -r CONTRACT_ID; do
  "$VERIFIER" "$API" "$CONTRACT_ID"
done
```

`VERIFIER` owns task-specific artifact access and evaluation. It must skip a
Contract that is no longer in `verification`, bind every result to the current
subject, and never expose sealed holdout feedback to an executor. The executor
does not receive principal mutation routes.

### 4.8 V2 no-Contract control

Use the same SessionV2 runner for causal evaluation. The control Session has no
Contract binding and therefore receives no privileged `<pro_contract>` System
Context or Contract reporting authority. An evaluation-only agent/config may
hide `contract_propose`; do not add a production feature flag solely for a
benchmark. Comparing a legacy Session against a V2 Contract Session confounds
Contract semantics with runner differences.

### 4.9 Durable service and authority topology

`opencode serve` is the OpenCode-specific Contract daemon: run it under
launchd, systemd, Docker, or another supervisor with durable `XDG_DATA_HOME`.
Do not add a second scheduler process. External trigger providers wake the
plane through its API; a trigger may create attention but cannot grant effect
authority.

The supervisor must probe `/global/health`; a live PID is not evidence that the
event loop can still renew leases. Restart the same command with the same
durable state after repeated probe failures. In Docker, use `--init` so finished
tool processes are reaped. A restart policy alone does not react to an unhealthy
but still-running process.

After restoring a durable state directory, the principal may run the daemon's
same recovery logic once without starting a second scheduler:

```bash
opencode contract sweep
```

This one-shot command rechecks triggers, deadlines, leases, and pending
dispatch. It grants no authority and creates no alternate lifecycle semantics;
the long-running server remains responsible for subsequent cycles.

The runner also enforces narrow inactivity bounds: a provider stream with no
event for ten minutes is interrupted and retried as transport, while filesystem
inspection inside `read` returns a tool error after one minute. Permission waits
are outside the read timeout. Streaming provider events reset the provider
bound, and process tools retain their own explicit timeout so long builds and
training are not constrained by the short read policy.
Contract-bound `read`, `edit`, `write`, `apply_patch`, `glob`, and `grep` calls
also settle with an explicit error after one minute. Ordinary Session
permission waits and process tools keep their existing behavior.

Treat the Contract Location as the capability boundary:

```text
read-only task inputs   -> mounted inside Location
writable candidate     -> mounted inside Location
OpenCode state/cache   -> outside Location
credentials            -> outside Location
authoritative promotion-> separate verifier/principal service
```

Filesystem capabilities expose tools inside the Location. External paths still
require the existing permission fence; adapters should not compensate with a
global external-directory allow rule.

## 5. MLE-bench: one CPU-friendly instance

The recommended local smoke instance is:

```text
detecting-insults-in-social-commentary
Low/Lite split, approximately 2 MB, CPU-friendly, AUC metric
```

### 5.1 Install MLE-bench

```bash
cd "$MLEBENCH_REPO"
uv venv --python 3.12
uv sync --python 3.12
```

MLE-bench v1 pins `kaggle<1.7`, which ignores the newer
`~/.kaggle/access_token`. Upgrade the client after every `uv sync`:

```bash
uv pip install --python .venv/bin/python 'kaggle>=2.2,<2.3'
chmod 600 "$HOME/.kaggle/access_token"
.venv/bin/kaggle config view
```

Accept the competition rules in the same Kaggle account before preparing data:

```text
https://www.kaggle.com/c/detecting-insults-in-social-commentary/rules
```

Kaggle 2.x removed `kaggle.rest.ApiException`, which MLE-bench v1 imports.
Use this shell wrapper without modifying the frozen MLE-bench checkout:

```bash
mlebench_v1() {
  .venv/bin/python - "$@" <<'PY'
import sys
import types

rest = types.ModuleType("kaggle.rest")
rest.ApiException = OSError
sys.modules["kaggle.rest"] = rest

from mlebench.cli import main

sys.argv = ["mlebench", *sys.argv[1:]]
main()
PY
}
```

Prepare one competition into an explicit immutable data root:

```bash
export MLE_DATA="$ARTIFACT_ROOT/mlebench-data"
mkdir -p "$MLE_DATA"
mlebench_v1 prepare \
  -c detecting-insults-in-social-commentary \
  --data-dir "$MLE_DATA"
```

Expected layout:

```text
$MLE_DATA/detecting-insults-in-social-commentary/
  prepared/public/    agent-visible
  prepared/private/   evaluator-only
```

A `403 Forbidden` during download normally means the competition rules have
not been accepted. Authentication can still be valid.

### 5.2 Start an isolated MLE-bench environment

Build the official base image on a Linux/amd64 evaluation host:

```bash
cd "$MLEBENCH_REPO"
docker build --platform linux/amd64 -t mlebench-env -f environment/Dockerfile .
```

Create a run directory and mount public/private data at the official paths:

```bash
export COMP=detecting-insults-in-social-commentary
export RUN_ID="mle-$COMP-$(date +%Y%m%d-%H%M%S)"
export RUN_DIR="$ARTIFACT_ROOT/$RUN_ID"
mkdir -p "$RUN_DIR/submission" "$RUN_DIR/logs" "$RUN_DIR/state"

docker run -d --name "$RUN_ID" \
  --platform linux/amd64 \
  -p 127.0.0.1:4096:4096 \
  -e COMPETITION_ID="$COMP" \
  -e OPENAI_API_KEY \
  -v "$MLE_DATA/$COMP/prepared/public:/home/data:ro" \
  -v "$MLE_DATA/$COMP/prepared/private:/private/data/$COMP/prepared/private:ro" \
  -v "$RUN_DIR/submission:/home/submission" \
  -v "$RUN_DIR/logs:/home/logs" \
  -v "$RUN_DIR/state:/opencode-state" \
  -v "$OPENCODE_LINUX_X64:/usr/local/bin/opencode:ro" \
  mlebench-env
```

Wait for the official structural validator, then start OpenCode as the nonroot
agent in the same container:

```bash
until docker exec "$RUN_ID" curl -fsS http://localhost:5000/health >/dev/null; do sleep 1; done

# ProContract snapshots the candidate Location including /home/submission.
# Keep OpenCode control-plane state outside that tree.
docker exec "$RUN_ID" sh -c \
  'mkdir -p /opencode-cache /opencode-runtime-state && chmod -R 777 /opencode-state /opencode-cache /opencode-runtime-state'
docker exec -u nonroot -e HOME=/home/nonroot "$RUN_ID" git config --global --add safe.directory /home
docker exec -u nonroot -e HOME=/home/nonroot -w /home "$RUN_ID" git init
docker exec -u nonroot -e HOME=/home/nonroot -w /home "$RUN_ID" git config user.email benchmark@localhost
docker exec -u nonroot -e HOME=/home/nonroot -w /home "$RUN_ID" git config user.name "MLE-bench"
docker exec -u nonroot -e HOME=/home/nonroot -w /home "$RUN_ID" \
  git add instructions.txt instructions_obfuscated.txt validate_submission.sh data
docker exec -u nonroot -e HOME=/home/nonroot -w /home "$RUN_ID" \
  git commit -m "Initialize public benchmark input"
docker exec -u nonroot -w /home "$RUN_ID" sh -c \
  'printf "/nonroot/\n/logs/\n/cache/\n" >> .git/info/exclude'

docker exec -d -u nonroot -w /home \
  -e HOME=/home/nonroot \
  -e XDG_DATA_HOME=/opencode-state \
  -e XDG_CACHE_HOME=/opencode-cache \
  -e XDG_STATE_HOME=/opencode-runtime-state \
  -e PATH=/opt/conda/envs/agent/bin:/usr/local/bin:/usr/bin:/bin \
  "$RUN_ID" \
  /usr/local/bin/opencode serve --hostname 0.0.0.0 --port 4096

until curl -fsS http://127.0.0.1:4096/api/contract >/dev/null; do sleep 1; done
```

Send the original benchmark instruction once. Do not add competition-specific
solution hints or manual remediation prompts:

```bash
TASK=$(cat "$MLEBENCH_REPO/environment/instructions.txt")
"$OPENCODE_BIN" run \
  --attach http://127.0.0.1:4096 \
  --dir /home \
  --model "$MODEL" \
  --variant "$VARIANT" \
  --auto \
  "$TASK"
```

The expected output is `/home/submission/submission.csv`. The current repository
does **not** include an automatic MLE-bench verifier consumer, so maintainers
must monitor `verification` through HTTP for now. Do not manually rewrite the
research plan or Contract during an autonomous evaluation.

### 5.3 Freeze and grade once

Copy the candidate only after the Contract enters `verification`:

```bash
curl -fsS http://127.0.0.1:4096/api/contract | tee "$RUN_DIR/contracts.json" | jq .
cp "$RUN_DIR/submission/submission.csv" "$RUN_DIR/submission.frozen.csv"
shasum -a 256 "$RUN_DIR/submission.frozen.csv" | tee "$RUN_DIR/submission.sha256"
```

Run the private grader once:

```bash
cd "$MLEBENCH_REPO"
.venv/bin/mlebench grade-sample \
  "$RUN_DIR/submission.frozen.csv" \
  "$COMP" \
  --data-dir "$MLE_DATA" \
  2>&1 | tee "$RUN_DIR/grade.log"
```

Hash `grade.log`, then attest or submit an exact subject-bound challenge using
Section 4.5. Acceptance conditions must be fixed before grading. Do not turn
the private grader into an iterative development oracle.

On macOS without CUDA and with Docker emulation, report the run as local
calibration, not a leaderboard-comparable MLE-bench result.

## 6. ProgramBench

The complete evaluator specification remains in the ProgramBench repository:

- [ProgramBench Evaluation Harness Runbook](../../ProgramBench/docs/harness_runbook_en.md)

### 6.1 Setup

```bash
cd "$PROGRAMBENCH_REPO"
uv sync
uv run programbench --help
uv run pytest -q
docker version
docker ps
```

Formal ProgramBench images are Linux/amd64. macOS/QEMU runs are calibration.

### 6.2 Start from a cleanroom

Freeze artifact-production acceptance before starting the executor. The
ProgramBench Contract ends at a submission-ready artifact; official evaluation
is a later benchmark measurement, not its settlement condition. Keep the
behavioral optimization goal separate from the delivery claim:

```json
{
  "version": 1,
  "instance": "sitkevij__hex.61ae69b",
  "claim": "submission-ready candidate with no known calibration mismatch",
  "subject": "exact Contract handoff tree",
  "accept": [
    "required source and relocatable compile.sh are present",
    "deterministic packaging succeeds",
    "cleanroom preflight passes",
    "preregistered calibration probes pass when supplied"
  ],
  "officialEvaluation": "external"
}
```

Store this as `acceptance.json`, hash its exact bytes, and include the policy
and hash in the pre-issued Contract brief. The run adapter must bind the exact
subject to the deterministic archive and report package, preflight, and probe
results. Attestation uses that report hash; a mismatch becomes a visible
challenge. The later official result is recorded separately and is never fed
back into the same run.

Use the behavioral objective as `goal` and the JSON `claim` text as
`evidence.claim`. The executor optimizes the former; package, preflight, and
probe evidence may settle only the latter.

If no preregistered probe suite exists, omit that criterion and issue a
delivery-only Contract. Build, packaging, and preflight evidence cannot support
a behavioral-adequacy or performance claim.

Claim frozen source and a reproducible build rather than a prebuilt executable
unless the evidence policy checks that binary in the exact Snapshot. Snapshot
capture may omit large untracked files; ProgramBench preflight rebuilds the
executable from the packaged source.

Example instance:

```bash
export IID='sitkevij__hex.61ae69b'
export IMAGE='programbench/sitkevij_1776_hex.61ae69b:task_cleanroom_v6'
export RUN_ID="programbench-$IID-$(date +%Y%m%d-%H%M%S)"
export RUN_DIR="$ARTIFACT_ROOT/$RUN_ID"
export WORKSPACE="$RUN_DIR/workspace"
mkdir -p "$WORKSPACE" "$RUN_DIR/state" "$RUN_DIR/logs"

docker run --rm --platform linux/amd64 \
  -v "$WORKSPACE:/candidate" \
  "$IMAGE" \
  bash -lc 'cp -a /workspace/. /candidate/ && unlink /candidate/executable'
```

Start a persistent OpenCode server in the cleanroom image:

```bash
docker run -d --name "$RUN_ID" \
  --platform linux/amd64 \
  --init \
  --user agent \
  -p 127.0.0.1:4096:4096 \
  -e HOME=/home/agent \
  -e OPENAI_API_KEY \
  -e XDG_DATA_HOME=/opencode-state \
  -e XDG_CACHE_HOME=/tmp/opencode-cache \
  -e XDG_STATE_HOME=/tmp/opencode-runtime-state \
  -v "$WORKSPACE:/candidate" \
  -v "$RUN_DIR/state:/opencode-state" \
  -v "$OPENCODE_LINUX_X64:/usr/local/bin/opencode:ro" \
  -w /candidate \
  --entrypoint /bin/sh \
  "$IMAGE" \
  -lc 'ln -sfn /workspace/executable /candidate/reference && exec /usr/local/bin/opencode serve --hostname 0.0.0.0 --port 4096'
```

This convenient local layout gives the OpenCode provider client and executor
shell the same container network. It is therefore calibration-only. A formal
ProgramBench cleanroom must mediate model traffic outside the executor network
or otherwise prove that shell commands cannot use inference egress.

Submit the original task once:

Every ProgramBench artifact is evaluated after the Session, so its trusted
adapter pre-issues the frozen Contract. Do not encode this benchmark policy in
Contract Core or rely on executor-authored formation.

```bash
"$OPENCODE_BIN" run \
  --attach http://127.0.0.1:4096 \
  --dir /candidate \
  --model "$MODEL" \
  --variant "$VARIANT" \
  --auto \
  "Implement the documented program in this cleanroom. Produce source, a relocatable compile.sh, and ./executable. Use the reference only for black-box experiments."
```

For formal agent comparison, use the benchmark's original task instruction,
not learned hints from earlier instances.

### 6.3 Candidate-owned preflight

Reference probes are calibration evidence, not official acceptance evidence:

```bash
export CONTRACT_ID=pct_example
"$OPENCODE_BIN" contract export "$CONTRACT_ID" "$RUN_DIR/subject"

cp -a "$RUN_DIR/subject" "$RUN_DIR/probe-subject"
(cd "$RUN_DIR/probe-subject" && ./compile.sh)

cd "$PROGRAMBENCH_REPO"
uv run programbench candidate probe \
  "$RUN_DIR/probes/cases.json" \
  "$RUN_DIR/probes/ledger.json" \
  "$WORKSPACE/reference" \
  "$RUN_DIR/probe-subject/executable"

uv run programbench candidate package "$RUN_DIR/subject" "$RUN_DIR/submission" "$IID"
uv run programbench candidate preflight "$RUN_DIR/submission" "$IID" --docker-cpus 4
```

`candidate probe` does not invent `cases.json`; the ProgramBench adapter must
materialize those black-box cases before this command. Skip the probe step when
no preregistered case set exists—never synthesize cases from official tests.

The candidate adapter owns `cases.json`, cleanroom packaging, and preflight. It
does not change ProContract semantics.

### 6.4 Official evaluation

Run official tests only after freezing the final evaluable handoff:

```bash
cd "$PROGRAMBENCH_REPO"
uv run programbench eval "$RUN_DIR/submission" \
  --filter '^sitkevij__hex\.61ae69b$' \
  -w 1 \
  -b 1 \
  --docker-cpus 4

uv run programbench info "$RUN_DIR/submission" | tee "$RUN_DIR/programbench-info.txt"
```

Only `✅` means solved. A rounded `100` is not equivalent to solved. An official
failure used for final evaluation should normally become a sealed challenge;
do not repeatedly expose official failures to the executor.

For a harness-only fixture smoke test, use Section 4 “Local Fixture Check” of
the ProgramBench runbook. Fixture results are never acceptance-grade.

## 7. Reproducibility record

Every run directory should contain:

```text
PROTOCOL.md                 environment and deviations
original-task.txt           exactly one initial instruction
opencode-version.txt        version and binary SHA-256
benchmark-version.txt       git commit and data/evaluator identities
contracts.json              final public Contract state
execution.json              attempts, turns, actions, lease
candidate archive           frozen evaluator subject
candidate.sha256
verifier report/log
verifier-report.sha256
official evaluation output
quiet.json                  final quiescence result
```

Also record:

- model provider, model ID, and variant;
- Docker platform, CPU/memory/GPU limits, and whether emulation was used;
- every environment deviation from the benchmark default;
- whether verifier feedback was visible or sealed;
- provider success/failure counts, tokens, turns, actions, and wall time;
- candidate subject hash, Contract revision/spec hash, evidence hash, ledger
  frontier, and ledger hash;
- contamination, reused instances, prompt changes, and absence of a matched
  control.

Mechanism validation and performance attribution are different claims. A run
can prove that ProContract preserved duty and rejected false completion without
proving that it raised benchmark score.

## 8. Cleanup

Stop persistent services after artifacts are frozen:

```bash
test -z "${OPENCODE_SERVER_PID:-}" || kill "$OPENCODE_SERVER_PID"
test -z "${RUN_ID:-}" || docker stop "$RUN_ID"
```

Do not delete run artifacts that support a reported result. Use a new `RUN_ID`
for remediation or reruns.
