# ProContract v1 R2 interactive preview

This is a separately developed preview based on frozen R2 commit `78bec1926`.
It does not replace a historical runtime, change an experiment, or establish
new benchmark performance. It is not yet a cross-platform stable release.

## Build and start

```bash
git switch r2-interactive-ready
bun install --frozen-lockfile
cd packages/opencode
OPENCODE_CHANNEL=r2-interactive OPENCODE_VERSION=0.0.0-r2-interactive-preview \
  bun run build --single --skip-install --skip-embed-web-ui
./dist/opencode-linux-x64/bin/opencode /path/to/project --model provider/model
```

The example output path is for Linux x64; native builds use the corresponding
platform directory. `--skip-embed-web-ui` does not disable the terminal UI.
Use a model and credentials configured in the normal local configuration.
The dedicated executor uses Core's Location configuration; for custom
providers, keep their definition in `opencode.json` rather than only a
client-process environment override.

The private embedded TUI worker receives a fresh ephemeral principal credential
when no password is configured. It has no HTTP listener; this does not grant
principal authority to anonymous network clients. External `serve`, `attach`,
`--port`, `--hostname`, and mDNS operation still require explicit server
credentials for governance. Keep listeners local unless deliberately secured.

## Natural-language task entry

For example:

> Use ProContract for this task. Implement the requested change and produce
> `dist/app`. Keep working within a six-hour deadline, without cumulative turn
> or action limits. Propose exact write/process authority and finite build and
> replay checks for my approval. Submit the result for my independent review.

The primary agent may propose a Contract for asynchronous, cross-Session,
future-triggered, durable follow-up, or later externally adjudicated work.
Ordinary work can proceed directly: proposal selection is model behavior, not
a deterministic promise that every prompt will activate ProContract.

The permission UI offers:

- **Confirm and start:** issue the displayed terms and delegate to a dedicated
  native Session.
- **Revise:** reject with correction feedback; no Contract is created.
- **Continue normally:** reject formation; no Contract or execution binding is
  created.

Inspect the exact authority, absolute deadline, count ceilings (if any),
settlement claim, replay checks, and original request before confirming.
`--auto` never approves this governance decision. A proposal cannot grant the
executor the right to attest its own completion.

## Optional original R2 strategy

Add to the project's `opencode.json`, preserving its other settings:

```json
{
  "procontract": {
    "execution_policy": "r2-v5"
  }
}
```

This selects the exact original ProgramBench v5 behavior-matching strategy:

```text
SHA-256 b382202cc07a74e212a8ab41e47a117a291dce1815e4967125a360a62e76d067
```

It is intended for reference/behavior-matching tasks and contains ProgramBench
delivery conventions such as `compile.sh` and `validate.sh`. It is not a proven
general-purpose strategy; leave it unset for unrelated tasks. Omitted or `false`
does not install a policy. Explicit independently supplied policy takes
precedence. It is shown before approval and frozen in the execution binding,
not added to the Contract specification. Changing configuration does not mutate
existing Contracts, authority, deadlines, attempts, or acceptance criteria.

## Inspect, verify, or cancel

Use `/contracts`. The list includes project-ID scopes used by natural-language
issuance and historical directory scopes used by older manual UI issuance.
While open, the list refreshes once per second without overlapping requests.
An open management menu can be updated with **Refresh status**.
Select a Contract, then **Open execution Session** to inspect its transcript.
This opens a read-only native transcript, not the legacy Session editor. Records
are newest-first, refresh while viewing the latest page, and have an **Older
messages** paging action. Select a record to view its exact JSON, including tool
inputs, outputs, status, provenance, and capture markers.
Future-triggered Sessions cannot be opened until the scheduler creates them.
Completed and released Contracts remain inspectable.

Readiness and a passing finite replay are not settlement. Principal-evidence
Contracts remain in `verification` until the user independently reviews the
exact handoff and chooses **Attest settlement claim**, supplying the review's
evidence hash. Other evidence policies require their designated verifier; the
executor cannot substitute an assertion for that evidence.

**Release without evidence** durably cancels the obligation, then interrupts its
active executor when owned by the same server process; it is not successful
completion. Effects already performed are not undone. An executor owned by
another process is fenced at its next authority check. Revision and resumption remain
explicit principal decisions and do not silently regrant budgets.

The minimal manual **Issue contract** command retains the historical read-only,
4-turn / 32-action / 24-hour defaults. Prefer a natural-language proposal for
implementation work requiring write authority, deadline-only execution, or
explicit replay checks.

Keep `opencode serve` alive for unattended scheduling. Closing every process
retains durable obligations but does not provide a background daemon. Restart
can recover eligible Contract work while retaining its original deadline;
verification already reached survives without reissuing the task.

## Qualification

Run from package directories:

```bash
cd packages/core
bun typecheck
bun test test/pro-contract-execution-policy.test.ts test/catalog.test.ts \
  test/pro-contract.test.ts test/pro-contract-replay.test.ts

cd ../tui
bun typecheck
bun test test/component/dialog-contracts.test.ts test/cli/cmd/tui/sync.test.tsx

cd ../opencode
bun typecheck
bun test test/cli/contract-worker.test.ts test/cli/pro-contract-interactive.test.ts \
  test/server/auth.test.ts test/server/httpapi-pro-contract.test.ts
OPENCODE_TEST_BINARY="$PWD/dist/opencode-linux-x64/bin/opencode" \
  bun test test/cli/pro-contract-interactive.test.ts
```

The tests use a deterministic loopback provider, real server processes, native
scheduler/Session execution, permission decisions, durable restart, and HTTP
settlement. They do not measure whether a live model reliably chooses formation,
solve benchmark tasks, or establish performance gains. A compiled binary run
must be reported separately from source-process tests. The current local shell
is not an adversarial sandbox; benchmark credential/network isolation remains
adapter-owned. No new commercial-provider requests are needed for these checks.
