# Essential ProContract + RSI

Implementation base: upstream `v2`, `1d610f90a04817c3e8b467f879e4d9a24daa0aff`
(2.0.24). This is a new implementation, not a migration of the historical R2
scheduler, experiments, policy portfolio, or databases.

The responsibility reducer and its Schema contract are retained byte-for-byte
from `native-rsi@6766cffd64`. They do not know about models, strategies, scores,
Sessions, or benchmarks. The native model-only transport is reused separately.
All new execution, persistence and policy succession compose upstream V2.

## Smallest complete loop

An ordinary task owns its goal, acceptance authority, deadline and outstanding
responsibility. An immutable method is instructions for both doing work and
learning from it. Work can submit, checkpoint, or propose a successor method.
Only the host grants permission and independently verifies sealed work.

```
task + authorized method -> native Session -> fenced checkpoint
    -> submit -> independent verification -> discharge or public feedback
    -> checkpoint -> fresh native Session, same responsibility/deadline
    -> propose method -> paired evaluation -> authorized selection
        -> successor actually continues the task and can propose again
```

Policy includes when to probe, checkpoint, rebuild context and continue. H is
the pinned upstream native runtime in this minimal profile; arbitrary runtime
OTA, source-tree search and benchmark-specific adapters are intentionally not
part of this implementation. No weight training is claimed.

New promotion protocols use fixed-repeat task-Pareto, complete development and
confirmation measurements, safety cases and established-full-pass protection.
Evaluation records establish measurements, not deployment permission. Source
ancestry is not a `requires` dependency. Execution grants and accepted results
have separate lifetimes. There is no cumulative request/tool/cost allowance.

Historical source trees, ledgers, cohorts and scores are not modified. R2 informs
the design through retained public counterexamples, evidence before readiness,
and continuity across context refresh, not by copying its execution machinery.

## Entry points

- `opencode contract run ROOT --profile PROFILE.json --task TASK.json`
- `opencode contract inspect ROOT --profile PROFILE.json`
- `opencode contract cancel ROOT`
- `opencode contract resume ROOT --profile PROFILE.json --task TASK.json`
- Embedded host: `import { ProContractRSI } from "@opencode/sdk/pro-contract"`.
  `open(root, configuration)` returns `run`, the issuer-owned `store`, and `close`.

These are opt-in host operations, not model tools or a replacement for upstream
Chat/TUI execution. Ordinary OpenCode startup does not import the RSI host. The
new command does not connect to or replace the installed background service.
No public Protocol/Server HttpApi changed, so client generation is not required.

Use Bun **1.4.2**, Linux with working user/PID/network namespaces and Bubblewrap,
and Python 3. The model adapter is the native OpenAI Responses transport. Model
ID, effort, endpoint and tool/runtime identities belong to the frozen profile.
For an authenticated provider, explicitly set `model.credential` to the name of
a host environment variable, e.g. `OPENAI_API_KEY`; its value is never serialized
or passed into the worker. Omission grants no credential, including in tests.

Freeze a **new** immutable source/dependency release from this checkout, outside
the worktree, from `packages/sdk`:

```sh
bun script/pro-contract-freeze.ts /absolute/opencode-checkout /absolute/new-release
```

`RELEASE.json` pins every tracked/nonignored source file and source symlink, the
upstream base and implementation commit. Dependencies are copied from the
operator's frozen-lockfile installation and mounted read-only; their package
versions are pinned by `bun.lock`. This is an operator-trusted dependency supply,
not a third-party package authenticity certificate. Never modify an admitted
release. The host checks source and Bun/Python/Bubblewrap identities on admission.

The configuration's `runtime` supplies absolute `directory` (that release),
`bun`, `python` and `bwrap` paths. `seed` contains the exact initial
`{instructions}`; `ProContractRSI.initialMethod` is a transparent optional seed,
not an automatically promoted policy. `tests` declares safety, development and
confirmation tasks with unique IDs, fixed repeats, denominators, goals, public
input directories and independent verifiers. Performance tasks need at least two
repeats; safety may use one. Each verifier supplies an absolute private directory
and explicit argv, e.g. `['/usr/bin/python3', '/verifier/judge.py']`.

A task supplies `id` (`pct_...`), `goal`, public input `directory`, exact `total`
and `verifier`. `deadline` is an absolute millisecond timestamp; omission on first
admission gives six hours, while retries retain the original value. The caller's
input tree is not modified. A verifier receives a fresh copy of the sealed
workspace at `/workspace`, its private inputs at `/verifier`, no model channel,
and must output one JSON object:

