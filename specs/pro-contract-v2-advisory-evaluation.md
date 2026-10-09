# Native V2 advisory: qualification and evaluation guide

Branch `closure-advisory`, implementation commit `9f711900b6` or later. This guide is for whoever runs the container qualification and the ProgramBench evaluation. The design is in [pro-contract-v2-advisory.md](./pro-contract-v2-advisory.md) (in Chinese); the base mechanism and its earlier qualification are in [pro-contract-v2-delivery.md](./pro-contract-v2-delivery.md).

## What changed

The branch is `procontract-closure` plus an **optional** advisory reviewer for the native V2 worker. It is off unless `native-programbench.py` receives `--advisory <file>`. Without that option, prompts, tools, results and artifacts are meant to match `procontract-closure` exactly.

When enabled, a read-only reviewer Session in the worker process (same model and `max` effort, tools limited to `read`, `grep` and `glob`) reviews the candidate at up to three points:

| Node       | When                                                                                                         | Effect                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| submission | First successful `handoff`                                                                                   | Handoff stays recorded; advice is appended to the tool result                        |
| blocked    | First `blocked` report with a reason                                                                         | That first report is not recorded; advice is returned; a second `blocked` records it |
| idle       | Researcher stops with delivery still open, at least `afterMs` after the previous review (or after the start) | Advice is appended to the existing continuation prompt                               |

The Researcher always decides. The six-hour original deadline never extends, and no cumulative caps are added. Reviews are skipped when less than about 25 minutes remain. A reviewer failure falls back to the original behavior. If a reviewer cannot be confirmed stopped within two minutes after a stop, the worker exits with code **86** (an infrastructure fault; the instance gets no score).

New artifacts under the run root, present only with `--advisory`:

- `advisory.json`: the exact config file (also written for failed runs);
- `RESULT.json` field `advisory`: SHA-256 of `advisory.json`;
- `state/advisory.jsonl`: one line per skipped review, plus a `started` and an `ended` line per started review;
- `state/advisory/<n>/`: `prompt.txt`, `opinion.txt` and `events.json` for each started review;
- fixture runs only: `advisory-qualification.json`, `fixture-identities.jsonl`, `fixture-overlap.json`.

## Environment

Use the same environment as the `procontract-closure` qualification and regression: the ProgramBench runner (`PYTHONPATH="$RUNNER/src"`), wheelhouse, offline blobs and cleanroom images. Build the read-only runtime from this branch with Bun 1.4.2 (`bun install --frozen-lockfile`); the recorded runs used Node 24.21.0. Keep run roots on local disk, not on a network filesystem, and use a fresh `--root` for every run.

## Step 1: local checks

From `packages/sdk` (do not run tests from the repository root):

```sh
bun test script/contract-delivery.test.ts script/contract-profile.test.ts \
  script/contract-advisory.test.ts script/contract-advisory-stop.test.ts \
  script/contract-advisory-evidence.test.ts script/contract-advisory-exit.test.ts \
  --timeout 30000
bun typecheck
PYTHONPATH="$RUNNER/src" python3 -m unittest \
  script/native_programbench_test.py script/native_programbench_advisory_test.py
```

Expected: 65 Bun tests pass, the typecheck passes, and all 22 Python tests pass. Four of the Python tests (official result aggregation) need the runner and could not be run where the branch was developed, so please report their result explicitly.

## Step 2: container qualification

Use the same arguments as your earlier `procontract-closure` qualification runs, with a fresh `--root` each time.

**2a. Advisory off.** Repeat the three existing checks without `--advisory`: `--fixture --fixture-steps 1002`, `--fixture --fixture-expiry 4`, and the cancellation check. Expected: the same outcomes as before, no `advisory` field in `RESULT.json`, and no advisory files in the run root.

**2b. Advisory on.** Create `qualification-advisory.json`:

```json
{ "nodes": { "submission": true, "blocked": true, "idle": true }, "reviewMs": 600000, "afterMs": 0 }
```

