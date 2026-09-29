# ProContract Kernel and RSI on upstream V2

## Scope and sources

This is a control-plane migration, not a replacement V2 Session runner or a new
model experiment. It does not import uncommitted work from `strategy-promotion`,
change frozen cohorts, migrate their databases, or claim a performance gain.

| Component                                                               | Frozen source                                            |
| ----------------------------------------------------------------------- | -------------------------------------------------------- |
| Upstream V2 base                                                        | `b30c4d00d15ed20d15a19e5c07534514bc2ee0fe` (`2.0.19`)    |
| Kernel, Core ledger, strategy settlement and historical comparator      | `0ab4b07a8b071fdb67aa82501c71f242c0763298`               |
| Deadline-optional Schema, OTA authority, supervisor and offline sandbox | `882e065558bffb98b016f5274f8c63209d9808fb` (`astra-ota`) |

The normative reducer is identical to the committed source apart from import
paths. The Schema includes the committed deadline-only and replay-observation
extensions. Explicit historical limits remain valid and part of the spec hash.
New `defaultSpec` values contain only a six-hour absolute deadline; no large
sentinel or cumulative count cap is substituted.

## Migrated boundaries

- `@opencode/schema/pro-contract`: canonical, browser-safe contracts, also
  exported by the Schema root.
- `@opencode/core/pro-contract/kernel`: deterministic authority transitions,
  obligation conservation, exact evidence coordinates, challenges, dependent
  support invalidation, and frontier-relative quiescence.
- `@opencode/core/pro-contract`: the issuer-owned Effect service. Accepted and
  rejected decisions, attestations, state changes, and the global hash-chain
  frontier commit through the current V2 SQLite transaction implementation.
- `src/pro-contract/sql.ts`: only the four institutional tables. No legacy
  OpenCode Session binding or scheduler table is silently introduced.
- `script/strategy-kernel.ts`: materializes exact strategy and evidence artifacts,
  issues and settles ordinary Contracts, supports exact settlement retries, and
  challenges live support. A dependent selection Contract cannot activate until
  its performance support is discharged. Negative performance remains negative;
  research ancestry does not itself establish deployment standing.
- `script/ota-rsi.ts`: committed OTA authority, exact task-Pareto qualification,
  full-pass retention, fixed protocol/seed identity, optimistic revision checks,
  atomic Kernel settlement and active-pair changes, probation, and rollback.
- `script/ota-supervisor.ts`, `ota-run.ts`, `ota-sandbox.ts`: the generic trusted
  driver boundary, acknowledged process fencing, cancellation, immutable
  artifacts, external paired evaluation, and accounting. The deterministic
  `ota-fixture.ts` is an offline qualification fixture, not a model driver.

The original `script/strategy-promotion.ts` comparator retains its historical
full-pass/mean/cost ordering and explicitly reports `promotion: false`. It is
not the gate for a new performance cohort. Such a cohort must separately freeze
OTA's `performanceRule: "task-pareto"`; missing evidence or an all-tied panel
cannot authorize promotion. No running or previously rejected cohort is
reinterpreted by this migration.

## V2 integration and persistence

Imports use the current `@opencode/*` packages; shared hashing and LayerNode
construction come from `@opencode/util`. Database schema, snapshot, and migration
registry were generated using Core's migration script.

Current V2 defaults `Database.node` to an in-memory database. Consequently the
strategy CLI explicitly replaces that node with
`Database.configured({ path: process.env.OPENCODE_DB })` and requires an absolute
persistent path. Merely retaining the old environment variable would silently
lose standing at process exit. Embedded callers must likewise supply the host's
configured Database node when they need persistence.

Run the issuer adapter from `packages/core`:

```sh
OPENCODE_DB=/absolute/path/to/isolated/issuer.sqlite \
  bun script/strategy-kernel.ts request.json result.json
```

Only a trusted issuer process may invoke that entrypoint or the OTA authority.
Do not expose either to candidate tools or mount their databases, evidence,
credentials, or artifact stores into workers. Hashes establish byte identity,
not evaluator authenticity or semantic truth. Existing trusted-recorder and
principal-attestation assumptions remain; no stronger adversarial claim is made.

The new database migration adds institutional tables to ordinary upstream V2
storage. It is **not** an importer for old fork databases that already contain
ProContract tables or frozen experiment ledgers. Those require a separately
reviewed, explicit data migration; do not open them with this branch.

## Native execution: bounded single-allocation profile

The real Luna/max single-instance result and the retained aggregation correction
are documented in [Native V2 qualification](./pro-contract-v2-native.md).

The follow-up adds `packages/sdk/script/contract-worker.ts` and
`packages/sdk/script/native-programbench.py`. They use the current embedded SDK,
Session inbox, runner and native model transport, not the legacy execution loop.
`packages/core/script/contract-authority.ts` runs exclusively on the host with
its own persistent ledger. A worker's idle/ended state is not an attestation.

