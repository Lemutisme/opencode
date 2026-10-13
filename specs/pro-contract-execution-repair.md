# ProContract execution repair

2026-10-13 · branch `repair-execution` · descendant of `kernel-foundation`.

## What failed

The second independent paired diagnostic admitted 15 of its 36 originals and
obtained 12 valid official scores (six first-repeat pairs). A csview/core request
was rejected by the provider's usage policy inside an HTTP 200 SSE error envelope.
The frozen parser classified the envelope as malformed output and the frozen
controller cancelled the cohort. No task completed both fixed repeats. Those
scores do not establish task-Pareto improvement or superiority over R2.

The contemporaneous csview/R2 stall had a different cause. Its last shell input
contained a real NUL byte; no shell ID or process was admitted. Node's spawn threw
synchronously inside an asynchronous startup callback. The shell managing fiber
failed without settling its `ready` deferred, leaving the Session waiting without
a child process. A completed gateway response or a BrokenPipe is not evidence of
this cause; the NUL input, spawn boundary and native regression are.

The earlier independent cohort's expired credential remains a separate
infrastructure failure. Neither old cohort is resumed, relabelled or pooled.

## Repairs and boundaries

- Shared Open Responses decoding now recognizes bare error envelopes on HTTP/SSE
  and WebSocket paths. An HTTP 200 JSON rejection is also classified rather than
  discarded as empty SSE. Original body, observed HTTP context and underlying
  cause remain intact. Malformed frames remain malformed.
- Content-policy, authentication, quota and invalid-request failures cannot become
  retryable because an `x-should-retry` header says true. There is no rephrasing,
  model substitution or replay of a refused request.
- Cross-spawn maps synchronous launch errors into its typed failure channel.
  Shell startup also settles readiness on **every** failed exit, preserving
  defects and interruption rather than converting them into success.
- The host gateway journals error envelopes, raw payload, actual status and time
  before forwarding SSE bytes. Refused/unfinished usage and cost remain unknown,
  not zero. JSON errors are retained too.
- A never-admitted verifier has an explicit host inventory and `not-admitted`
  cleanup state. A started grader with missing evidence is still unacknowledged.
- A new controller can record a host-witnessed, fenced provider policy refusal as
  terminal UNKNOWN and continue **independent original assignments**, but only
  with the separately frozen `witnessedProviderRefusal` policy. Its default is
  still fail-closed. Authentication faults, unclassified errors, unknown ownership,
  missing fences, incomplete accounting, replay after refusal, or started graders
  without acknowledgements still stop the cohort. UNKNOWN prevents promotion.
- Host credential lifetime is verified before freezing and again before launch.
  The required lifetime is the worst-case repeat-block schedule plus a frozen
  margin; it is not a task execution budget. A finite credential monetary cap is
  rejected, not replaced by a runner cap. Only allow-listed metadata and a key
  fingerprint are retained. Keys, raw key/info documents and redirects are never
  admitted to artifacts or workers. Missing configured credentials fail before
  opening a campaign; native prechecks precede channel allocation.
- The inherited restricted `Reflect.apply` lint failure is fixed while retaining
  the regression that extra diagnostic arguments cannot bypass live publication.
  Checks use the repo's Bun 1.4.2 and a supported Node 24 toolchain; the host's old
  default Bun/Node are not replaced globally.

The normative kernel reducer and fixed R2/core methods are unchanged. These are
execution and measurement repairs, not a new semantic oracle or test-time RSI.

## Qualification

Private operator artifacts: `/home/duozhou/run-artifacts/procontract-repair-20261013`.
They include preserved failed **scripted fixture** preparations and their explicit
cancellation. None is a real-model or official-score experiment.

The real native regression runs five cases through the existing V2 Session,
provider transport, leaf tools, sandbox and ownership fencing:

| Case | Physical requests | Outcome |
| --- | ---: | --- |
| NUL shell → repaired shell → submit | 3 | independently discharged local artifact |
| HTTP 200 SSE policy refusal | 1 | escalated, fenced, UNKNOWN, no grader |
| HTTP 200 JSON policy refusal | 1 | escalated, fenced, UNKNOWN, no grader |
| expired/authentication envelope | 1 | escalated and fenced; shared fault remains fail-closed |
| malformed stream frame | 1 | escalated and fenced; not converted into a policy refusal |

Qualification uses a scripted provider and synthetic public task. No learned
policy performance, paid comparison, official grader call or superiority claim
is derived from it. Future paired freezing requires this qualification in
addition to the existing observation-continuity, deadline-only, resource and
shutdown qualification. Historical sources, receipts and budget coordinates are
not rewritten.

## Validation readout

- Full AI package: 1,782 passed, 28 optional/recording cases skipped, 0 failed.
- Focused Core shell/coordinator/ProContract suites: 123 passed, 42 platform or
  optional cases skipped, 0 failed; the actual NUL-startup recovery case passed.
- Controller/gate/schema suites: 25 passed, including both real systemd tests
  and TypeScript-producer → Python-consumer refusal receipt qualification.
- Endpoint/replay suites: 62 passed, 1 optional historical replay skipped.
- Native startup/refusal and task-only observation-continuity E2E: both passed.
- `bun run check`: passed, 36/36 package typechecks; inherited lint warnings
  remain (1,541 warnings, 0 lint errors), not a claim of warning-free source.
- The reusable gate also qualified the current host key using a metadata-only
  query: its verified expiry covers the 260,100-second worst-case schedule.
  No model inference occurred and no raw key/info document was persisted.

## Reproduce

From the affected package directories, with supported tools on `PATH`:

```sh
# packages/ai
bun test --only-failures
# packages/core
bun test test/tool-shell.test.ts test/shell-retention.test.ts --timeout 30000
# research/programbench
PROGRAMBENCH_ENDPOINT_QUALIFY=1 PROGRAMBENCH_SYSTEMD_QUALIFY=1 \
  python3 -m unittest discover -s . -p 'test_*.py' -v
bun test
bun typecheck
# packages/sdk — a new operator-owned release and qualification directory
bun script/pro-contract-freeze.ts /absolute/source /absolute/new-release --worker
bun script/pro-contract-repair-qualify.ts /absolute/new-qualification /absolute/new-release /absolute/bun
PROCONTRACT_RELEASE=/absolute/new-release bun test test/pro-contract-repair-e2e.test.ts
# repository root: canonical lint + 36 package typechecks, not root tests
bun run check
```

New cohort preparation copies `credential.py` alongside its controller. Run
`test_credential.py` separately for `reports/credential-tests.log`; retain the
native repair result as `qualification/execution-repair/RESULT.json`. Freeze
pins the policy, sanitized validity receipt and helper sources. Do not replace
these files in an already frozen or running cohort.
