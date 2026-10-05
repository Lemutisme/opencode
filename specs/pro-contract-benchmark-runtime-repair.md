# TB4 protocol and runtime repair

2026-09-22. The Luna cohort was stopped before repair. Its source, budgets and
results remain unchanged. This document supersedes the interpretation that
missing public replay by itself makes an official benchmark run invalid.

## Official protocol

- https://www.tbench.ai/run specifies Harbor and pinned
  `terminal-bench/terminal-bench@4.0.0`, with Modal and `-k 5` in its example.
- https://docs.harborframework.com/core-concepts/agents/custom-agents permits
  custom installed and external agents. BaseInstalledAgent is preferred for a
  CLI inside the task environment; using our custom wrapper does not substitute
  a different grader, but is not an untouched built-in leaderboard agent.
- https://docs.harborframework.com/core-concepts/tasks/separate-verifier defines
  isolated grading and declared artifact transfer. The pinned TB4 tasks select
  this mode. Final tests are not in-attempt feedback.
- https://docs.harborframework.com/core-concepts/tasks/resources defines declared
  CPU/RAM enforcement. The repair must not solve OOM by increasing those budgets.

The user's 63 GPU-free tasks, one trial, local Docker and official task timeouts
are a deliberate subset protocol. They are not the complete 66-task, five-trial
leaderboard protocol. Retain raw official rewards, all failed attempts and
infrastructure errors separately. The three previously qualified FreeCAD
dependency constraints are disclosed local environment corrections.

`report_ready -> stop generation -> official verifier -> kernel settlement` is
correct for sealed one-shot evaluation. Strategy-side self-checking and adaptive
strategy selection are separate agent capabilities. They cannot be implemented
by feeding official final failures back into the same scored candidate.

## Repairs

1. `route/client.ts` now invokes the protocol's clean-EOF flush only on clean
   stream termination. A decode/transport failure is no longer first obscured by
   a synthetic EOF provider-error. Each stream subscription has separate state.
   Valid completed tool effects are retained; incomplete arguments are not
   executed or guessed. Nullable documented streaming-error fields are accepted.
2. The isolated gateway records a bounded, host-only fault-frame tail for HTTP
   200 streams without a terminal event; known secrets are redacted and the
   file is mode 0600. Accounting is settled before diagnostic file I/O. Original
   response bytes and unknown usage remain unchanged; no provider success is
   invented. Actual historical fault frames were unavailable, so upstream EOF
   itself is not claimed to have been eliminated.
3. Opt-in `OPENCODE_PROTECT_CONTROL_PLANE=1` raises Bash tool/descendant Linux OOM
   priority to 1000 before executing user code. It leaves the native supervisor
   priority and the container's CPU/RAM limits unchanged. No new capabilities,
   privileged container, extra memory, or automatic daemon restart is introduced.
   This protects against tool-driven OOM, not arbitrary supervisor memory leaks.
4. `benchmark_runtime.py` exports the retained Session projection through a
   read-only SQLite transaction and atomically publishes complete JSONL plus a
   receipt. It avoids the HTTP 32 MiB page limit and remains usable after daemon
   death. The new adapter bounds the individual host export operation at 180 s;
   original inference deadlines are unchanged. The durable database remains the
   recovery source if export is interrupted.
5. Intermediate provider health is reported separately from official task
   scores. HTTP 200 alone is not a successful turn, while client disconnect
   after a recorded terminal event is not a false transport failure. Recovered
   faults do not erase or silently invalidate completed benchmark scores.
6. The Node-to-Bun provider response body uses a backpressured, cancellable
   stream bridge instead of the incompatible Node/DOM stream type surface.

## Qualification

Artifact root:
`/home/duozhou/run-artifacts/procontract-protocol-repair-20260922`.

An isolated copy of the previously frozen source was patched and compiled as
`0.0.0-procontract-protocol-20260922`. The shared dirty workspace was not packaged
wholesale. Exact source/harness diffs and binary hashes are retained.

The real native binary was tested with local scripted Responses streams:
malformed frame or premature EOF after a completed once-only tool action,
followed by actual tool OOM inside a 1 GiB Docker fixture. Both recoveries retain
the same Session, one semantic attempt and original deadline; the once-only
effect is not repeated, the supervisor survives, and subsequent public checks
pass. One test also checks the actual tool priority equals 1000. These are
engineering fault injections, not model performance results.

The new binary also completed Coq and sidecar official-reference engineering
fixtures through real Harbor collection, independent grading (reward 1) and
native discharge. Reference solutions were injected only into explicitly
scripted, no-paid-model qualifications, never production trials.

Read-only recovery exported the previously incomplete transcripts, including a
432 MB Session, without editing historical state. Relevant regressions and
opencode/llm typechecks pass. Core's standalone typecheck separately reports an
unrelated `script/strategy-kernel.ts:125` budget typing error; that file was not
modified by this repair.

No new adaptive strategy learner has been implemented and no improvement in
Luna's benchmark score is established. No paid cohort was restarted by this
repair. A new performance run must freeze its new source and declared protocol.
