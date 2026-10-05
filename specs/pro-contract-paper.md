# ProContract Paper Skeleton

Status: research proposal, not a report of completed paper experiments.

Recorded: 2026-09-04. This document preserves the paper discussion and defines
the claims that subsequent experiments must earn. A Best Paper is an aspiration,
not an outcome that the current evidence establishes or that this plan promises.

## Current research priority

Revised direction, 2026-09-04: **C1 is primary: continuity of responsibility and
currently justified completion under replaceable execution.** This supersedes
the earlier same-day C2-first decision. A projection ablation holds settlement
authority fixed; it cannot identify the architectural effect of separating
search from settlement. C2 is an interface hypothesis. C3 is a later application.

The proposed insight is not merely that generation and verification should
differ. Completion is a history-dependent, defeasible recognition: unchanged
artifacts and test logs can require different current dispositions after changes
in authorization or admitted support. The same boundary must preserve outstanding
duties when execution stops or changes hands.

Start with a paired-history lifecycle probe, strong CI/durable-workflow controls,
and individual semantic ablations. Measure false acceptance, false quiet, useful
delivery, unnecessary blocking/reopening, and recovery cost together. A system
that always rejects must not count as a win. Then test task-linked consequences:
synthetic counterexamples alone cannot establish practical value or failure prevalence.

