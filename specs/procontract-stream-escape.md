# Recovery from recurrent tool-input generation failures

This is an unpromoted runtime candidate based on `b26138f3f`. The frozen September 15 RSI cohort continues with its original binary and configuration. This change does not alter its policies, scores, deadlines, or solver artifacts.

## Observed bottleneck

An audit of the cohort's unfinished eva baseline found 19 closed tool-input failures across write, apply_patch, and bash. The retained prefixes contained 4,352,081 bytes in total; every longest suffix was a run of zeros inside a JSON string containing source or shell text. Those requests occupied about 4.49 hours. A reference observation contained a legitimate 309-digit decimal value with 292 trailing zeros. Generated source repeatedly expanded a corresponding literal into 150,000–269,000 zeros without completing the tool call.

The failed arguments were not executed. Durable input-ended events retained the received text, while projected failed inputs were `{}`. Consequently, the long literals were not directly copied into subsequent model requests by the normal tool-input projection. Later wire requests and raw SSE were not retained, so the audit cannot prove every upstream chunk's provenance. Synthetic replay through the frozen production SSE parser showed no duplication. The existing post-failure advice had already failed to restore useful work.

Evidence: `/home/duozhou/run-artifacts/procontract-growth-rsi-20260915/analysis/eva-stream-origin-20260916/REPORT.md`.

## Two separable changes

The history-only commit represents a confirmed uncalled failure as short assistant text, without inventing a tool call with empty arguments or its result. Confirmation requires native `status=error`, no durable `time.ran`, and an explicit local `provider.executed=false`. Unknown imported provenance, called empty-argument tools, and hosted tools retain their existing representation. Reasoning is omitted from the next request only when this assistant has at least one confirmed uncalled failure and every tool in it is such a failure. Durable source history remains unchanged. Mixed turns retain their reasoning.

The subsequent guard commit applies when the preceding context is an assistant containing a confirmed uncalled failure. A same-Session Contract retry inserts a queued user prompt: the runner skips that prompt only when its durable message ID equals the current Contract binding prompt ID. It never identifies internal recovery by matching prompt text. An unrelated user message ends the recovery episode. It observes each new call's argument deltas independently. A guard failure requires all of:

- at least 65,536 UTF-8 argument bytes;
- a non-whitespace trailing run of at least 16,384 identical Unicode code points;
- that run occupying at least 95% of the argument characters;
- the same trailing character run lasting at least 60 seconds.

Changing the trailing character resets its clock; input-end and tool-call discard that input's counter. Healthy first turns do not use this guard. A subsequent successful assistant or unrelated user message ends the recovery episode. These are conservative research thresholds, not a proof that large repeated input is invalid. A legitimate slow literal in a recovery episode can still trigger the guard; the model can express such data with short code. The guard does not detect arbitrary periodic loops or prevent a noncompliant provider from repeating failures until the deadline.

The triggering delta is published before raising a typed local failure. The existing interruption-safe stream finalizer flushes the exact prefix to a durable input-ended event. Already-called local tools settle under the original Contract deadline. Hosted calls retain their called identity and receive a stream-closed error when no result arrives. Only the triggering call receives the repetition diagnosis. The assistant ends with an error; the existing Contract scheduler can resume the same Session. There is still one explicit provider stream per reserved turn, no new in-memory provider loop, and no replay of incomplete commands. Explicit cancellation and the original deadline retain their interruption semantics.

No terminal usage is invented when local stream closure prevents receipt of it. Native known usage and the gateway's closed-unknown/open request rows must be reconciled; missing cost is not zero. The original six-hour deadline remains the sole cumulative instance budget, with individual operation bounds unchanged apart from this recovery guard.

## Validation and RSI interpretation

Native Session tests include the binding reschedule, claim, and queued-prompt promotion path. They cover exact durable prefix retention and replay, recovery into a subsequent valid call, preservation of a same-turn local result and hosted-call identity, healthy large-input completion, deadline and cancellation, and explicit turn/action accounting. Pure module tests cover all thresholds and independent-call state. Request serialization tests cover Chat and Responses representations and historical provenance boundaries. A separate compiled-binary HTTP fixture must qualify the production path before a paid cohort launches.

The proposed ProgramBench screen pairs the exact old and fixed runtimes on eva, sd, and pueue with identical initial policy, model, offline resources, and six-hour deadline-only settings. All six inference jobs close before scoring begins. The cases were selected after observing a failure and are development evidence, not an independent estimate of global benchmark improvement. Report every assigned task, score validity, unknown usage, and paired macro delta. A positive small screen does not promote the default baseline; independent tasks and replication are required.

This manual runtime repair is not proof of recursive self-improvement. It removes a measured obstacle to collecting useful policy-search evidence. The frozen RSI experiment separately tests whether a changed generator produces a descendant solver policy that improves development and independent confirmation scores. Its successor generator is unvalidated until those descendants are evaluated. Faster failure, shorter prompts, successful fixture delivery, or a larger number of policy revisions cannot substitute for improved final task scores.
