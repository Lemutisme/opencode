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

After consolidating MetaContract artifact selection and the RSI gate, a
three-instance smoke batch exercised the merged branch without an inherited
policy. CMatrix reached 99.60% but leaked two timed-out executor descendants;
Tailspin fell to 32.08% despite valid delivery evidence; and the previously
unseen XSV reached 78.85%, below the public same-model 87.14%. All three exact
handoffs passed package/preflight, independently discharged, and became quiet.
The merge is mechanically sound, but the batch provides no capability-gain
evidence and reinforces process cleanup as an adapter responsibility.
The resulting Docker shell adapter was then exercised against a real
Linux/amd64 container: normal exit, an in-container hard timeout, and host
interruption all left no execution-tagged descendants.

A subsequent three-instance run pre-issued dependent Evaluation Contracts for
Grex, HTML-to-Markdown, and FD. All Delivery handoffs passed package/preflight,
but official utilities of 54.50%, 83.39%, and 76.44% missed frozen floors. Each
negative report challenged the exact Delivery and left Evaluation outstanding;
all scopes remained non-quiet. The fenced Docker adapter also reaped a Grex fuzz
probe at its hard deadline without leaking descendants.

Retesting the historical Pareto commit `af579a44e` on the same three tasks
showed a quality/cost tradeoff rather than uniform superiority. HTML improved
0.68 points and FD improved 10.93 points, but cost rose 3.3x and 6.2x. Grex cost
$22.90 and produced a nonterminating evaluator path, so no score was available.
The old controller acquired more behavioral evidence but predates prompt-cache,
finality, and liveness fixes; it should not replace the current core wholesale.

A one-line executor treatment then restored only the historical controller's
high-value evidence pattern: enumerate behavior surfaces, batch differential
probes, and preserve observations across coherent edits. HTML-to-Markdown rose
from 83.39% to 85.65% and FD from 76.44% to 78.30%, but Grex failed a
preregistered 20-minute evaluator cutoff because the candidate never advanced
for `--min-substring-length 0`. That tail rejected the initial wording.

The smallest general correction added boundary and error semantics to the same
rule. A fresh Grex Session proactively probed the exact zero boundary, preserved
16 regression cases, and produced an 88.34% candidate at $2.39, versus 54.50%
at $2.41 for the current baseline. Official evaluation finished in 185 seconds.
The final wording binds batches to the already enforced action deadline; it
does not claim the model supplies per-case timeouts. This remains executor-edge
guidance rather than a normative kernel invariant, and the single fresh run is
strong diagnostic evidence rather than a causal performance theorem.

A subsequent preregistered Grex pilot compared ordinary OpenCode with an active
ProContract using the same binary, GPT-5.5 high model, frozen task text,
cleanroom, reference, network policy, and evaluator. Ordinary OpenCode reached
80.87% in 100 turns for $4.07; ProContract reached 88.57% in 58 turns for
$2.66. The Contract arm explicitly acquired zero-boundary and CLI-error
evidence, while ordinary OpenCode missed it. Both evaluators terminated. This
validates the matched protocol and supplies a strong Pareto signal, but remains
one stochastic pair on a development instance.

A frozen three-instance fresh screening then produced two measurable pairs.
ProContract improved RnR from 88.58% to 91.80% at 31.5% lower cost and Dstask
from 26.45% to 63.46% at 2.47x cost. On Dstask, ordinary OpenCode stopped
without finding the mounted reference; ProContract issued 15 reference-bearing
probe batches. Both Treemd arms exceeded an uncalibrated 20-minute TUI evaluator
cutoff while still progressing, so the preregistered three-pair gate is
inconclusive rather than passed. All candidates packaged and preflighted; all
three Contract scopes independently discharged and became quiet.

A fresh Hashcards three-arm ablation then separated the institution from its
executor policy. Ordinary OpenCode scored 79.49%; Contract-only scored 80.77%
at 28.6% higher cost; full ProContract scored 87.14%, improving 6.38 points over
Contract-only while using 16.1% less cost and 37.9% fewer turns. The ordinary
arm had one official `results_read_failed` branch, so its contrast is confounded;
Contract-only and full had complete evaluations. This localizes the main clean
gain to proactive evidence routing inside the durable institution, not to
Contract state machinery alone.

