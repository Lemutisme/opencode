# ProContract: learning from execution trajectories

Status: development implementation and diagnostic study, 2026-10-05. This is
not delivery qualification, independent benchmark confirmation, or evidence of
fully autonomous RSI. It extends [research execution](pro-contract-research-execution.md)
without changing the Kernel's responsibility or acceptance semantics.

The question is not whether an agent can patch code after a failure. The original
solvers already did that. It is whether a running method can identify **why** work
improves or regresses, distinguish rival explanations, retain useful evidence,
and test a reusable change to its own way of working.

## 1. What the three trajectories establish

The original frozen ProgramBench submissions scored FX **373/2044**, Cheat
**213/297**, and Hush **1005/1201**. These are different tasks, not three points on
an improvement curve. The initial evaluation infrastructure failed because its
PATH lacked `uv`; a separate recovery evaluated the unchanged submissions with
no additional model calls. Both the failure and recovery remain recorded.

All three trajectories, inspected scores, and subsequent analyst-designed probes
are now **development data**. They cannot be relabeled as fresh confirmation.
The following diagnoses use public execution records, source snapshots, and
explicit experiments, not private model reasoning.

### FX: a conditional observation became an unconditional model

The first no-query invocation produced a TTY panic. The implementation generalized
that observation to every non-slurp invocation, although M16 had already observed
`-x`, without `-s`, returning `-1` successfully. The final source still rejects
all non-slurp execution before query evaluation. Three formatting sweeps used
753 reference calls, while this top-level mode distinction remained unresolved.
The issue was not simply too few probes: most of those probes could not falsify
the governing assumption.

There was real local improvement: the same 104-case comparison went from eight
mismatches at M49 to zero at M56. There was also a concrete regression: M47's
bracket-shorthand repair broke field shorthand, exposed at M66 and repaired at
M67. But the last differential batch, M101, retained six mismatches in nine
cases; no subsequent implementation edit occurred before green self-validation
and handoff. An offline replay of those nine already-observed inputs against the
final frozen candidate reproduced **3/9 exact matches**, while its unchanged
`validate.sh` passed.

This supports a narrow diagnosis: known contradictions did not remain active
constraints on later implementation and stopping. It does not establish how
many official failures one dispatch repair would recover. Sources: [F1], [F2].

### Cheat: repeated observations did not distinguish the semantic unit

Single-paragraph fixtures made whole-sheet and matched-paragraph search produce
the same output. A new two-paragraph contrast separated them: the reference kept
the matching paragraph and its context; the candidate printed the whole sheet.
Title restriction was a different failure: M9 already observed it, but the first
implementation and final validator omitted it. That is loss of an acquired fact,
not evidence of a later code regression.

A temporary candidate-only intervention on the **already exposed development
search tests** changed paragraph selection: **11/34 → 27/34**; adding title scope
gave **28/34**, without losing previously passing cases in that module. This
localizes part of the program error; it is not a new official score or evidence
that a better research method would discover the repair.

Some apparent differential observations were invalid: regex probes omitted the
search flag; sequential reference/candidate deletion shared a mutable fixture.
Conversely, the agent did repair an earlier quoting error, so not every probing
failure persisted. A new network-none local bare-remote experiment also showed
that Git success and dirty-state transitions were observable without external
network access. The restriction had been generalized too far into an explanation
of what could not be tested. Sources: [C1], [C2].

### Hush: useful abstraction changes coexisted with evidence loss

The solver built a lexer/parser/AST/interpreter, discovered library surfaces by
introspection, and used contrasts to distinguish receiver binding from partial
application and runtime scope from static declaration checks. These were useful
mechanism-level repairs, not just output patches. They are a plausible reason for
broad capability, but the cross-task score comparison cannot establish that cause.

Historical-source replay directly confirmed nonmonotonic progress. Sequential
commands and scope witnesses improved; T77 broke a previously successful
while/break case by referencing an unbound `loop_env`; T82 restored it. The final
candidate still returned `hinil\n` where the earlier public print-order witness
recorded `nil\nhi`. T130 also replaced invocation-name parameterization with the
literal `reference`, making a local comparison fit while losing behavior under
renaming. The two-name replay measures the candidate source transition, not a
newly established reference invariant.

