# ProContract Experiment Index

This document records non-default controller designs and calibration results.
It is an experiment index, not part of the ProContract protocol. The normative
design is in [`pro-contract.md`](pro-contract.md), and operational procedures
are in [`pro-contract-runbook.md`](pro-contract-runbook.md).

## Default boundary

The retained OpenCode path is deliberately small:

```text
durable Contract execution
  -> model-owned adaptive trajectory
  -> exact Snapshot handoff
  -> frozen replay, when specified
  -> independent attestation or challenge
```

ProContract owns obligation persistence, delegated authority, exact handoff
identity, and recognized settlement. The executor owns exploration, planning,
implementation, and local validation. A replay-passing handoff enters
verification; it does not trigger an executor-authored review.

A new semantic attempt requires a concrete institutional event: lost execution,
failed replay, an issuer or verifier challenge, an accepted revision, or a
blocked-condition retry. Principal-approved budgets and attempt limits remain
exact ceilings. The institution does not expand them in pursuit of quality.

This boundary is the best-supported interpretation of the core claim:
ProContract provides completion integrity and durable responsibility for a
black-box executor. It does not replace the executor's search policy.

The goal and settlement claim are intentionally distinct. The goal governs how
the executor spends its budget; `evidence.claim` governs what the institution
may certify. Treating the verifier proxy as the optimization goal caused an
observed YJ regression from 83.18% to 77.57%.

The Contract prompt prefix contains only immutable terms, including the exact
turn/action ceiling and evidence policy. Remaining budget is enforced by the
institution rather than injected as a changing countdown. A static settlement
warning appears only in the final twenty turns or actions. A focused Luna Max
smoke test used one cold request followed by three warm requests: the warm
requests reported 60,970 cache-read tokens and 1,634 uncached input tokens, a
97.39% warm-prefix hit rate.

## Designs kept outside the default path

### Synthetic counterexample review

Several versions turned a replay-passing handoff into a new executor attempt
with a generated counterexample or review prompt. This was intended to expose
blind spots before settlement. It is not a sound institutional event: the same
black-box policy both produced the claim and invented the defeater, so the
review added compute without adding an independent truth source. It also made
a valid handoff insufficient for quiescence for reasons absent from the
ratified Contract.

Counterexample search remains useful as executor policy. A verifier may also
return a concrete negative witness. Neither requires a synthetic challenge in
the Contract state machine.

### Evidence-closure search

Responsibility closure requires material loss of support to create owned
remediation while the mandate remains live. An executor's stated uncertainty
is not, by itself, loss of institutional support. Automatically reopening every
handoff uncertainty conflated epistemic honesty with failed verification and
could create an endless self-review loop.

The retained design preserves uncertainties in the handoff for independent
adjudication. Only replay failure or issuer/verifier evidence reopens work.

### Value scheduling

Value-of-information ordering and value gates attempted to spend the remaining
budget on the experiment most likely to change the implementation decision.
That is a promising model-side heuristic, but its value estimates are
task-dependent and unverifiable by the normative kernel. Making them mandatory
reduced Typst calibration scores. They belong in a replaceable compiler or
executor policy, using ordinary Contract budget telemetry.

### Evidence-frontier prompt

A one-sentence executor policy asked the model to prefer the cheapest legal
observation likely to falsify an implementation of a materially untested
behavior class. On a same-instance Loop calibration it repaired 27 tests missed
by the prior candidate, including fractional counts, sentinel values, and
argument errors, but lost 149 prior passes. The final result was 530/710
(74.65%), down from 652/710 (91.83%), despite nearly identical model cost.

The candidate explored more broadly and handed off after 181 turns, but one
missing finite-input termination invariant caused 154 of its 180 active
failures to time out. Enumerating behavior classes did not preserve the
cross-cutting invariants that connected those classes. The policy was therefore
rejected and removed from the default prompt. This is calibration on an already
observed instance, not holdout evidence; its value is the counterexample that
more falsification language can still trade implementation discipline for
exploration.

