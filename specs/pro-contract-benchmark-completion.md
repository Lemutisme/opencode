# Benchmark completion wiring repair

Date: 2026-09-21. All model evaluations in this thread remain cancelled. This is
an execution-adapter repair and a no-model regression test, not a performance
promotion or permission to restart a cohort.

## What actually ran

The TB4 binary identifies itself as `0.0.0-procontract-fenced-20260920` with
SHA-256 `7c35b24f361bfa3404bc5e45e9fa9ebe3dfd252a10af3a367ca2ff95a55cd2ca`.
The preserved source snapshot is
`/home/duozhou/run-artifacts/procontract-fair-tau-terminal-20260920/vendor/native-fenced`.
It is a source snapshot without `.git`, not a clean checkout that can honestly be
identified by a HEAD commit alone. The current workspace is the dirty
`contract-policy-split` tree at `3108ea519`; it is not byte-identical to that
snapshot. Exact file comparisons are retained in `reports/VERSION-AUDIT.json`
under the repair artifact root below.

The binary already has same-Session repair after unsuccessful replay. The
benchmark adapter never supplied a replay policy and instead issued the claim
“candidate ready for independent benchmark evaluation.” It stopped generation
at `verification`, then ran the external grader without settling the native
obligation. The nineteen inspected zero-score cases all ended this way, rather
than reaching the eight-hour deadline. This did not demonstrate an adaptive
strategy portfolio, and the version label did not establish “strongest strategy.”

## Repair

`packages/opencode/script/benchmark-contract.ts` provides a host-only boundary:

1. Admission requires an issuer-owned verification manifest bound to the exact
   instruction. Version 1 declares executable **public** replay and rejects
   empty checks. Version 2 explicitly declares **external-only**, sealed final
   evaluation and forbids replay. Lack of public tests is not a missing official
   evaluator and must not force an invented or vacuous public check.
2. The final evaluator identity is frozen in the manifest and acceptance claim.
   The claim concerns that evaluator accepting the exact candidate for the task,
   not merely producing something to submit. A later caller cannot substitute a
   different/easier evaluator under the same claim.
3. `executionPolicy` stays outside the immutable brief and goal. Changing the
   strategy does not silently change the acceptance terms or original budget.
4. `verification` means **evaluate**, not **complete**. Only `discharged` means
   complete. Failed public replay uses the existing native tool feedback path,
   retaining the Session, semantic attempt and deadline.
5. A final passing report requests issuer attestation. A final negative report
   becomes a **sealed** challenge; it does not give hidden-test details to the
   solver or automatically create another attempt. Unavailable evaluation leaves
   the obligation pending, not accepted and not fabricated as a model failure.

`packages/opencode/script/benchmark_completion.py` connects this boundary to the
actual native adapter. `bind(NativeOpenCode)` intercepts admission before the
first model call, checks the host manifest hash and installs the selected mode.
`settle(...)` requires the matching host-owned generation/stop receipts, verifies
that the solver/gateway identities are no longer alive, binds evaluator/report/
artifact/subject identities, and applies the final transition through the native
API. It never edits SQLite or fabricates a kernel result.

`settle_offline(...)` restores only the retained native state in a network-none,
read-only administrative container after the solver environment is destroyed.
It mounts no task, provider socket or real credential. It follows the retained
state UID/GID because Harbor changes bind-mount ownership during teardown; it
does not reopen generation or change the original task deadline. A separate
Harbor fixture exercised the repaired admission, public replay, MCP/skills,
main/sidecar collection, fresh verifier and actual final discharge end to end.

The legacy attestation endpoint is not a compare-and-swap API. The host must keep
its single-writer generation seal through settlement. The bridge rejects a stale
revision, specification or handoff and serializes settlement for a run. This is
not a new clustered ownership guarantee or an adversarial same-UID sandbox.

## Regression coverage

Run the boundary tests from the package directory:

```sh
cd packages/opencode
bun test script/benchmark-contract.test.ts
bun typecheck
cd script
python3 -m unittest benchmark_manifest_test.py
```

The deterministic integration driver is:

```text
/home/duozhou/run-artifacts/procontract-completion-repair-20260921/qualification/completion_e2e.py
```

It uses the real frozen binary, actual Docker filesystem and native replay, a
local scripted Responses provider, and an offline administrative API for final
settlement. In each case, a wrong calculator confidently reports ready; the
issuer-frozen public check rejects it while the Contract remains active. The
same Session repairs it and hands off without resetting the original deadline or
`maxAttempts: 1`. An independent final check then exercises:

- acceptance → `discharged`;
- a candidate that only overfits the public case → sealed `escalated`;
- unavailable final verification → still `verification`, not success.

No hidden final case or report is returned to the scripted solver. These are
mechanism tests with zero paid model calls, not claims of better model reasoning.
Earlier fixture failures remain in the artifact root; they are not overwritten.

## Required work before another benchmark launch

This repair does **not** invent a sound semantic verifier from natural language.
TB4 already supplies the final tests, oracle and artifact collection configuration
for all 63 CPU tasks. `benchmark_manifest.py` binds the official task inputs,
separate evaluator and collection plan on the host. It does not expose test or
oracle contents. The runner uses Harbor's actual delivered instruction (including
its canary removal), rather than duplicating the normalization. MCP/skill context
stays in execution policy, outside the immutable task instruction. Input identity
is checked again at generation closure and before settlement.

Dynamic sidecar state and outputs outside the Location use the **official**
Harbor artifact plan, not a newly invented workspace-only snapshot. Image recipes
are bound by the manifest; resolved runtime image identities must also be retained
in environment receipts. A source hash alone does not pin remote dependencies.

The first wired repair runner is retained at
`/home/duozhou/run-artifacts/procontract-completion-repair-20260921/terminal_run_uid_v2.py`.
It required explicit public manifests; that over-restrictive gate is superseded
by the new runner at
`/home/duozhou/run-artifacts/procontract-completion-e2e-20260921/terminal_run_uid_v2.py`.
The new runner automatically binds the official sealed evaluator. Explicit public
replay remains available with `--public-manifest` and its SHA256. It records the
raw official result separately from `COMPLETION.json` and the settlement receipt.

Before restarting TB4, qualify actual native handoff, official artifact collection,
fresh verification and kernel settlement on real tasks, and validate the real
scoring environments with official reference scripts. Reference-answer injection
is permitted only in explicitly labelled engineering fixtures with a local
scripted provider, never a paid-model or performance run. SWE requires its own
adapter qualification; a successful TB4 test does not qualify SWE.
Do not mutate or resume the cancelled historical
cohorts. Do not feed official held-out failures back into the candidate being
scored, and do not restore the previously rolled-back quality-loop treatment by
accident. Adaptive strategy selection/learning remains a separate implementation
and controlled comparison, not a feature established by this repair.

Initial artifact root:
`/home/duozhou/run-artifacts/procontract-completion-repair-20260921/`.

Real-task engineering qualification root:
`/home/duozhou/run-artifacts/procontract-completion-e2e-20260921/`.