The reported 200-task result belongs in the effectiveness evidence, subject to
final provenance and metric reconciliation. It does not replace causal boundary
experiments, but moves performance motivation beyond three-task anecdotes.
Neither a negative interface result nor absent recursive advantage automatically
refutes C1. The detailed direction is recorded in the
[experiment plan](pro-contract-paper/experiment-plan.md#0-当前方向决策).

## 1. Working title and central question

**ProContract: Separating Search from Settlement**

Settlement concerns the authorized disposition of an exact duty. Successful
fulfillment (`discharged`) recognizes an exact claim and artifact under currently
valid authorization and admitted evidence. An accepted defeater can remove that
current support without deleting the historical decision. Issuer-authorized
`released` relinquishes a duty; it is not proof of successful fulfillment.
Neither model termination nor finite acceptance establishes all semantic quality.

> When executors and search strategies change, what preserves outstanding duties,
> the justification of completion, and responsibility after that justification fails?

Mutable search and independently authorized settlement should be separate.
The scientific question is which explicit semantics preserve that continuity,
and at what cost to useful delivery, relative to well-configured existing systems.
How much institutional state to show the model is a separate interface question.

In Chinese, the discussion's central formulation is:

> 搜索可以变化，但已经承担的责任、完成认定的依据，以及失证后的处置，
> 不能随执行者一起漂移。

The proposed contribution is a problem definition, justified state distinctions
and transition properties, and measured lifecycle utility. It is not a claim
that only ProContract can implement these semantics, or that renaming approval,
persistence, or truth maintenance establishes novelty.

## 2. Frozen starting point

| Coordinate                           | Value                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| OpenCode branch                      | `contract-policy-split`                                                        |
| Runtime reference                    | `910d9f2856323ad5493ee52f8cb2c315d2172e10`                                     |
| Inspected HEAD                       | `524da4a639a8f0192453428d2ff59b89315ed424`                                     |
| Difference from runtime reference    | Only `specs/pro-contract-experiments.md`                                       |
| User-reported model label            | GPT-5.6 Luna Max                                                               |
| User-reported three-task macro score | 93.6037%; task identities and original aggregation not independently recovered |

The user additionally reports a completed **200-task Luna Max cohort**, exceeding
leaderboard Sol by approximately **1.5%**. Its final aggregate, units, and exact
run mapping have not yet been independently reconciled. This report changes the
scale of the effectiveness evidence, not the causal status of the comparison.

The public [ProgramBench leaderboard](https://programbench.com/), inspected on
2026-09-04 and marked updated 2026-08-16, lists Sol xhigh at **1.0% resolved
and 69.9% average test-case pass rate**. These are different metrics. Do not
compare macro pass rate to resolved rate, or convert “1.5%” into percentage
points without checking the actual aggregate and denominator.
The benchmark's primary metric is fully resolved instances; average pass rate
is auxiliary. Be explicit about which metric the reported gain improves.

One local candidate campaign, `luna-max-policy-split-p0-200-20260902-v5`, has
200 trajectory records, a wrapper summary marked failed, and 165 per-task
evaluation files at inspection. It has not been established as the user's final
aggregate. Stored evaluation status is not a live-process observation; this
snapshot does not refute the reported completed run. Before publication, bind
all task IDs and selected submissions to immutable evaluation results, failure
and recovery rules, runner/model settings, and the leaderboard snapshot.

A confirmed gain here is system-level effectiveness across different models and
harnesses, not an identified kernel effect or a matched non-inferiority result.
It can establish competitive utility; stronger attribution needs its own control.

The three-task score is not an established overall result, a causal effect, or
proof of recursive improvement. Do not combine it with a different task cohort,
replace failed runs with recovery runs, or infer superiority from unmatched
public model results.

An experiment coordinate must additionally freeze the runner revision, model
identifier and settings, prompts, policy, evaluator and image identities,
artifact selection rule, task cohort, and compute budget. Runtime identity alone
is insufficient. The separately existing `contract-tcb` branch has later runtime
changes; do not silently attribute those semantics or hardening to benchmarked
`910d9f285`. If both are evaluated, label both implementations explicitly.

## 3. Scientific motivation

### Same artifacts, different justified recognition

Suppose B's completion expressly relies on evidence supporting A. Compare two
histories with the same current artifacts and original test logs. In the first,
the evidence remains admitted. In the second, an authorized, exactly bound
defeater removes A's support. B can remain completed in the first history, but
requires renewed responsibility in the second. Its bytes need not change.

The negative control matters: if A merely helped generate B, and B has independent
admitted support, defeating A must not automatically reopen B. Likewise, a low
broad benchmark score need not defeat an unrelated narrow delivery claim.
The relation is live support, not generic ancestry.

This motivates a representation-independent requirement. If a state summary
maps two histories to the same state although they require different authorized
dispositions, no rule using only that summary can distinguish them. Construct
such pairs for revision, authority, outstanding duty, and live support/dependency
state. This explains needed distinctions, not a uniquely minimal schema or a
major theorem merely from reducer induction.

### Prior observations: constraints, not a unified mechanism

The existing pilots constrain design and attribution. They do not jointly prove
that institutional context impairs cognition, nor that the kernel raises quality.

| Observation                                                                                                           | Source                                                                                            | Entitled interpretation                                                  | Not established                                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Full repeated Contract projection did not beat the exact baseline; minimal projection recovered only part of the loss | [Reliable Contract ablation](pro-contract-experiments.md#2026-08-28-reliable-contract-ablation)   | Repeated projection is not supported as a stronger default by these runs | A causal effect of authority framing rather than length, sampling, or infrastructure                     |
| Policy on/off improved Entr by 26.62 points, but HTMLq by only 0.34 points at about 2.59 times cost                   | [Policy separation](pro-contract-experiments.md#2026-08-29-policycontract-separation)             | Policy usefulness is heterogeneous in the observed pair                  | The causal effect of separating policy from Contract identity, or a validated policy selector            |
| All six head-validation trajectories settled their delivery claims, while FFmpeg scored 5.49%                         | [Head validation](pro-contract-experiments.md#six-instance-head-validation-and-public-comparison) | Delivery acceptance and broad behavioral quality are distinct            | That settlement framing caused low quality, or that the verifier established the whole optimization goal |
| Historical recursive policy flow worked, but capability candidates were rejected                                      | [RSI calibration](pro-contract-experiments.md#capability-rsi-calibration)                         | Some flow and rejection mechanisms were demonstrated                     | Sustained, generalizable recursive capability improvement on the current runtime                         |

The six-instance strict mean was 58.50%, with one evaluator-invalid instance
assigned zero under that campaign's aggregation. Report that failure category
separately; it is not interchangeable with a behavioral score of zero. Do not
silently substitute valid-only means or assembled cohorts.

## 4. Proposed architectural principle

```text
Search:
observations -> hypotheses -> implementation changes -> tests -> policy updates

Settlement lifecycle:
admitted duty -> exact candidate -> recognition under authorization and support
      ^                               |
      +--- renewed duty/remediation <-+--- accepted defeater

Executor replacement, stopping, or escalation cannot erase the admitted duty.
Issuer-authorized release is a separate disposition, not successful delivery.
```

The two paths exchange exact candidates, finite evidence, and actionable
feedback. They need not exchange the entire institutional ledger on each model
turn. Search policy remains replaceable and experiment-owned.

For the secondary interface study, the audit adds an exposure distinction: current
"inject once" means one durable admission message, not one provider request.
That message remains in subsequent history until history selection/compaction
changes its representation. The interface question concerns additional
recurring institutional projection over this history-carried baseline. Removing
task or policy information after the first request is a separate treatment, not
a description of current behavior.

Three distinctions must survive the implementation:

1. A faithfully completed experiment may refute its hypothesis. Experiment
   completion is not candidate improvement and is not promotion authorization.
2. A candidate rejected for deployment may remain in a bounded research archive.
   Conservative promotion need not prohibit exploratory intermediate candidates.
3. Generation ancestry is not live evidential dependence. A later independently
   validated candidate is not invalid solely because an ancestor's evidence was
   withdrawn.

The frozen evaluation and authorization boundary applies to one declared
comparison. It is not an assertion that goals or evaluation methods can never
change. Their revision needs independent authorization and cannot be the
candidate's means of certifying its own success in that same comparison.

## 5. Candidate contributions and claim gates

### C1. History-dependent recognition and responsibility continuity

Specify the modifiable executor state, authenticated roles, exact candidate and
evidence identities, resource delegation, and authoritative support transitions.
State precisely what survives crashes, retries, executor replacement, and
withdrawal of evidence.

The required implication is:

```text
Discharged_t(claim, revision, subject)
  => AuthorizationValid_t(claim, revision, subject)
     and AdmittedSupport_t(claim, revision, subject)
```

`AdmittedSupport` means declared evidence-admission rules are met, not that all
semantic correctness has been proved. Do not apply this implication to `released`.
Quiet is relative to a scope and ledger frontier, and limited to discharged or
issuer-released duties. Crash, budget exhaustion, replacement, and escalation
do not settle outstanding duties.

Motivate the state distinctions with paired histories before proving conditional
preservation. For accepted defeaters, establish removal of affected live support
and assignment of responsibility, preserving historical decisions and unrelated
independently supported work. This is neither continual revalidation of every
artifact nor eventual completion: scheduling and resources remain external.

Any correctness result must be conditional on the stated mediation, isolation,
authentication, evidence-origin, and atomic-persistence assumptions. Hash
agreement proves identity, not the semantic truth or sufficiency of evidence.
The current cooperative deployment does not establish unconditional non-bypass.
Independent authority does not make a verifier sound. Settlement cannot undo
arbitrary execution-time side effects; those require effect-time mediation.

In the benchmarked runtime, current support is an admission state, not a
machine-checked proof that every prior defeater has been substantively resolved.
An accepted challenge removes current support; stale attestation identities or
coordinates are rejected. A new authorized issuer attestation may nevertheless
re-admit the same evidence bytes. Forbidding this without explicit defeater
disposition would be a stronger proposed policy, not an existing invariant.

Relevant boundaries: [constitution](pro-contract-constitution.md),
[truth-boundary audit](pro-contract-truth-boundary.md), and
[Linux lifecycle](pro-contract-linux-lifecycle.md).

### C2. A secondary hypothesis about the executor interface

Test whether moving institutional constraints out of recurring model context
changes final quality, compute consumption, or failure modes while retaining
the same enforceable acceptance boundary.

The experiment must distinguish policy content, policy presence, context length,
instruction role, repetition, cache behavior, and actual runtime enforcement.
A policy-on/off comparison alone does not identify separation's effect.

Do not remove essential task information, active authorization changes, or
actionable feedback merely to shorten a treatment. Initial projection contrasts
identify a content/role/length/position bundle. If matched controls explain the
result as token cost, narrow the claim. Positive, null, or negative interface
results do not by themselves establish or refute C1.

### C3. Consequences for continuous improvement

Compare a fixed mechanism, a once-improved then frozen mechanism, and a mechanism
whose admitted successors participate in further improvement. Charge all
candidate generation, unsuccessful experiments, selection, and evaluation to
the declared budget.

An RSI claim requires an advantage attributable to recursive participation, not
only one useful policy, additional search trials, or additional compute. Add
"Self-Improving Agents" to the title only if this evidence exists. Otherwise RSI
is an application or limitation, not the central empirical claim.

Recursive versus once-frozen identifies the value of continued adaptation. A
claim specifically about successor participation in candidate generation also
requires an iterative-deployment control: permit successive candidates to be
deployed, but keep the candidate generator frozen. Otherwise repeated policy
selection remains a rival explanation. Keep seed stages that fail to produce an
improved successor in the assigned-cohort analysis; do not select only successful
lineages into the experiment.

Before recursive superiority, test exact evaluation-to-adoption identity,
justified withdrawal, and retained utility after all costs. Current component
mechanisms do not form an authenticated end-to-end policy succession loop.
This remains proposed work, not an implemented capability for the abstract.

## 6. Experimental program

### A. Primary: lifecycle discrimination and task-linked consequences

Hold model, policy, task verifier, feedback contract, and total resource budget
fixed. Compare well-configured CI/durable workflow, full ProContract, and
individual semantic removals: exact revision/subject binding, cross-executor
duty retention, and support invalidation/closure. Each removal gets an explicit
paired-history counterexample and unaffected positive controls.

Test fault-free operation, executor loss/replacement, stale approval or retry,
accepted defeaters, and authorized release. Measure false acceptance, false
quiet, valid delivery/quality, false blocking or excessive reopening, and recovery
cost at prespecified horizons. Freeze an independent expected-state oracle, not
a copy of the reducer. Synthetic conformance tests come first; task-linked
perturbations establish practical consequences. Induced-fault frequency is not
natural-world incidence.

A workflow baseline that implements all these semantics remains a valid baseline.
If outcomes match, compare implementation/verification burden, portability, and
overhead rather than relabeling it as ProContract and excluding it. An unmatched
weak “no kernel” arm cannot establish architectural superiority.

### B. Effectiveness at useful task scale

Reconcile the reported 200-task record, selected artifacts and evaluator lineage,
and both resolved and average-pass metrics. Keep public Sol comparison as external
effectiveness evidence. Matched Luna/policy/budget comparison against the strong
workflow control is needed for causal attribution. Do not force a weighted
safety/quality score; report the joint operating tradeoff.

### C. Secondary: fixed-boundary interface utility

Compare history-carried admission, full recurring projection, and minimal
event-driven updates without changing settlement authority. Audit actual
requests and budgets first; then control content, length, role, and position.
Do not infer internal attention solely from scores or self-reports. Keep the
institution-by-policy factorial as an optional attribution extension, not a
prerequisite to the primary semantic experiment.

### D. Later: retained improvement, then recursive value

Use fixed, one-shot-improved, and recursively improved arms with equal total
search budgets and an untouched final evaluation set. Separate evidence used
for candidate search from final evidence of generalization. Repeated exposure
to a nominal holdout makes it part of adaptive selection.

The research reports are:

- [Causal and performance study](pro-contract-paper/causal-study.md).
- [Reliability and trust-boundary study](pro-contract-paper/reliability-study.md).
- [RSI and promotion study](pro-contract-paper/rsi-study.md).
- [Integrated experiment plan](pro-contract-paper/experiment-plan.md).

These are designs and audits unless an individual artifact explicitly records
an executed test. The current documentation task does not authorize paid model
campaigns, new cloud resources, or production changes.

## 7. Measurement discipline

- Primary architectural outcomes: false acceptance and false quiet, alongside
  useful valid delivery and false blocking at a bounded recovery horizon.
- Primary performance: independently evaluated quality of the selected final
  artifact under a frozen budget and artifact-selection protocol. Report
  ProgramBench resolved rate and average pass rate separately.
- Separate outcomes: institutional violations, availability failures, invalid
  evaluations, task failures, compute cost, wall time, and bad-tail behavior.
- Freeze task membership, outcome handling, estimands, exclusions, and stopping
  rules before confirmatory runs. Retain all attempts and recovery lineage.
- Analyze uncertainty at the task/run hierarchy. Individual unit-test cases
  are not independent task replicates, and paired stochastic runs need not
  share an effective model seed.
- Size confirmatory campaigns using pilot variance and a declared meaningful
  effect; task and replicate counts must not be chosen after inspecting wins.
- Report absolute quality at matched budget and quality/cost tradeoffs. Do not
  silently turn performance-first into cheapest-first.
- Preserve task disjointness and evaluator access controls. A content hash alone
  does not prove run-record honesty, evaluator secrecy, or data independence.

## 8. Related-work positioning

The following are comparison leads from the paper discussion, not an exhaustive
novelty review. Verify publication status and exact claims before submission.

| Work                                                                    | Why it is a close comparison                                                                                                                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Automated Design of Agentic Systems](https://arxiv.org/abs/2408.08435) | Agent generation and code-based search are not new contributions by themselves                                                                                              |
| [Darwin Godel Machine](https://arxiv.org/abs/2505.22954)                | Self-modification, empirical evaluation, and candidate archives precede this proposal                                                                                       |
| [CaMeL](https://arxiv.org/abs/2503.18813)                               | External control/data and capability boundaries precede this proposal                                                                                                       |
| [AgentSpec](https://arxiv.org/abs/2503.18666)                           | Runtime enforcement of agent rules is a relevant baseline                                                                                                                   |
| Scientific CI/CD for Self-Modifying Discovery Agents                    | The publicly discussed manuscript is a direct novelty risk for promotion gates, budgets, evidence, and rollback; venue status and detailed comparison remain to be verified |

Additional close comparisons:

- [CommitGuard](https://arxiv.org/abs/2607.10487) already studies temporal
  authorization, same-artifact/different-history cases, and commit-time freshness.
  History sensitivity alone is not our novelty. Compare post-recognition support
  closure and responsibility explicitly; absence from an abstract is not proof
  that a competing method lacks a feature.
- [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
  already provide stale-review invalidation and independent approval mechanisms.
  Truth-maintenance systems and durable execution also belong in the comparison.

Do not claim first self-modifying agent, first external safety layer, first
independent evaluator, or first evidence-gated promotion system. The desired new
knowledge concerns the combination of revocable recognition, obligation continuity,
and bounded remediation under replaceable execution, and its measured benefits
and costs. The difference from temporal authorization, truth maintenance, and
durable workflows must be demonstrated rather than presumed from terminology.

## 9. Paper outline

1. **Introduction:** identical artifacts and tests can require different
   recognition; replaceable execution must not erase outstanding duties.
2. **Problem setting:** exact claims, authorization, admitted support, live
   dependencies, quiet, actors, budgets, and deployment assumptions.
3. **ProContract:** necessary state distinctions, lifecycle semantics, conditional
   composition/preservation properties, and a minimal implementation.
4. **Experimental method:** strong workflow controls, semantic ablations,
   independent lifecycle oracle, task-linked perturbations, and cost accounting.
5. **Results:** full-cohort effectiveness as context, decisive lifecycle outcomes,
   then interface utility; retained/recursive improvement only if established.
6. **Analysis and limitations:** rival explanations, negative tails, evaluator
   limitations, isolation assumptions, overhead, and failure to generalize.
7. **Related work and conclusion:** distinguish the demonstrated principle from
   existing self-improvement, CI, enforcement, and durable-execution machinery.

Figure 1 should show two same-artifact histories, a genuine support edge, and
renewed responsibility after an accepted defeater. The main empirical figure
should show valid task quality/delivery against compute under normal and
perturbed lifecycles, with false acceptance and false quiet explicitly visible.
Both always-accept and always-reject shortcuts must be unattractive. Do not
substitute a rising development-score curve for generalization.

## 10. Introduction seed

Autonomous agents can change their plans, tools, and implementations, but changes
in execution raise a distinct question: what preserves unfinished obligations,
binds evidence to the claim currently being submitted, and reopens responsibility
when previously admitted support fails? Artifacts and test scores alone cannot
answer this question. The same artifacts and observations can have different
completion eligibility under different authorization and support histories.

ProContract separates candidate-producing search from authorized settlement.
Its executor-independent state records duties, exact claims and subjects,
authorization, and current evidential support. An executor can change its method,
submit a candidate, or request revised terms; replacement, termination, and policy
changes cannot themselves settle its duties. An accepted defeater changes current
support without erasing history, and affected duties receive renewed disposition.
These semantics require neither a fixed search policy nor repeated projection
of the entire ledger into model context. We separately evaluate lifecycle continuity
against strong workflow baselines, useful task performance at a declared budget,
and the utility of alternative executor interfaces.

This paragraph states a research program. Add empirical conclusions only after
the corresponding claim gates are satisfied.

## 11. Stop and pivot rules

- If context-matched comparisons remove the apparent placement effect, report
  the narrower finding. This rejects an interface explanation, not C1.
- If authorized lifecycle transitions still lose duties or preserve defeated
  recognition within the claimed boundary, the core implementation claim fails;
  benchmark scores and projection gains cannot substitute for a repair.
- If robust CI and durable execution match the invariants and outcomes, do not
  claim ProContract is necessary or uniquely superior. If no practical cost,
  portability, or verification advantage remains, drop empirical superiority.
- If recursive participation does not beat fixed and once-improved mechanisms
  at equal total compute, remove the recursive-capability claim, not C1.
- If isolation or evidence provenance is absent, restrict claims to the
  cooperative, trusted-caller boundary actually tested.
- If broad confirmation rejects a policy, retain that negative result and do
  not rescue it by choosing favorable tasks after inspection.
- If a strong paper cannot be supported by these tests, preserve the engineering
  and measurement contribution instead of expanding philosophical claims.
