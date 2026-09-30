# ProContract on upstream V2

ProContract adds issuer-owned authority and a restricted native execution bridge;
it does not replace the V2 Session runner. The latest ProgramBench-evaluated runtime is
`bc8af80928` on upstream `74dbc509d7` (2.0.20), on branch `procontract-closure`.
Documentation-only commits do not change that frozen runtime.

- [Delivery mechanism and current regression](./pro-contract-v2-delivery.md)
- [Native RSI: linear/tree source expansion and successor execution](./native-rsi.md)
- Historical reports: [single-instance pilot](./pro-contract-v2-native.md),
  [three-instance sync](./pro-contract-v2-sync.md)

## Migration provenance

| Component                                              | Committed source                                    |
| ------------------------------------------------------ | --------------------------------------------------- |
| Initial upstream V2 base                               | `b30c4d00d15ed20d15a19e5c07534514bc2ee0fe` (2.0.19) |
| Kernel, ledger, strategy settlement/comparator         | `0ab4b07a8b071fdb67aa82501c71f242c0763298`          |
| Deadline-only Schema, OTA authority/supervisor/sandbox | `882e065558bffb98b016f5274f8c63209d9808fb`          |

The normative reducer retains the committed semantics; only import paths changed.
Uncommitted `strategy-promotion` work and historical cohort databases were not imported.

## Code map

| Location                                                    | Responsibility                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/schema/src/pro-contract.ts`                       | Browser-safe Contract types                                                                                                     |
| `packages/core/src/pro-contract/kernel.ts`                  | Deterministic transitions, obligation conservation, challenges, dependent-support invalidation and frontier-relative quiescence |
| `packages/core/src/pro-contract.ts`                         | Issuer service, transactional SQLite ledger and hash-chain frontier                                                             |
| `packages/core/script/strategy-kernel.ts`                   | Exact strategy/evidence artifacts, settlement, retries and support challenges                                                   |
| `packages/core/script/ota-rsi.ts`                           | Qualification, atomic selection, probation and rollback                                                                         |
| `packages/core/script/ota-{supervisor,run,sandbox}.ts`      | Trusted execution, fencing, isolation and accounting                                                                            |
| `packages/sdk/script/contract-{worker,profile,delivery}.ts` | Native Session execution and public-evidence handoff                                                                            |
| `packages/sdk/script/native-programbench.py`                | Host gateway, packaging and independent grading                                                                                 |

## Authority and deployment boundaries

- V2 defaults to an in-memory database. Issuer CLIs require an absolute
  `OPENCODE_DB`; embedded callers must replace `Database.node` with
  `Database.configured({ path })`. Otherwise standing disappears on exit.
- Keep issuer APIs, databases, evidence stores and provider credentials on the
  trusted host, never in candidate tools or mounts. Hashes establish byte identity,
  not evaluator authenticity or semantic truth. Session completion is not attestation.
- The migration adds institutional tables to upstream storage; it does **not**
  import old fork databases. Preserve historical databases, frozen cohorts and
  the original meaning of explicit historical budget limits.
- Native execution uses the V2 SDK/inbox/runner, not the legacy loop. It exposes
  five leaf tools plus `contract_delivery`; Code Mode, subagents, movement,
  background shell and implicit restart recovery remain outside the admitted profile.
- The runtime is pinned and read-only. This is not qualification of candidate-evolved
  H, a public Contract HTTP API or a server scheduler. Legacy `ota-opencode.ts` and
  `ota-profile.ts` are not advertised as V2-compatible.

From `packages/core`, invoke the host-only issuer adapter with:

```sh
OPENCODE_DB=/absolute/path/to/isolated/issuer.sqlite \
  bun script/strategy-kernel.ts request.json result.json
```

The [native RSI driver](./native-rsi.md) is separate from the read-only task bridge.
RSI implementation/qualification is not an RSI performance result. New promotion protocols must
separately freeze `performanceRule: "task-pareto"`: no task-level mean regression
and at least one strictly positive improvement across fixed repeats. All ties
reject promotion. Safety, development/confirmation evidence and established-full-pass
protections still apply. The historical `strategy-promotion.ts` comparator reports
`promotion: false`; it is not this admission gate. Never relabel post-hoc readmission
as preregistered evidence.

## Validation

Use pinned Bun 1.4.2 and a supported Node version (recorded runs used 24.21.0).
From `packages/core`:

```sh
bun test test/pro-contract.test.ts test/pro-contract-constitution.test.ts \
  test/pro-contract-v2.test.ts script/strategy-kernel.test.ts \
  script/strategy-promotion.test.ts script/ota-rsi.test.ts script/ota-supervisor.test.ts
bun script/migration.ts --check
bun typecheck
```

Set `OPENCODE_OTA_IMAGE=sha256:<installed-image-id>` to exercise the six offline
container checks; otherwise they skip, not pass. From `packages/schema`, run
`bun typecheck` and `bun test test/contract-hygiene.test.ts`; from the repository
root, run `bun run check` (not tests). Native bridge qualification is documented
in the [delivery guide](./pro-contract-v2-delivery.md).