`reviewMs` must be at least 300000 (five minutes), or every review is skipped as "insufficient time". The scripted reviewer answers within seconds, so the review does not actually take ten minutes. Then run:

1. `--fixture --fixture-steps 1002 --advisory qualification-advisory.json`
2. `--fixture --fixture-expiry 4 --advisory qualification-advisory.json`
3. the cancellation check with `--advisory qualification-advisory.json`, triggered the same way as before.

**Required for run 1** (the script enforces these):

- exit status 0;
- `RESULT.json` has `"qualified": true` and an `advisory` hash;
- `state/advisory.jsonl` shows completed `idle` and `blocked` reviews;
- each reviewer's scripted `read` succeeded;
- every pre-existing qualification check still passes.

**Recorded only, not failures** (in `advisory-qualification.json`):

- `arrived` and `overlap`: whether the reviewer request reached the upstream while the Researcher's first `blocked` response was still open. If your gateway serializes requests from one process, expect `false` after a 60-second wait. This is not a problem for real runs.
- `attributionVerified`, `attribution` (`verified` or `unknown`), `gatewayTimeUnit` and `diagnostics`: whether gateway records could be matched to known request identities and time units determined. `unknown` means later usage splits for advisory runs must also be reported as unknown.

The only attribution failure is `"attribution": "mismatch"`: matching and time units were verified, but the review windows disagree with known identities. The file is written before the script fails; please send it.

**Expected for runs 2 and 3:** the same failure and fencing behavior as the corresponding advisory-off check (compare the fencing delay with the earlier ~1.5 seconds). `advisory.json` exists in the run root. In run 2 no review can start: `state/advisory.jsonl` contains at most `skipped` lines, or does not exist.

Please send back, for every run: the command line, the exit status, `RESULT.json` or `FAILURE.json`, `FENCED.json`, `STATUS.json`, `worker.stderr`, and the advisory files listed above.

## Step 3: ProgramBench evaluation

Start only after the project owner approves the protocol and freezes the configuration. The proposed configuration is:

```json
{ "nodes": { "submission": true, "blocked": true, "idle": true }, "reviewMs": 1800000, "afterMs": 2700000 }
```

- Use the same instances, model and effort (`max`) as the `procontract-closure` baseline, add `--advisory <frozen file>`, and use fresh run roots.
- Label these runs as a separate advisory cohort. Do not modify, rerun or replace baseline or historical runs.
- Stop and preserve everything on infrastructure faults or on anything this guide does not cover; do not retry automatically.

**Per instance, please report:**

1. the score, or the failure reason from `FAILURE.json`;
2. the worker exit code from `STATUS.json`; code 86 means the advisory reviewer could not be stopped;
3. from `state/advisory.jsonl`: reviews per node, their outcomes (`completed`, `skipped`, `timeout`, `aborted`, `failed`, `no-opinion`, `unsettled`), start and end times, and durations;
4. whether the candidate changed or new probes were added after the submission review, and whether a new handoff followed. `state/delivery.jsonl` has no timestamps; the submission review follows the first `handoff` entry, so look at the order of entries after it (`reopened`, `probe`, a later `handoff`);
5. instances where delivery was already `ready` when the submission review started but the run produced no score, classified by `FAILURE.json` and whether a `CANCEL` file exists;
6. from the Researcher's `state/events.json`: the time of every `contract_delivery` call by action, especially `probe`, and the number of `session.inbox.enqueued` events (one more than the number of premature stops). These numbers inform whether a mid-course review node is worth adding later;
7. usage from `ACCOUNTING.json`:
   - a request whose gateway start time falls between a review's `started` and `ended` lines belongs to the reviewer; all others belong to the Researcher;
   - report known usage and the count of requests with missing usage separately for each side;
   - mark the split unknown when qualification left attribution unverified, when a review has a `started` line without an `ended` line, or when a review ended `unsettled`.

Each instance is a single sample. Report observations, not causal conclusions.
