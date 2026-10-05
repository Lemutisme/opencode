# Research execution qualification

This record qualifies the executable research mechanism described in
[the implementation guide](pro-contract-research-execution.md), not a claim of
recursive capability improvement or a general hostile-workload hosting service.

## Source and artifact

- Date: 2026-10-05 UTC.
- Branch: `research-execution`, based on `contract-delivery@431324f412`.
- Implementation: `0062569725f5ef177c603fbb08a3f4711f15308e`.
- Built artifact: `packages/opencode/dist/opencode-linux-x64/bin/opencode`,
  including the embedded Web UI.
- Version: `0.0.0-research-execution-0062569725`.
- Binary SHA-256:
  `9d72c91f585a92b13daf27582318379e28e3398513fb3678d24a392f87cf3373`.
- Environment: Linux x64/glibc, Bun 1.3.14, Node 24.21.0 for the build,
  bubblewrap with user/PID/network namespace support.

The artifact is a local build, not an uploaded release. Documentation-only
qualification updates do not change its source identity. Tests used isolated
temporary state and deterministic local model/evaluator fixtures. No paid-model
campaign, frozen cohort, or production responsibility ledger was changed.
`pro-contract/kernel.ts` is unchanged from the base.

## Checks

| Check                                              | Result                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Type checking                                      | Schema, Protocol, Core, Server, Client, SDK Next, LLM, OpenCode and TUI passed; legacy JS SDK separately passed |
| Committed Core full suite                          | 1,468 passed, 0 failed, 5,305 assertions across 178 files                                                       |
| OpenCode full suite                                | 3,696 passed, 0 failed, 22 skipped, 1 todo; 50 snapshots and 10,584 assertions across 266 files                 |
| Shared-package tests                               | Client 16, Schema 23, Protocol 2, legacy JS SDK 1 passed                                                        |
| SDK Next full suite                                | 6 passed, 25 assertions                                                                                         |
| Built-binary lifecycle and research process suites | 6 passed, 471 assertions                                                                                        |
| Source strategy/version CLI                        | 5 passed, 63 assertions                                                                                         |
| Unified HostRun                                    | 18 passed, 179 assertions                                                                                       |
| SQLite startup and concurrent selection stress     | 20 passed, 190 assertions, 10 repetitions of each case                                                          |
| Official generated sources                         | All 48 checked Client/SDK source files reproduced byte-for-byte                                                 |
| Build                                              | Linux x64 binary, embedded Web UI and version smoke test passed                                                 |

Run commands from their package directories, never repository-root tests:

```bash
# packages/core
umask 0022
bun typecheck
bun test --timeout 120000 --only-failures

# packages/opencode
umask 0022
bun typecheck
bun test --timeout 30000 --only-failures
OPENCODE_TEST_BINARY="$PWD/dist/opencode-linux-x64/bin/opencode" \
  bun test test/cli/serve/pro-contract-research-process.test.ts \
    test/cli/serve/pro-contract-process.test.ts \
    --timeout 120000 --only-failures
```

Official Client generation was `bun run generate` in `packages/client`; legacy
SDK generation/build was `./packages/sdk/js/script/build.ts` at the repository
root. The clean SDK build produced 78 distribution files and both compiled
client entrypoints passed an import smoke test. The native build used:

```bash
# packages/opencode; use Node 24 on PATH and an existing models.dev snapshot
OPENCODE_CHANNEL=research-execution \
OPENCODE_VERSION=0.0.0-research-execution-0062569725 \
MODELS_DEV_API_JSON="$MODELS_SNAPSHOT" \
  bun run script/build.ts --single --skip-install
```

Local raw logs are retained under `tmp/research-execution-eval/`, not committed
as operational data. Validation totals from the historical delivery guide must
not be counted as passes of this implementation.

## What the mechanism tests establish

- Frozen v0 actually writes v1 source; independently authorized, research-only
  v1 executes its changed workflow and writes v2. Incumbent stays v0 until v2
  receives its own comparison and adoption decision.
- Research-only qualification does not masquerade as confirmation. The fixture
  compares v2 against incumbent v0, not merely its source parent v1.
- Tasks retain their original method, grant and deadline across later role
  changes. A failed old task can explicitly resume without losing the failed
  run or extending its budget.
- A negative research report can complete the specified ordinary research duty
  without deploying a new method or closing a broader improvement objective.
- Method withdrawal stops execution but preserves independently accepted
  results. Challenging a genuine result dependency still reopens affected work.
- Candidate requests cannot authorize adoption or attestation. Substituted
  source, strategy text, target or run identity is rejected.
- Native reasoning uses the real Session admission/coordinator/runner and
  returns unverified observations. Interruption never silently replays a
  consumed provider request; the parent retains its accounting references.
- Host-death tests cover startup and active sandbox workers, including detached
  descendants. Verified pending input survives without inventing a completion
  receipt; incomplete capture fails closed rather than replacing it with a
  changed live workspace.

## Findings corrected during qualification

The expanded checks caught concrete boundary defects: optional `undefined`
fields in Contract Views were not JSON wire values; pending input needed the
same integrity checks as completed input; startup cancellation could orphan a
sandbox; and SQLite could encounter a concurrent WAL recovery lock before its
busy handler was installed. The final source normalizes the View at its wire
boundary, validates every retained input, uses a fixed external supervisor, and
installs a bounded SQLite startup wait before the first WAL access.

The SQLite fix was also exercised against the actual Node adapter on Node 22
and 24. Explicit zero/custom timeouts remain effective; a sustained lock fails
after approximately five seconds rather than waiting indefinitely.

Not every failed validation attempt was a source defect. An initial OpenCode
suite inherited the machine's `0002` umask, whereas an existing file-mode test
expects `0644`; it also overlapped SDK regeneration, briefly removing a generated
module needed by a child CLI process. Qualification reruns use `0022` and stable
generated sources. A pre-existing legacy SDK incremental cache could leave
`dist` empty after its build script cleared that directory; removing only the
ignored `tsconfig.tsbuildinfo` and rerunning the official script produced the
verified clean build. The SDK build script itself was not changed.

## Limits

This is executable Bun workflow succession with a protected local authority
boundary, not arbitrary full-OpenCode-binary OTA. It does not provide cgroup
memory/PID/disk-exhaustion containment, automatic mid-task method reassignment,
or autonomous confirmation-budget governance. Inputs explicitly granted by the
principal remain readable, so the principal must exclude secrets and sealed
evaluation material from those inputs.

The recursive-chain fixture is deterministic mechanism evidence. Establishing
better successor-generation performance still requires frozen, same-starting-
point comparisons with equal permitted experience/resources, independent final
evaluation, failed searches included, and no selection on confirmation scores.
