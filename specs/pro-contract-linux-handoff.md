# ProContract Linux Handoff

This document is the restart point for continued ProContract development on a
native Linux machine. It records the retained implementation, the empirical
boundary, and the next gated work. It does not promote any rejected executor or
RSI policy.

## Canonical state

- Repository: `https://github.com/Lemutisme/opencode`
- Branch: `procontract-strength`
- Handoff parent: `bd42d6de194f7e79bab4bba90904b2c5c42d3e6b`
- Retained runtime ancestor: `26f420dc8a9cab0654317e27a5cbd7f6dfd91f69`
- Default upstream branch: `dev`
- ProgramBench revision used for the recorded runs:
  `69f99237fa8d978a6f4ac002e5b201e3c8ea0aec`

`procontract-strength` and `capability-rsi` have the same runtime at the
handoff parent. The four commits after `26f420dc8` are experiment documentation.
Use `procontract-strength` because it carries the current evidence and rejected
claims.

## Branch disposition

| Branch | Disposition | Reason |
| --- | --- | --- |
| `procontract-strength` | canonical ProContract branch | Most complete institution and evidence record |
| `capability-rsi` | archive | Same runtime, less current evidence |
| `metacontract` | separate RSI research | Promising assurance/witness mechanisms; capability promotion unproved |
| `semantic-attempts` | archive | Ancestor already contained in the canonical branch |
| `replay-verifier` | archive | Ancestor already contained in the canonical branch |
| `pareto-retest` | archive | Some quality gains at large cost and with a liveness failure |
| `frontier-simplify`, `policy-value`, `recovery-continuity` | archive | Divergent controller experiments without stronger general evidence |

Do not merge `metacontract` wholesale. Its assurance-transition and witness
inheritance work may later be re-evaluated on top of the cleaned institution;
its UCB/improvement-graph selectors failed their generalization screens.

## What is supported

The strongest claim is institutional:

> Within the mediated domain, an executor cannot unilaterally erase a live
> duty, expand its recognized authority, or certify its own completion.

Real runs and focused tests exercised:

- durable issue, trigger, activation, lease, heartbeat, expiry, and retry;
- dedicated execution Sessions surviving executor and server replacement;
- immutable goal, settlement claim, authority, budget, and revision;
- exact spec, subject, archive, executable, replay, and attestation binding;
- executor petition versus institution-owned status transitions;
- candidate/authoritative separation and independent package/preflight;
- challenge, dependency reopening, escalation, discharge, and scoped quiet;
- effect-process fencing and cleanup under normal exit, timeout, and interrupt.

Multiple batches completed package, cleanroom preflight, content-addressed
attestation, discharge, and quiet after server restart. Failed score floors,
nontermination, missing evaluator output, and tail regressions remained visible
instead of becoming recognized success.

## What is not supported

The hard-coded behavioral evidence sentence is not a generally stronger default.
A frozen four-task confirmation produced:

| Instance | Contract only | Full | Delta |
| --- | ---: | ---: | ---: |
| Tparse | 51.7647% | 78.8235% | +27.0588 |
| Hostctl | 75.7374% | 63.6537% | -12.0837 |
| Diffr | 88.4488% | 77.5578% | -10.8911 |
| Keifu | 60.3053% | 64.8855% | +4.5802 |

Mean score increased 2.1660 points and aggregate cost fell 19.1%, but only two
of four pairs improved and two regressions violated the frozen tolerance. The
policy routes attention toward evidence, but does not ensure that observations
become retained regressions or that a small replay suite justifies stopping.

No current experiment proves general capability improvement, autonomous RSI,
or recursive metaproductivity. `metacontract` proves bounded policy flow and
contains preliminary one-step evidence, but later successors and search
selectors were rejected.

## Known impurity

`packages/core/src/session/runner/llm.ts` currently injects this default line:

```text
For behavior-matching work, enumerate documented surfaces, boundary and error
semantics, and material interactions. Use batched differential probes within
the action deadline, then preserve observations as regression checks after
coherent edits; delivery replay alone is not a behavioral stopping condition.
```

This is an executor policy, not a ProContract invariant. It should not remain in
the default institution after its confirmation gate failed. Existing support
for ratified Policy Contracts already provides the correct policy injection
boundary.

## Linux bootstrap

Use a native Linux/amd64 host when possible. Do not copy credentials into the
repository or artifact bundles.

