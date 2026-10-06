# A replaceable task and trajectory research method

`workflow.ts` is a self-contained **candidate method**, not a new trusted research
controller. Freeze this directory with `ProContractVersion`, authorize that exact
method, and issue an ordinary `ProContractRun` task with an explicit native model
grant. The host's existing Contract, deadline, isolation and authorization checks
remain authoritative. No provider client or alternate model/tool loop is embedded.

## Task

For trajectory research, stage only permitted projected packets in the workspace. The projector is
`ProContractTrajectory.project`; never stage the raw global database, credentials,
private model reasoning or held-out evaluation files.

```json
{
  "question": "Which observations distinguish poor coverage from ineffective repair?",
  "packets": [
    {
      "path": "packets/task-a.json",
      "sourceID": "task-a-development",
      "summary": "Public execution trajectory; development-only observations"
    }
  ],
  "context": "State the study scope, known missing evidence, and permitted comparisons.",
  "operationTimeoutMs": 30000
}
```

`question` and `packets` are required; `packets: []` is valid. An ordinary local
Bun task can use the same execution primitive, read its staged task inputs and
write its durable solution under `.research/work`. Learning from its own captured
feedback does not require an archived trajectory, a second complete task rollout,
or a separate `solve`/`improve` engine. This method does not provide native solver
tools: its native model request is text-only, and its executable actions remain
isolated Bun computations and packet inspections.

`context` and `instructions` optionally
clarify the task. `operationTimeoutMs` is an individual local compute watchdog
(default 30 seconds, range 1–300000 ms), **not a cumulative research budget**.
The only cumulative execution limit is the original host deadline; it is never
reset by continuation. There is no turn, action, request, cost or generation cap.
Single-operation byte/window guards prevent an unbounded read, prompt or output.

The outer Version request wraps this as `task.input`. It supplies the immutable
Contract coordinates, deadline, past native observations and unresolved request
identities. `.research` is reserved for receipt-bound candidate checkpoint state;
a preexisting unbound `.research/state.json` is rejected.

## How the method works

The initial method requests a native text-only reasoning observation. The model
chooses one JSON action, including an optional updated `notes` working notebook:

- **inspect**: select permitted source IDs and record IDs, or an ordered window;
- **compute**: propose one self-contained Bun program, its rationale and a
  prediction which distinguishes explanations;
- **critique**: ask another native observation to challenge a particular claim,
  alternatives and missing evidence;
- **conclude**: report findings, uncertainty and discriminating follow-up work,
  optionally proposing solver and/or successor research instructions.

This is an editable action protocol, not mandatory research stages. Inspection,
computation, criticism and completion are selected by the running method. The
host does not choose a diagnosis or require a positive finding. One invocation
runs at most one proposed compute program and then yields a named native request
or a report. Every native observation is unverified. Unknown request outcomes
stop the method rather than being silently replayed.

## Same-task conditional method trials

An ordinary action may carry a **revision** and/or declare **uses** of earlier
active trials. These are optional method data, not Kernel hypotheses, new
acceptance states, or a mandatory reflection step:

```json
{
  "type": "compute",
  "rationale": "Try a smaller discriminating observation before changing the solution.",
  "prediction": "The concise output will expose the relevant contrast.",
  "program": "console.log(JSON.stringify({contrast: 'not yet evaluated'}))",
  "revision": {
    "condition": "A diagnostic computation produces more output than can be retained.",
    "previous": "I expected the whole result to remain visible; this is a retrospective account.",
    "change": "Print the distinguishing summary, retaining full local results separately when needed.",
    "expectation": "The next computation should retain the requested contrast without output truncation.",
    "reconsiderWhen": "The summary omits conditions needed to distinguish the explanations.",
    "reason": "An output-limit diagnostic challenges the observation method, not the underlying solution.",
    "evidence": [
      {
        "event": 2,
        "hash": "the exact 64-character SHA-256 of the earlier event file",
        "pointer": "/value/status",
        "quote": "output-limit"
      }
    ]
  }
}
```

The example's event/hash must be replaced by actual retained coordinates. There
is no preselected diagnosis or requirement to produce a rule. A revision may
change how the task is solved **or how the running method investigates its own
work**. The method preserves these distinctions:

- **Before an operation:** `compute.prediction`, or optional `inspect.prediction`,
  records its expectation. A later revision links a cited outcome to that prior
  declaration where present. The optional revision `previous` is always a
  retrospective account, never manufactured preregistration. An inspection
  prediction precedes only that local retrieval, not the recorded source
  experiment; it establishes neither unseen data nor independent preregistration.
- **After feedback:** the revision provides a condition, behavioral change,
  expected future consequence and reconsideration condition. Exact quotation
  checks bind it to retained bytes, **not semantic support, causality or benefit**.
- **During continued work:** its event index becomes the trial ID. Active advice
  is supplied to the next ordinary native decision prompt. `uses: [7]` declares
  application of earlier active trial `7`; it is not verified compliance.
- **When contradicted or unhelpful:** `replaces: 7` replaces that active rule;
  `change: null` retracts it. Both retain their evidence and reason. Retraction
  never erases history or automatically reactivates an ancestor.

