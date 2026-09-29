# Native V2 ProgramBench qualification — 2026-09-29

## Outcome

The restricted native V2 execution path completed one real ProgramBench allocation
with the user-selected `gpt-5.6-luna` / `max`. Independent offline preflight passed.
The official, metadata-filtered result is **507/539 (94.0631%)**, with 32 assertion
failures, no system errors, no branch errors, and no warnings. This is **not a full
task pass** and is not comparative or RSI-improvement evidence.

The host Kernel retained responsibility: `verification -> escalated` through a
sealed challenge, no attestation, `quiet: false`. The worker's successful Session
termination did not certify task completion. No model or official test rerun was
performed, and no policy was promoted.

| Coordinate                                               | Value                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| Branch / upstream base                                   | `procontract-v2` / `b30c4d00d15ed20d15a19e5c07534514bc2ee0fe`             |
| Instance / repetitions                                   | `altdesktop__i3-style.f93821b` / one                                      |
| ProgramBench source                                      | `ProgramBench-host-authority`, committed source pinned in `PROTOCOL.json` |
| Start / original deadline (UTC)                          | 06:54:47.565 / 12:54:47.565                                               |
| Total elapsed, including independent scoring and cleanup | 1,784.695 seconds (29m 44.7s)                                             |
| Model requests / local tool calls                        | 195 / 205                                                                 |
| Missing request usage records                            | 0                                                                         |
| Input / cached input / output tokens                     | 19,573,203 / 19,404,028 / 108,621                                         |
| Monetary cost                                            | Not independently verified; recorded as unknown, not zero                 |
| Submission SHA-256                                       | `c9b8a580ed7b879bec8b3c51f6cac71fd2084642af112f8de0ef3298a9b58c79`        |
| Preflight and official rebuilt executable SHA-256        | `6cd2c9d60846a63ea924c60da752bd108d92de91320dfe973d21277dbc62f8e7`        |
| Official raw evaluation SHA-256                          | `ac1be8c17d20d9ce3ddba1d4fdf2958db951a118f24a8403cb788c2620494b03`        |
| Frozen protocol SHA-256                                  | `bb16b14f1681a14e5def24faf4ae3f4f9e061bc3800cfd3c93dc94e45f69117b`        |

## Actual execution boundary

The SDK worker uses the upstream V2 inbox, Session runner, tools and native
OpenAI transport. It does not invoke a legacy Session loop. Runtime and
dependencies were copied into an independent, read-only snapshot before the
live call; `runtime-manifest.json` names 182,331 files/links. The original dirty
worktree and all other cohorts remained unchanged.

The host owns the Kernel database, real provider credential, process-identity
gateway and official evaluator. The worker container has no network, Docker
socket, host ledger or upstream credential. Only the admitted runtime PID can
use the model-only Unix channel. Each physical request checks live Kernel
standing, exact model/effort and the original deadline.

This profile deliberately exposes only `glob`, `grep`, `patch`, `read` and
`shell`. It disables Code Mode, subagents, movement and background shell mode.
It rejects existing worker databases rather than silently recovering Session
claims or assuming that first-admission-wins retries prove exact Contract
identity. It is not qualification of unrestricted V2 execution or a mutable-H
RSI deployment driver.

## Deadline and isolation qualification

Before the live allocation, a scripted local provider exercised the real V2
runner and shell in an isolated task image, without paid model calls:

- 1,003 native protocol requests and 1,002 real shell calls completed. The
  gateway additionally contained 3,001 explicitly synthetic prior rows, proving
  that the old request-count ceilings did not stop this deadline-only path.
- A shell child was denied use of the model channel. It observed only loopback
  networking and no Docker socket.
- A separate allocation with ten seconds remaining on its original six-hour
  deadline stopped without renewal. Its last admitted request preceded the
  deadline; complete container fencing was acknowledged 1.49 seconds later.
- Fixture 01's incorrect provider package attempted an unavailable package
  lookup and failed before any provider request. Its source/logs are retained;
  it is not counted as a model trial. Later fixtures fixed the native package
  selection and qualified the five-tool profile.

## Aggregation defect and non-destructive correction

The frozen pilot adapter initially read `EvaluationResult` directly. That
object intentionally retains officially ignored tests, so `RESULT.json`
reported an **unfiltered 652/750**, unlike the official CLI's 539-test scope.

The canonical readout applies the existing ProgramBench functions
`get_active_branches`, `get_ignored_tests`, `for_branches`, and `without_ignored`.
The metadata was already committed and frozen; no tests were dropped based on
their observed result. The corrected adapter also uses the scorer's own
`get_branches_to_eval` completeness check.

`RESULT_CORRECTION.json` explicitly supersedes the summary's numerical scope.
The initial report, raw evaluation bytes, submission, model trajectory, and
Kernel history remain unchanged. `ADAPTER_VALIDATION.json` records that the
fixed reader reproduces **507/539** from the same raw file without running a
model or test. Four regression tests cover ignored failures, retired branches,
active failures, missing tests, and preservation of infrastructure diagnostics.

The Kernel's original negative disposition remains appropriate: both readouts
are short of a full pass. Its original challenge still names the original
report hash; history was not rewritten to pretend that the corrected adapter
produced that historical event. Future runs use the corrected adapter, preventing
ignored failures from incorrectly vetoing an official full pass.

## Artifacts and checks

Artifacts remain under:

```text
/home/duozhou/run-artifacts/procontract-v2-native-20260929/
  PROTOCOL.json
  runtime-manifest.json
  FINAL_SUMMARY.json
  ENVIRONMENT.json                 # explicitly post-run environment capture
  fixture-01/ ... fixture-04/
  fixture-long/
  fixture-expiry/
  trial-0/
    RESULT.json                    # original unfiltered readout, preserved
    RESULT_CORRECTION.json          # official scope
    ADAPTER_VALIDATION.json
    ACCOUNTING.json
    TERMINAL.json
    FENCED.json
    issuer.sqlite
    control/requests.db
    state/session.sqlite
    state/events.json
    state/messages.json            # one paginated view; not the complete transcript
    preflight.json
    score.log
    submission/altdesktop__i3-style.f93821b/
  research-ledger/
```

The Session database and durable event log, rather than the paginated message
view, preserve the full trajectory. Fixture and live containers were fenced.
The main repository's TB4 research commitment was not modified; this engineering
qualification has an independent ledger and Commitment
`C-5290bb4028513000075f9541434ba8c6`.

Checks: Core/SDK typechecks, transport/cancellation tests, native process
qualification, four aggregation regression tests, and the repository-wide
`bun run check` passed. The one-task score is descriptive only. No baseline,
development/confirmation comparison or statistical/RSI performance claim is
supported by this allocation.