That one-task attribution did not replicate uniformly in a frozen four-task
confirmation. Full improved Tparse by 27.06 points and Keifu by 4.58, but
regressed Hostctl by 12.08 and Diffr by 10.89. Mean delta remained +2.17 and
aggregate cost fell 19.1%, yet only two of four pairs were nonnegative and both
negative tails violated the preregistered tolerance. All eight evaluations and
Contract lifecycles completed cleanly. The gate therefore rejects the evidence
sentence as a generally stronger default: it routes attention, but does not
guarantee observations become retained regressions or justify stopping.

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
| `altdesktop__i3-style.f93821b` | current ProContract, Luna Max | 88.1262% | 1 attempt, 126 turns | Fresh instance; exact discharge and quiet, no causal control |
| `chmln__sd.87d1ba5` | current ProContract, Luna Max | 93.5802% | 1 attempt, 124 turns | Fresh instance; one timed-out probe left an orphaned container process |
| `abishekvashok__cmatrix.5c082c6` | current ProContract, Luna Max | measurement unavailable | 1 attempt, 60 turns | Contract discharged; official evaluator did not terminate |
| `abishekvashok__cmatrix.5c082c6` | capability-RSI baseline, Luna Max | solved; 768/769 raw | 59 turns, 83 actions | Retained |
| `abishekvashok__cmatrix.5c082c6` | first-order policy, Luna Max | solved; 768/769 raw | 71 turns, 98 actions | Rejected for cost regression and missing holdouts |
| `abishekvashok__cmatrix.5c082c6` | second-order policy, Luna Max | not evaluated | 91 turns, 113 actions | Rejected before confirmation for cost and process violations |
| `bensadeh__tailspin.6278437` | P0 baseline, GPT-5.5 high | 72.48% / 78.66% | 116 / 100 turns | Retained |
| `bensadeh__tailspin.6278437` | MetaContract P1, GPT-5.5 high | 75.08% / 73.13% | 96 / 59 turns | Cheaper but weaker; rejected before holdouts |
| `abishekvashok__cmatrix.5c082c6` | consolidated smoke, Luna Max | 99.6047% | 45 turns, 67 actions | Delivery passed; executor leaked two descendants |
| `bensadeh__tailspin.6278437` | consolidated smoke, GPT-5.5 high | 32.0847% | 61 turns, 64 actions | Valid artifact, severe stochastic capability regression |
| `burntsushi__xsv.f430466` | consolidated smoke, GPT-5.5 high | 78.8494% | 81 turns, 81 actions | Unseen locally; useful but below public same-model result |
| `pemistahl__grex.fa3e8ed` | evaluated delivery, GPT-5.5 high | 54.4970% | 53 turns, 53 actions | Floor failed; Delivery reopened, quiet false |
| `johanneskaufmann__html-to-markdown.3006818` | evaluated delivery, GPT-5.5 high | 83.3898% | 83 turns, 88 actions | Floor failed; Delivery reopened, quiet false |
| `sharkdp__fd.40d8eb3` | evaluated delivery, GPT-5.5 high | 76.4372% | 112 turns, 111 actions | Floor failed; Delivery reopened, quiet false |
| `pemistahl__grex.fa3e8ed` | historical Pareto retest, GPT-5.5 high | measurement unavailable | 108 turns, 110 actions | Expensive candidate hung evaluator on invalid input |
| `johanneskaufmann__html-to-markdown.3006818` | historical Pareto retest, GPT-5.5 high | 84.0678% | 77 turns, 81 actions | +0.68 points at 3.3x current cost |
| `sharkdp__fd.40d8eb3` | historical Pareto retest, GPT-5.5 high | 87.3684% | 104 turns, 107 actions | +10.93 points at 6.2x current cost |
| `johanneskaufmann__html-to-markdown.3006818` | bounded evidence frontier, GPT-5.5 high | 85.6497% | 78 turns, 81 actions | +2.26 points at 1.08x current cost |
| `sharkdp__fd.40d8eb3` | bounded evidence frontier, GPT-5.5 high | 78.2996% | 53 turns, 58 actions | +1.86 points at 0.54x current cost |
| `pemistahl__grex.fa3e8ed` | bounded evidence frontier, GPT-5.5 high | measurement unavailable | 91 turns, 87 actions | Rejected: zero-boundary candidate hung evaluator |
| `pemistahl__grex.fa3e8ed` | boundary-evidence correction, GPT-5.5 high | 88.3384% | 61 turns, 63 actions | Exact hang fixed; +33.84 points at baseline cost |
| `pemistahl__grex.fa3e8ed` | matched ordinary OpenCode, GPT-5.5 high | 80.8689% | 100 turns, 99 actions | Paired protocol pilot baseline; $4.07 |
| `pemistahl__grex.fa3e8ed` | matched ProContract, GPT-5.5 high | 88.5671% | 58 turns, 59 actions | +7.70 points at 34.6% lower cost |
| `ismaelgv__rnr.fc0733b` | matched ordinary OpenCode, GPT-5.5 high | 88.5798% | 99 turns, 102 actions | Fresh screening baseline; $3.26 |
| `ismaelgv__rnr.fc0733b` | matched ProContract, GPT-5.5 high | 91.8009% | 76 turns, 82 actions | +3.22 points at 31.5% lower cost |
| `naggie__dstask.ff57396` | matched ordinary OpenCode, GPT-5.5 high | 26.4476% | 20 turns, 22 actions | Stopped without retrieving mounted reference |
| `naggie__dstask.ff57396` | matched ProContract, GPT-5.5 high | 63.4585% | 41 turns, 44 actions | +37.01 points at 2.47x cost |
| `epistates__treemd.825c6dd` | matched screening, GPT-5.5 high | measurement unavailable | 87 / 85 turns | Both arms exceeded evaluator cutoff |
| `eudoxia0__hashcards.48aa136` | ordinary OpenCode ablation, GPT-5.5 high | 79.4897% | 76 turns, 78 actions | One evaluator branch error; $2.57 |
| `eudoxia0__hashcards.48aa136` | Contract-only ablation, GPT-5.5 high | 80.7655% | 95 turns, 98 actions | Institution without evidence sentence; $3.30 |
| `eudoxia0__hashcards.48aa136` | full ProContract, GPT-5.5 high | 87.1443% | 59 turns, 70 actions | +6.38 points vs Contract-only at 16.1% lower cost |
| `mfridman__tparse.2416b4b` | Contract-only / full, GPT-5.5 high | 51.7647% / 78.8235% | 118 / 57 turns | Full +27.06 points |
| `guumaster__hostctl.d6d9699` | Contract-only / full, GPT-5.5 high | 75.7374% / 63.6537% | 62 / 86 turns | Full -12.08 points |
| `mookid__diffr.2152742` | Contract-only / full, GPT-5.5 high | 88.4488% / 77.5578% | 85 / 45 turns | Full -10.89 points |
| `trasta298__keifu.3331426` | Contract-only / full, GPT-5.5 high | 60.3053% / 64.8855% | 54 / 69 turns | Full +4.58 points |