### Adaptive Contract graphs

Immutable `requires` edges remain useful for real durable dependencies between
independently settled obligations. A planning DAG is different: it is a
temporary hypothesis about how one executor should search. Automatically
turning every plan node into a Contract adds issuance, scheduling, and
settlement overhead without strengthening completion integrity.

Use sub-Contracts only when a node needs independent persistence, authority,
ownership, or evidence. Keep ordinary decomposition inside the executor.

### Unlimited horizon

A larger horizon improved Pandoc coverage, but additional attempts were not
monotonic and the final attempt exhausted the budget without a handoff.
Obligation persistence does not imply unlimited delegated authority. Contract
budgets remain exactly issuer-approved; an executor may petition for revision
when more authority is justified.

### Authoritative checkpoint and rollback

An experiment promoted each replay-passing handoff to an intermediate
`authoritative` Snapshot, reserved final turns, and could roll the workspace
back after escalation. This improved lifecycle hygiene but did not identify
the best hidden-evaluator candidate. Candidate-defined replay establishes
policy support, not comparative quality.

The retained core binds every handoff to an exact Snapshot and leaves the live
workspace non-authoritative. Promotion belongs at the actual effect boundary:
for example, an adapter-owned sealed comparator, repository protection, or an
external deployment service. ProContract does not add an intermediate status,
promotion operation, or automatic filesystem rollback.

## MetaContract mechanism check

A fresh local E2E bound one discharged Contract as the exact execution policy
of a later Task Contract. Admission failed before policy attestation, succeeded
after it, and the task followed the injected policy through replay and
discharge. Challenging policy support then escalated the discharged dependent,
restored non-quiescence, and prevented a new dependent from being issued. This
checks retention, future binding, and support-loss remediation; it does not
claim automatic policy selection or task-quality improvement.

A second fresh E2E placed that exact policy edge in location configuration. A
normal natural-language proposal inherited it before principal permission, and
the dedicated executor produced policy-only marker content. After the policy
was challenged, another natural-language proposal inherited the same stale
selection and failed issuance closed without creating a Contract. This checks
durable default retention while leaving winner selection outside the executor.

A clean recursive E2E then used a ratified P0 policy to govern a MetaTask that
generated the exact P1 policy text. P1 was built only from the exported MetaTask
Snapshot, independently attested, selected by the principal policy command, and
inherited by a later Task that produced a value absent from the user request.
Challenging P1 retracted the Task's support. Failed and ambiguous policy
candidates remained in history and were not promoted. This proves bounded
recursive policy flow, not general capability improvement.

A development artifact-selection E2E reused the existing mechanism without a
new selector state machine. Two independently discharged Loop candidates became
requirements of an ordinary read-only Selection Contract. Its frozen report,
replay, independent attestation, and exact export selected the 670/710 candidate
over the 513/710 candidate, whose run had 146 timeouts. A fresh network-disabled
Linux cleanroom reproduced the winner's executable hash and regression pass.
This proves evidence-backed artifact selection, not policy improvement: the
candidate policy remains rejected, and no policy, validation, or holdout stage
was opened.

## Capability-RSI calibration

A reused CMatrix calibration ran a fresh matched baseline and one MetaContract-
generated policy with Luna Max. Both artifacts solved the official evaluation
with the same 768/769 raw result, while the candidate used 20.3% more turns,
18.1% more actions, and 3.9% more cost. The capability gate rejected it for
cost regression and absent confirmation/OOD evidence. A bounded second-order
MetaContract then removed completeness-before-implementation; its new executor
started implementation earlier but finished with 54.2% more turns, 36.1% more
actions, 78.0% more cost, and two unbounded-process incidents, so it was rejected
before official confirmation.

This run demonstrates conservative policy selection rather than capability
gain. It also localizes one non-policy requirement: process-group deadlines and
descendant cancellation must be enforced at the shell effect boundary because
natural-language policy retention did not prevent unbounded probes. CMatrix was
already saturated by the baseline and remains a calibration task; promotion
still requires repeated private runs and disjoint confirmation/OOD tasks.