```bash
git clone https://github.com/Lemutisme/opencode.git
cd opencode
git fetch origin
git switch --track origin/procontract-strength
git status --short --branch

bun install --frozen-lockfile

(cd packages/core && bun typecheck)
(cd packages/core && bun test test/pro-contract.test.ts test/session-runner.test.ts)
(cd packages/opencode && bun typecheck)
(cd packages/opencode && bun run build --single --skip-install --skip-embed-web-ui)
```

ProgramBench remains a sibling repository and benchmark adapter, not a runtime
dependency:

```bash
git clone https://github.com/Lemutisme/ProgramBench.git ../ProgramBench
cd ../ProgramBench
git checkout 69f99237fa8d978a6f4ac002e5b201e3c8ea0aec
uv sync
docker version
uv run programbench --help
```

The historical `run-artifacts` directories are not committed. The summaries
needed to resume are in `pro-contract-experiments.md`. Transfer the external
artifact directories separately only when exact trajectory or evaluator JSON
is needed; never transfer API keys or provider configuration with them.

## Ordered implementation plan

### Phase 1: purify the institution

Make one minimal runtime change:

1. admit the approved brief and ratified execution inputs once through the
   durable scheduler prompt;
2. delete the repeated Contract dossier from ordinary provider turns;
3. conserve unclassified provider errors as transport retries while typed
   nonretryable failures still escalate;
4. prove permissions, budgets, challenge repair, settlement, and finality stay
   enforced below the model;
5. run the focused Core tests and package typecheck;
6. commit separately as `refactor(core): minimize contract execution context`.

This phase must not add a replacement prompt, policy schema, selector, or
configuration flag.

### Phase 2: audit the truth boundary

The current boundary audit is recorded in
[`pro-contract-truth-boundary.md`](./pro-contract-truth-boundary.md). It finds
that coordinate binding and deterministic rejection are enforced, while final
principal evidence provenance and claim semantics remain external trust.

Trace the existing path from frozen evidence terms through replay, attestation,
kernel adjudication, challenge, and reopening. Record exactly where the current
flow trusts principal-supplied hashes or external orchestration.

The target boundary is:

```text
external mechanical verifier
  -> finite content-addressed attestation
  -> total deterministic kernel decision
  -> discharge or explicit rejection
```

Verifier execution remains outside the pure kernel. The executor must not be
able to issue prescribed testimony. Principal authority remains for revision,
release, and residual adjudication—not silent self-verification on behalf of
the executor.

Do not add a general evidence DSL until one real mechanical verifier cannot be
expressed with the existing replay/evidence structures. If public Protocol or
Server `HttpApi` changes, regenerate clients with `bun run generate` from
`packages/client`; never edit generated sources directly.

On the essential-development branch, principal HTTP mutations now require
configured server authentication even when read-only server routes are left
local and unsecured. This is one authority-boundary layer, not proof of worker
isolation; executor processes must still receive no server credential, plane
database, verifier storage, or route to the principal listener.

### Phase 3: close one native-Linux lifecycle

The completed mechanism record and credential-free finite reports are in
[`pro-contract-linux-lifecycle.md`](./pro-contract-linux-lifecycle.md).

Run one small, fresh, network-none Contract through:

```text
issue -> activate -> execute -> handoff -> replay/preflight
      -> independent attestation -> discharge -> quiet
```

Restart the server once before attestation. Add a negative control with a stale
revision, stale lease, or wrong subject hash and prove that authoritative state
does not change. This is a mechanism validation, not a benchmark score claim.

### Phase 4: only then evaluate capability policies

Keep policy candidates content-addressed and outside the default path. Use
paired, preregistered multi-task evaluation with mean, worst-pair, cost,
liveness, and no-regression gates. A positive average cannot promote a policy
that violates the frozen tail tolerance.

RSI work belongs on a separate branch after the ProContract institution is
clean. Candidate generation, improvement graphs, UCB, and recursive policy
selection must not be added to this worktree.

## Completion gates

The Linux continuation is ready for review only when:

- the default institution contains no task-performance policy;
- focused tests and typechecks pass from their package directories;
- ratified policy injection still works;
- one positive and one negative native-Linux lifecycle are recorded;
- documentation distinguishes enforced invariants from empirical hypotheses;
- the worktree is clean and every logical phase is a separate conventional
  commit.
