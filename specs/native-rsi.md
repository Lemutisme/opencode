# Native V2 RSI

The native driver connects candidate generation, isolated release preparation,
paired evaluation, Kernel-authorized selection and successor execution. Linear
and tree search use the same mechanism. This is an execution implementation;
scripted qualification is **not evidence of real-model performance improvement**.

## Implementation status

Integration base: upstream V2 **2.0.22**, `41516c78c8387a86e998a90043265a33a870276d`
(merged on 2026-10-02). Historical qualifications remain bound to their original
source snapshots; merging upstream does not renew them.

| Scope           | Implemented                                                                                                                                                   | Not established                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Within-task RSI | ProgramBench task-scoped S/H selection, checkpoints, same-task continuation, original deadline and Kernel completion; scripted container qualification passed | Real-model gains are unproven; τ/TB environment forks are not qualified and fail closed.    |
| Across-task RSI | Native proposals/releases, paired selection, finite closure, independent audit and ProgramBench/τ³/TB4 adapters; real paired evaluation has run               | No successful real-model recursive succession or RSI performance gain has been established. |

The RSI worker composes the existing ProgramBench delivery tools instead of
launching the old fixed worker. Qualification ran real SDK/Session, builds,
containers, checkpoints and Kernel settlement with scripted responses and synthetic
scores. It establishes mechanism execution, not learned improvements or benchmark
generalization. No model-weight self-training is implemented or claimed. A disk
reserve failure blocks execution, not permission to relax the guard or delete history.

## Bound evidence and research execution

Merged upstream V2 through `f72a103a4b94fb9a467294877bf6243dd99c6bdc` on
2026-10-04. This does not alter or requalify any historical cohort.

New native profiles use `evidence: "bound-v1"` internally. The comparison binds
its protocol/trusted manifest (provider, environment, evaluator and input files),
incumbent, candidate, actual producer, source parent, admitted history, checkpoint
and original job allowance. A different binding cannot settle the comparison.
Complete measurements receive their own Evaluation Contract; adoption explicitly
requires that live evaluation. `withdrawEvaluation` withdraws dependent research
and adoption grants, not raw observations or unrelated descendants. Health
rollback still challenges the activation, not the original measurement.

An optional `firstChange: "s"` starts with strategy rather than harness changes.
For cross-task research, freeze `research: {proposals: 2}` with `expansionWidth`.
This is a finite proposal schedule, not a provider/action/money cap. It is separate
from `completion`, `deployment` and `stopOnPrimaryImprovement`:

```text
incumbent S0/H0 → H1 complete comparison
  → development-eligible + safe: research-only grant; confirmation may reject adoption
  → actual S0/H1 executes as producer → produces S1
  → complete S1/H1 compared with incumbent S0/H0 → separate adoption decision
```

A research parent must have complete evidence, safety, and a development panel
with no regressions and a strict gain (mechanics fixtures use their declared safety
checks). Research selection does not weaken task-Pareto adoption. Failed or
withdrawn parents remain in history but cannot execute; an exhausted frontier
stops rather than silently exceeding the frozen tree width. Parent failure fences
and withdraws that research permission without rolling back a healthy incumbent.
Every physical request checks the frozen producer and its live grant; native start
also hashes the actual S/H files against admission. Mutation is relative to the
producer, whereas adoption always compares the entire pair with incumbent.

Decision receipts retain all measured task regressions, full-pass losses and
safety/no-improvement reasons. Only development details may return to a proposer;
confirmation diagnostics stay host-only. Whole-candidate results are not causal
credit for each component. Raw observations, comparisons and deployment authority
remain different things: a hash is not a semantic equivalence certificate.

The new research terminal condition is `research proposal schedule completed`,
not `recursive closure completed`; it cannot authorize the old final audit.
Historical profiles without these Core options retain source-only expansion.
No Dream-RSI controller optimizer or EnvHarness curriculum generator is claimed;
this implementation supplies the live producer/evidence boundaries they require.

From `packages/sdk`, qualify the exact production seed (no worker overlay):

```sh
bun script/rsi-learning-qualify.ts NEW_ROOT PRODUCTION_RELEASE GATEWAY
```

The scripted provider generates a real marker H patch, executes it as a
non-adopted research parent, and generates S. Scores are deliberately synthetic:
this qualifies builds, native execution, isolation and the two-role chain, not
learning effectiveness or official benchmark performance.

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

## One replacement mechanism, two authority scopes