All 79 planned replay rows were retained. An initial noexec-tmpfs validator
failure was infrastructure-inconclusive and preserved; a separately frozen
exec-enabled follow-up passed unchanged compile/validation. Thus the final
validator demonstrably passed while the known print-order witness failed.
Sources: [H1], [H2].

### The oracle itself was tested

No-model mutation probes deleted Hush diagnostic-flag effects and replaced Cheat
completion output with syntactically invalid shell. Both original validators
still passed. Stronger assertions on the **same inputs** rejected those mutants:
diagnostic output must differ from ordinary execution, and Bash completion must
parse with `bash -n`. These predicates demonstrate specific oracle weaknesses;
they neither certify complete semantics nor attribute the benchmark score loss.
Source: [O1].

The shared research hypothesis is therefore more precise than “test more”:
**preserve the conditions that make an observation informative, then preserve
its consequence when changing the implementation or deciding to stop**. More
runtime, a different model, and genuinely unobserved task breadth remain possible
contributors. They have not been controlled away.

## 2. Small implementation delta, unchanged authority

The host retains three existing kinds of durable information: Contract
responsibility, version/experiment archives, and authorized role bindings.
Research questions and experimental judgment belong to replaceable methods,
not new Kernel states or a permanent research controller.

| Addition                                                                                                                             | Purpose and boundary                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Explicit `checkpoint` in [Version](../packages/core/src/pro-contract/version.ts) and [Run](../packages/core/src/pro-contract/run.ts) | A completed method invocation can retain an artifact prefix such as `.research`. Continuation restores the verified original workspace plus that prefix, checking task, method, target, original deadline, baseline, and retained bytes. Failed/unknown scratch does not become state.     |
| [Public trajectory projection](../packages/core/src/pro-contract/trajectory.ts)                                                      | Hash-checks the admitted source JSON, validates execution coordinates, and selects public user/assistant text and tool records with stable identities, hashes, missingness, and operation guards. Excludes private reasoning, provider metadata, internal messages, and non-text payloads. |
| [Executable research method](../packages/core/script/trajectory-research/workflow.ts)                                                | Uses ordinary `ProContractRun` and native reasoning observations to choose inspection, bounded local computation, criticism, or conclusion. Retains questions, decisions, predictions, programs, outcomes, and optional notes/proposals in its explicit checkpoint.                        |

The method has no private provider loop. Native reasoning uses the existing V2
Session machinery; observations remain unverified. A local compute program runs
with the candidate's sandbox access, not host credentials or acceptance powers.
The six-hour deadline is the cumulative limit, not a required run duration; there
are no cumulative provider-turn, action, request, cost, or generation caps.
Individual timeout and byte/window guards remain.

The seed method can emit an optional solver policy or executable successor
package. Such output is only a proposal. Freezing, independent authorization,
actual subsequent execution, and adoption are distinct events. No successful
local computation, report, critic response, or ancestry relation accepts it.
The [method README](../packages/core/script/trajectory-research/README.md)
describes the task format, artifacts, and operational limits.

### Byte provenance is not scientific truth

A retained receipt proves which bytes and version produced an artifact under
the host's checked conditions. It does not prove that the artifact's claims,
citations, or computation are correct. In particular, method-supplied Bun code
can modify candidate-local packet files and event files. Candidate-reported
hashes and narratives cannot authenticate themselves.

Independent review must resolve citations against the **host-retained original
permitted packets/source**, verify the corresponding byte identities, and rerun
relevant calculations when needed. A packet marker alone does not prove that an
authorized projector produced it. Nor is field selection semantic secret
redaction: the principal must approve public text before staging it. Raw host
databases, credentials, encrypted/private reasoning, and hidden evaluation files
must stay outside research and solver workspaces.

## 3. We tested the researcher, not only the solver

The first actual research run, **g0**, used `openai/gpt-5.6-luna / max` on the
three projected trajectories. It completed ten native observations: six inspect
decisions, three local computations, and one conclusion. It used no critique
action, retained an empty notebook, and emitted a solver-policy proposal but no
successor research package.

Its report was appropriately **inconclusive**. It counted substring proxies for
reference/candidate comparisons and nearby edits, acknowledged false positives
from embedded script text, and did not establish semantic mechanism or causal
benefit. This is a completed research execution, not a demonstrated improvement.
The report remains unverified. Source: [R1].