Every revision field except `previous` and `replaces` is required when a revision
is chosen. `replaces` is required for retraction. Uses and successor carry select
only earlier active trials, not future or currently retracted ones. All revision
references and metadata are checked **before** changing the notebook, recording
any trial/use, or executing the action. Invalid metadata yields `invalid-action`;
the proposed operation does not run. No revision, critic, minimum number of
steps, positive result, or successor is required.

Evidence references use an event index, exact full-event hash, allowlisted JSON
pointer and literal quote. There are two explicitly different classes:

| Class                 | Allowed pointers                                                                                                                                                                                     | What the record establishes                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Captured outcome body | Compute `/value/stdout/text`, `/value/stderr/text`; inspection `/value/value/<window>/records/<record>/tool/content/<entry>/text/text` or `.../tool/error/text`                                      | The quoted bytes were retained as an unverified local/public observation.                 |
| Execution diagnostic  | Compute `/value/status`, `/value/exitCode`, `/value/stdout/bytes`, `/value/stdout/truncated` and stderr equivalents; inspection `/value/status`, `/value/error`; prior invalid-action `/value/error` | A recorded execution/measurement condition, not task correctness or method effectiveness. |

A diagnostic quote must match its entire string, or the JSON scalar spelling
(`0`, `true`, `false`). A body quote may select a literal substring. An empty
quote is valid only for a genuinely captured empty, nonpartial field. Missing
fields are not empty output; partial fields retain their status, original
hash/byte count, omissions and operation outcome. A timeout or output limit can
support a proposed measurement-method change; exit zero cannot become semantic
success. Source code, decisions, predictions, critic praise, tool inputs,
availability and lifecycle metadata are not outcome-body citations.
A prior `invalid-action` error may motivate repairing how the method uses its own
interface. It remains a non-execution diagnostic, without a claimed predeclared
experimental prediction; a successful revision's self-report is not a witness.
Compute stream `complete: false` also marks reader cancellation: a stopped empty
pipe is not evidence of empty output, even when no byte guard was exceeded.

`method-revision`, `method-use` and `method-import` events remain in the normal
checkpointed archive. Active advice is derived from that log, newest first.
Its separate 16 KiB serialized preview has explicit omissions and an already
materialized full hashed JSON archive under `.research/context`. This is a
presentation guard, not a count limit on trials, operations or learning. The
original task identity, deadline, grants, acceptance and adoption boundaries are
unchanged. There is no special self-modification authority.

Like existing research events, this is **candidate-local provenance**, not a
trusted verifier: arbitrary compute code shares write access and can tamper with
local files. Hash checks detect inconsistency, not a malicious candidate which
rewrites data and hashes together. External evaluation must inspect host-retained
artifacts rather than treat a quoted claim, self-rating or declared use as proof.
The implementation makes same-run policy adaptation executable; it does not
prove that the model discovers a useful revision or obeys it.

A compute process has no network/host credentials and sees only the surrounding
Version sandbox. Source, prediction, stdout/stderr, exit code and timeout/output
truncation are retained. A successful exit is not a scientific or task-level
pass. Arbitrary Bun code has the **same candidate workspace access** as the method;
path checks on inspection are not a second sandbox, and the child can modify
candidate-local files. Operation pipe capture is cancelled on timeout/output
limits; the outer Version namespace cleans up residual descendants on exit.
There is no cgroup memory/disk/PID denial-of-service guarantee.

The compute prompt documents the actual public-packet schema, with a structural
example. `tool.output` is availability, not the body: captured strings live in
`tool.content[i].text.text`, with `tool.error.text` separate. Input text is decoded
according to its encoding. Record IDs differ from message IDs; field status,
hashes, content order and missingness must survive extraction. Absent text is not
empty output, and tool completion is not inner-command success. This is schema
guidance, not a new accessor or mandatory research stage. It followed offline
replay of g4's wrong-field extraction; **the frozen g4 method did not contain or
test this later guide**. No improved model decisions are established by that
replay or by implementation tests.

Full research events stay under `.research/events`. The next reasoning prompt
separates recent evidence detail from an index of what the method declared and
what outcomes were recorded:

- The latest **three non-decision outcomes** retain their existing 21845-byte
  preview rendering unchanged, including failed operations, invalid actions and
  critic observations. Older outcome bodies remain available on disk.
- An exact local operation index pairs decisions with adjacent recorded outcomes.
  It retains event references/hashes, declared rationale, prediction and selectors,
  and recorded status/exit/output-size facts. Missing outcomes are explicitly
  `not-recorded`; malformed decisions remain unparsed, not successful operations.
  These associations are not evidence dependencies or acceptance decisions.
- Full index JSONL and notebook text are materialized as ordinary, hashed files
  under `.research/context` **before** the prompt advertises their paths. The
  checkpoint retains them with the full events. Indexing checks event bytes
  against their local recorded hashes; this is not host authentication.
