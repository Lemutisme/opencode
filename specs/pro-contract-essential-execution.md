# ProContract: ordinary work can produce the next method

This extends `research-execution@8745ab9297` without changing the Kernel or
rewriting historical Contracts. The reduction is practical: **executing a task
does not require a research policy, benchmark protocol, or role registry**.
Research and promotion remain optional applications of the same execution and
authorization boundary.

## What is separate

| Record                 | What it establishes                                                    | What it does not establish                                                  |
| ---------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Task Contract          | Outstanding responsibility, exact handoff, and accepted support        | That a completed process solved the task                                    |
| Method grant           | Principal permission to execute exact code and instructions in a scope | Task acceptance, safety, comparative quality, or deployment eligibility     |
| Optional method source | The executable source matches a retained task handoff and run          | That the originating task is accepted or the successor is better            |
| Policy role            | Which authorized method the policy selects for new work                | Ownership of existing responsibility or automatic acceptance of descendants |

A direct method grant is an ordinary Contract with a typed brief, not a new
Kernel command. Its subject binds the frozen executable manifest and execution
instructions. The principal's authorization evidence hash is recorded with its
attestation. A hash identifies the record; it does not authenticate a reviewer
or turn permission into a quality judgment.

The emitted `ExecutionAuthorization` contains `contractID`, `revision`,
`specHash`, `subjectHash`, and `attestationID`. Admission and continued execution
check that exact grant and scope. No method grant or source lineage is
automatically inserted into `requires`. Genuine result dependencies remain
explicit through `--require ID@revision`.

## Run without a research policy

Use a binary built from this implementation, Linux x64, Bun, `jq`, and
`/usr/bin/bwrap` with the required namespace support. The sandbox fails closed.
The example runs no model, benchmark, or external service. It demonstrates code
succession, not an improvement in capability. All commands run as the principal,
outside candidate execution.

```bash
set -euo pipefail
: "${OPENCODE_BIN:?Set the absolute path to the built opencode binary}"
ROOT=$(mktemp -d /tmp/opencode-essential.XXXXXX)
export XDG_DATA_HOME="$ROOT/host/data"
export XDG_STATE_HOME="$ROOT/host/state"
export XDG_CONFIG_HOME="$ROOT/host/config"
export XDG_CACHE_HOME="$ROOT/host/cache"
export OPENCODE_DB="$ROOT/host/contracts.sqlite"
mkdir -p "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" \
  "$XDG_CACHE_HOME" "$ROOT/source" "$ROOT/workspace" "$ROOT/artifacts"
SCOPE=ordinary-example

cat > "$ROOT/source/workflow.ts" <<'TS'
const input = await Bun.stdin.json()
await Bun.write("report.txt", "Original: " + input.task.input.topic + "\n")
await Bun.write("candidate/workflow.ts", [
  'const input = await Bun.stdin.json()',
  'await Bun.write("report.txt", "Successor: " + input.task.input.topic + "\\n")',
  'console.log(JSON.stringify({ version: 1, observations: [], requests: [], artifacts: ["report.txt"] }))',
].join("\n"))
console.log(JSON.stringify({
  version: 1,
  observations: [{ note: "Report and possible successor; neither is accepted." }],
  requests: [],
  artifacts: ["report.txt", "candidate/workflow.ts"],
}))
TS
printf '%s\n' '{"topic":"durable responsibility"}' > "$ROOT/task.json"

"$OPENCODE_BIN" contract version freeze \
  --directory "$ROOT/source" --entrypoint workflow.ts \
  > "$ROOT/artifacts/v0.json"
V0=$(jq -er '.versionHash' "$ROOT/artifacts/v0.json")
jq -n --arg scope "$SCOPE" --arg version "$V0" \
  '{action:"permit-execution",scope:$scope,versionHash:$version,
    reason:"Principal authorizes this offline example; no quality claim."}' \
  > "$ROOT/artifacts/permission-v0.json"
"$OPENCODE_BIN" contract version authorize "$V0" --scope "$SCOPE" \
  --evidence-hash "$(sha256sum "$ROOT/artifacts/permission-v0.json" | cut -d ' ' -f 1)" \
  > "$ROOT/artifacts/method-v0.json"

DEADLINE=$(bun -e 'console.log(new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString())')
"$OPENCODE_BIN" contract version run --scope "$SCOPE" \
  --method "$ROOT/artifacts/method-v0.json" \
  --task "$ROOT/task.json" --workspace "$ROOT/workspace" --deadline "$DEADLINE" \
  > "$ROOT/artifacts/task-v0.json"
jq -e '.run.status == "completed" and .contract.status == "verification"' \
  "$ROOT/artifacts/task-v0.json"
```