Review found a concrete failure in our own method: every inspection preview was
a clipped JSON prefix. Across six events, only **7/18 selected source windows**
and **22/225 record IDs** were visible. Multi-source requests often displayed
only the first source; the researcher explicitly requested Hush again after its
earlier preview omitted it. Empty notes and proxy analysis may also matter, but
their causal role has not been isolated.

The next frozen method, **g1**, changes only inspection presentation: divide the
preview allowance across sources, windows, records, and fields, preserving
identities and explicit omissions. Offline rendering replay of the same six
events exposed **18/18 windows and 225/225 IDs**, with nonempty field snippets for
every selected record. The archived events remained unchanged. Source: [R2].

Both methods use the same nominal **21,845-byte** preview guard, but its semantics
are not identical: g0 bounded raw prefix bytes before JSON serialization; g1
bounds the complete serialized preview. Realized prompt-byte/token budgets are
therefore not exactly matched. This measured result is evidence visibility,
not evidence of better research decisions.

This correction was externally assisted engineering prompted by g0's trace;
**g0 did not generate g1**. The completed g1 run used the same task, packets,
model, action protocol, and host binary. Independent audit verified matching
captured inputs, receipts, and all retained inspection records against the
host's original packets. Source: [R3].

| Observed measure                |         g0 |         g1 |
| ------------------------------- | ---------: | ---------: |
| Native observations             |         10 |          8 |
| Elapsed seconds                 |    751.978 |    638.159 |
| Recorded model cost             | $0.1401318 | $0.1099594 |
| Final exact record-ID citations |          0 |          9 |
| Proposed research successor     |       None |       None |

g1's first request was too broad: the metadata for 187 selected records exceeded
the preview allowance. The records were retained successfully; **presentation**
was explicitly unavailable, not source collection. Its two narrower previews
then displayed all requested windows and IDs. Retrieval volume and repeated
deliveries did not uniformly decline.

The substantive difference was falsification. g1's first computation reported
zero edits because it misread nested tool objects as strings. Visible edit IDs
let it reject the result and request a parser repair. It then inspected the
records underlying its revised counts and requested a critic. The critic found
overlapping, non-independent chains and a second direct contradiction: a zero-error
count despite visible `status:error` records. The final report retained these
objections, included nine source-valid record citations, and proposed neither
solver nor research instructions. Both Contracts ended at `verification`, not
discharge or deployment. Neither method used the notebook.

This was a more specifically supported **inconclusive** report in one sequential,
unseeded pair, not an established method effect. Lower observed cost does not
prove population efficiency; correct citations do not make proxy classifications
semantically valid. g1 stopped without repairing the zero-error detector or
performing the suggested semantic reannotation. The later same-rubric audit
properly credits its correction of the zero-edit parser and explicit rejection
of the zero-error result. Reusing the critic's already exposed witnesses was
legitimate; another call was warranted only if it could change the scoped answer.
Semantic episode labels remained insufficiently validated, but absence of another
tool call is not itself a failed stopping decision.

That leaves a concrete next question: can the method keep packet schema distinct
from preview schema, check one positive and negative classification against the
original before aggregation, and distinguish “available verification remains”
from “new evidence is needed”? This is an editable research practice to test,
not a minimum-step Kernel gate. g1's proposed future “equal action budgets” are
not authorized count ceilings; any actual follow-up remains deadline-only.

### g2: a negative result, despite lower cost and more citations

The next externally proposed intervention added a generic contradiction-response
policy to g1's policy, without changing workflow bytes, task, initial packets,
or model. Its evaluation rubric was frozen before g2; g1 was retrospectively
reviewed by the same rubric, not relabeled as a preregistered baseline. g2 made
six inspections and concluded: **7 native observations, 230.664 seconds,
$0.0555788**, and 17 final exact record-ID citations. It performed no aggregate
computation or critique, and encountered no eligible source-versus-measurement
contradiction. The proposed mechanism was therefore **unexercised**, not shown
to work better or successfully prevent contradictions. Source: [R4].

Independent review authenticated every cited record against the host originals,
but found that their semantic relationships did not support the narrative:

- The FX triple connected malformed-JSON error observation, a mixed-array
  rendering edit, and a themes check: three different behavior surfaces.
