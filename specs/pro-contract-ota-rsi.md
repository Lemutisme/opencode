# Fixed-Kernel, cross-partition OTA RSI

Branch: `ota-rsi`, isolated checkout `/home/duozhou/opencode-ota-rsi`.
Base: the already qualified deadline-only issuer `c814157f1`. This implementation
has not modified the normative Kernel or the running Sol R3–R5 cohorts.
The main checkout still has the historical count-required Schema: do not copy
these scripts there and pretend it supports deadline-only model execution.

## H means the complete OpenCode harness

The user clarified that **all OpenCode execution components belong to H**, not
merely a policy renderer or a plugin. The earlier blanket description of the
OpenCode runtime and Schema as fixed was too broad. The distinction is between
the **external trusted control plane** and the **mutable worker implementation**,
not between arbitrarily frozen and mutable directories inside OpenCode.

| Component                                                                                                                                                           | Surface                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Persistent strategy/heuristics, selected approach and strategy revisions                                                                                            | S                                                          |
| Context-window allocation, history selection, compaction, summaries and retrieval                                                                                   | H                                                          |
| Memory representation, read/write/retrieval policy, storage implementation and internal schemas                                                                     | H                                                          |
| Tool definitions, registry, implementations, output processing and agent-side tool selection                                                                        | H                                                          |
| Session/provider loop, planning, internal scheduling, retry/recovery implementation                                                                                 | H                                                          |
| Prompt assembly, agent configuration, plugins, internal protocols and provider request construction                                                                 | H                                                          |
| Other OpenCode components, dependencies and build configuration                                                                                                     | H, unless part of the separately pinned external authority |
| Canonical promotion/withdrawal, independent grader, actual sandbox/capability enforcement, credential gateway, accounting/deadline enforcement and watchdog/fencing | Fixed outside S and H                                      |

This is **not a mutable-path allowlist**: listing memory, tools or context does
not exclude the rest of OpenCode. Nor does it authorize an evolved worker to
change its external permissions, provider credentials, original deadline, assigned
experiment model or hidden grader. Agent-side permission/routing code may change;
the external admission and capability ceiling still apply. Managing a context
window is evolvable; changing the model's underlying supported limit is not a
software capability the harness can invent.

Source examples in this checkout include `src/system-context`,
`src/session/history.ts`, `src/session/compaction.ts`, `src/session/runner`,
`src/tool`, `src/tool-output-store.ts`, config/plugin modules and `packages/llm`.
These are examples, not the extent of H. Candidate source/build scripts execute
only inside the isolated build/worker environment, never as host imports.

The full implementation binds **source archive + build inputs + runnable binary
digest + execution-image digest** as H and actually starts that release for both
generation and evaluation. Keeping the old OpenCode binary and merely reading a
new policy file does **not** implement this definition. The small release manifest
is content-addressed; its referenced source, build evidence and executable are
rehash-checked before use. `ota-opencode.ts` now supplies this full-release driver.
The qualified target is the Linux headless OpenCode executable, not a claim that
all desktop/UI/platform distributions have been built and tested.

### Memory and state are part of the rollout problem

Rolling back code alone is insufficient when H can change memory/storage schemas.
The full-release driver now:

- Fence the old worker and checkpoint its derived memory/workspace state.
- Boot the trial in a private, copy-on-write state namespace. A trial may not
  destructively migrate the fallback's database or files.
- Bind migration/compatibility checks and the checkpoint identity to the boot
  receipt. On failure restore both the exact release pair and its compatible state.
- Keep authoritative task inputs, evidence, external side-effect receipts and
  original deadlines outside the rollback. Reverting derived memory must not
  erase facts or cause an already performed action to be replayed as new work.

The earlier 91-test qualification at `f47982a2e` covered only a small stateless
fixture. The new `ota-opencode-e2e.ts` separately exercises these properties with
actual rebuilt OpenCode binaries, real native Sessions/tools, schema changes and
private-state recovery. Its provider is explicitly scripted: this proves runtime
wiring and recovery, **not Sol intelligence or benchmark improvement**.

## The small invariant

The unit of execution/qualification/rollback is an immutable **pair** `(S, H)`.
The active role determines which **one** artifact the proposer can replace:

