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

| Addition | Purpose and boundary |
| --- | --- |
| Explicit `checkpoint` in [Version](../packages/core/src/pro-contract/version.ts) and [Run](../packages/core/src/pro-contract/run.ts) | A completed method invocation can retain an artifact prefix such as `.research`. Continuation restores the verified original workspace plus that prefix, checking task, method, target, original deadline, baseline, and retained bytes. Failed/unknown scratch does not become state. |
| [Public trajectory projection](../packages/core/src/pro-contract/trajectory.ts) | Hash-checks the admitted source JSON, validates execution coordinates, and selects public user/assistant text and tool records with stable identities, hashes, missingness, and operation guards. Excludes private reasoning, provider metadata, internal messages, and non-text payloads. |
| [Executable research method](../packages/core/script/trajectory-research/workflow.ts) | Uses ordinary `ProContractRun` and native reasoning observations to choose inspection, bounded local computation, criticism, or conclusion. Retains questions, decisions, predictions, programs, outcomes, and optional notes/proposals in its explicit checkpoint. |

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

| Observed measure | g0 | g1 |
| --- | ---: | ---: |
| Native observations | 10 | 8 |
| Elapsed seconds | 751.978 | 638.159 |
| Recorded model cost | $0.1401318 | $0.1099594 |
| Final exact record-ID citations | 0 | 9 |
| Proposed research successor | None | None |

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
semantically valid. In fact, g1 stopped without repairing the zero-error detector
or doing the cheap semantic reannotation suggested by its critic. It deferred an
informative check on already permitted evidence, not merely an experiment that
required new external access.

That leaves a concrete next question: can the method keep packet schema distinct
from preview schema, check one positive and negative classification against the
original before aggregation, and distinguish “available verification remains”
from “new evidence is needed”? This is an editable research practice to test,
not a minimum-step Kernel gate. g1's proposed future “equal action budgets” are
not authorized count ceilings; any actual follow-up remains deadline-only.

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

The first two startup attempts performed **zero model calls** and remain retained.
Attempt 1 hit a container-name collision; the ownership guard protected the
historical container. In attempt 2, the orchestration's freeze step incorrectly
removed the installed binary's executable permission; both retrying services
were explicitly stopped. These are infrastructure failures, not zero-performance
model trials. A separately frozen third attempt uses the same inputs, policy
bytes, model, and runner revision, with distinct output identities and executable
modes recorded alongside hashes. Its startup receipts are retained independently;
this report does not yet contain a valid solver comparison.

A 22-case public-doc-derived diagnostic panel was frozen before continuation,
excluding the already exposed nine FX witnesses. Neither solver receives it.
Candidate archives must be frozen and hashed before either arm's panel result
is read. Evaluation records exact stdout/stderr/exit, every loss, and invalid
outcomes; the candidate cannot invoke the reference during evaluation.

**Matched continuation result: pending.** This is one targeted development pair,
not representative benchmark evidence or a promotion cohort. Same allowed
deadline does not mean equal realized computation: any comparison must report
actual work and inspect whether the proposed mechanism was used. A negative
result is a reason not to adopt, not a reason to replace the panel afterward.
Source: [S1].

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
solver, stochastic luck, or more realized computation. A real recursive chain
also needs a successor to execute and produce later research, not just appear
in a registry. None of these claims follows from g0's completed report.

Research selection and service selection remain separate. Development findings
can justify limited further research without replacing the incumbent. Adoption
still requires complete independent evidence and authority under a separately
frozen protocol, including task-level Pareto, safety, and established-full-pass
protections. Method rollback never deletes research history or automatically
invalidates independently accepted task results.

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
- **[S1]** `R/continuation-study/STARTUP-FAILURE.md`,
  `R/continuation-study-v2/STARTUP-FAILURE.json`, and each attempt's frozen plans
  and arm receipts; current attempt `R/continuation-study-v3/PLAN.json`,
  `FROZEN.json`, and arm receipts;
  `R/controlled-probes` frozen evaluator and plan. Runner revision
  `20ce3ac5e4a98bbe14a2fa59845107d97f255084`.