- The prompt index is at most 32 KiB, individual row previews at most 4 KiB,
  and the notebook preview at most 16 KiB. Older index rows leave the view with
  exact omitted ordinal ranges and a complete archive reference. Clipped fields
  retain explicit omissions/hashes rather than invented semantic summaries.
  The complete serialized evidence view is at most 128 KiB; unrepresentable
  mandatory metadata fails explicitly.

Program entries preserve source hash, byte count and archive location, with a
short, explicitly clipped code excerpt. They are labeled
`code-text-not-observed-IO`: a declared `Bun.file` read plus exit code zero does
not prove that file was read, understood or scientifically validated. Likewise,
a retained result is not proof that the next reasoner has consulted it. Large
programs, older output bodies and omitted index rows require selected retrieval
or local analysis. Repeated experiments are not automatically deduplicated.

These are replaceable context guards, not Kernel rules or cumulative search
caps. An index can expose earlier work and still fail to improve research;
it does not guarantee semantic memory or establish a causal mechanism. Each view
currently rebuilds the index from the full event history; retaining per-prefix
index snapshots adds cumulative read, derivation and storage overhead. These
limits bound prompt presentation, not archive size, memory or cumulative work.
This seed does not add an incremental index store. Protocol-validated action
string fields must be well-formed Unicode so byte/hash references round-trip
through ordinary UTF-8 files; malformed fields receive an invalid-action
observation. Arbitrary extension properties remain JSON data, not program
execution facts.

Inspection previews divide their text allowance across sources, selected windows,
records and fields. A large early record therefore cannot hide later selected
sources. Compact tables retain source/packet hashes, record identities and hashes,
tool names/statuses and explicit field omissions. If even this metadata exceeds
the preview budget, the preview says `unavailable` rather than silently omitting
later records. The bound includes the complete serialized UTF-8 preview, not just
excerpt text; an impossibly small bound fails explicitly. Full event files are
unchanged and remain available for retrieval. This rendering policy improves
visibility of selected evidence; it does not establish better research decisions
or turn previews into independent evaluation evidence.

The compact preview preserves selected record order but omits detailed timing and
index metadata. Retrieve or compute over full archived records when those details
matter. Each event retains the same nominal 21845-byte guard (`128 KiB / 6`,
rounded down). Historical g0 applied that number to raw prefix bytes **before**
serialization; this renderer applies it to the entire serialized preview. These
are not identical realized prompt-byte or token budgets. The new 128 KiB guard
covers the entire serialized evidence view; the earlier six-preview view did
not bound its notebook and metadata together. It is a stricter serialization
guarantee, not a claim of equal realized tokens or more effective research.

This correction followed observed preview starvation in g0 and was
human/assistant-assisted engineering, not a successor generated or validated by
g0. Its frozen source, trajectory and reports remain unchanged. A subsequent
method still needs its own execution and evidence; better evidence visibility
alone does not prove better research or task performance.

## Outputs and recursion

All files are under the declared `.research` artifact/checkpoint:

- `state.json`: task/version/deadline-bound pending request and research state;
- `events/`: local/model observations, decisions, inspections and calculations;
- `operations/`: proposed program bytes and local execution outcomes;
- `work/`: optional durable ordinary-task solution artifacts;
- `context/`: hashed full operation-index JSONL and notebook snapshots referenced
  by bounded prompt views;
- `report.json`: **unverified** research report, including negative/inconclusive
  outcomes, uncertainty and follow-up questions;
- `proposals.json`: pointers explicitly marked **proposed-only**;
- optional `solver-policy.txt`: proposed task-execution instructions;
- optional `candidate/{workflow.ts,policy.json}`: executable successor method.

A research-instruction proposal copies the executing source into the candidate
and supplies the new policy. `conclude` may also specify `carry: [7]` to select
earlier active conditional trials for that successor; omitted trials are not
implicitly inherited. A carry-only proposal reuses the current base instructions.
Carry cannot select a revision newly created by the same conclude action; record
a trial in an earlier ordinary action when its structured carry is desired.
The selected records retain their originating execution identity and observation
references, remaining scoped, unverified proposals. No task checkpoint, pending
request, completed state or task authority is transplanted. On fresh successor
execution the frozen policy creates `method-import` records with fresh local trial
IDs and the original provenance, allowing later declared use, revision or
retraction. Imported evidence is not claimed to have occurred in the new task.
Each local trial ID is paired with its registering execution identity; an import
also retains the preceding trial's coordinate. Individual observation references
keep their original execution identity across repeated carry/import, so a fresh
local ID is never falsely paired with an older task.

Freezing and independently authorizing that package
allows it to execute a later research task. The new policy really controls its
next decisions; it is not just a version label. Authorization, independent
validation and adoption are deliberately outside this package. Producing a
report does not prove that an improvement worked or that a long-term improvement
duty has been discharged.

Packet/source hashes bind observations to bytes, not truth or permission. The
method verifies the projected packet marker and hash but cannot authenticate that
a hostile caller used the projector. The host must stage only explicitly permitted
projection outputs. A critic shares the admitted model/evidence boundary and is
**not** an independent confirmation evaluator. Descriptive trajectory analysis
can justify a fresh experiment, not establish causal benefit, task-Pareto
improvement or deployment suitability.
