# Native V2 delivery closure

Evaluated source: `bc8af809281c7fe3bec0ce127258c3679d1233de`, based on upstream
`74dbc509d74df46a2523676dd4068225c4f0c9b0` (2.0.20). Container qualification and
the three-instance regression completed on 2026-09-30. This changes neither
historical cohorts nor Kernel/RSI admission rules.

## Mechanism

The previous bridge synthesized `report-ready` from Session stop. The revised
bridge requires explicit public-evidence handoff through `contract_delivery`:

| Action    | Effect                                                                                                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe`   | Retain the pinned reference observation; compare candidate exit, stdout, stderr and selected output-file bytes in separately reset fixtures. Supports text/base64 inputs and `{{case}}` paths. |
| `handoff` | Rebuild, run the self-validator and replay **every retained probe**. Mismatches or source changes prevent handoff; changes after handoff reopen it.                                            |
| `status`  | Report delivery readiness, not authoritative correctness.                                                                                                                                      |
| `blocked` | Record a concrete unresolved reason rather than claim completion.                                                                                                                              |

If the Session stops while delivery is open, the native bridge admits a new durable inbox
item in the same allocation. There is no alternative model/tool loop or deadline
reset. Ready/blocked end normal execution; cancellation, expiry or faults also
stop it. The host then
fences the worker and independently verifies the exact archived submission;
only the issuer can attest, and hidden grading results never return to the solver.

`delivery.jsonl` is worker execution evidence, **not a trusted issuer ledger**.
The guarantee covers registered counterexamples, not complete specification
coverage; raw shell observations are not automatically registered. No probe
removal, oracle overwrite, self-attestation or strategy promotion is exposed.
See the [overview](./pro-contract-v2.md) for deployment and RSI limits.

## Frozen execution profile

- Explicit `--rg`: copied, hashed, smoke-tested and mounted read-only on PATH.
  The host gateway admits the five leaf tools and `contract_delivery` explicitly.
- Candidate effects serialize with closure checks. Source snapshots reject
  escaping symlinks; reference probes use immutable `/workspace/executable`.
- Six-hour original deadline; no cumulative request, action or cost limit.
  Individual operations/provider requests remain bounded at 600/900 seconds,
  with cancellation, process-group cleanup and an 8 MiB stdout/stderr guard.
- Every physical model request checks model/effort, peer identity, active Kernel
  standing and the original deadline; tools also check standing.
- Host-only credentials/Kernel, network-none workers and fenced replacement.
  No implicit crash recovery or frozen-source/configuration edits.

## Qualification

Recorded on the evaluated source:

- 15 local native/delivery tests; 13 delivery tests inside the cleanroom.
- 137 Core/Kernel/OTA regressions, including containment; 173 affected AI tests;
  eight Python admission/aggregation tests; lint and 35 package typechecks passed.
- Actual container profile: 1,009 protocol requests, 1,007 tool calls, two durable
  admissions and zero tool failures; separately labeled 3,001 synthetic prior rows.
- Original-deadline and explicit-cancellation fixtures fenced workers about
  1.46 and 1.39 seconds later. The frozen runtime snapshot also passed qualification.

Failed qualification attempts remain in the artifact directory: the new tool was
initially missing from the gateway allowlist, then fixed before model calls;
synthetic test executables were moved from noexec `/tmp` to the production-equivalent
`/candidate` mount without relaxing `/tmp` protection.

From `packages/sdk`, run `bun test script/contract-delivery.test.ts
script/contract-profile.test.ts` and `bun typecheck`. Run Python checks with the
pinned ProgramBench environment and `PYTHONPATH="$RUNNER/src"`. Before a new cohort,
qualify the actual container profile with `--fixture --fixture-steps 1002`, plus
separate expiry (`--fixture-expiry 4`) and cancellation checks. Scripted tests
are mechanism evidence, not model performance.

## Regression results — 2026-09-30

Each instance received one `gpt-5.6-luna/max` allocation, with no baseline or rerun.
Official active/ignored metadata determines the denominators.

| Instance                       | Previous single run | Delivery-closure run |
| ------------------------------ | ------------------- | -------------------- |
| `altdesktop__i3-style.f93821b` | 484/539 (89.80%)    | 463/539 (85.90%)     |
| `cheat__cheat.b8098dc`         | 251/297 (84.51%)    | 197/297 (66.33%)     |
| `sharkdp__hexyl.2e26437`       | 841/906 (92.83%)    | 834/906 (92.05%)     |

All three official scores are valid, but none is a full task pass: each Kernel
ended `escalated`, `quiet=false`, and each worker was fenced. All three scores
are lower than the [previous singles](./pro-contract-v2-sync.md); this is not
performance-improvement or RSI-promotion evidence. Both runtime and sampled
trajectory changed, so the difference is not causal attribution. Prior failure
categories were inspected: these are repair regressions, **not fresh confirmation**.

Exact protocol, source/dependency manifest, qualification logs, per-task trajectories,
archives, official results, accounting and Kernel receipts remain private under:
`/home/duozhou/run-artifacts/procontract-v2-closure-20260930/`.
Consult `PROTOCOL.json`, `RUNNING.json` (commands), `FINAL_SUMMARY.json` and each
`trial-*/RESULT.json`, `TERMINAL.json`, `FENCED.json`. Do not rerun a historical
cohort or replace valid negatives; separately freeze any future experiment.