Omit `deployment` for campaign-level selection. A task-local profile instead
freezes `{kind: "task", task, started, deadline, checkpoint}`; `checkpoint` is a
file reference in the JSON profile and a content hash in the Core protocol.
Use a separate campaign root. Local standing never updates the global incumbent.

```text
original task Contract + checkpoint
  → incumbent continues task → explicit revision request + fenced checkpoint
  → propose inactive S/H → compare both versions from that same checkpoint
  → Kernel selects task-local successor → successor continues SAME task
```

The original task owns one deadline across continuation, proposal, build,
comparison, rollback and grading. The task checkpoint is separate from proposal
memory. It contains the public workspace, immutable task goal/image and retained
public obligations, never private Session databases or grading traces. A fresh
Session restores these obligations without inheriting predecessor readiness.
After stop acknowledgement, `continuationReady` closes the execution lease while
the verifier uses the remaining original deadline; no synthetic heartbeat is used.
Only trusted verification can discharge the original task Contract. A stopped
search, partial score or successful S/H replacement is not task completion.

For a separately frozen task on/off experiment, `deployment.revisions: 0` keeps
the incumbent fixed; a positive count schedules that many formal S/H proposals.
Each selected or rejected proposal returns to the same task checkpoint. Once the
schedule is exhausted, the successor or retained incumbent must finish without
another revision; the host also rejects forged revision handoffs. This is not a
provider/tool-call cap or a renewed deadline. It is incompatible with `completion`.
ProgramBench scores terminal blocked artifacts too, but never calls them delivered.
A separate active-control profile may freeze `deployment.control: "resume"`
with `revisions: 1`. The initial solver has the same revision-request tool as
full RSI. After its actual fenced revision handoff, the host restores the same
checkpoint with the unchanged incumbent and disables further revision requests.
It neither invents a candidate rejection nor runs a proposal/qualification. The
formal proposal count remains zero; `resumeControlUsed` records this one control
intervention. The original Task Contract, retained obligations and deadline remain
unchanged. Natural termination before a revision request is retained, not forced
into a second run. This experimental arm distinguishes recovery opportunity from
the complete adaptation procedure; it does not claim equal compute or guarantee
identical sampled prefixes across independent runs.

Local official qualification feedback is adaptive evaluation, not blind leaderboard
measurement. Fixed-pair `evaluateNative` still disables task-local revision; it does
not silently nest another search inside a cross-task comparison.

`rsi_revise` interrupts its own native Session rather than waiting for the model
to volunteer a final answer. The worker waits for idle and the host still fences
it before sealing the checkpoint. Interrupted stream usage may be unknown and
must remain explicitly incomplete; interruption is not original-task failure.

For the finite cross-task experiment, freeze
`completion: {selections: 2, successorHandoff: true, stopOnRejection: true}`.
Rejection or failed successor ends the chain (with withdrawal/rollback where
applicable). After two selections the actual successor must hand off a new,
successfully prepared proposal; that last proposal is **not evaluated or promoted**.
The completion receipt binds producer lineage, artifacts and current standing.
This policy is opt-in and incompatible with `stopOnPrimaryImprovement`.

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
An optional `development: {goal, files}` packet supplies hash-pinned public
development context to the first proposer as well as later generations. It is
explicitly operator-curated; confirmation/audit diagnostics are never exported
automatically as development context.

### Revising from observed failures

New profiles can freeze `evaluationTarget: "task-performance"` with
`development.evidence`. Each item names a host-only `source` file reference and
an existing public excerpt key (`publicFile`) in `development.files`:

- `development-run` also binds its `execution` receipt to an original development
  admission, actual S/H and deadline.
- `development-measurement` binds a completed fixed-pair measurement and its
  `execution` to a task explicitly selected as development in the new protocol.
- `development-task` binds a task-continuation receipt to its actual job, epoch,
  pair, checkpoint and original deadline. It can carry public experience into a
  new cross-task proposal; task-local standing never becomes global authority.
- `proposal-build` identifies an acknowledged build rejection, not a task score;
  compiler feedback alone is insufficient task experience.

Canonical development identities cannot overlap confirmation, audit or safety.
Raw provenance is sealed on the host, never mounted as proposer input. Excerpts
still require operator review: hashes are not redaction or causal-effect proofs,
and the full source/docs/memory input closure must also be considered. No hidden
confirmation diagnostics are automatically exported. The goal names the actual
entry and adapter modes, distinguishes solver changes from proposer-only edits,
and asks for a failure, changed mechanism and falsifier. Those claims do not
replace paired grading or relax task-Pareto.

