# ProContract continuation repair — 2026-09-06

## Scope

This change closes the observed admission/execution prompt conflict and keeps
unsuccessful native readiness checks inside bounded search. It also fixes two
ProgramBench integration issues: default execution/preflight image skew and
automatic evaluation being skipped after revision-paused jobs seal artifacts.
It is not a new performance result, a revision approval policy, or a claim that
every external delivery failure now recovers autonomously.

The original six Luna Max trajectories and their evaluation results remain
unchanged. Both original campaigns remain `invalid_protocol`.

## Runtime changes

- The default build-agent prompt contains ordinary coding guidance. A domain-owned
  `pro-contract/lifecycle` System Context source supplies admission guidance only
  to an unbound default agent, or execution guidance to a Contract-bound Session.
  The runner selects this mode from the binding rather than asking the model to
  infer whether admission has already happened. Agent changes remove obsolete
  admission guidance through a chronological context update, not a new authority.
- The execution guidance identifies admission as complete. Later external
  evaluation alone is not a reason to petition revision. The revision tool remains
  available for actual changes and retains its existing approval/pause semantics.
- A failed completed replay in `contract_report_ready` produces a bounded
  diagnostic with exact evidence and subject hashes, but does not call kernel
  `report-ready`. The same Session can repair and retry without consuming another
  semantic attempt. Every configured readiness replay reserves one shared action
  and is bounded by the remaining deadline. It does not reuse a previous passing
  `contract_check` result.
- Verifier unavailability and exhausted resources still fail closed. A successful
  replay only permits the handoff to enter verification; independent principal
  attestation is still necessary. Kernel challenge and authorization rules are
  unchanged.

## Lua mismatch: reproduced, not inferred from benchmark score

The original sealed executable has SHA-256
`296234f68530f1e24b1618983c76b0eaeabbca3b65908c71e9b3c27f4cc4fafe`.
It was run without modification in two existing images, with a read-only bind
mount, read-only root filesystem, disabled network, dropped capabilities, and
bounded memory/process/CPU resources.

| Image                                 | Default interactive output for `1 + 2`      |
| ------------------------------------- | ------------------------------------------- |
| `task_cleanroom` (`c4732687753a…`)    | Prompt followed by `3`, without input echo  |
| `task_cleanroom_v6` (`823d20cc45c7…`) | Prompt followed by echoed `1 + 2`, then `3` |

The candidate dynamically loads readline. Selecting `libreadline.so.8` through
the actual `LUA_READLINELIB` variable makes both images echo the input. Selecting
a nonexistent readline library makes both use the non-echoing fallback. Thus,
image-dependent dynamic-library availability explains this reproduced difference
without changing the executable or weakening any test.

ProgramBench's workspace default used `task_cleanroom`, while its preflight and
evaluator default used `task_cleanroom_v6`. New untagged workspaces now use the
same `programbench.candidate.DEFAULT_IMAGE_TAG` as preflight. Explicit tags remain
explicit, including legacy tags, and existing image-digest identity checks remain
in force. Old frozen campaigns are not retagged or retrospectively rescored.

This does not make native replay hermetic: ambient environment, toolchain changes
made during execution, and host-verifier behavior still require separate controls.
It removes this default-image mismatch, not every possible environment mismatch.

## Evaluation scheduling

The campaign runner now evaluates after inference if no worker remains running
and all selected jobs are terminal or have valid hash-bound sealed artifacts.
A sealed revision-paused candidate is evaluable without approving its revision
or restarting inference. An unsealed paused job still prevents evaluation, and
the evaluator's breaker and integrity checks remain authoritative. Evaluation
does not convert an incomplete or protocol-invalid campaign into a successful one.

## Validation and evidence

Final checks: 182 Core tests passed across 10 files; 407 ProgramBench tests
passed, with its separate image-building Docker integration test deselected.
The two-image Lua reproduction above did use real Docker. `bun typecheck` passed
in both `packages/core` and `packages/opencode`. Prettier, the selected Python
files' Ruff checks, and both working trees' `git diff --check` passed.

Focused Core coverage includes lifecycle projection, same-Session failed-replay
repair with `maxAttempts: 1`, stale passing-check rejection, action exhaustion,
verifier unavailability, principal-only completion, durable context updates,
runner execution, and kernel invariants.

ProgramBench coverage includes workspace image selection and explicit-tag
preservation, sealed versus unsealed revision pauses, artifact conservation,
and the existing native delivery lifecycle suite.

Reproduction artifacts:

```text
/home/duozhou/run-artifacts/procontract-continuation-20260906-v1/
  lua-image-comparison.log
  lua-image-comparison-v2.log
  lua-image-comparison-v3.log
  core-tests.log
  programbench-tests.log
  core-typecheck.log
  opencode-typecheck.log
  programbench-lint.log
  validation.json
```

The first pilot could not read the subject directory under dropped capabilities;
it did not test program behavior. The second used the wrong optional environment
variable for its forced-library controls; only its default-image comparison is
usable. The third corrected the variable and is the controlled reproduction.
All pilots remain recorded. All 30 audited original campaign files retain their
pre-evaluation hashes. No provider inference was rerun for this reproduction.

## Remaining boundary

An unexpected negative verdict from the final external host preflight still
terminates delivery in the existing adapter. This patch does not silently retry
it, alter its checks, or turn its negative result into an attestation. A general
recovery bridge for that boundary must preserve each sealed attempt, admit a
principal-owned subject-bound challenge, and reuse the original ceilings with
crash-safe transitions. It must not feed held-out benchmark failures back into
the candidate used for the same evaluation.

The next performance experiment must freeze a new binary and runner snapshot.
An apples-to-apples runtime comparison must use the same corrected image policy
on both arms; the historical mixed-image panel is not that comparison. Unit tests
and the environment reproduction do not establish improved benchmark performance.