`authorize` optionally accepts `--policy instructions.txt`; the exact text is
part of the method identity. `--id pct_...` supports exact grant retries. `run`
also accepts `--id` for exact admission retries. Changing the code, instructions,
grant, or admitted task is not an exact retry.

The task is now ready for independent judgment, not discharged. The caller's
workspace was copied; outputs live in retained run artifacts. Export them for
inspection. In this example, the ordinary task also produced executable source:

```bash
RUN0=$(jq -er '.run.id' "$ROOT/artifacts/task-v0.json")
"$OPENCODE_BIN" contract version export "$RUN0" --directory "$ROOT/export-v0"
cat "$ROOT/export-v0/report.txt"
"$OPENCODE_BIN" contract version freeze \
  --directory "$ROOT/export-v0/candidate" --entrypoint workflow.ts \
  > "$ROOT/artifacts/v1.json"
V1=$(jq -er '.versionHash' "$ROOT/artifacts/v1.json")
jq '{contractID:.contract.id,revision:.contract.revision,
     specHash:.contract.specHash,subjectHash:.contract.handoff.subjectHash,
     runID:.run.id,artifact:"candidate"}' \
  "$ROOT/artifacts/task-v0.json" > "$ROOT/artifacts/source-v1.json"

# Explicit permission to run v1, not acceptance of the report or a promotion.
jq -n --arg scope "$SCOPE" --arg version "$V1" \
  '{action:"permit-execution",scope:$scope,versionHash:$version,
    reason:"Principal authorizes the retained successor for another offline task."}' \
  > "$ROOT/artifacts/permission-v1.json"
"$OPENCODE_BIN" contract version authorize "$V1" --scope "$SCOPE" \
  --source "$ROOT/artifacts/source-v1.json" \
  --evidence-hash "$(sha256sum "$ROOT/artifacts/permission-v1.json" | cut -d ' ' -f 1)" \
  > "$ROOT/artifacts/method-v1.json"
"$OPENCODE_BIN" contract version run --scope "$SCOPE" \
  --method "$ROOT/artifacts/method-v1.json" \
  --task "$ROOT/task.json" --workspace "$ROOT/workspace" --deadline "$DEADLINE" \
  > "$ROOT/artifacts/task-v1.json"
RUN1=$(jq -er '.run.id' "$ROOT/artifacts/task-v1.json")
"$OPENCODE_BIN" contract version export "$RUN1" --directory "$ROOT/export-v1"
cat "$ROOT/export-v1/report.txt"

# Using its output as a method did not discharge the original task.
TASK0=$(jq -er '.contract.id' "$ROOT/artifacts/task-v0.json")
"$OPENCODE_BIN" contract version show "$TASK0" | jq -e '.contract.status == "verification"'
```

Source admission checks the current exact handoff, successful run, request
coordinates, and retained executable source under `artifact` (default:
`candidate`). This proves where the source files came from, not that the
generating program chose the entrypoint, configuration, or execution
instructions. The principal explicitly authorizes that complete frozen method.
The policy path retains its stricter generated `strategy.json` derivation checks.
A source Contract may be in `verification` or `discharged`;
acceptance is not required to establish where executable bytes came from.
The new grant remains a separate principal decision. It does not discharge the
source task or manufacture a policy archive entry.

## Optional policy selection and permitted information

The two admission paths are mutually exclusive:

- `--method grant.json`: direct execution permission; no research scope state
  needs to exist. Optional `--target-executable HASH` names a frozen executable
  manifest, made available read-only at `/target`.