- The Cheat triple connected a failed literal edit, comment rewording, and
  `py_compile`: editing recovery and syntax validity, not behavioral repair.
- Hush's probe and lexer change plausibly concerned the same issue, but the
  cited later asset runs did not replay its triggering command-block input.

These objections were discovered after completion, not ignored feedback
available to g2. They show why **valid citation is not support for the claimed
relation**. A narrative can repeat the same adjacency error as a keyword counter.
Calling coverage/selection the narrowest supported mechanism was too strong;
it remains an explanation to test, not an identified cause of three task scores.

The access tradeoff also persisted: four broad previews retained all 72 record
identities each, but clipped **742/757 displayed fields**. g2 did not follow its
consequential middle-trace examples with focused full-field retrieval. A small
terminal request had no clipped fields. This identifies an acquisition-granularity
problem, not a reason for a global record quota. Lower cost, more IDs, and an
inconclusive conclusion do not establish better research. g2 remains unverified
and is not adopted as a default.

### g3: a real generated successor, with a censored outcome

Unlike g0/g1, g2 emitted a solver proposal and `.research/candidate`: the executing
workflow with model-proposed research instructions. The host froze that exact
package without human edits, checked its source linkage to the g2 receipt,
qualified startup, and independently granted limited research execution. The
exact generated policy then appeared in g3's native requests. This establishes
**one generated-and-run researcher succession link**: a policy change with
inherited executable code, not merely a registry entry. Source: [R5].

The new task supplied g2's report and the independent critique alongside the
original packets, asking the successor to defend, narrow, or retract disputed
same-behavior claims. The question and feedback were selected externally; this
was not a controlled g2-versus-g3 comparison or an unaided research loop.

The investigator explicitly cancelled g3 after approximately **15m16s**. Its
original six-hour deadline was unchanged, not exhausted; no count ceiling was
introduced. The archive retains **12 completed method invocations, 12 native
responses, and $0.1550558 declared response cost**. Seven completed computes
include four output-limited outcomes; the three nontruncated computes reread
predecessor artifacts. Three inspections repeatedly delivered the same nine
records, authenticated against the host originals. There was no completed
`conclude`, final report, successor package, or handoff. Source: [R6].

The outcome is **investigator-censored, not completed research or demonstrated
eventual inability to finish**. Response 11 was malformed and recorded as an
invalid action. Response 12 is retained and valid, but its computation has no
completion receipt: that operation's outcome remains unknown, and scratch is
not a completed checkpoint. The Contract remains **active**. Cancellation does
not erase its responsibility, convert it to budget exhaustion, or authorize an
automatic retry of the unknown invocation.

The trace exposes a second problem in our own method. The old six-event view
held roughly three operations because decisions and outcomes occupied separate
slots. The optional notebook stayed empty. Decisions **1, 5, and 9** read the
same predecessor artifacts; decision 5 said they had not yet been read after
the first completed read had left its view. Decisions **2, 6, and 10** inspected
the same nine records after the preceding inspection was evicted. This is a
measured gap between the archive and the selected view, not proof that every
reread was unnecessary or that a new view will change model choices.

There was also partial semantic progress. Response 11 recognized the FX
cross-surface, Cheat syntax-versus-behavior, and Hush missing-same-condition
problems; response 12 continued to acknowledge the evidential gap. This is
feedback-informed revision, neither a final report nor a validated alternative
explanation of task scores. Stopping post hoc prevents a claim about how that
revision would eventually end.

### Next diagnostic: restore prior-work facts without inventing memory

The new editable workflow separates an exact operation index from recent
scientific detail. It materializes a hashed full index and notebook as ordinary
checkpointed files, exposes bounded index rows, and preserves the latest three
outcome previews. Rows retain declared actions, selectors, event references,
recorded outcomes, and explicit omissions. Program text is labeled
`code-text-not-observed-IO`: a declared read plus exit zero does not prove a file
was read, understood, or established as scientific evidence. No Kernel state,
semantic summary, acceptance power, or automatic deduplication is added.

Offline comparison rejected an initial equal-slot layout because it hid an FX
quote-escaping edit and a malformed-JSON comparison. The preferred index retained
those leads and every historical recent-outcome preview unchanged, while making
the earlier completed-read facts visible at decisions 5, 6, and 8. Older result
bodies still require retrieval; bounded index rows can leave the prompt with
explicit omissions. These measurements show **visibility, not semantic memory
or improved decisions**. No change was applied to frozen g3. Source: [R7].

