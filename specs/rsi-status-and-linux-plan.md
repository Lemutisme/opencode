# Governed RSI status and Linux restart plan

Snapshot date: 2026-08-17

This file is the durable handoff for the ProContract/MetaContract RSI work. It
separates implemented guarantees, empirical evidence, rejected hypotheses, and
the next bounded development slice.

## Repository state

### OpenCode

```text
repository  https://github.com/Lemutisme/opencode.git
branch      metacontract
worktree    repository root
snapshot    f0a27828d docs: record rejected ucb screen
```

The branch was clean and six commits ahead of `origin/metacontract` before this
handoff commit.

Key commits:

```text
98ab913fb  feat(opencode): check assurance transitions
630c07c3c  feat(opencode): inherit assurance across generations
2b4f57aef  docs: record one-step improver recursion
fd9e1d23a  docs: record rejected m2 screen
1d45ea5b1  feat(opencode): add improvement graph selector
f0a27828d  docs: record rejected ucb screen
```

### ProgramBench

```text
repository  https://github.com/Lemutisme/ProgramBench.git
branch      retained-regressions
snapshot    5664b22 feat(candidate): replay retained witnesses
```

Key commits:

```text
3b2c38f  feat(candidate): retain repaired regressions
0e8344e  feat(candidate): persist falsified witnesses
5664b22  feat(candidate): replay retained witnesses
```

## Implemented architecture

```text
ProContract
  durable obligation lifecycle
  executor cannot self-settle
  dependency challenge propagation
  assurance-root inheritance

MetaContract
  trajectory/falsifier -> successor improver proposal
  advisory provenance only; no promotion authority

ProgramBench adapter
  append-only falsified/repaired witness journal
  externally admitted discoveries
  read-only candidate replay

Search layer
  append-only improvement DAG
  multi-parent merge edges
  retained rejected branches
  linear and node-UCB baseline selectors
```

The central boundary is:

```text
epistemic search is a graph
normative succession is one assurance-carrying chain
```

No RSI experiment added campaign, graph, MCTS, or benchmark state to
ProContract Core.

## What is supported by evidence

### ProContract mechanism

The real YJ witness lineage exercised both hereditary closures:

```text
H0  five falsified witnesses
H1  five repaired witnesses -> generation 1 accepted
H2  higher scalar score but one protected regression -> rejected
H2' repaired regression -> generation 2 accepted
```

H2' preserved all 825 official test statuses of the 89.0482% parent. This
supports completion integrity, durable negative evidence, repair inheritance,
and separation of execution from settlement. It does not prove unconditional
liveness or verifier completeness.

The assurance checker tests rooted executor transitions, judge bridges, stale
support, direct self-certification, conflicting retries, and cumulative risk.
The ProgramBench suite tests witness admission, repair/reopen lifecycle,
lineage tampering, read-only replay, deterministic packaging, and cleanroom
preflight.

The strongest governance evidence is negative: weaker m2 and node-UCB
self-modifications were actually rejected under frozen rules instead of
overwriting the incumbent.

### RSI capability evidence

One update produced a preliminary positive metaproductivity signal:

| Paired campaigns | m0 | m1 |
|---|---:|---:|
| Active passes | 856/976 | 867/976 |
| Tool actions | 75 | 55 |
| Recorded cost | $0.392046 | $0.263340 |

m1 therefore gained 11 active tests (+1.1270 micro percentage points) while
using 26.7% fewer actions and 32.8% less cost on Jot and Gron.

This is preliminary one-step evidence, not promotion-grade RSI: there was one
replicate per arm, the tasks had appeared in older project calibrations, and no
promotion threshold was preregistered.

Later generations did not establish sustained recursion:

- m2 lost five Eva passes, tied Shellharden, and used more actions/cost;
- hybrid m3 did not outperform m1;
- node-UCB selected m2 after SD (760/810), but m2 then scored 695/872 on
  Figlet versus 696/872 for linear m1 and hybrid m3.

Thus the honest status is:

```text
governed recursive mechanism       implemented
automatic witness-driven repair    demonstrated
one-step metaproductivity gain      preliminary evidence
sustained recursive capability      not established
node-UCB/MCTS superiority           not established; current baseline rejected
```

## Research nodes

```text
m1  097ae66f63aa5c9e04c0a74e80fa717061945effe519e9942670d27b057c49c4
    research incumbent; not production-promoted

m2  e285f592220661241b1c8ffd33663c690a716ac451f6da6220c55ce49f16d443
    rejected: evidence admission over-constrained invariant propagation

m3  317d0c4d3e98c60d72a8722f51b48adce38e35a5b0c4d6a058433a148a794762
    hybrid invariant/impact-cone proposal; did not beat m1
```

Rejected nodes remain useful repair parents. None has succession authority.

## Code entry points

