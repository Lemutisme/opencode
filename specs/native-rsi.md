# Native V2 RSI

The native driver connects candidate generation, isolated release preparation,
paired evaluation, Kernel-authorized selection and successor execution. Linear
and tree search use the same mechanism. This is an execution implementation;
scripted qualification is **not evidence of real-model performance improvement**.

## One source graph, one admission gate

Set `expansionWidth` in the operator profile:

- `1`: extend the previous materialized candidate, including rejected candidates.
- `2` or more: breadth-first expansion, retaining siblings and descendants.

Only the authorized incumbent executes the proposer. A selected parent provides
**inactive source bytes**, not deployment authority. Each candidate is compared
with the current incumbent, not merely its research parent. Exact rejected pairs
cannot be re-sampled into a lucky promotion under the same incumbent. A switch
starts a new source root; old lineage and negative evidence remain in SQLite.

```text
incumbent S/H → choose source parent → propose inactive S or H → fence
             → prepare immutable artifact → independent paired evaluation
             → existing OTA/Kernel gate → successor S/H runs → probation/rollback
```

The normative reducer is unchanged. `task-pareto`, fixed repeats, complete
safety/development/confirmation evidence and retained-full-pass protections
remain authoritative. Source ancestry never substitutes for evidence.

## Boundaries

- **S** is nonempty UTF-8 policy text, at most 64 KiB.
- **H** identifies the complete worker release: source archive, dependency archive,
  Bun, ripgrep, entrypoint and image. The first profile changes source while
  dependency/toolchain/image supplies stay pinned; it does not admit arbitrary
  dependency upgrades. A patch is a proposal, never the deployed release.
- Candidate source is patched and checked only in a network-none builder. A
  bounded source archive crosses to the host as data, never extracted or imported
  there. Workers mount the materialized release read-only. Compiler execution
  cannot rewrite the already-exported host source archive.
- The host loads its own fixed Kernel, OTA, driver, gateway and operator grader,
  never their copies from H. Provider credentials and issuer SQLite stay outside
  workers. The gateway checks the live job/epoch/incumbent/support, exact model
  and effort, peer PID identity and original deadline on every physical request.
- Each proposal/evaluation has its original six-hour deadline; there are no
  cumulative request/action/cost limits. Host provider, build and control
  operations are bounded. The seed worker also bounds leaf-tool operations;
  authority over mutable H ultimately rests on the external gateway and container
  fencing, not on H honoring its own guards.
- Public handoff summaries cross generations as hash-bound advisory checkpoints.
  Private Session databases and confirmation traces are not migrated to proposers.
  Restart fences old workers before any decision; interrupted work is not silently
  retried. Rollback preserves an existing job's original deadline.

## Entrypoints

| File                                                | Role                                                           |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `packages/core/script/ota-rsi.ts`                   | Existing authority plus persistent source lineage              |
| `packages/core/script/ota-supervisor.ts`            | Existing execution/evaluation/switch loop                      |
| `packages/sdk/script/rsi-profile.ts`                | Operator-owned configuration and grader loading                |
| `packages/sdk/script/rsi-driver.ts`                 | Native implementation of the supervisor's Driver interface     |
| `rsi-runtime.ts`, `rsi-native.ts`, `rsi-gateway.py` | Release, process and credential boundaries                     |
| `rsi-worker.ts`                                     | Mutable H's native SDK/Session entrypoint and artifact handoff |

From `packages/sdk`, package an **operator-trusted** source tree; new source files
must be tracked because packaging uses `git ls-files`:

```sh
bun script/rsi-seed.ts SOURCE NEW_SEED_DIR BUN RG PINNED_IMAGE_ID
```

A frozen JSON profile supplies `harness`, `strategy`, `grader`, `gateway` and
`authority` file references (`{path, sha256}`), plus `model`, `effort`, `upstream`,
`expansionWidth`, `tests`, `startupMs`, `heartbeatMs`, `probationMs` and
`evaluationConcurrency`. Optional: `requiredFull`, `stopOnPrimaryImprovement`.
The operator must enumerate the custom grader/data closure in `authority`.
Performance manifests require safety tests and at least two distinct executions
per task in each development/confirmation panel. All ties reject promotion.

The trusted grader exports `task(test)` (goal, output basename, optional pinned
input files/image) and `grade({test, artifact, state, run, release})` returning
`{passed, total, valid}`. It judges fenced artifact bytes independently; worker
summaries, exit status and self-tests do not certify correctness.

From `packages/core`, launch using the existing OS-locked supervisor:

```sh
OPENCODE_RSI_PROFILE=/absolute/frozen-profile.json \
  bun script/ota-run.ts /absolute/new-campaign ../sdk/script/rsi-profile.ts
```

`OPENAI_API_KEY` stays host-only. Cancel via the campaign's `CANCEL` file or CLI
signal. Freeze a separate performance experiment before paid model execution;
no real-model RSI campaign is implied by these commands or the qualification.

## Verification

- Core: `bun test script/ota-rsi.test.ts script/ota-lineage.test.ts script/ota-supervisor.test.ts`.
- SDK: `bun test script/rsi-boundary.test.ts`; Python: `python3 script/rsi_gateway_test.py`.
- Container/wire qualification: `bun script/rsi-qualify.ts NEW_ROOT FIXTURE_RELEASE GATEWAY WIDTH MODE [WARMUP_STEPS]`.
  The explicit fixture release adds an observable code revision to the real SDK
  worker; the scripted provider generates actual source patches and policy files.
  Healthy tests require both promoted H and S to appear in successor executions,
  not just an updated pointer. Rollback tests require restored standing and the
  unchanged job deadline. A 1002-step warmup checks the former count boundary.

Qualification scores are deterministic mechanics fixtures, not ProgramBench scores.
The previous [task-level regression](./pro-contract-v2-delivery.md) remains unchanged.