- `--role incumbent|research_executor`: existing policy-selected execution.
  Optional `--target-version HASH` names an archived **bundle** hash, not an
  executable manifest. Full research selection and promotion requirements stay
  in the [research workflow](pro-contract-research-execution.md).

An incumbent's ordinary task can now supply a policy candidate, just as a
research executor's task can. Exact role, grant, target, retained run, and
generated-artifact checks still apply. Direct method tasks instead use the
source-authorization path above; they cannot pretend to have policy history.

For a direct task, `--view` may select Contracts but not a policy archive:

```json
{
  "versionHashes": [],
  "experimentIDs": [],
  "contractIDs": ["pct_existing_result"]
}
```

Listed Contracts must exist and are exposed as current full Contract records;
the principal must not include sealed information. Nonempty archive selectors
are rejected for direct tasks. Reading a Contract neither makes it an evidence
dependency nor transfers its artifact bytes. Conversely, `--require` does not
implicitly authorize reading. Without `--model`, no provider access is granted;
the existing text-only native reasoning bridge remains optional.

## Preserved boundaries and remaining limits

- The Kernel is unchanged. Responsibility, permission, submission, and accepted
  support retain distinct meanings. Independently accepted results survive
  withdrawal of the method that produced them; actual evidence challenges still
  reopen affected responsibility.
- Historical `version-run-v1` tasks remain readable with their original meaning.
  Existing `requires`, frozen cohorts, and task-pareto promotion protocols are
  not rewritten or bypassed by direct execution permission.
- An admitted task remains pinned to its method, grant, model, and deadline.
  This change does **not** add same-task reassignment to a different method.
  Explicit recovery uses the retained initial input, not arbitrary later
  workspace edits. Unknown execution is not automatically replayed.
- Independently reusable partial results still require independently represented
  Contracts; this is not a new fine-grained result/checkpoint system.
- Proposed research actions do not become autonomous scheduling or authority.
  A negative study can be useful without yielding a successor, and a successor
  can run without a claim that it is better. Recursive capability improvement
  still requires separate experiments.
- The executable boundary remains a self-contained Linux Bun workflow, not
  arbitrary OpenCode binary OTA or a cgroup resource-exhaustion guarantee. See
  the existing [isolation limits](pro-contract-research-execution.md#6-qualification-and-limits).

The goal is not to require a special research workflow for every task. It is to
let ordinary work produce replaceable methods while keeping responsibility,
provenance, and permission honest.

## Qualification

The 2026-10-05 implementation is `1ff9c866501ffff83e7640c033e64d4a600d5098`
on `essential-execution`. Source was committed before the final full Core run
and native build; subsequent qualification edits are documentation-only.

- Full Core: **1,483 passed, 0 failed**, 5,525 assertions across 180 files.
- Built-binary version/strategy CLI and lifecycle/research suites: **12 passed,
  0 failed**, 589 assertions across four files.
- Core, OpenCode, Schema, Protocol, Server, Client and SDK Next package type
  checks passed.
- Linux x64 binary with embedded Web UI built successfully:
  `0.0.0-essential-execution-1ff9c86650`.
- Binary SHA-256:
  `7db6581908abe67c19b619ebf9a400cf8530e32b5cd81ca18c591f9757538078`.
- The complete offline CLI example above was separately exercised against
  source. It is a mechanism fixture, not a paid-model or capability experiment.

Final commands run from package directories:

```bash
# packages/core
umask 0022
bun test --timeout 120000 --only-failures

# packages/opencode, after building the committed source
OPENCODE_TEST_BINARY="$PWD/dist/opencode-linux-x64/bin/opencode" \
  bun test test/cli/contract-version.test.ts test/cli/contract-strategy.test.ts \
    test/cli/serve/pro-contract-research-process.test.ts \
    test/cli/serve/pro-contract-process.test.ts --timeout 120000 --only-failures
```

Local logs are in `tmp/essential-execution-eval/`. No public Protocol/Schema or
generated SDK files changed, so generators were not run during measurement.
The earlier full OpenCode qualification remains historical; it is not counted
as a fresh full-package run for this increment. No frozen campaign, model
weights, or production ledger was modified.
