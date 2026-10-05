# ProContract: bounded context, isolated work, and execution-policy verification

2026-09-22. This is a new runtime/policy treatment. Cancelled cohorts, their
budgets and their outcomes are retained. No paid benchmark was restarted.

## Roots of the failures

1. Compaction estimated serialized base64 as language tokens. Summaries then
   discarded visual bytes, inducing repeated reads. A 4096-token summary ceiling
   starved max-reasoning requests. The history splitter also duplicated the
   prefix of a split entry.
2. Selecting media *after* loading/decoding the complete history was too late:
   the strengthened 40-image stress fixture killed the supervisor even after
   request deduplication. Prompt history must be bounded while it is loaded.
3. OOM priority is not isolation. The kernel killed an expendable worker, then
   killed opencode before those pages had been reclaimed. Independent memory
   leaves under the original total limit are required.
4. Execution policy had no durable, executable evidence/routing state. A final
   readiness claim could bypass publicly observable failures or reuse checks
   from an older candidate. Conversely, freezing an erroneous model-authored
   checker forever would prevent legitimate strategy improvement.
5. Benchmark setup required creating/committing a task-local Git repository.
   This failed in protected non-root task directories and unnecessarily changed
   task inputs. Snapshot bookkeeping belongs in private harness storage.
6. Final source-delta review caught a repair-merge regression: copying the older
   workspace snapshot implementation had dropped the frozen runtime's owned
   object stores and durable references. Six frozen snapshot regressions failed.
   The final implementation merges private non-Git support with those retained
   protections; source deletion/recreation, legacy stores and failed publication
   are tested together, not only in separate workspace suites.

## Context selection and compaction

`session/context-budget.ts` treats typed media separately from text. It uses a
conservative per-media scheduling allowance, not encoded byte length or a claim
of exact provider tokenization. Actual provider overflow remains authoritative.
An independent 32 MiB inline-media request bound protects transport/RAM.
Exact-byte duplicates retain their most recent representation; equal remote URLs
are not assumed to contain equal bytes. Omissions carry explicit references,
never fabricated visual observations.

`SessionHistory.entriesForRunner` fetches row identities first, then decodes
newest-first one message at a time, removing duplicate media and duplicate legacy
`structured.content` blobs before collecting the prompt view. It never rewrites
durable history. Full exports and user-facing history retain original evidence.
Opt-in Bun GC checkpoints reclaim discarded blobs within the supervisor budget.

Compaction inherits the selected model/request output allowance instead of an
unrelated 4096 ceiling, preserves the original deadline, and retains diagnostic
evidence. Failed automatic summaries fall back to explicitly labelled verbatim
excerpts; partial generated claims are not promoted into facts. Failure during
actual provider-overflow recovery still propagates the original failure. No
count ceiling, new task attempt, or reset deadline is introduced.

## Resource separation

`benchmark_cgroup.py` creates a dedicated parent slice with the task's original
CPU and RAM limits. The native supervisor and task/tool processes occupy sibling
memory cgroups. The reserve is `min(1 GiB, total / 2)`; the worker leaf gets the
remainder. Thus a 4 GiB task remains 4 GiB total: 1 GiB supervisor + 3 GiB work.
This is an explicit allocation inside the budget, not extra agent memory.

A small trusted broker moves a shell into its leaf before arbitrary work starts.
It admits the supervisor once with a token, admits only its verified descendants
as tools, and checks process identities. It exposes no arbitrary PID or resource
setting API. The broker is network-none, read-only, has no Docker socket, and
mounts only the dedicated task slice and its channel/control directories. It
uses host PID/cgroup namespaces and DAC_OVERRIDE for this administrative role;
the **task** receives none of these privileges or mounts. Provider credentials
remain on the host. Cleanup is scoped to this task's resource group.
The broker itself is host harness infrastructure, separately bounded at 128 MiB
and 0.25 CPU; it does not execute solver work. The unchanged task-sized total
above is the supervisor plus task/tool processes, not a claim of zero host
orchestration overhead.

The existing OOM priority remains secondary. It is not the claimed safety
boundary. Unsupported cgroup environments fail closed rather than silently
falling back to priority-only protection. This does not promise immunity from
arbitrary bugs inside the supervisor's own finite allocation.

## Strategy stays outside the normative kernel

Opt-in flag: `OPENCODE_STRATEGY_PORTFOLIO=1`.

