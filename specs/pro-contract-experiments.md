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
The deterministic external selector then reproduced the same winner from
reversed report order, proved exact-retry idempotence and conflicting-retry
rejection, and completed a fresh Selection Contract and exact export.
This proves evidence-backed artifact selection, not policy improvement: the
candidate policy remains rejected, and no policy, validation, or holdout stage
was opened.

A focused assurance-transition check then treated the existing fixed-root flow
as generation zero. It accepted an executor successor only when its Evaluation
Contract required the exact successor plus the predecessor judge. A judge
replacement additionally required a Bridge Contract depending on both old and
new regimes. The checker rejected direct self-certification, missing
bridges, stale attestations, and cumulative-risk overflow. This is a mechanism
test for predecessor-grounded tiling: the accepted executor report served
directly as the next tile's frontier for a judge transition. It is not evidence
of capability improvement, indirect independence, or semantic equivalence
between judges.

A fresh Luna Max private screen then used aggregate historical evidence to have
MetaContract generate one task-independent coverage-to-closure policy. Against
one fixed current baseline, H1 improved unseen Srgn from 62.74% to 71.00% while
using 67 fewer turns, but regressed unseen Cheat from 70.03% to 67.34% while
using 42 more turns. Macro and micro utility improved, yet the -2.69-point worst
pair exceeded the frozen one-point tolerance. An independently attested
Evaluation Contract rejected H1 before replication or holdout. The run also
validated container-scoped tool cancellation across 518 process calls. Failure
analysis points to a mutable, externally retained behavior-surface regression
corpus rather than more global policy wording.

The original transition calibration above exercised the version 1 direct
predecessor check. The version 2 checker now carries one discharged Assurance
Contract in every frontier and requires its successor to depend on it. The
ProgramBench adapter's version 2 retained-regression ledger complements that
positive lineage with append-only `falsified` and `repaired` witness events.
These are mechanism upgrades; no new capability or RSI result is inferred until
a successor uses the unresolved witnesses and is evaluated on fresh campaigns.

A real YJ mechanism run then exercised both hereditary closures. A 77.57%
candidate produced five reproducible public witnesses; an 83.18% candidate
repaired all five. The 89.05% incumbent was stronger on the official aggregate
yet reintroduced one protected JSON-key behavior, so its unsupported assurance
transition was rejected. A one-line witness-directed successor restored the
exact reference failure, closed the journal, and advanced the checker to
generation two. Its single frozen official evaluation had exactly the same 825
raw test statuses and 89.0482% score as its parent. This demonstrates cumulative
finite repair without hidden-test regression, not score improvement or recursive
metaproductivity; the mutation was manual and the checker used a deterministic
Contract API fixture.

That successful YJ trajectory was then compiled by MetaContract into a
167-word task-independent successor-repair policy. In paired Luna Max campaigns
on Jot and Gron, the policy-bearing improver produced 867/976 active passes
versus 856/976 for the original improver (+1.13 micro points) while reducing
tool actions from 75 to 55, reference calls from 32 to 15, and recorded cost by
32.8%. Jot supplied the capability difference: the original improver repaired
only the observed help literal, while the successor localized and repaired the
shared help-template boundary. Gron quality tied, but the successor used a
15-line typed parser error instead of an approximately 64-line parallel parser.
This is preliminary one-step metaproductivity evidence, not promotion: there was
one replicate per arm, the confirmation rule was not preregistered, and Jot's
broader repair gained 17 tests relative to the control but also regressed six.
Both campaigns initially needed a copied read-only replay script so the
improver could consume retained cases without authority to mutate their ledger.
That repeated boundary was folded back into the ProgramBench adapter as
`candidate replay`: it emits exact case/expected/actual mismatches, exits
nonzero while any remain, and never admits evidence. External `candidate
retain` remains the sole witness/repair writer. No ProContract Core state or
policy was added.

m1 then generated an m2 policy that required contrastive mismatches to cross an
external admission command before they could justify broader mutation. A
preregistered Eva/Shellharden screen falsified that successor. The admission
mechanism worked: Eva m2 expanded one witness to four durable cases and
Shellharden expanded one to three. Yet m2 lost five Eva active tests, tied
Shellharden, increased actions by 17%, and increased cost by 30%. The frozen
rule therefore rejected m2. Failure analysis distinguishes behavior-surface
expansion, which needs admitted falsifiers, from semantic-invariant propagation,
which needs an explicit impact cone. m2 over-constrained the latter and missed a
stale help identity that m1 repaired. Recursive depth two is not established.