A subsequent private Tailspin experiment used two matched GPT-5.5 high
replicates per arm. A MetaContract-generated policy reduced total cost by 32.9%,
turns by 28.2%, and actions by 25.5%, but mean official utility fell from 75.57%
to 74.10% and one paired replicate regressed by 5.54 points. The capability
gate rejected the candidate before holdouts. The observed bad tail also led the
gate to enforce its existing regression tolerance on every paired run instead
of only a task's replicate mean.

## Calibration results

These runs are mechanism calibrations, not causal performance claims. The
instances had been inspected in earlier development, trajectories were
stochastic, and compute was not always matched.

| Instance | Controller | Result | Trajectory | Observation |
| --- | --- | ---: | --- | --- |
| `typst__typst.88356d0` | simplified | 44.6056% | 1 attempt, 136 calls | Valid Snapshot handoff, replay, attestation, and discharge |
| `typst__typst.88356d0` | fixed-point review | 44.8956% | 5 attempts, 504 turns | Five additional passing tests at much higher cost |
| `typst__typst.88356d0` | value-order | 38.9211% | - | Mandatory scheduling regressed quality |
| `typst__typst.88356d0` | value-gate | 38.6311% | - | Mandatory gate regressed quality |
| `typst__typst.88356d0` | review-gate | 34.9768% | - | Mandatory review produced the largest regression |
| `jgm__pandoc.5caad90` | evidence closure | 20.7326% | 5 attempts, 547 turns | Durable risks caused later work; no causal control |
| `jgm__pandoc.5caad90` | unlimited horizon | 22.0176% | 10 attempts, 1,000 turns | Better score, 173 regressions, no final handoff |
| `jgm__pandoc.5caad90` | authoritative checkpoint | 20.9436% | 14 attempts, 992 turns | Clean final handoff, lower score than the long run |
| `jgm__pandoc.5caad90` | simplified, Luna Max | 22.5738% | 1 attempt, 524 turns | Best local score; different model and no matched control |
| `sclevine__yj.8016400` | settlement/cache fix, Luna Max | 81.4863% | 3 attempts, 198 turns | Strong candidate; Contract released after exact subject omitted required binary |
| `sclevine__yj.8016400` | final core, Luna Max | 77.5750% | 1 attempt, 119 turns | Exact replay, independent preflight, discharge, and quiet |
| `sclevine__yj.8016400` | goal/claim separation, Luna Max | 89.0482% | 1 attempt, 256 turns | New best; independent delivery discharge and quiet |
| `sclevine__yj.8016400` | E2E artifact export, Luna Max | 81.0952% | 1 attempt, 173 turns | Exact CLI export consumed by external adapter |
| `sitkevij__hex` | later controllers | 98.5419% | multiple variants | Plateau; added control logic did not improve the score |
| `miserlou__loop.209927c` | evidence frontier, Luna Max | 74.6479% | 1 attempt, 181 turns | Rejected; 27 gains, 149 regressions, 154 timeout failures |
| `miserlou__loop.209927c` | policy screening, Luna Max | P0 93.38%; invariants 92.68%/80.00%; probes 75.92%; simplicity 81.55% | matched development runs | No candidate survived replicate/tail-risk gates; no validation or holdout opened |
| `miserlou__loop.209927c` | decision frontier, Luna Max | 94.37% / 72.25% | 2 matched replicates | Rejected; second run had 146 timeouts and lost 150 tests versus the first |
| `abishekvashok__cmatrix.5c082c6` | capability-RSI baseline, Luna Max | solved; 768/769 raw | 59 turns, 83 actions | Retained |
| `abishekvashok__cmatrix.5c082c6` | first-order policy, Luna Max | solved; 768/769 raw | 71 turns, 98 actions | Rejected for cost regression and missing holdouts |
| `abishekvashok__cmatrix.5c082c6` | second-order policy, Luna Max | not evaluated | 91 turns, 113 actions | Rejected before confirmation for cost and process violations |
| `bensadeh__tailspin.6278437` | P0 baseline, GPT-5.5 high | 72.48% / 78.66% | 116 / 100 turns | Retained |
| `bensadeh__tailspin.6278437` | MetaContract P1, GPT-5.5 high | 75.08% / 73.13% | 96 / 59 turns | Cheaper but weaker; rejected before holdouts |

