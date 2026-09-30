# Native V2 delivery closure

Status: implementation and local qualification; **not yet container-qualified or
ProgramBench re-evaluated**. This follows the three-instance trajectory audit of
`69bd038fc6565720021b7e57ce73666f8c0c60f5` (tested runtime `d7ec9728f6`). It does
not change those frozen runs, the normative Kernel, or RSI promotion rules.

## Repair the boundary, not the benchmark answers

The previous bridge synthesized `report-ready` from a stopped Session. Its
independent verifier correctly rejected incomplete candidates, but public
counterexamples did not constrain subsequent handoff. Also every recorded
`glob`/`grep` attempt failed in the offline profile.

The revised bridge has one extra execution-evidence tool, `contract_delivery`:

- `probe` runs the host-pinned reference and the candidate on the same public
  input, in separately reset fixtures at a stable per-probe path. It retains the
  original reference observation, candidate observations, and mismatch results.
  Exit status, stdout, stderr and requested output-file bytes are compared;
  nonzero CLI exits may be correct behavior. Text and base64 binary fixtures
  are supported. `{{case}}` expands in textual inputs and environment values.
- `handoff` rebuilds, runs the self-validator, and replays **every** retained
  probe. A passing self-validator cannot erase a counterexample. The source
  tree is bound before validation and after replay; modification during checks
  or after handoff reopens delivery. Out-of-tree source symlinks cannot supply
  unbound code. The ordinary reference symlink is excluded, but probes always
  invoke the immutable `/workspace/executable`, not that mutable symlink.
- `status` reports execution readiness. `blocked` records an explicit unresolved
  reason. There is no delete-probe, overwrite-oracle, self-attest or promote action.
- Candidate tool effects and closure operations serialize. Probe/validator child
  processes have bounded operations, cancellation, process-group cleanup and
  the original absolute deadline. stdout/stderr have an 8 MiB per-operation
  infrastructure guard, not a cumulative action or monetary budget.

After the native Session becomes idle, an open delivery results in a **new
durable Session inbox admission** in the same allocation. There is no
alternative model/tool loop, cumulative iteration cap, or deadline reset.
Ready and blocked dispositions stop this scheduling loop. The host no longer
manufactures readiness from `stop`; it requires explicit handoff and preserves
its summary. The host then fences the worker, archives the candidate, and runs
independent preflight and sealed official evaluation as before. Only the issuer
can attest on the exact archived subject. No hidden scoring result is returned
to the candidate.

`delivery.jsonl` is append-only execution evidence maintained by the worker,
**not a trusted institutional ledger**. It is not sufficient for Kernel
attestation. Implicit process-restart recovery remains refused. The retained
corpus does not establish complete specification coverage, and observations
made through raw shell are not automatically converted into probes. This repair
prevents forgetting **registered** counterexamples; it does not prove every
possible behavior was registered. Those limitations belong in handoff summaries
and in any performance interpretation.

The runner now requires an explicit `--rg` executable. It copies and hashes it,
performs offline search smoke checks, and mounts it read-only on worker PATH.
The scripted container fixture executes and checks all five native leaf tools,
not just shell; it also verifies durable continuation after a premature stop.
These checks must pass in the actual cleanroom before a model cohort is admitted.

## Local qualification

From `packages/sdk`, using pinned Bun 1.4.2 and temporary HOME/XDG directories:

```sh
bun test script/contract-delivery.test.ts script/contract-profile.test.ts
bun typecheck
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$RUNNER/src" \
  "$RUNNER/.venv/bin/python" script/native_programbench_test.py
```

The native tests use scripted provider responses but the actual V2 SDK, inbox,
runner, plugin, leaf tools, filesystem, reference/candidate processes, and SQLite.
They verify premature-stop continuation, rejected handoff followed by repair,
all five leaf tools, binary evidence, cancellation and original-deadline expiry,
source binding, and continuation after **1002 preceding native steps**. They are
mechanism tests, not real-model scores or Docker containment evidence.

From `packages/core`, run the Kernel/strategy/OTA regression suite documented in
`pro-contract-v2.md`. Without a usable Docker environment and explicit fixture
image the six containment tests skip; never report them as passed.
Run the full repository `bun run check` as well. No public Protocol/HttpApi was
changed, so generated clients are unchanged.

### Recorded local checks — 2026-09-30

- New delivery/native integration tests: **15 passed**, 0 failed. The long
  scripted native case executed 1012 logical steps across two durable admissions.
- Existing Kernel/strategy/OTA suite: **119 passed, 6 skipped**, 0 failed.
  The six skipped checks require Docker and were not treated as qualified.
- Python official-scope/handoff/offline-rg tests: **7 passed**.
- `bun run check`: lint and all **35** package typechecks passed.
- `ruff check` and `git diff --check`: passed.

No model request or official task scoring was run during these local checks.

## Re-evaluation protocol: not admitted yet

A separately frozen repair-regression cohort is authorized by the user's request
to fix and re-evaluate. Before any model request, bind the final source/dependency
manifest, Bun/Python/rg bytes, runner revision, image digests, task metadata and
official blob/wheelhouse digests, and successful qualification artifacts.

- Model: `gpt-5.6-luna`, effort `max`.
- One allocation each: `altdesktop__i3-style.f93821b`, `cheat__cheat.b8098dc`,
  `sharkdp__hexyl.2e26437`.
- Each original deadline is six hours. No cumulative request, step, tool or cost
  limit; no finite sentinel. Provider request and individual operation bounds
  remain 900 and 600 seconds. Completion need not consume the full deadline.
- No task-specific answer patches or hidden-test feedback. No model re-runs or
  best-of selection; retain failures, blocked allocations and infrastructure
  diagnostics. Historical results remain unchanged.
- The previous audit inspected failure categories. Reusing these instances is
  **development/repair regression, not fresh confirmation**. There is no baseline,
  causal superiority claim, or RSI promotion from this three-single-run cohort.
- RSI qualification still requires separately frozen development/confirmation
  comparisons, task-Pareto and full-pass protections; this change does not run
  that campaign or enable mutable native H deployment.

First run the container-only scripted profile with `--fixture --fixture-steps
1002`, then a separate expiry fixture (for example `--fixture-steps 1002
--fixture-expiry 3`; that count only drives the fixture past its deadline, not a
production budget). Verify request admission beyond former ceilings, all leaf
tools, the new durable prompt, cancellation/fencing, and no admission past the
original deadline. Preserve failed qualification attempts too.

Common runner arguments, from the SDK directory:

```sh
"$RUNNER/.venv/bin/python" script/native-programbench.py \
  --root "$NEW_EMPTY_TRIAL" --runtime "$FROZEN_RUNTIME" \
  --bun "$FROZEN_BUN" --rg "$FROZEN_RG" \
  --runner "$RUNNER" --python "$RUNNER/.venv/bin/python" \
  --wheelhouse "$FROZEN_WHEELHOUSE" --blobs "$FROZEN_BLOBS" \
  --instance "$INSTANCE" --model gpt-5.6-luna
```

Append fixture flags for qualification. Do not launch the three model commands
until the complete revised profile has passed in the isolated containers. Store
new results outside all historical cohort directories. Compare all three scores
and observable trajectories (retained probes, failed/successful handoffs,
continuations, unresolved dispositions, tools and accounting), not just scores.

The repair session cannot access `/var/run/docker.sock` (permission denied).
Thus no new ProgramBench score or full native containment qualification is
claimed here. Run the pending qualification and cohort in an environment with
legitimate access to the required sandbox; never fall back to an unsandboxed
solver or credential-sharing workaround.