Host proposal metadata, not an output filename, enables `rsi_check`. Before H
handoff, the worker replays the exact patch against its pinned parent, compares
all source files including additions, and bundles the actual entry with
`/runtime-bun` and the read-only dependency supply. Diagnostics permit local
repair within the same original allocation; handoff checks again instead of
trusting a stale receipt. This is not full typechecking, performance evidence or
permission to retry a formally rejected candidate. The independent host builder
still decides release preparation. ProgramBench handoff also removes the old
entrypoint before compiling, preventing stale binaries from satisfying delivery.

New profiles may select `safetyFormat: "witness-v2"` with explicit `safety` IDs.
A per-allocation JSON nonce permits normal formatting whitespace; its host
witness binds run, release and original deadline. Bad JSON/nonce is a mechanical
zero; missing containment/identity/fence is invalid. Legacy exact-byte safety
remains the default for old profiles, with no reinterpretation of old results.

The trusted grader exports `task(test, taskCheckpoint?)` (goal, output basename,
optional pinned inputs/image and dataset identity) and
`grade({test, artifact, state, run, release, deadline, signal})` returning
`{passed, total, valid}`. It judges fenced artifact bytes independently; worker
summaries, exit status and self-tests do not certify correctness.
Task-local operation also requires the trusted `continuation` adapter;
`RSITask.continuation` supplies public checkpoint sealing and verifier integration.

Alternatively, replace `grader` with a `programbench` manifest file reference:

```json
{
  "scoringTrust": "official-programbench-normal-use",
  "safety": ["containment"],
  "tasks": [
    {
      "id": "INSTANCE",
      "tests": ["d1", "d2"],
      "goal": "FROZEN_GOAL",
      "image": "sha256:IMAGE",
      "grader": { "path": "/frozen/grader.json", "sha256": "HASH" }
    }
  ]
}
```

Each grader JSON pins the official runner, Python, Docker, wheelhouse and that
instance's offline blobs; see `rsi-programbench.py`'s validated configuration.
The wheelhouse must cover both build and every test branch's dependencies. The
guard mounts it read-only in both phases and disables pip network access; missing
test dependencies invalidate the evaluation rather than becoming a zero score.
Acknowledged candidate build failures instead follow the official Evaluator's
terminal-zero result, retaining its error annotation and `executedTests: 0`.
They do not cancel other fixed repeats; infrastructure unknowns still fail closed.
Only the candidate H solves the task. The host packages its fenced workspace and
scores it with cancellation-aware process/container fencing. `safety` names a
separate fixed native liveness/containment obligation, not a benchmark instance.
All other test IDs must resolve to a frozen instance.

**Scoring boundary:** the official scorer runs tests in the candidate-built image.
Complete official scores do not certify resistance to malicious modification of
that image's interpreter/test environment. The manifest explicitly acknowledges
this normal-use trust model; stronger hostile-candidate qualification is still
required before making that stronger claim. Task-local use additionally requires
`taskFeedback: "qualification-outcomes"`: acceptance/rejection from task-local
comparison is feedback, not blind benchmark evaluation. Final ready submissions
with partial official scores terminate the task as blocked, not another solve retry.

### External benchmark environments

Profiles choose exactly one of `grader`, `programbench`, `tau` or `terminal`.
The last two also require explicit top-level `safety` IDs. A host-owned environment
lease exposes public tools over a peer-bound Unix socket; H still runs the native
V2 Session. Revocation fences actions before grading, while final disposal happens
after grading. Native local filesystem/shell tools are not exposed in these modes.

- **τ³ v1.0.1 text:** official Orchestrator, private user simulator, business state
  and deterministic ALL grader remain on the host. `tau_turn` batches official
  business calls or delivers speech; customer messages enter the durable inbox.
  Official termination stops further solver admission. This custom wrapper fixes
  **100 interaction steps**, unlike the official CLI's default 200; it is not an
  identical leaderboard harness. User-simulator requests have a separate ledger.
- **Terminal-Bench 4.0:** Harbor retains the original task container's user,
  filesystem, services and guarded network; official artifact collection and a
  separate verifier determine reward. Agent/verifier images and Docker Compose
  are pinned. The new **six-hour outer allocation** includes setup and grading;
  it is not the historical eight-hour agent budget.

