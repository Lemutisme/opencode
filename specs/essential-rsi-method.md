# Evidence-led work and explicit method research

This is an **opt-in, unmeasured** method, not a replacement for an admitted seed
or a claim that Essential has caught up with R2. The normative Kernel, public
Contract Schema, historical `initialMethod`, and frozen experiments are unchanged.
No model or benchmark execution is started by these helpers.

## Solving method

`investigationMethod` in `packages/sdk/src/pro-contract/method.ts` expresses the
control loop rather than a required checklist or a minimum amount of work:

1. Identify relevant public behavior and distinguish observations from assumptions.
2. Choose a consequential unresolved observation. Investigate competing explanations
   with a discriminating experiment, or repair a supported shared cause.
3. Preserve the invocation, available outcome and incompleteness, not just a claim
   that a probe passed. Reuse ordinary workspace files and retained observations.
4. Replay the motivating case and affected behavior after edits. Update what remains
   unresolved; a matching neighbor does not establish untested behavior.
5. Carry evidence locators and unresolved next actions across context changes.
6. Submit when supported by the task's acceptance conditions; distinguish completed,
   uncertain and blocked work. A useful authorized repair should not disappear merely
   because a local test passed. A completed task need not consume its entire deadline.

Selecting this method changes instructions only. It does not by itself add durable
observation recall or prove that the model follows these instructions. In particular,
a checkpoint summary must not claim to be the entire prior tool transcript. Evidence
retention capabilities and their actual use need separate implementation tests and
trace audits. These instructions contain no task-specific answers or hidden tests.

For a **new** profile, explicitly select the method as `seed`. Keep the original
seed/profile as the control; never update an admitted profile in place.

## Research is an ordinary responsibility

`researchGoal({ parent, experience })` returns task-goal text. `parent` is a complete
`RSI.Method`; its exact admitted instruction bytes are embedded with their hash.
`experience` contains normalized public `/workspace/...` locators. The helper neither
reads these files nor grants access to them; the issuer must materialize only permitted
experience into the research task's public directory. A public-looking path does not
certify that its contents are safe or permitted. Private confirmation diagnostics must
not be put there. The list may be empty, making a justified no-change finding useful.

The requested output is `/workspace/method-research.json`:

```json
{
  "parentHash": "<exact admitted parent hash>",
  "disposition": "candidate",
  "reason": "A public observation supports a general mechanism; here is its uncertainty and a test that could refute it.",
  "evidence": ["/workspace/experience/observation.jsonl"],
  "method": { "instructions": "Complete replacement solving and learning instructions." }
}
```

A `no-change` artifact has the same parent identity, reason and evidence fields,
but **omits `method`**. Qualification may accept either disposition. It must not
reward producing a different hash or more prose.

### Admission example

The following composes the existing host API; it is not an autonomous research
scheduler. Before running it, the issuer must create a **new** release/profile,
public input directory, independent artifact verifier and original task deadline.
No implicit credentials or permissions are supplied by this example.

```ts
import { Schema } from "effect"
import { ProContractRSI } from "@opencode/sdk/pro-contract"

const parent = ProContractRSI.investigationMethod
const configuration = {
  ...qualifiedConfiguration,
  seed: parent,
  proposals: 0,
}
const task = Schema.decodeUnknownSync(ProContractRSI.Task)({
  id: "pct_method_research_1",
  goal: ProContractRSI.researchGoal({
    parent,
    experience: ["/workspace/experience/observations.jsonl"],
  }),
  directory: "/operator/new-research-public-input",
  total: 1,
  verifier: {
    directory: "/operator/new-private-artifact-verifier",
    command: ["/usr/bin/python3", "/verifier/judge.py"],
  },
  verification: "terminal",
  deadline: originalResearchDeadline,
})
// Pass configuration and task to a newly admitted ProContractRSI.open(...).run(...).
// This example does not install a returned candidate or start performance tests.
```

`qualifiedConfiguration` denotes an existing fully supplied Configuration, including
qualified runtime/model identities and frozen test assignments. The
verifier should independently check the frozen parent identity, disposition, required
fields, allowed scope and references. For a candidate it should also apply the actual
`RSI.method` validity boundary. Those are artifact checks, **not evidence of superior
performance**. Mere format validation cannot establish that an explanation is true.

The research model uses `contract_handoff` with `action: "submit"` to request
qualification of this artifact, or reports a real blocker. With `proposals: 0`, the
optional in-task `propose` action is not admitted. This is intentional: that action
would request the existing host's immediate paired comparison under the original
task allowance, not submit the research artifact described here.

After artifact qualification, separate issuer-owned work may freeze candidate
performance experiments. Choosing a candidate as a research parent does not deploy
it; adopting it requires complete independently verified evidence under the frozen
task-Pareto rule, safety and established-full-pass protection. A full recursive claim
also needs actual successor execution and a successor-authored next proposal. This
helper supplies none of those decisions automatically.

## Minimal diagnostic plan

First isolate **solving method quality** from **whether research occurs**:

- In a separately frozen cohort, compare the historical Essential seed with
  `investigationMethod` using the same new runtime, Luna/max, public inputs, scorer,
  resource allocation, fixed repeats and per-instance six-hour deadlines. Disable
  formal proposals on both sides; leave checkpoint/continuation behavior available.
- Preserve unknown scores as unknown, negative outcomes, safety and complete evidence.
  Do not change the running protocol. Existing exposed tasks are development diagnostics,
  not new blind confirmation. No minimum time or cumulative call/tool/money cap is added.
- Audit the proposed mediators in public traces: whether unresolved observations survive,
  repairs trigger relevant replay, and final readiness is consistent with known evidence.
  Better scores alone do not identify which instruction or runtime change caused them.

Only then run an explicitly admitted research task using allowed development experience.
Freeze its candidate before performance comparison. Keep research-parent selection and
incumbent adoption separate; allow an honest no-change outcome. A separately specified
successor-generation allocation is required to test recursion. Do not turn these exported
helpers or deterministic API tests into a claim that real-model RSI already works.

## Why this differs from R2 without migrating it

The readable R2 v5 method makes unresolved observations the control state and couples
repair, contrast, replay and stopping judgment. Its runtime also contains diagnostic
preservation during compaction and hash-addressed observation recall. More text alone
does not explain its historical scores, and copying its scheduler is not required to
retain those semantics.

The retained Luna study summary records R1 generating R2 and development improvement,
but not formal adoption. Recovered R2 policy bytes have SHA-256
`b382202cc07a74e212a8ab41e47a117a291dce1815e4967125a360a62e76d067`.
Historical provenance links that hash to the generation-1 manifest `c07bda25...`:

- `/home/duozhou/ICLR_paper/analysis/rsi_20260918.json`
- `/home/duozhou/ICLR_paper/analysis/RUNTIME_PROVENANCE_20260925/rsi_chain/evidence.json`
- `/home/duozhou/ICLR_paper/analysis/TERRA_RQ1_RQ2_AUDIT_20260924/source_availability.json`
- `/home/duozhou/run-artifacts/procontract-sol-r2-full-20260919/runtime/solver-policy.txt`

The 45 indexed original generation/selection files remain unavailable. The evidence is
retained provenance plus recovered bytes, not a newly complete audit of the old study.
Historical R2 versus Essential scores remain a descriptive comparison: different runtime,
environment and repeat design prevent assigning the observed gap to the seed alone.