- `strategy_plan`: task-quoted criteria and bounded executable public checks.
  Plans are stored outside the candidate directory, bound to Session/spec hash.
- `strategy_verify`: executes the canonical Bash tool under its existing
  permissions, resource broker and shared action/deadline accounting. Records
  actual outcomes and selects bootstrap, specification probing, differential
  testing, roundtrip validation, business audit, resource-safe work or
  counterexample review.
- `strategy_status`: restores durable state after compaction.
- Check-method revisions require a rationale, retain original requirement
  quotations and previous failed observations, and invalidate prior readiness.
  Criteria cannot simply be removed to evade a failure.
- The tool-level readiness gate requires a passing complete check batch on the
  unchanged snapshot. Failed/incomplete checks, changes during verification and
  stale candidate hashes cannot produce a handoff. Contract goal, acceptance
  claim, budget and semantic attempt are unchanged.

This is an executable policy gate, not a semantic oracle: check quality and
coverage still require good strategy. A model-authored test passing is not an
issuer attestation. Official final grading stays sealed and alone settles the
benchmark obligation. No cross-task learned-strategy promotion is implemented.

## Private snapshots and permissions

`OPENCODE_PRIVATE_SNAPSHOTS=1` enables private snapshot storage for non-Git
Locations, scoped to the actual Location rather than the global project root.
The adapter no longer initializes/commits task Git state, changes ownership, or
relaxes task permissions. Supervisor HOME is private; tool HOME/environment is
still the task's original environment.

Intentionally unreadable, untracked assets can be excluded only when owned by a
different UID and located in a non-writable parent, so the agent cannot replace
them. Their environment identity remains in the harness records. Forced inclusion
still fails on unreadable files. Mutable candidates are not silently excluded by
this permission exception. The prior snapshot large-untracked-file policy remains
separate; public checks do not claim to bind all external business state.

Snapshot stores own the captured Git object closure rather than borrowing the
source repository indefinitely. Creation is published only after retention;
durable references bind each capture to its original Location/store. Deleting or
recreating the task repository cannot redirect an existing captured subject.

## VPP verifier environment diagnosis

The unmodified `vpp-loss-divergence` reference preflight started roughly
316 and 311 native threads in its two ranks despite a 2 CPU Docker quota and
stalled for more than fourteen minutes. A separate diagnostic task copy limits
OMP/MKL/OpenBLAS/NumExpr/VecLib pools to two threads in both Dockerfiles. It
passed all five official checks: reference execution took about 26 seconds and
verification 115 seconds, within the unchanged 900-second verifier budget and
the same 2 CPUs / 8 GiB. Agent timeout remains 28,800 seconds.

This is a disclosed local environment variant, not an unmodified official task
score. `reports/VPP-THREADS.patch` contains the complete difference. The canonical
dataset and old candidates remain unchanged. A new cohort must explicitly freeze
its environment treatment before using this correction; never silently patch a
running task or relabel this oracle qualification as model performance.

## Validation and scope

Artifacts: `/home/duozhou/run-artifacts/procontract-fundamental-repair-20260922/`.

- Actual native stress: 40 large-image reads, no auxiliary compaction loop,
  repeated tool OOM, failed/stale submission rejection, check-method revision
  with retained failures, same Session/attempt/deadline, then final discharge.
- Official Coq and sidecar reference engineering fixtures reach reward 1 and
  discharge. Protected non-root benchmark environments are separately checked.
- One real Luna max public development smoke completed in about 72 seconds and
  9 provider requests. It revised an erroneous checker without deleting its
  requirement and passed independent final checks. It is not a benchmark score.
- Tests that exposed MIME assumptions and the too-late history bound remain in
  the artifacts as failed qualifications, not overwritten successes.

The final binary is `2955a6dace7496f77c442496a370d45f484edea0147c7370cd66688288a22561`.
The isolated runtime passes 219 Core regressions, including 11 combined snapshot
tests, and Core/LLM/OpenCode package typechecks. The earlier intermediate binary
and failed qualifications are retained. Exact case/version correspondence is in
`VALIDATION.json`, with the source delta against the preceding frozen runtime in
`reports/SOURCE.patch`. No monorepo-wide clean typecheck is claimed: the unrelated
`packages/core/script/strategy-kernel.ts:125` deadline-only Spec typing issue
remains separate from these repairs.