A separately documented **g4 prelaunch plan** preserves the generated g3 policy,
question, permitted evidence, model, and deadline-only protocol while changing
this presentation. Its task changes one provenance sentence, so it is not an
identical-prompt experiment. The correction is externally assisted, not source
generated by g3. At this report boundary it is pending implementation review and
freeze: **no launch or outcome is claimed**. The proposed observations are
correct use or retrieval of prior work and condition-supported claim revision,
not merely fewer calls or a completed report. Its historical comparator is
censored; one diagnostic cannot establish a population effect or adoption.
Source: [R8].

## 4. Matched continuation: distinguish method benefit from another chance

A separately frozen exploratory FX study starts two fresh tasks from the same
source checkpoint and public trajectory. Both get the existing acceptance policy
and the same continuation context. Only the treatment adds a conditional
counterexample-frontier policy: retain consequential uncertainty and select a
discriminating next check rather than simply accumulate more activity.

The intervention was analyst-orchestrated from the forensic findings, not
generated by g0. Both arms use the same runtime/model and a fresh six-hour
deadline, with no cumulative count or monetary caps. Historical cohorts and
their original budgets remain untouched. The new runner seeds inputs before
task/provider admission, verifies the frozen inventory, and fails closed on an
unknown or conflicting seed outcome.

The first three startup attempts performed **zero model calls** and remain retained.
Attempt 1 hit a container-name collision; the ownership guard protected the
historical container. In attempt 2, the orchestration's freeze step incorrectly
removed the installed binary's executable permission; both retrying services
were explicitly stopped. These are infrastructure failures, not zero-performance
model trials. Attempt 3 failed because its preseed guard treated the mandatory
readiness probe's exact pre-forward denial as provider work. Each arm had one
blocked accounting row, but no model admission, seed import, or Contract issue.
The correction accepts only that specifically evidenced denial; it does not
erase the row or ignore arbitrary 403s.

The corrected runner passed **316 tests** and a separately frozen real no-model
lifecycle exercise: isolated readiness check, exact seed import, native restart,
preissue adoption without reseeding, and owned cleanup. Only denied readiness
requests were recorded; no provider or deadline admission occurred. This qualified
runner revision `1c41f24a83ea76a5604fc77d60ee9fecbeade96d` before the separately
frozen **continuation-study-v4** launch. Both v4 arms completed real model
execution from the same source inputs, model, runtime, and study measures, with
their separately frozen policies. Prior failures remain separate, unchanged
evidence. Sources: [S1], [S2].

A 22-case public-doc-derived diagnostic panel was frozen before continuation,
excluding the already exposed nine FX witnesses. Neither solver received it.
Both candidate archives were frozen and hashed before either evaluation began;
independent integrity review checked receipts, input/evaluator identities, and
exact stdout/stderr/exit results. The evaluation candidate could not invoke the
reference. All 44 reference observations completed, with identical repeats.

**Parent 12/22 → neutral 17/22 and frontier 17/22.** Both gained the same five
cases, retained the same five failures, and had zero panel regressions or invalid
cases. The frontier policy ties neutral on every outcome: **no treatment
advantage or adoption is supported**. This is one targeted development pair,
not benchmark-wide improvement, statistical equivalence, transfer, or promotion
evidence. The panel is now inspected feedback, not future independent
confirmation. Sources: [S1], [S3].

| Realized public Session work  |          Neutral |         Frontier |
| ----------------------------- | ---------------: | ---------------: |
| Provider turns / tool actions |        196 / 209 |        202 / 218 |
| Elapsed minutes               |            30.15 |            43.57 |
| Recorded model cost           |      $1.79987724 |      $1.78385704 |
| Input / output tokens         | 320,687 / 47,798 | 326,356 / 55,179 |

Elapsed time runs from user-input creation to the last completed message. Same
six-hour allowance did not mean equal realized work; neither the time difference
nor small cost difference establishes efficiency from one stochastic pair.

Both agents consulted history, ran fresh comparisons, changed source, and saved
regression tests. Both eventually separated viewer/no-query from non-slurp query
and implemented per-input streaming. These repairs explain the shared query-mode
gains, not a frontier-specific benefit. More opportunity to continue, shared
context/base policy, and additional computation remain sufficient explanations;
this pair does not isolate the effect of history itself.