The Pareto result is the simplified implementation at
`af579a44e4445a008119d8a38a3a22df85217bb5`. On Typst it recovered to
within five tests of fixed-point review with one semantic attempt and avoided
the substantial regressions of mandatory value and review gates.

## Local artifacts

The result files are external evaluation records and are not runtime or build
dependencies of this repository. These links resolve in the evaluation
workspace layout documented by the runbook:

- [Typst simplified](../../run-artifacts/programbench-typst-simplified-gpt55-xhigh-20260806-163137/RESULT.md)
- [Pandoc evidence closure](../../run-artifacts/programbench-pandoc-evidence-closure-gpt55-xhigh-20260806-135649/RESULT.md)
- [Pandoc unlimited horizon](../../run-artifacts/programbench-pandoc-long-horizon-gpt55-xhigh-20260806-163444/RESULT.md)
- [Pandoc authoritative checkpoint](../../run-artifacts/programbench-pandoc-authoritative-gpt55-xhigh-20260806-210625/RESULT.md)
- [Pandoc simplified Luna Max](../../run-artifacts/programbench-pandoc-simplified-luna-max-20260807-105143/RESULT.md)
- [YJ settlement/cache fix](../../run-artifacts/programbench-yj-settlement-cachefix-luna-max-no-net-20260807-151834/RESULT.md)
- [YJ final core](../../run-artifacts/programbench-yj-final-core-luna-max-no-net-20260807-163701/RESULT.md)
- [YJ goal/claim separation](../../run-artifacts/programbench-yj-goal-claim-luna-max-no-net-20260807-172413/RESULT.md)
- [YJ E2E artifact export](../../run-artifacts/programbench-yj-e2e-export-luna-max-no-net-20260808-130711/RESULT.md)
- [Loop evidence frontier](../../run-artifacts/programbench-loop-frontier-luna-max-20260809-113915/RESULT.md)
- [MetaContract policy binding](../../run-artifacts/metacontract-policy-e2e-20260809-150615/RESULT.md)
- [MetaContract default policy](../../run-artifacts/metacontract-default-policy-e2e-20260809-152643/RESULT.md)
- [MetaContract recursive policy generation](../../run-artifacts/metacontract-rsi-e2e-final-20260809-161638/RESULT.md)
- [Loop policy screening](../../run-artifacts/meta-policy-screen-loop-20260809-165038/RESULT.md)
- [Decision-frontier screening](../../run-artifacts/meta-decision-frontier-loop-20260809-183654/RESULT.md)
- [Decision-frontier artifact selection](../../run-artifacts/meta-decision-frontier-loop-20260809-183654/SELECTION_RESULT.md)
- [CMatrix capability-RSI calibration](../../run-artifacts/programbench-cmatrix-rsi-luna-max-20260810-102617/RESULT.md)
- [Tailspin private capability-RSI](../../run-artifacts/programbench-tailspin-rsi-gpt55-high-20260810-125520/RESULT.md)

## Decision rule for future additions

A mechanism belongs in ProContract Core only if removing it permits an
executor to erase a live duty, exceed delegated authority, change the identity
of a handoff, certify its own completion, or leave recognized support loss
without an owner. A mechanism that only changes which hypothesis the model
tries next belongs in the compiler, executor, verifier adapter, or benchmark
harness.

Future controller experiments should first live outside the default path and
report matched model, prompt, environment, maximum budget, artifact lineage,
trajectory, and external evaluation. They should move into the harness only
after demonstrating a repeatable gain and a new invariant that cannot be
expressed at an existing boundary.