```json
{ "passed": 8, "total": 10, "valid": true, "feedback": "Optional explicitly public feedback" }
```

Nonzero exit, missing output, invalid JSON, changed denominator and cancellation
are unavailable evidence, never synthetic zeroes. A legitimate zero is valid.
The original task's verifier may return explicitly public repair feedback; this
is adaptive execution, not blind leaderboard measurement. Confirmation details
never enter the producer's feedback. A complete rejected comparison leaves the
incumbent in place and continues the original task. An incomplete comparison
stops; its reserved candidate cannot be re-sampled under that incumbent.

## Retained state and boundaries

The private scope contains `ledger.sqlite` (Kernel plus method standing and an
append-only hash chain), content-addressed checkpoints/evidence, `FROZEN.json`,
and per-execution native Session databases, provider requests, usage, logs and
fence receipts. Evaluation and verification receipts bind the exact producer,
method, original deadline, assignment, input/output and verifier. A hash proves
identity, not evaluator authenticity: the issuer and verifier remain trusted.

Every worker has an isolated PID/network/mount namespace, read-only runtime,
private Session state and a fresh writable workspace. Only that native runtime's
PID and birth identity can use the Unix model channel; shell descendants cannot.
The gateway checks the live task and grant on every physical request. Host
monitoring fences processes on cancellation, withdrawal or original-deadline
expiry. Individual requests/tools/verifiers are bounded; counts and unknown
usage/cost are retained without becoming cumulative execution caps.

Only regular files and directories are admitted into public checkpoints;
symlinks/special files fail closed. Each file is bounded to 64 MiB and each
snapshot to 10,000 entries as infrastructure guards. Empty directories and
executable bits survive context refresh. Full public observations are retained;
the next prompt includes bounded recent excerpts with an explicit full-read path.

The authority ledger is single-host and single-writer. An interrupted invocation
that acknowledged fencing may be explicitly resumed within its original deadline.
After an issuer process crash, `RUNNING` and an unclosed execution intentionally
block automatic restart: an operator must establish process cleanup before
releasing that claim. Removing a file is not proof of fencing. Automatic crash
replay, distributed ownership and arbitrary candidate-evolved H are out of scope.
The private SQLite API is for the principal, never a capability given to tools.
Accepted independent task results do not depend on the continued permission of
the method that produced them; withdrawing actual evidence still propagates
through the Kernel's explicit `requires` relation.

## Reproducible zero-model qualification

From `packages/sdk` in the **frozen release**:

```sh
bun script/pro-contract-qualify.ts NEW_RESULT_ROOT /absolute/new-release /absolute/bun
PROCONTRACT_QUALIFY_MODE=rejected \
  bun script/pro-contract-qualify.ts NEW_REJECTION_ROOT /absolute/new-release /absolute/bun
bun script/pro-contract-faults.ts NEW_FAULT_ROOT /absolute/new-release /absolute/bun
PROCONTRACT_QUALIFY_WARMUP=1002 \
  bun script/pro-contract-qualify.ts NEW_LONG_ROOT /absolute/new-release /absolute/bun
```

The qualification creates inspectable `PROFILE.json` and `TASK.json` examples.
It uses a local scripted Responses provider with the actual SDK, Session runner,
tools, filesystem, sandbox, gateway, verifiers and durable Kernel. The positive
case requires two complete paired selections, actual native requests using each
successor, successor-authored next proposals, retained work and original-task
discharge. The negative case requires a confirmation regression to reject the
candidate while the unchanged incumbent continues. Fault cases exercise actual
cancellation, expiry and support withdrawal. These are **mechanism proofs, not
real-model performance results**; no paid model is invoked.

Package tests:

```sh
# packages/core
bun test test/essential-rsi.test.ts test/pro-contract-constitution.test.ts
bun typecheck
# packages/sdk
bun test test/pro-contract.test.ts
PROCONTRACT_RELEASE=/absolute/new-release bun test test/pro-contract-e2e.test.ts
bun typecheck
# packages/cli and packages/schema, separately
bun typecheck
```

Full `bun run check` also requires a Node version that can load upstream's
TypeScript lint plugins (qualification uses Node 22.22.0, not the host's Node 20).
Qualification results and artifact coordinates are appended only after execution.