The treatment reached execution: its exact frozen policy appears in admission
and public runtime records. Yet **retrieved evidence and written notes did not
reliably constrain later claims**. Frontier M8 retrieved historical M16's `-x`
without `-s`, returning `-1`. At M99 it nevertheless wrote that no-slurp input
panics; M121 moved that overbroad guard ahead of parsing. Only a fresh M123
comparison led to M127's no-query qualification. Final `WORKING-NOTES.md` still
contains both:

> “no `-s` reaches the `/dev/tty` panic in this non-TTY cleanroom”

and

> “Query expressions use a per-item stream when `--slurp` is absent (expressions
> are the documented non-TTY path)”

Persistence alone did not make these notes valid working knowledge.
Both sources also retain `' '.join(expr_parts)`, discarding argv boundaries.
Neither continuation performs a fresh separate-stage versus joined-expression
contrast, despite frontier retrieving such a historical contrast at M8. The
panel's argv group remains **0/4** in both arms. Hundreds of valid renderer
comparisons could not answer that different semantic question.

Broad testing was not simply wasted: frontier's renderer change broke at least
seven previously passing shared-seed inputs, and later same-300 replays went
**4 → 1 → 2 → 0** mismatches, detecting and repairing regressions. But green
summaries still need their conditions. Neutral's broad comparisons weakened from
exit/stdout/stderr to exit/stdout; their falling mismatch counts are not one
unchanged strict oracle. Frontier observed malformed TOML exiting successfully
where the reference failed, omitted those cases from its later valid-input
replay, and inaccurately summarized them as clean language diagnostics. Both
native delivery replays passed; neither demonstrated full semantic equivalence
or reconciliation of every known contradiction.

The next question is thus narrower than “add a notebook”: can a replaceable
method connect a retrieved witness to a **condition-scoped claim revision and
the next discriminating action**, without weakening the comparison oracle?
That is a falsifiable research question, not an already effective intervention
or a new Kernel gate. The negative method result remains in the archive; no
frontier-policy adoption or automatic promotion follows. Source: [S3].

## 5. What remains necessary within and across tasks

Within a task, a useful replaceable method should recover outstanding questions
and valid observations at decision boundaries, distinguish invalid experiments
from mismatches, select a cheap informative probe, and replay affected witnesses
after a coherent change. An observation should retain its conditions—argv,
input, state, environment, source/version, and outcome where applicable. These
are research records, not a Contract for every thought. The representation can
vary for code, proofs, documents, and other tasks; no fixed test-count or
reflection schedule belongs in the Kernel.

Across tasks, the method should retrieve relevant **mechanisms and failed
experiments**, not import task-specific answers as proof of general skill.
Examples worth testing are lost negative constraints, indistinguishable probes,
stateful comparison interference, or conditional behavior generalized beyond
its conditions. A new task must instantiate and test the relevant question.
The current work provides evidence access and an executable research method;
automatic live triggering, reliable semantic diagnosis, and beneficial transfer
are not established by this study.

The next research-method comparison needs the same target parent, permitted
experience, feedback rights, and allowed deadline for old and new researchers.
Each must select its candidate using development evidence only, followed by
fresh independent assessment. Multiple starting points and repeats are needed
to separate researcher improvement from archive accumulation, a better starting
solver, stochastic luck, or more realized computation. g3 supplies execution
provenance for one generated successor, rather than just a registry entry.
Repeated autonomous succession and improved successor-generation ability remain
unestablished; no report or lineage identity alone demonstrates either.

Research selection and service selection remain separate. Development findings
can justify limited further research without replacing the incumbent. Adoption
still requires complete independent evidence and authority under a separately
frozen protocol, including task-level Pareto, safety, and established-full-pass
protections. Method rollback never deletes research history or automatically
invalidates independently accepted task results.

## 6. Technical validation is not research qualification

The retained pre-index validation receipt for revision `4e4c3d9941` records
**1,525 Core tests**, **12 native tests**, and the relevant package typechecks.
It predates the exact-index change and does not qualify that newer code.
No public Protocol or Server `HttpApi` changed, so no generated Client/SDK update
was required. These checks support
the implementation's tested behavior, not causal research quality, solver
improvement, transfer, or deployment eligibility. Running cohorts retain their
own frozen runtime/source identities rather than inheriting later test results.