The admitted profile exposes only `glob`, `grep`, `patch`, `read` and `shell`.
Code Mode, subagents, Session movement and background shell mode are disabled.
Every captured tool checks host-authored standing; shell operations are bounded
by ten minutes and the original deadline. The model-only Unix transport retains
caller cancellation and forwards V2 request middleware. The external gateway
checks exact model/effort, process identity, live Kernel standing and the original
deadline on every physical request. Credentials and the ledger are never worker
mounts. Cancellation fences the complete container before any replacement.

The SDK worker rejects an existing Session database: implicit restart recovery
and first-admission-wins reuse are not silently treated as exact Contract retries.
The host must explicitly qualify a recovery protocol before enabling them.

No public HTTP endpoint, generated client or server scheduler is added. The
existing normal V2 execution path remains unchanged. The old `ota-opencode.ts`
and `ota-profile.ts` are not advertised as V2-compatible. In this pilot the
runtime is operator-pinned and read-only, not a candidate-evolved H release.
Do not invoke the host authority adapter from an arbitrary proposed H source.
Mutable native V2 H admission still needs a separately pinned authority closure
and release/containment qualification; this pilot does not authorize an RSI
campaign or canonical strategy promotion.

Before broadening this native profile:

1. Preserve Contract-owned exact prompt/revision identity despite V2 inbox
   first-admission-wins retries.
2. Coordinate startup execution-claim recovery with Contract leases, current
   standing, revocation, and the original deadline.
3. Check authority at every physical model attempt and every relevant effect
   boundary, including nested Code Mode calls, subagents, and background work;
   retain full accounting without adding cumulative caps.
4. Await interruption settlement before releasing ownership or replacing a
   worker. An accepted interrupt is not completed cleanup.
5. Port snapshot/replay and independent evaluation against exact artifacts;
   prove credential/network isolation and cancellation before a cohort.
6. Add Protocol/Server surfaces only with the appropriate principal boundary,
   regenerate Client, and test the assembled API. None is inferred from Core
   unit-test success.

## Validation

From `packages/core`:

```sh
bun test test/pro-contract.test.ts test/pro-contract-constitution.test.ts \
  test/pro-contract-v2.test.ts script/strategy-kernel.test.ts \
  script/strategy-promotion.test.ts script/ota-rsi.test.ts \
  script/ota-supervisor.test.ts
bun script/migration.ts --check
bun typecheck
```

Real-process qualification uses an already-installed immutable Linux image with
`/usr/bin/python3`, no network, and no provider:

```sh
OPENCODE_OTA_IMAGE=sha256:<installed-image-id> \
  bun test script/ota-supervisor.test.ts
```

Without that explicit image, the six container tests skip rather than pretending
that unit tests establish isolation. The fixture labels every container with a
unique temporary-root identity and fences only its own processes.

Schema checks run from `packages/schema` with `bun typecheck` and
`bun test test/contract-hygiene.test.ts`; the canonical full repository check is
`bun run check` from the root. These are migration/mechanics checks, not a
benchmark, statistical superiority result, or qualification of model-driven RSI.

### Recorded migration checks — 2026-09-29

| Check                                                                               | Result                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------- |
| Kernel, ledger, V2 migration, strategy CLI/comparator, OTA authority and supervisor | 125 passed, 0 failed, 0 skipped                   |
| Schema package                                                                      | 64 passed                                         |
| Upstream database migration and Session coordinator regressions                     | 45 passed                                         |
| Upstream Session prompt/inbox and execution regressions                             | 78 passed                                         |
| Core and Schema package typechecks                                                  | Passed                                            |
| Core generated migration consistency                                                | Passed                                            |
| Root `bun run check`                                                                | Passed: lint and all 35 scheduled typecheck tasks |
| `git diff --check`                                                                  | Passed                                            |

The final runs used Bun `1.4.2` (the repository's pinned version) and Node
`24.21.0`, installed only in temporary tool directories; the host's existing
Bun/Node executables were not replaced. The older host Bun `1.3.14` crashed
during the initial full check, and Node `20.20.2` did not satisfy Astro's
`>=22.12.0` requirement. The supported-toolchain rerun completed successfully.

The six real-process isolation tests used the already-installed image
`sha256:3da9e8f8c580a551b7e5aaa5ee14621af668243ef535b3c60506ae09baf11ae3`.
They exercised cold boot, rollback, orphan fencing, cancellation, accounting,
and denial of control-plane/network/socket access without model calls. All
fixture-owned containers were removed. No production cohort was started or
changed, and no native V2 model execution or performance claim follows from
these results.