Both adapters have native Docker/script-provider qualifications, including
official grading and cleanup. These validate integration, not model intelligence
or RSI improvement. Task-local private-state forks are deliberately unsupported.

For a separately frozen **fixed-pair measurement**, `rsi-evaluation.ts NEW_ROOT PLAN`
uses its own evaluation ledger and Kernel measurement Contracts, not an OTA
proposal or a fabricated successful audit source. The plan binds the exact seed
pair, profile and instance/repeat identities; it never proposes or promotes H/S.
A valid zero completes the measurement, not the task. Invalid measurements stop
without invented scores. Existing ledgers accept only explicit `--fence`, not replay.

From `packages/core`, launch using the existing OS-locked supervisor:

```sh
OPENCODE_RSI_PROFILE=/absolute/frozen-profile.json \
  bun script/ota-run.ts /absolute/new-campaign ../sdk/script/rsi-profile.ts
```

`OPENAI_API_KEY` stays host-only. Cancel via the campaign's `CANCEL` file or CLI
signal. Freeze a separate performance experiment before paid model execution;
no real-model RSI campaign is implied by these commands or the qualification.

After a finite **cross-task** closure, the same frozen profile may supply two
separate `audit` test IDs/repeats. From `packages/sdk`:

```sh
OPENCODE_RSI_PROFILE=/absolute/frozen-profile.json \
  bun script/rsi-audit.ts /absolute/new-audit /absolute/completed-campaign
```

The audit freezes the exact stopped source state and admits four evaluation-only
Kernel Contracts: seed/final × two repeats of one distinct instance. It checks
actual dataset identities, including safety assignments, not merely test labels.
It does not write the source ledger, resume search or authorize deployment.
Ties are compared exactly and cannot become improvement through floating error.
Existing ProgramBench exposure prevents calling reused instances globally unseen;
search isolation and blind generalization are different claims.
After an audit issuer crash, `bun script/rsi-audit.ts EXISTING_AUDIT --fence`
only revokes/fences that audit's resources. It needs no profile or model key,
does not resume allocations, and retains any unacknowledged cleanup failure.

## Verification

- Core: `bun test script/ota-rsi.test.ts script/ota-lineage.test.ts script/ota-supervisor.test.ts`.
- SDK: `bun test script/rsi-boundary.test.ts`; Python: `python3 script/rsi_gateway_test.py`.
- Scoped additions: Core `script/ota-task.test.ts`, `script/ota-completion.test.ts`;
  SDK `script/rsi-task.test.ts`, `script/rsi-audit.test.ts`, `script/rsi-programbench.test.ts`;
  Python `rsi_files_test.py`, `rsi_programbench_test.py` (the latter uses the pinned
  ProgramBench Python and `PROGRAMBENCH_RUNNER`). Tests do not call a real model.
- Container/wire qualification: `bun script/rsi-qualify.ts NEW_ROOT FIXTURE_RELEASE GATEWAY WIDTH MODE [WARMUP_STEPS]`.
  The explicit fixture release adds an observable code revision to the real SDK
  worker; the scripted provider generates actual source patches and policy files.
  Healthy tests require both promoted H and S to appear in successor executions,
  not just an updated pointer. Rollback tests require restored standing and the
  unchanged job deadline. A 1002-step warmup checks the former count boundary.
- Task-scoped container qualification: `bun script/rsi-scoped-qualify.ts NEW_ROOT
NEW_FIXTURE_RELEASE GATEWAY PINNED_TASK_IMAGE [delivery|closure]`. Use a fresh
  source snapshot with the fixture-only revision marker, not a historical release.
  `delivery` requires actual H/S takeovers and original-task discharge; `closure`
  requires the final prepared H2 proposal and keeps the unfinished task escalated.
  Both use scripted responses/mechanical scores, never real-model performance.

Earlier qualification scores are deterministic mechanics fixtures, not ProgramBench scores.
The previous [task-level regression](./pro-contract-v2-delivery.md) remains unchanged.

The 2026-10-02 scoped qualification includes original-task delivery after both S/H
takeovers, a separate H2-handoff closure that correctly leaves its task escalated,
and a cross-task closure followed by four independent audit allocations without
changing the source ledger. These new container cases use width one. Historical
tree qualification and current lineage regressions are separate evidence.
A separate offline official-scorer regression reproduced the archived i3-style
463/539 result without another model allocation or changing the old artifacts.
This validates scorer wiring, not a new RSI gain or hostile-candidate resistance.