## Evidence index

Local study root `R`:
`/home/duozhou/run-artifacts/procontract-trajectory-research-20261005`.
Historical cohort root `H`:
`/home/duozhou/run-artifacts/programbench-essential-3-20261005`.
These paths identify retained local evidence; they are not a promise that raw
artifacts are safe or included in this repository. Publish only reviewed public
derivatives, never private host state or cohort secrets.

- **Original scores/recovery:** `H/evaluation-recovery-v1/RESULT.json`.
- **[F1]** `R/analysis/fx/REPORT.md`, `validation-audit/FINDINGS.md`.
- **[F2]** `R/analysis/causal-probe/fx-retained-replay.json`, `replay_fx.py`.
- **[C1]** `R/analysis/cheat/REPORT.md`, `probe-results.json`, `probe-provenance.json`.
- **[C2]** `R/analysis/cheat/search/REPORT.md`, `ablation-result.json`, `hashes.json`.
- **[H1]** `R/analysis/hush/REPORT.md`, `historical-witnesses.json`, `source-snapshots.json`.
- **[H2]** `R/analysis/hush/REPLAY-RESULT.md`, `REPLAY-SUMMARY.json`, replay/follow-up plans.
- **[O1]** `R/analysis/oracle-mutation/results.json`, `mutation_probe.py`.
- **[R1]** `R/run-g0.json`; retained run `23f1011b-21f1-4a88-9967-6ee8d16a331a`,
  `artifacts/.research/report.json` and events. Read only reviewed public fields.
- **[R2]** `R/analysis/research-rendering/RESULT.json`, `replay.ts`;
  `R/research-g1-plan.json`. g0 method hash
  `45b3c5d535a17d3f8f1f2b6450714d10ba580c635a64fe60b06ee5d90b511951`;
  g1 method hash
  `f5895ade08609ef2ec5e082cb44e2b65d2bd9c71dab69120929ab21608690c2a`.
- **[R3]** `R/analysis/research-method-comparison/REPORT.md`, `AUDIT.json`;
  g1 final run `ec745448-384e-4d96-8dab-efb88eed340b`.
- **[R4]** `R/analysis/research-stopping/result/REPORT.md`, `AUDIT.json`;
  `R/research-g2-plan.json`; g2 final run
  `9b263788-6d04-457c-9e8b-304ef9508f65`.
- **[R5]** `R/research-g3-plan.json`, `source-g3.json`, `qualification-g3.json`,
  `grant-g3.json`, and `method-g3.json`; exact generated version
  `722713caaccf59b3aa698715ab1bfe285e5838e6bec8b732c20d846ec7657921`.
- **[R6]** `R/analysis/research-successor/REPORT.md`, `SUMMARY.json`;
  `R/research-g3-cancellation.json`, `research-g3-post-stop-contract.json`.
- **[R7]** `R/analysis/research-context/INDEX-REPORT.md`, `RESULT-index.json`,
  and retained paired-slot/pooled comparators.
- **[R8]** `R/research-g4-prelaunch-plan.json`; a plan, not an execution receipt.
- **[S1]** `R/continuation-study/STARTUP-FAILURE.md`,
  `R/continuation-study-v2/STARTUP-FAILURE.json`,
  `R/continuation-study-v3/STARTUP-FAILURE.md`, and each attempt's frozen plans
  and arm receipts; current cohort `R/continuation-study-v4/PLAN.json`,
  `FROZEN.json`, and arm receipts; `R/controlled-probes` frozen evaluator and plan.
- **[S2]** `R/adapter-preseed-smoke-v3-20261005/RESULT.json`, `FROZEN.json`,
  `QUALIFIED.json`; runner revision `1c41f24a83ea76a5604fc77d60ee9fecbeade96d`.
- **[S3]** `R/analysis/continuation-v4-trajectories/AUDIT-PROTOCOL.md`,
  `REPORT.md`, `SUMMARY.json`; frozen public projections and recomputation script.

Validation receipt: `R/analysis/validation-4e4c3d9941/receipt.json` and sibling
`*.tool-output.txt` files. These extracts were assembled from retained tool
outputs after validation, not captured as original redirected shell logs.