The Pareto result is the simplified implementation at
`af579a44e4445a008119d8a38a3a22df85217bb5`. On Typst it recovered to
within five tests of fixed-point review with one semantic attempt and avoided
the substantial regressions of mandatory value and review gates.

## 2026-08-28 reliable Contract ablation

This ablation used Luna Max, a six-hour wall limit, 1,000 provider turns,
4,000 Contract actions, an 80% cache-read gate, the same ProgramBench images,
and the same behavior-evidence issue policy in both arms. It compared exact
`2abdc89d05f6a5e5caf13d856074e40f7fbf3796` with two descendants:

- `a1a79159566751ee93b262edac95d3e70b2be4f8` projected the complete immutable
  goal, claim, brief, policy, authority, budget, and evidence on every turn;
- `8cc580c84aed38b82d9b3c1ccf5b5750d659e3ec` projected only active duty
  identity, goal, claim, and the candidate/settlement boundary.

The strict four-instance runs retained infrastructure-invalid trajectories as
zero rather than replacing them with recovery runs:

| Instance | exact `2abdc89d` | full projection `a1a791595` |
|---|---:|---:|
| `mgdm__htmlq.6e31bc8` | 98.21%, 337 turns, $3.04 | 95.88%, 298 turns, $2.15 |
| `mibk__dupl.1bf052b` | 83.65%, 360 turns, $5.03 | invalid at 263 turns |
| `eradman__entr.8e2e8b4` | invalid at 233 turns | 84.47%, 268 turns, $1.01 |
| `ffmpeg__ffmpeg.360a402` | 7.37%, 405 turns, $3.83 | 6.68%, 440 turns, $4.54 |
| invalid-as-zero mean | **47.31%** | **46.76%** |

The full projection was therefore rejected. Its lower HTMLq cost did not
compensate for 34 fewer resolved tests. The regressions concentrated in
remove-node behavior, exact help and error output, missing option values, and
file/stdin conventions. Its `validate.sh` was 4.9 KiB versus 11.8 KiB for the
exact-base candidate even though its parser implementation was larger. This
is evidence that repeatedly elevating executor policy to system authority can
create settlement-attention bias instead of improving behavioral coverage.

