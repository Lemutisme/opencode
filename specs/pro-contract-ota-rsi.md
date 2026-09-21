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

The full implementation must bind **source tree + build inputs + runnable
release/image digest** as H and actually start that release for both generation
and evaluation. Keeping the old OpenCode binary and merely reading a new policy
file does **not** implement this definition. A release manifest may be a small
artifact; the complete source/image closure it names must be verified by the
trusted materializer. The current generic artifact store and offline fixture do
not yet provide that materializer or a full OpenCode build/deployment profile.

### Memory and state are part of the rollout problem

Rolling back code alone is insufficient when H can change memory/storage schemas.
Before enabling full H mutation, the production driver must additionally:

- Fence the old worker and checkpoint its derived memory/workspace state.
- Boot the trial in a private, copy-on-write state namespace. A trial may not
  destructively migrate the fallback's database or files.
- Bind migration/compatibility checks and the checkpoint identity to the boot
  receipt. On failure restore both the exact release pair and its compatible state.
- Keep authoritative task inputs, evidence, external side-effect receipts and
  original deadlines outside the rollback. Reverting derived memory must not
  erase facts or cause an already performed action to be replayed as new work.

These full-release and persistent-memory properties are **not covered by the
91-test offline qualification at `f47982a2e`**. That qualification proves the
controller's pair switch, health fencing and exact artifact rollback with a small
stateless fixture. It must not be reported as full OpenCode harness RSI.

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

## Remaining live-experiment boundary

The generic `Driver` is trusted application wiring. A **production Sol profile
is not included yet**. It must build and execute the complete mutable OpenCode
release inside the credential-isolated worker boundary, keep the
grader/gateway/admission/Kernel outside that code, pin the external trusted
closure (not the evolvable worker binary), implement the memory/checkpoint
boundary above, and report real host-observed progress and native accounting.
`evaluate` must independently recompute
scores rather than accepting a candidate-written report. An exit code or hash
alone does not authenticate a model's claim.

Before model work, qualify matching deadline-only support through configuration,
Contract/Session admission, gateway and accounting, including continuation past
former count limits and termination at the original deadline. The offline Docker
fixture must not be “upgraded” with host networking, host source mounts or raw API
keys. No existing running/frozen cohort is modified or replaced by this work.
