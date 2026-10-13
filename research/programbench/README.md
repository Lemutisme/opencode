# Frozen ProgramBench cohort control

`cohort.py` is copied byte-for-byte to a **new** cohort's `launch.py`; it never
repairs or resumes a historical cohort. Production entry is `python3 launch.py`
(or `python3 cohort.py /absolute/cohort-root`). It verifies qualification and all
frozen hashes before exclusive creation of `LAUNCH.json`.

The production protocol is nine instances, two fixed repeats, three concurrent
originals, and an absolute six-hour allowance per original. All provider/tool/
request/money count fields must explicitly be `null`. Repeat two waits for all
of repeat one. No endpoint is retried, substituted with zero, or removed.

## Ownership and cancellation

A frozen 32-hex `cohortToken` names each allocation's separate systemd scope.
The controller writes `runs/ID/ADMISSION.json` before spawning and exports
`PROCONTRACT_COHORT_TOKEN`, `PROCONTRACT_ALLOCATION_ID`, and
`PROCONTRACT_ADMISSION_ID`; `run-one.ts` retains positional `ID deadline-ms`.
The independent native admission record remains `ADMITTED.json`.

A signal only sets an in-process flag. The loop checks flags and `CANCEL` before
every admission and again after preflight. Cancellation is exclusive-create;
the first request's timestamp and graceful end never reset. Status is
`cancelling`, not `running`. After bounded graceful cleanup, only each owned
scope receives SIGKILL; every command and final observation is bounded.

Before signaling, scope ownership requires its token-bearing name, unchanged
durable admission, matching description, and exact InvocationID/cgroup. A
transient startup scope without identity can only be waited on boundedly,
not signaled. Unknown ownership is retained as unresolved; there is no broad
PID search, global Docker kill, shared cgroup kill, or unbounded Popen wait.
The controller and systemd RuntimeMaxSec enforce the original deadline
independently of solver/native cooperation. Cleanup grace never changes the
admitted deadline or authorizes new model/tool work.

## Terminal evidence

`ENDPOINT.json` binds the exact assignment/admission, instance, original
deadline, profile/task hashes, artifact hashes, and native/official cleanup.
Artifacts must be canonical regular files inside that allocation's root.
A host-owned `CLASSIFICATION.json` supplies explicit predicates and source
links. Scores alone are not endpoint or cleanup evidence.

Only `scored` and safely classified `invalid-official-score` endpoints settle an
original. The latter remains unknown but does not cancel independent siblings.
Missing/changed evidence, generic execution faults, or unknown cleanup fail
closed and cancel the cohort. Killing a scope does not invent native or official
cleanup acknowledgement. `CONTROLLER-CLEANUP.json` retains both facts separately.

`executionComplete` means all 18 originals safely settled. `scoresComplete`
and legacy `complete` mean all 18 have valid scores. Unknown scores produce
`complete-with-unknown`, not a numerical result or a promotion.

## Zero-model qualification

Run from this directory:

```sh
python3 -m unittest discover -s . -p 'test_cohort.py' -v
PROGRAMBENCH_SYSTEMD_QUALIFY=1 \
  PROGRAMBENCH_QUALIFICATION_ROOT=/tmp/new-unique-controller-qualification \
  python3 -m unittest discover -s . -p 'test_cohort_systemd.py' -v
PROGRAMBENCH_ENDPOINT_QUALIFY=1 \
  PROGRAMBENCH_QUALIFICATION_ROOT=/tmp/new-unique-endpoint-qualification \
  python3 -m unittest discover -s . -p 'test_endpoint_schema.py' -v
```

Local tests inject an explicit process backend and launch real subprocesses,
including TERM-ignoring children; they do not fake Popen. The opt-in production
backend test binds real systemd scopes, verifies bounded SIGKILL and no survivor,
and proves an unrelated live control scope was untouched. A separate scope
expires solely through systemd, without controller signals. The schema test runs
the actual TypeScript classifier and Python consumer, with and without candidate
executions and local safety verification. These are execution qualifications, **not model or benchmark results**.

## Receipt layout and read-only diagnosis

The frozen ProgramBench bridge records operations as UUID-named JSON receipts.
For `run -d` it also retains the matching `.stdout` file containing the created
container ID. A directory-wide JSON-only assumption is incorrect. The endpoint
parser validates receipt/companion pairs, ownership, timestamps, content hashes,
completion and return codes; it rejects unknown entries, orphan companions and
the `.tar` files that the bridge removes before a successful copy completes.

`Endpoint.finish` is the live publisher. It always uses the current cancellation
markers and clock. `Endpoint.inspect` never writes an endpoint; an explicit
historical observation is diagnostic only and has no admission envelope.

From this package directory, a stopped cohort can be diagnosed without copying,
retiming or rewriting its artifacts:

```sh
bun replay.ts /absolute/stopped-cohort /absolute/new-audit-directory
```

The output must be new and outside the cohort. Replay hashes the entire original
tree before and after, checks frozen sources and recorded receipt hashes, and
retains the original classification separately from the diagnostic result.
Reading may update access times; bytes, inode identities and other recorded
metadata must remain unchanged. A diagnostic score is not a repaired result,
new grading, task resumption, or preregistered benchmark evidence.

`bun test` runs endpoint and replay unit tests. The actual-cohort regression is
opt-in with `PROCONTRACT_RECEIPT_REPLAY_ROOT` and
`PROCONTRACT_RECEIPT_REPLAY_OUTPUT` (a new directory). A passing offline replay
does not mean a new live model/grader cohort has been run or admitted.

## Repaired execution protocol (new cohorts only)

See [execution repair](../../specs/pro-contract-execution-repair.md). Preparation
now freezes a host-only `credential.py` gate and explicit no-retry provider-refusal
policy. Credential metadata must cover the full worst-case schedule, without a
finite monetary cap, and never enters worker mounts or raw artifacts.

A positively witnessed provider policy refusal may be a terminal UNKNOWN only
under `endpointPolicy.witnessedProviderRefusal =
"unknown-and-continue-independent-assignments"` and `retry: false`. The receipt
must link the authenticated gateway journal, complete request accounting, all
native PID/birth fences and an explicit never-admitted verifier inventory.
Unknown scores are not zeros and prevent fixed-repeat promotion. All other
execution/identity/cleanup uncertainty still fails closed. No refused allocation
is replayed, and neither historical paired cohort adopts this new policy.

Future freezing additionally requires `qualification/execution-repair/RESULT.json`
and `reports/credential-tests.log` (three pure gate tests). The former comes from
`packages/sdk/script/pro-contract-repair-qualify.ts` using the frozen runtime:
NUL startup recovery, SSE/JSON refusal, authentication and malformed-frame cases.
The native fixtures and credential metadata query make no real model calls.