```text
active S: (S0, H0) --propose H1--> (S0, H1) --qualify--> boot H
active H: (S0, H1) --propose S1--> (S1, H1) --qualify--> boot S
```

Both source artifacts are read-only in the worker. Its only export is the
inactive artifact. A read-only filesystem boundary enforces this; a prompt is
not an access-control mechanism. Evaluate the entire resulting pair, not H1 or
S1 in isolation. Cold-switch only after a useful handoff and acknowledged stop
of every old worker. Do not splice a new harness into an in-flight tool call.

`ota-rsi.ts` is an **issuer adapter**, not a new normative Kernel. It invokes the
existing `ProContractKernel.transition`. One FULL-synchronous SQLite transaction
persists the Kernel commands, historical attestations, and active boot pointer.
Proposers cannot mount this DB, its artifact store, the external grader, the host
Docker socket or credentials. The trusted application driver is outside both
mutable partitions. Candidate harness code is never imported into the host.

## Switching is not final success

The user clarified on 2026-09-21 that an acceptable **average-pass gain may
authorize switching**; the ultimate objective remains **full pass**. Accordingly:

1. All fixed safety tests (Kernel, isolation, recovery, etc.) must pass completely.
2. Grade the current pair and candidate independently on the same frozen
   development and confirmation assignments. Each task has at least two distinct
   executions. Missing, invalid, duplicated or denominator-mismatched results
   stop the run; they are not a cheap retry or a dropped hard task.
3. A robust full pass means _every assigned execution_ passed every test exactly.
   Preserve the parent's robust full passes and all previously established full
   passes in this protocol; a noisy low parent rerun cannot erase that floor.
4. New full passes have priority over the average margin. Otherwise the default
   margin is **+2 percentage points in each panel** (`minimumMeanGainBps: 200`),
   using exact rational, task-equal means, averaging replicates within each task.
   A panel that was and remains entirely full may tie while another improves.
5. A mean-only accepted candidate can switch. Its `primaryImproved` is **false**.
   `allFull` is a separate, panel-scoped observation, not a universal capability
   claim. Unchanged performance does not authorize continuous mutation.

The 2 pp margin is an explicit initial operating choice, not a significance test;
change it only in a **new** frozen protocol. Cost cannot veto a higher-priority
gain. Complete and incomplete costs are recorded, but cost alone does not cause
OTA switching in this version.

Performance tests carry frozen `(panel, task, replicate, total)` identities.
Safety tests have no performance annotation. `scope: mechanics` is reserved for
offline controller qualification and makes **no RSI quality claim**. Production
profiles must use `scope: performance`, with both panels and replicated tasks.
The supervisor gives proposers only aggregate **development** feedback, not
confirmation scores, hidden assertions or expected outputs. Repeated selection
on a fixed confirmation panel still exposes a selection signal: it is not a
globally unseen holdout and does not establish population-level significance.

## Health, fencing and recovery

A switched release starts as a trial boot. The trusted transport observer must
report a strictly increasing sequence of actual provider/tool progress. Candidate
stdout, a touched heartbeat file, a live PID and the supervisor's own timer do
not count. Startup grace, subsequent heartbeat timeout and probation duration are
fixed in the protocol. A short useful completed operation may finish probation;
it is not kept busy to fill a time allowance. Monitoring continues after probation.

On lost progress or worker failure:

1. Stop and positively fence all owned descendants/containers.
2. Challenge the failed pair's current Kernel standing. Keep its historical
   attestation and execution/accounting evidence.
3. Restore the exact last acknowledged `(S, H)` pair and role, with a new boot
   epoch. Old heartbeat/job messages cannot act on that epoch.
4. Quarantine the failed pair against immediate ping-pong. Keep the interrupted
   job's **original absolute deadline**, including across supervisor restart.

If fencing is uncertain, the fallback has lost support, or no fallback exists,
stop rather than starting a second executor. A restarted supervisor fences first.
An unconfirmed trial can then roll back. Interrupted stable provider/evaluator
work stops for reconciliation; it is not silently replayed and re-billed. There
is no distributed ownership claim. Run one host supervisor under its OS-held
`flock`; SQLite revision checks additionally reject stale mutations.

