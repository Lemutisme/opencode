# A replaceable trajectory research method

`workflow.ts` is a self-contained **candidate method**, not a new trusted research
controller. Freeze this directory with `ProContractVersion`, authorize that exact
method, and issue an ordinary `ProContractRun` task with an explicit native model
grant. The host's existing Contract, deadline, isolation and authorization checks
remain authoritative. No provider client or alternate model/tool loop is embedded.

## Task

Stage only permitted projected packets in the workspace. The projector is
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

`question` and `packets` are required. `context` and `instructions` optionally
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

A compute process has no network/host credentials and sees only the surrounding
Version sandbox. Source, prediction, stdout/stderr, exit code and timeout/output
truncation are retained. A successful exit is not a scientific or task-level
pass. Arbitrary Bun code has the **same candidate workspace access** as the method;
path checks on inspection are not a second sandbox, and the child can modify
candidate-local files. Operation pipe capture is cancelled on timeout/output
limits; the outer Version namespace cleans up residual descendants on exit.
There is no cgroup memory/disk/PID denial-of-service guarantee.

Full research events stay under `.research/events`. The next reasoning prompt
uses the current notebook and six recent, explicitly bounded previews. Older
records remain available for selected retrieval/local analysis. This is a
replaceable seed context policy, not a Kernel rule or a cumulative search cap.

## Outputs and recursion

All files are under the declared `.research` artifact/checkpoint:

- `state.json`: task/version/deadline-bound pending request and research state;
- `events/`: local/model observations, decisions, inspections and calculations;
- `operations/`: proposed program bytes and local execution outcomes;
- `report.json`: **unverified** research report, including negative/inconclusive
  outcomes, uncertainty and follow-up questions;
- `proposals.json`: pointers explicitly marked **proposed-only**;
- optional `solver-policy.txt`: proposed task-execution instructions;
- optional `candidate/{workflow.ts,policy.json}`: executable successor method.

A research-instruction proposal copies the executing source into the candidate
and supplies the new policy. Freezing and independently authorizing that package
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
