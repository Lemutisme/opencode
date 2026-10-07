# Essential native RSI: ProgramBench adapter and small paired study

This is a new source/protocol on `essential-bench`, based on the delivered
`essential-rsi@dd3d74f` and upstream V2 2.0.24. Historical releases and cohorts are
not changed. The normative Kernel and public Contract Schema are unchanged.

## Added execution boundaries

- An optional operator-prepared task rootfs supplies the exact cleanroom image's
  public documentation, executable reference and preinstalled tools. Inference
  remains a network/PID/mount-isolated native V2 Session. The reference is
  execute-only and read-only; private root ownership is preserved. The only
  added image paths are harness mount points and a private qualification canary.
  This is a disclosed read-only-rootfs execution profile, not an assertion of
  identical Docker scheduling or arbitrary filesystem behavior.
- Official grading uses the retained qualified `native-rsi@6766cffd64`
  ProgramBench bridge, copied without semantic changes. It runs only on the
  trusted host, packages a fenced workspace, uses pinned evaluator/data/tool
  supplies, and owns/fences all of its Docker containers. Workers never receive
  the Docker socket, evaluator inputs or provider credential. Scoring retains
  `official-programbench-normal-use`, not hostile-candidate certification.
- `verification: "terminal"` records final official scores once. A valid partial
  score leaves the original Contract escalated with a sealed challenge, without
  feeding private final diagnostics into another solve attempt. Blocked work may
  be independently scored but is not called delivered. Invalid/missing evidence
  remains unknown; an acknowledged candidate build failure is an official zero.
- `proposals` freezes a finite candidate-comparison schedule (0 for the fixed
  control, 1 for this diagnostic), not a model-request/tool-action/cost budget.
  Checkpointing and task execution remain deadline-only. The schedule cannot be
  changed after admission. Safety/development/confirmation comparisons remain
  complete fixed-repeat task-Pareto with full-pass retention.
- Fixed-pair evaluation now follows a method's checkpoint/refresh workflow to a
  terminal handoff instead of grading its first checkpoint as final output.
  Its retained execution chain binds every segment, method, input, output,
  assignment and original deadline. No continuation resets the allocation.
- The declared disk reserve is checked before new work. It is an infrastructure
  guard, never a substitute for an unlimited provider/action allowance.
- Model-visible runtime releases use `pro-contract-freeze.ts --worker`, excluding
  experiment specifications, scripts, tests and fixtures. This prevents the
  operator's calibration notes or confirmation assignments from entering the
  model-visible source/docs closure. Full operator sources remain separately
  retained. Fixed-schedule handoffs are also checked at the host admission boundary.

## Proposed small study

Three historically exposed Rust/medium instances with distinct CLI behavior:

| Instance                       | Domain                             | Official active denominator |
| ------------------------------ | ---------------------------------- | --------------------------: |
| `altdesktop__i3-style.f93821b` | configuration/theme transformation |                         539 |
| `yaa110__nomino.f892499`       | filesystem renaming                |                         313 |
| `dalance__amber.69a0f52`       | search/replacement                 |                         565 |

Two fixed original-task repeats per arm and instance: 12 original tasks.
The arms share the same seed policy, model/effort, task image, public material,
six-hour original deadline, verifier and resource profile. The treatment enables
one optional candidate comparison and actual successor continuation; the control
keeps the seed method fixed. Both may checkpoint. No additional request, tool,
action or monetary cap is introduced; early completion remains allowed.

Each treatment's development task is its original instance, with the next
instance in the table as confirmation (cyclic). Each comparison executes both
methods twice per performance task, plus fixed safety cases. This is task-local,
adaptive development evaluation, not a blind leaderboard or unseen-generalization
study. Only development aggregates return to the proposer. Confirmation details
stay private. Formal qualification may consume more compute than the control;
usage and wall time are reported rather than pretending to be compute-matched.

Primary readout: each instance's two-repeat mean official pass fraction and the
RSI-minus-fixed difference. Secondary: full passes/delivery, proposal/adoption
frequency, actual policy use on the provider wire, retained public observations,
failures, time, requests and token accounting. Missing endpoints prevent a complete
paired mean; no rerun, dropping difficult tasks, imputation or post-hoc promotion.
Two repeats and three exposed tasks support a diagnostic, not a population claim.

## Preflight finding: reference calibration is not perfect

The unmodified official active/ignored scope produced complete, valid reference
control measurements of **539/539, 311/313 and 564/565**, respectively. The initial
all-reference-full check therefore failed and remains recorded as failed.
This diagnostic can evaluate official-score differences, but cannot assume that
full official scores and reference-equivalent behavior are identical on all cases.
The canonical maps/assertions/denominators are not changed; no failed case is
removed. Private calibration details are not supplied to generators or solvers.
These are operator-only qualification observations, not model results or an
agent baseline. Study admission must separately disclose this limitation.

Artifact root: `/home/duozhou/run-artifacts/programbench-essential-rsi-3-20261007`.
`PROTOCOL.json`, `FROZEN.json`, qualification receipts and `LAUNCH.json` identify
the actual final admitted study. Preparation alone does not mean inference began.
The root `CANCEL` file cancels only this owner's tasks. Final readout must retain
negative results, incomplete accounting and every original deadline.