OpenCode:

```text
packages/opencode/script/check-assurance-transition.ts
packages/opencode/script/select-improvement-search.ts
packages/opencode/test/script/check-assurance-transition.test.ts
packages/opencode/test/script/select-improvement-search.test.ts
```

ProgramBench:

```text
src/programbench/candidate.py
src/programbench/cli/candidate.py
tests/test_candidate.py
tests/test_cli.py
```

Important commands:

```bash
programbench candidate retain CASES LEDGER REFERENCE CANDIDATE
programbench candidate replay LEDGER CANDIDATE

bun run script/select-improvement-search.ts SEARCH.jsonl linear 1
bun run script/select-improvement-search.ts SEARCH.jsonl ucb 3

PRO_CONTRACT_API=http://host \
  bun run script/check-assurance-transition.ts FRONTIER.json TRANSITION.json REPORT.json
```

## Linux bootstrap

### OpenCode

```bash
git clone https://github.com/Lemutisme/opencode.git
cd opencode
git fetch origin
git switch metacontract
git pull --ff-only origin metacontract
bun install

cd packages/opencode
bun test \
  test/script/check-assurance-transition.test.ts \
  test/script/select-improvement-search.test.ts
bun typecheck
```

From the repository root, run focused lint:

```bash
node_modules/.bin/oxlint \
  packages/opencode/script/check-assurance-transition.ts \
  packages/opencode/script/select-improvement-search.ts \
  packages/opencode/test/script/check-assurance-transition.test.ts \
  packages/opencode/test/script/select-improvement-search.test.ts
```

### ProgramBench

```bash
git clone https://github.com/Lemutisme/ProgramBench.git
cd ProgramBench
git fetch origin
git switch retained-regressions
uv sync
uv run pytest
```

Linux/amd64 is preferred. It avoids the macOS/QEMU calibration limitation, but
the required ProgramBench task/cleanroom Docker images still need to be pulled.

## External artifacts

Large run artifacts are intentionally outside both Git repositories. The most
important local records are:

```text
run-artifacts/procontract-witness-yj-20260811
run-artifacts/procontract-rsi-metaproductivity-luna-max-20260811
run-artifacts/procontract-rsi-m2-confirmation-luna-max-20260811
run-artifacts/procontract-rsi-search-validation-luna-max-20260812
run-artifacts/procontract-rsi-search-graph-20260811
```

The in-repo `specs/pro-contract-experiments.md` contains the durable summaries
and links. Exact transcript/eval replay on Linux requires copying the external
directories separately, for example with `rsync -a`; code and unit tests do not.
Do not commit credential-bearing OpenCode state databases.

## Next bounded development slice

Create a new short branch from the pushed `metacontract` head, for example:

```bash
git switch -c rsi-value
```

Do not continue from the older `capability-rsi` worktree.

The next slice addresses value estimation, not more governance features or a
larger MCTS implementation.

### 1. Split exploration from incumbent challenge

Change the external selector output from one `selected` list to two advisory
sets:

```json
{
  "explore": [],
  "challenge": []
}
```

`explore` may contain unvisited, novel, rejected, or repairable nodes and may
use UCB/information gain. `challenge` must require:

- assurance-closed evaluation artifacts;
- multiple campaign visits;
- zero worst paired regression;
- positive one-sided lower confidence bound for capability gain.

ProContract may consume only a separately attested challenge decision, never an
exploration score.

Concrete regression fixture: after the real SD/Figlet log, m2 must remain in
`explore` but must not appear in `challenge`. With only two visits and one zero
gain, m1 should also produce no promotion-grade challenger.

### 2. Add content-addressed executable improver manifests

Represent mutable improvement machinery as one external manifest artifact:

```json
{
  "parents": ["manifest-hash"],
  "promptBundle": "hash",
  "probePolicy": "hash",
  "scopePolicy": "hash",
  "retrievalPolicy": "hash",
  "selectionPolicy": "hash",
  "prediction": {
    "gain": 0,
    "regression": 0,
    "falsifier": "description"
  }
}
```

The whole manifest is bound by the existing Contract `subjectHash`; no new
ProContract schema or table is required.

### 3. Validate before deeper search

Use branching successive halving before full MCTS:

```text
4 sibling manifests x 2 development campaigns
2 survivors x 2 more campaigns
1 challenger x disjoint sealed confirmation
```

Capability is primary. Cost breaks ties only. A successor is promotion-grade
only when the preregistered paired lower confidence bound is positive, the
worst task-family regression is zero, and false promotion remains zero.

## Non-goals for the next slice

- no new ProContract Core state or database table;
- no automatic global promotion;
- no claim of full MCTS or general RSI;
- no reuse of sealed confirmation outcomes inside the same search generation;
- no replacement of m1 unless the frozen challenge rule passes.