The rejected m2 result was then represented in an append-only speculative DAG
rather than overwriting m1. A real archive contained m1, rejected m2 with its
Eva falsifier, sibling invariant/local proposals, one repair child of m2, and a
two-parent hybrid merge. The deterministic linear baseline selected m1; the
node-UCB baseline selected all three unvisited branches first. Unit tests also
cover multi-parent reconstruction, idempotent retries, conflicting evidence,
forward-parent rejection, explicit closure, and retention of rejected repair
parents. This is a mechanism test for search-policy separation, not evidence
that UCB or MCTS improves capability.

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
| `sclevine__yj.8016400` | witness inheritance + assurance v2 | 89.0482% | 5 falsifiers, 2 accepted generations | Higher-scoring regression rejected; directed repair preserved all 825 official statuses |
| `shashwatah__jot.a92aad8` + `tomnomnom__gron.88a6234` | m0 vs MetaContract m1 | 856/976 → 867/976 | 2 paired campaigns | +1.13 micro pp with 26.7% fewer actions and 32.8% lower cost; not promoted |
| `oppiliappan__eva.41ae245` + `anordal__shellharden.6a6ffd4` | preregistered m1 vs m2 | 1778/2008 → 1773/2008 | 2 paired campaigns | m2 rejected: -5 passes, +17% actions, +30% cost |
| `sitkevij__hex` | later controllers | 98.5419% | multiple variants | Plateau; added control logic did not improve the score |
| `miserlou__loop.209927c` | evidence frontier, Luna Max | 74.6479% | 1 attempt, 181 turns | Rejected; 27 gains, 149 regressions, 154 timeout failures |
| `miserlou__loop.209927c` | policy screening, Luna Max | P0 93.38%; invariants 92.68%/80.00%; probes 75.92%; simplicity 81.55% | matched development runs | No candidate survived replicate/tail-risk gates; no validation or holdout opened |
| `miserlou__loop.209927c` | decision frontier, Luna Max | 94.37% / 72.25% | 2 matched replicates | Rejected; second run had 146 timeouts and lost 150 tests versus the first |
| `altdesktop__i3-style.f93821b` | current ProContract, Luna Max | 88.1262% | 1 attempt, 126 turns | Fresh instance; exact discharge and quiet, no causal control |
| `chmln__sd.87d1ba5` | current ProContract, Luna Max | 93.5802% | 1 attempt, 124 turns | Fresh instance; one timed-out probe left an orphaned container process |
| `abishekvashok__cmatrix.5c082c6` | current ProContract, Luna Max | measurement unavailable | 1 attempt, 60 turns | Contract discharged; official evaluator did not terminate |

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
- [YJ witness inheritance and assurance tiling](../../run-artifacts/procontract-witness-yj-20260811/RESULT.md)
- [One-step governed improver self-improvement](../../run-artifacts/procontract-rsi-metaproductivity-luna-max-20260811/RESULT.md)
- [Preregistered m2 confirmation screen](../../run-artifacts/procontract-rsi-m2-confirmation-luna-max-20260811/RESULT.md)
- [Speculative m1/m2 search graph](../../run-artifacts/procontract-rsi-search-graph-20260811/search.jsonl)
- [Loop evidence frontier](../../run-artifacts/programbench-loop-frontier-luna-max-20260809-113915/RESULT.md)
- [MetaContract policy binding](../../run-artifacts/metacontract-policy-e2e-20260809-150615/RESULT.md)
- [MetaContract default policy](../../run-artifacts/metacontract-default-policy-e2e-20260809-152643/RESULT.md)
- [MetaContract recursive policy generation](../../run-artifacts/metacontract-rsi-e2e-final-20260809-161638/RESULT.md)
- [Loop policy screening](../../run-artifacts/meta-policy-screen-loop-20260809-165038/RESULT.md)
- [Decision-frontier screening](../../run-artifacts/meta-decision-frontier-loop-20260809-183654/RESULT.md)
- [Decision-frontier artifact selection](../../run-artifacts/meta-decision-frontier-loop-20260809-183654/SELECTION_RESULT.md)
- [Fresh three-instance calibration](../../run-artifacts/programbench-rsi-fresh-three-luna-max-20260809-214234/RESULT.md)
- [Luna Max MetaContract private screen](../../run-artifacts/programbench-rsi-private-srgn-cheat-luna-max-20260810-185302/RESULT.md)

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