The explicitly operator-authorized seed is a research bootstrap, **not** a
fabricated performance attestation. Subsequent switches require real gate evidence.
Fallback restores availability; it is not a claim that all candidate gains survived.

## Budgets and accounting

Each proposer admission and each evaluation instance gets an original six-hour
deadline, recorded before work starts. Rollback never renews an admitted job.
There is no cumulative turn/action/request/money cap or large finite sentinel.
Individual control calls, sandbox resources/output, and a 64 GiB disk reserve
are bounded infrastructure guards. Issuer-only settlement has a short atomic
transaction deadline; it does not admit or extend model work.

`ROOT/CANCEL` prevents new admission and interrupts work. SIGINT/SIGTERM/SIGHUP
to the CLI request the same cancellation. Retain rejected candidates, results,
partial execution logs and accounting. Unknown usage is explicitly incomplete,
not zero; native and gateway overlapping cost sources must not be added together.

## Executable pieces

- `packages/core/script/ota-rsi.ts`: durable authority, exact performance gate,
  live binding/epoch checks, Kernel qualification and defeasible rollback.
- `ota-supervisor.ts`: proposer/evaluator lifecycle, content-addressed artifacts,
  original deadlines, progress watchdog, fencing, receipts and cancellation.
- `ota-sandbox.ts`: pinned-image, offline, non-root Docker boundary, no network or
  credential forwarding, bounded output, campaign-owned cleanup.
- `ota-run.ts`: OS-locked CLI for a trusted immutable application profile.
- `ota-fixture.ts`: deterministic **no-model** profile for real-container checks.
  It executes and mutates actual S/H artifacts. It is not a Sol strategy experiment.
- `ota-release.sh`: thin build/fence/checkpoint OS operations. Candidate source and
  build scripts run in non-root, network-none containers; no host source execution.
- `ota-files.py`: bounded single-file export and quiescent state copying, including
  committed SQLite WAL. Files/directories are fsynced; links are never followed by
  the host, and unsupported special files/hardlinks fail closed.
- `ota-supplies.py`: freeze the full source commit, installed workspace dependencies,
  Bun and model metadata for an offline build. No download or candidate execution.
- `ota-native.ts`: start the **selected release binary** in a credential-isolated
  container, communicate through the public native API, observe the external
  gateway's completed requests, and positively stop the runtime and gateway.
- `ota-opencode.ts`: full-release driver for proposer, materialization, independent
  task evaluation and private-state lifecycle. Syntax/patch failures are recorded
  as negative preparation Contracts and stay in the current partition; missing
  infrastructure/evidence still stops rather than inventing performance scores.
- `ota-profile.ts`: production CLI entrypoint loading a frozen operator-owned JSON
  profile, independent grader module and a host-only provider credential.
- `ota-opencode-e2e.ts`: actual OpenCode source mutation → build → native execution
  → external gate → cold switch → successor request, plus failed-migration rollback.

From `packages/core`:

```sh
bun typecheck
OPENCODE_OTA_IMAGE=sha256:<preinstalled-python-image> \
  bun test script/ota-rsi.test.ts script/ota-supervisor.test.ts

# Optional local mechanics demonstration; explicitly cancel it when done.
OPENCODE_OTA_IMAGE=sha256:<preinstalled-python-image> \
  bun script/ota-run.ts /absolute/new-root script/ota-fixture.ts
touch /absolute/new-root/CANCEL
```

Tests cover real S → H → S boots, a candidate that prints fake heartbeats but
hangs, exact rollback with retained attestation, orphan fencing after restart,
read-only active artifacts, missing host/network/socket access, linked-artifact
rejection, stale receipts and epochs, fixed denominators, +2 pp mean-only
switching, full-pass retention/priority, confirmation regression, cancellation
and original-deadline preservation. These are controller properties, not evidence
of model self-improvement.

## Full native E2E

The following is an **offline mechanics qualification**, not a paid model run.
Use new directories; prior artifacts and failed preparation attempts are retained.
From `packages/core`, with an installed dependency tree and a pinned local image:

```sh
python3 -I script/ota-supplies.py \
  /absolute/opencode-repository FULL_COMMIT_SHA \
  /absolute/public-model-metadata.json sha256:IMAGE_ID /absolute/inputs

# Freeze the already qualified deadline-only gateway, not an edited live cohort.
cp /absolute/frozen-ProgramBench/scripts/campaign_provider_gateway.py \
  /absolute/inputs/provider-gateway.py

mkdir /absolute/qualification
bash script/ota-release.sh build /absolute/qualification sha256:IMAGE_ID \
  /absolute/inputs/source.tar /absolute/inputs/dependencies.tar \
  /absolute/inputs/bun /absolute/inputs/models.json \
  /absolute/inputs/empty.patch /absolute/qualification/seed

bun script/ota-opencode-e2e.ts /absolute/qualification/healthy \
  /absolute/inputs/supplies.json /absolute/qualification/seed healthy
bun script/ota-opencode-e2e.ts /absolute/qualification/rollback \
  /absolute/inputs/supplies.json /absolute/qualification/seed rollback
```

The healthy case changes actual context assembly, bash implementation and database
schema, rebuilds OpenCode, runs the new H to produce S, then observes the new S
in the next provider request. The failure case passes fresh-state checks but hangs
after modifying its inherited memory. The external watchdog restores the prior
binary and a fresh copy of the prior sealed memory, then observes the restored
runtime's next real provider request. No reverse database migration is needed.

Memory lineage (`id`, `parent`, exact checkpoint hash) is part of the same durable
Kernel-controlled boot pointer as `(S,H)`, not an independently switched symlink.
Trial state cannot become the rollback source. Bootstrap is explicit; old state
formats are not silently migrated into an ongoing/frozen campaign. Aborted
startup is fenced before rollback, and the original admitted deadline survives.

## Live-experiment boundary

`ota-opencode.driver(...)` accepts a pinned gateway, model/effort, upstream
endpoint, and host-only credential, plus operator-owned task and grading functions.
It runs both controls and candidates through their actual selected binaries in
fresh evaluation namespaces; evaluator memory never becomes proposer memory.
Real-provider usage stays in each host-side gateway ledger. Until independent
cost reconciliation is supplied, monetary usage is explicitly incomplete/null,
not zero and not the evolved runtime's self-reported cost. The scripted fixture
alone records zero real model cost.

An experiment profile uses `scope: performance`, replicated development and
confirmation tasks, the frozen margin and independent grading. `task` supplies
only legitimate task inputs; `grade` must independently recompute outcomes using
safe exported artifacts, never candidate score claims. The provided mechanics
test is not a replacement for ProgramBench and is not evidence of full-pass gains.
No new paid Sol/ProgramBench OTA cohort has been launched by this qualification.

To use the full driver with real provider/task evaluation:

```sh
# Credential is supplied to the host process, never passed as a CLI argument.
OPENCODE_OTA_PROFILE=/absolute/frozen-profile.json \
  bun script/ota-run.ts /absolute/new-campaign script/ota-profile.ts
```

The JSON names hash-bound `supplies`, `harness` (release manifest), `strategy`,
`grader`, and optional transitive `authority` files. `provider` names the pinned
gateway, exact `model`, `effort`, `upstream`, and the host credential's environment
variable name (default `OPENAI_API_KEY`), never its value. `tests` uses the frozen
safety/development/confirmation identities described above. The independent grader
module exports `task(test)` → `{goal, brief, artifact}` and `grade({test,state,run,
harness})` → `{passed,total,valid}`. Use `artifact(...)` for safe exported-file
reads; do not follow guest-created links into the host. Task assets/environment
and the grader's transitive dependencies belong in the operator-owned profile,
not the candidate's proposed source. The mechanics grader is deliberately **not**
automatically substituted for the requested ProgramBench evaluation.

Before model work, qualify matching deadline-only support through configuration,
Contract/Session admission, gateway and accounting, including continuation past
former count limits and termination at the original deadline. The offline Docker
fixture must not be “upgraded” with host networking, host source mounts or raw API
keys. No existing running/frozen cohort is modified or replaced by this work.