The minimal projection recovered part, but not all, of that loss:

| Instance | minimal projection | full projection | exact base or recovery |
|---|---:|---:|---:|
| `mgdm__htmlq.6e31bc8` | 96.63% | 95.88% | 98.21% |
| `eradman__entr.8e2e8b4` | 86.01% | 84.47% | 93.00% |

It completed both exact deliveries with 99%+ cache reads and used fewer turns
than the full projection on Entr, but it did not beat the no-projection base.
`b58eb4fef` consequently restores the product tree exactly to `2abdc89d`.
The projection commits remain only as falsifiable historical ablations.

Two invalid trajectories exposed an independent adapter reliability defect.
Neither server container was OOM-killed. Candidate Dupl was explicitly
classified lost after one transient public-API observation failure; exact-base
Entr ended as `execution_failed` while a tool was still live, without enough
persisted exception detail to assert the same immediate cause. Both recovery
replicates completed after the observer and terminalization path was hardened.
The runner now:

- accepts only same-Contract, same-revision execution successors with
  monotonic attempts, turns, and actions (`3845762`);
- retries up to six transient read-only observations while preserving the
  wall, turn, action, authentication, and coordinate conflict boundaries
  (`943bf12`).

The runner suite passes 180 tests. Fixed-runner recovery replicates discharged
and evaluated at 93.00% for exact-base Entr (343 turns) and 91.42% for
full-projection Dupl (180 turns). These replicates demonstrate the liveness
repair but do not overwrite the strict-run invalids or establish a model-side
performance gain.

The resulting boundary is simpler:

```text
ProContract Core owns durable duty, authority, attempt identity,
subject capture, independent settlement, and bounded liveness.

The executor prompt or RSI layer owns search and stopping policy.
The observer adapter retries temporary absence of evidence;
it never converts that absence into evidence of absence.
```

The evidence-backed canonical implementation remains `2abdc89d`; the reliable
ProgramBench execution coordinate is that OpenCode tree plus runner `943bf12`.
No claim of overall leaderboard improvement is warranted by this ablation.

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
- [Fresh three-instance calibration](../../run-artifacts/programbench-rsi-fresh-three-luna-max-20260809-214234/RESULT.md)
- [CMatrix capability-RSI calibration](../../run-artifacts/programbench-cmatrix-rsi-luna-max-20260810-102617/RESULT.md)
- [Tailspin private capability-RSI](../../run-artifacts/programbench-tailspin-rsi-gpt55-high-20260810-125520/RESULT.md)
- [Post-merge three-instance calibration](../../run-artifacts/programbench-postmerge-three-20260810-180829/RESULT.md)
- [Three-instance evaluated delivery](../../run-artifacts/programbench-evaluated-three-20260810-192321/RESULT.md)
- [Historical Pareto three-instance retest](../../run-artifacts/programbench-pareto-retest-20260810-215501/RESULT.md)
- [Evidence-frontier three-instance treatment](../../run-artifacts/programbench-evidence-frontier-20260811-105706/RESULT.md)
- [Grex boundary-evidence validation](../../run-artifacts/programbench-grex-boundary-20260811-192100/RESULT.md)
- [Grex matched A/B pilot](../../run-artifacts/programbench-procontract-pilot-20260811-150337/RESULT.md)
- [Fresh matched screening](../../run-artifacts/programbench-procontract-screening-20260811-154249/RESULT.md)
- [Hashcards essential-mechanism ablation](../../run-artifacts/programbench-procontract-ablation-20260811-191048/RESULT.md)
- [Four-task evidence-policy confirmation](../../run-artifacts/programbench-procontract-confirmation-20260812-003824/RESULT.md)
- [Reliable exact-base four-task run](../../.config/superpowers/worktrees/ProgramBench/full-runner/output/reliable-base-luna4-20260828-v1/RESULT.md)
- [Full-projection four-task run](../../.config/superpowers/worktrees/ProgramBench/full-runner/output/reliable-candidate-luna4-20260828-v1/RESULT.md)
- [Exact-base Entr recovery](../../.config/superpowers/worktrees/ProgramBench/full-runner/output/reliable-base-entr-recovery-20260828-v1/RESULT.md)
- [Full-projection Dupl recovery](../../.config/superpowers/worktrees/ProgramBench/full-runner/output/reliable-candidate-dupl-recovery-20260828-v1/RESULT.md)
- [Minimal-duty two-task run](../../.config/superpowers/worktrees/ProgramBench/full-runner/output/reliable-minimal-luna2-20260828-v1/RESULT.md)

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
