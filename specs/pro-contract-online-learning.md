# ProContract: online method learning in one rollout

Status: development implementation, 2026-10-06. This makes a feedback-to-method-to-action
path executable; it does not establish useful autonomous learning, causal method
superiority, or deployment eligibility. See the earlier
[trajectory findings](pro-contract-trajectory-research.md) for the failures motivating it.

## The smallest useful update

With fixed model weights, the effective policy can still change through its working
method: how it selects actions, obtains evidence, retains exceptions, or stops.
One task already contains many observations. A new full rollout is not required to
reject an assumption contradicted by an existing witness.

The update unit is a **conditional trial**, not a reflection essay or a self-score:

> When this condition holds, try this different action; expect this future
> consequence; reconsider it under these observations; retain the feedback that
> motivated it.

The running method decides whether a signal matters, whether a small discriminating
experiment is needed, and whether to revise anything. No change is a valid outcome.
A solved task with no method revision is task completion, not evidence of RSI.
The same mechanism can revise the researcher's own evidence extraction or experiment
selection; research is not a privileged, fixed controller above ordinary work.

Separate three claims: an observed counterexample; a plausible method hypothesis;
and a demonstrated benefit from using that method. A single trajectory can refute a
scoped claim and sometimes supply a local comparison. It cannot invent the outcome
of a policy that was never tried. Calling this fixed-weight test-time learning does
not make every saved note reinforcement learning.

## Ordinary native execution: `working_method`

The built-in tool is available through existing agent/tool permissions. It reads
public observations from its own Session and records model-authored trials. It does
not require a ProContract-bound Session, a second solver, or a special `improve` loop.

Start by obtaining actual references:

```json
{ "action": "read" }
```

The reply includes `view.revision`, active trials, observation excerpts and exact
`messageID`, `callID` where applicable, `channel`, `block`, and `hash` coordinates.
Use the returned values, not guessed IDs or a hash of your paraphrase. For example,
the following is a **template**, not an observation from an experiment; substitute
real coordinates and a literal quote returned by `read` before calling it:

```json
{
  "action": "revise",
  "expectedRevision": 0,
  "condition": "A validation check passes while a known boundary witness still fails.",
  "change": "Include the known witness before relying on this validation check to stop.",
  "expectation": "The next validation run will expose that witness until its behavior is repaired.",
  "reconsiderWhen": "The witness is invalid, its conditions differ, or a stronger check already covers it.",
  "reason": "The observed disagreement challenges this check's coverage, not every part of the solution.",
  "evidence": [
    {
      "messageID": "<messageID from read>",
      "callID": "<callID from read>",
      "channel": "content",
      "block": 0,
      "hash": "<64-character SHA-256 from read>",
      "quote": "<literal nonblank excerpt from that captured block>"
    }
  ]
}
```

`expectedRevision` must equal the latest ledger revision. Required revision fields
are `condition`, `change`, `expectation`, `reconsiderWhen`, `reason` and one to eight
evidence references. Optional `previous` is a **retrospective account**, not a
fabricated prior prediction. `expectation` concerns the future; neither field
proves that a hypothesis was recorded before its motivating observation.

Other operations use the same tool:

- `{"action":"read","revision":1}` retrieves one complete historical receipt.
- `{"action":"read","historyOffset":0}` pages one history entry at a time.
- `before` pages earlier messages; `messageID` and `captureOffset` select a
  message's captures. `observation` takes an exact reference plus byte `offset`
  and `length` (at most 4096) for body retrieval. Split UTF-8 pages use base64.
- A new `revise` with `replaces: 1` withdraws that active trial and records its
  replacement. Retraction uses `action: "retract"`, the current `expectedRevision`,
  an active `replaces` revision and a nonblank `reason`; evidence is optional:

```json
{
  "action": "retract",
  "expectedRevision": 1,
  "replaces": 1,
  "reason": "The condition no longer distinguishes these cases."
}
```

A mutation must match its real, local running tool invocation. Exact retries are
idempotent; conflicting retries and stale revision numbers fail rather than
silently overwrite. Replacement/retraction retains history and never revives an
ancestor. There is no accepted/promoted status: receipts are `trial-unverified`.

### What can ground a trial?

Only earlier admitted public feedback in the same Session is eligible:

- Tool `content`, `error`, and JSON-only public `structured` output.
- Tool `diagnostic`: capture/lifecycle facts such as timeout, pruning or truncation.
- User text: `channel: "user"`, `block: 0`, **no `callID`**. A user's statement is
  feedback, not independent verification or an automatic Contract amendment.

Requested tool `input` can be read but cannot ground a revision. Neither can the
successful working-method state/claim output, pending user inputs, attachments, private
reasoning, provider metadata, system messages, or another Session's records.
Missing or pruned bodies are not reconstructed. Diagnostics remain distinguishable
from a captured body; an empty output is not silently substituted for unavailable
text. Returned warnings remain relevant even when a quote matches.

Hash and literal-quote checks establish **source-byte binding, not entailment**.
They do not establish that a command succeeded, an interpretation is true, or a
method helped. An exit-zero diagnostic is not semantic correctness; a timeout may
justify a smaller measurement without proving anything about the target behavior.
The system does not label model agreement or self-rating independent evidence.
Prior failed method calls expose only their error/diagnostic, so the agent can
repair its use of the observation interface without treating its own successful
claims as reward. The standalone method similarly admits prior `invalid-action`
errors as execution diagnostics, not task correctness.

### From saved trial to the next decision

