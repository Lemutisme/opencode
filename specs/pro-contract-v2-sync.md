# Upstream V2 sync and three-instance regression — 2026-09-29

## Tested source

At the user's request, `procontract-v2` was rebased onto the then-current
upstream `v2` commit `bc5ff1cfd993c9ce28f471476acca4440e021f61`. The migration
implementation tested here is commit
`d7ec9728f6bf8d17b3157a3ab92a7baee815384c`. It includes the official-test
aggregation fix discovered by the earlier single-instance pilot.

The runtime and dependencies were copied into an independent read-only snapshot
before model execution. All three slots used those same bytes. Report-only
publication commits do not change the tested runtime.

Upstream advanced during testing (the later check observed `135995d4fc`). Those
additional database/OAuth changes were **not** silently incorporated after the
model runs. This branch publishes the tested sync point, not a claim that a
moving upstream HEAD was tested retroactively.

## Frozen test plan

- `gpt-5.6-luna`, reasoning `max`, three predetermined instances, one allocation
  each, local concurrency three, no extra baseline.
- Each instance had its own original six-hour deadline. No cumulative request,
  tool-action or monetary cap; completed work stopped before the ceiling.
- Same restricted native SDK profile: `glob`, `grep`, `patch`, `read`, `shell`.
  Code Mode, subagents, movement, background shell mode and implicit crash
  recovery remained disabled. This is not mutable-H RSI deployment qualification.
- Kernel, provider credentials, process-identity gateway and official grader
  stayed on the host. Workers had network-none, read-only runtime, no host
  ledger or Docker socket. The gateway checked live standing and exact model,
  effort, PID identity and deadline for every physical request.
- Worker stop preceded fixed candidate packaging and independent verification.
  Official active/ignored metadata and completeness checks were used from the
  start. No model or official test rerun was performed.

Commitment: `C-fedcd5ce9714baad800ee83dd63b30c9`, in an independent research
ledger rather than the main repository's ongoing TB4 ledger.

## Results

| Instance                       | Official assertions passed | Pass rate | Model requests | Local tool calls | Elapsed including scoring/cleanup | Kernel                 |
| ------------------------------ | -------------------------- | --------- | -------------- | ---------------- | --------------------------------- | ---------------------- |
| `altdesktop__i3-style.f93821b` | 484/539                    | 89.80%    | 137            | 147              | 23m 19.7s                         | `escalated`, not quiet |
| `cheat__cheat.b8098dc`         | 251/297                    | 84.51%    | 198            | 207              | 28m 9.4s                          | `escalated`, not quiet |
| `sharkdp__hexyl.2e26437`       | 841/906                    | 92.83%    | 197            | 209              | 32m 15.4s                         | `escalated`, not quiet |

All three had valid independent scores, successful offline preflight, matching
preflight/official executable hashes, and unchanged submission archive hashes.
There were no system errors, branch errors, warnings or missing usage records.
All 532 admitted model requests named `gpt-5.6-luna` with `max` reasoning.
Monetary cost remains unknown rather than zero; raw usage is retained.

None was a full task pass. Every Contract received a sealed challenge, retained
its obligation, and had `quiet: false` with no attestation. No strategy was
promoted. All owned worker containers were fenced and removed.

The raw evaluator files contain 750, 307 and 974 cases respectively, including
officially ignored cases. The table uses the frozen official denominators
539, 297 and 906; it is not a post-outcome choice of favorable assertions.

The previous independent i3-style pilot was **507/539 (94.06%)**, higher than
this new **484/539**. That historical record is unchanged. One stochastic sample
per runtime does not attribute the difference to the upstream update, and the
lower new score was not retried into a better result. These three cases are an
engineering regression check, not a controlled performance or RSI experiment.

## Checks and evidence

- Repository `bun run check`: lint and all 35 scheduled typecheck tasks passed.
- ProContract/RSI/transport suite: 126 tests passed, including real offline
  container qualification.
- Updated upstream Session error and provider tests: 46 passed.
- Official-score aggregation regressions: four passed.
- Core generated migration consistency and `git diff --check` passed.
- Exact environment-credential scanning found no credential bytes in the
  changed tracked files.
- The updated native V2 scripted-provider fixture completed 1,003 actual
  protocol requests and 1,002 real shell calls, in addition to 3,001 explicitly
  synthetic gateway history rows. It crossed the historical count ceilings.
- A separate original-deadline fixture admitted its last request before expiry
  and confirmed complete container fencing 1.49 seconds later, without renewal.

```text
/home/duozhou/run-artifacts/procontract-v2-sync-20260929/
  PROTOCOL.json
  runtime-manifest.json
  FINAL_SUMMARY.json
  check.log
  core-tests.log
  upstream-tests.log
  fixture-long/
  fixture-expiry/
  trial-i3-style/
  trial-cheat/
  trial-hexyl/
  research-ledger/
```

Each task directory retains the issuer ledger, gateway database/accounting,
complete Session database and durable event log, fixed submission, independent
preflight, raw official evaluation, result, terminal receipt, fence receipt and
`AUDIT.json`. The per-task audit rechecks metadata hashes, actual request model
and effort, original deadlines, official denominators, candidate/executable
identity and the Kernel's evidence binding.

Frozen protocol SHA-256:
`4f407ab30444cd67b277de0be695ebc1d198b26f713e29d848abb774d5aa77b6`.
Runtime-manifest SHA-256:
`9dc9184c67faaec03e2afc5b343106163b0d8a621e6af96c0b2ef43e1c6eb605`.

All prior cohorts, including the earlier V2 pilot, remain untouched. Only code
and this bounded readout are published with the branch; raw trajectories,
databases, submissions and environment data remain in the private artifact
directory, not GitHub.