On subsequent eligible native provider turns, active trials are read back as
bounded **assistant-owned data**, not System Context or privileged instructions.
The configured permission must allow `working_method`; `ask`/`deny` do not trigger
an automatic read. Text-only Reason mode does not read ambient trial state.
The normal model/tool execution and its single provider stream remain unchanged.

This readback survives history compaction and explicit Session resume. Historical
source retrieval uses retained Session records, not a summary's reconstruction;
actually pruned bodies can become unavailable. A corrupt optional ledger produces
an explicit unavailable notice, not an empty history or an automatic reset, and
does not stop ordinary task execution. Explicit tool diagnosis can still fail.

Readback proves delivery, not compliance. To claim learning, inspect the next
relevant actual action and its outcome. A recorded change ignored by later work
is an unsupported trial, not a success metric.

## Replaceable research method and cross-task reuse

The existing [trajectory method README](../packages/core/script/trajectory-research/README.md)
documents the executable `workflow.ts` interface. Ordinary `inspect`, `compute`,
`critique`, and `conclude` actions can optionally carry `revision` and `uses`.
Evidence cites exact retained event hashes, allowlisted JSON pointers and quotes;
body observations and execution diagnostics are distinct. Active trial IDs are
prior event indices. `uses: [7]` declares use, not verified compliance.
`revision.replaces: 7` replaces; `revision.change: null` retracts with the required
condition, expectation, reason, reconsideration condition and evidence.

This candidate runs through the existing `ProContractRun` and native text-only
Reason bridge. `packets: []` is valid for an ordinary local Bun task; durable
solution files may live under `.research/work`. The completed explicit checkpoint
retains its method log alongside normal artifacts. It does not become a new
Kernel research state machine. Candidate-local hashes are not hostile-candidate
authentication: a compute process shares the candidate workspace. Independent
analysis must use host-retained artifacts, not trust rewritten local history.

There is **no implicit global learning memory**:

- Native trials stay in their Session. There is no cross-Session ledger import
  endpoint. Reuse requires explicitly selecting and staging permitted material
  through ordinary task/method inputs, retaining its original provenance and
  checking applicability again. Foreign evidence cannot masquerade as local feedback.
- A research `conclude` may select earlier active trials with `carry: [7]` for
  its proposed successor package. Omission carries nothing implicitly. A frozen,
  independently authorized successor imports these as unverified advice with new
  local IDs, original execution/evidence origins and preceding trial coordinates.
  It does not inherit the old task, deadline, pending request or authority.

`packages/core/script/trajectory-research/native-policy.txt` is a small **opt-in,
replaceable seed method** for ordinary native work. Supply it through existing
agent/run policy configuration; it is not automatically installed as a privileged
controller. It asks for conditional revision when warranted, not reflection after
every action, a positive lesson, or a mandatory successor. Its selection is
external engineering, not a method autonomously discovered by this implementation.

## Boundaries and lifecycle

Contract goals, grants, original deadline, model, permissions, acceptance and
adoption rules remain unchanged. Experiments use ordinary granted tools. A method
trial cannot authorize task completion, change evaluation terms, or deploy itself.
Retraction of a method is not retraction of valid task results.

Native ledgers are ordinary JSON files under
`<global.data>/working-method/<sha256(SessionID)>.json`, bound to the existing
Session ID and creation time. A deleted Session cannot read its orphaned ledger;
a different creation identity cannot adopt it. Trials whose registering messages
are deleted or lie beyond a staged revert boundary are suppressed from active
advice. Historical replacement links remain: reverting a replacement does not
silently reactivate its ancestor. Receipts describe capture at recording time,
not a guarantee that its source body remains available after pruning or revert.

Each native mutation input is limited to 8192 UTF-8 bytes; the active-receipt
array has a 16 KiB serialized budget, plus view metadata and readback prose.
Omissions are explicit and historical receipts remain retrievable. These and the
research method's per-operation/presentation guards are not cumulative research
budgets. No new total turn, action, request, or cost ceiling is introduced.
Native reads preflight ledger size at 16 MiB and message size at 8 MiB before
decoding. An oversized source is unavailable, not absent; the archive is not
truncated or reset. These checks and subsequent reads are separate operations,
not atomic bounds against concurrent replacement. The metadata tool also uses
the existing one-minute individual-operation watchdog in Contract execution.

These files are not a new trusted acceptance store. Native synchronization is
process-local; clustered writers are not supported. There is no automatic ledger
cleanup on Session deletion, bounded archive retention, or incremental archive
index in this change. Full ledger reads/rewrites and research history rebuilding
can grow with history; bounded prompts do not bound storage or total work.

## Evidence still required

Implementation tests exercise real tool feedback, user feedback, revision,
readback, compaction, retraction, permissions and unchanged Contract boundaries.
They establish mechanics and failure behavior, not autonomous insight or gain.

The new diagnostic lives at
`/home/duozhou/run-artifacts/opencode-online-learning-20261006`.
Its frozen `PLAN.json` specifies one ordinary repair task, a held-out-from-solver
17-case diagnostic panel, and Luna/max with only a six-hour cumulative deadline.
It does not require a lesson or a revision. **PLAN is not LAUNCH:** exact new
binary/method qualification and launch authorization are separate. At this
pre-launch documentation point, no model result is available; infrastructure
smoke tests with a previously frozen binary are not this experiment's learning result.

The intended audit distinguishes a genuine signal, a scoped update, actual later
behavior, and local consequences. No-change, ignored trials, measurement failures
and unelicited retraction remain reportable outcomes. Even a positive single run
would not establish causal superiority, cross-task transfer, or promotion eligibility.
