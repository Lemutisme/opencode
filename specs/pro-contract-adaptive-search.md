# ProContract: preserve observations, revise representations

## Minimal intervention

The P0 policy-split runtime at `910d9f2856323ad5493ee52f8cb2c315d2172e10`
already accepts a replaceable `executionPolicy`. The experiment uses that seam,
not a new kernel gate, tool, authority role, evidence schema, or planning DAG.
The ProgramBench adapter now accepts opt-in `execution_policy: adaptive`.
`behavioral` remains the default and its policy text is unchanged.

The new policy asks the executor to build a small end-to-end slice when a design
is materially uncertain, use a discriminating black-box trace, preserve observed
behavior in the existing `validate.sh`, and replace a state representation when
a counterexample reveals lost state or a cross-cutting invariant. Routine
omissions can still be repaired locally. Simple tasks need not conduct a design
comparison. A design change alone does not justify a Contract revision.

This is an execution-policy intervention, not a host-certified architecture
selector. The host does not know which implementation primitive is correct.
Actual probes and changes must be checked in trajectories; a policy instruction
does not establish that the executor followed it. No extra mandatory planning
artifact is introduced. Reference observations remain observations, while
readiness evidence must be re-established on the exact candidate delivered.

The Python `policy-split-adaptive-v1` label is an adapter profile, not a new
OpenCode public protocol or Contract state transition. Tests check identical
Contract terms across policies, exact policy identity on reload, rejection of
policy substitution, and compatibility with attestation recovery.

## Frozen diagnostic experiment

Artifact root:
`/home/duozhou/run-artifacts/procontract-programbench-adaptive-luna-max-3x3-20260906-v1`

Three tasks are selected before inference: `nukesor__pueue.8b9d6fe`,
`rcoh__angle-grinder.9c2fc88`, and `wintermute-cell__ngrrram.8ea13c3`. The first two
target state/representation gaps identified in P0; the third is a simple-task
regression control. These are development tasks, not an independent holdout.

| Arm        | Runtime                                      | Execution policy      |
| ---------- | -------------------------------------------- | --------------------- |
| `p0`       | P0 runtime reconstructed from the exact base | Original `behavioral` |
| `repair`   | Frozen continuation-repair runtime           | Original `behavioral` |
| `adaptive` | Same binary as `repair`                      | New `adaptive`        |

`p0` versus `repair` measures the repair bundle; `repair` versus `adaptive`
isolates the new policy bundle. The latter does not isolate individual wording,
length, or cognitive mechanisms. All arms use the same patched ProgramBench
adapter, v6 image identities, model catalog, Luna Max model, and task inputs.
Thus `p0` is a runtime/policy control in the corrected environment, not a
reproduction of the historical 200-task campaign environment.

Nine trajectories, one worker per arm, three new trajectories concurrently.
Per trajectory: 1,000 provider turns, 4,000 actions, six hours, at most three
native semantic attempts. Each arm uses an $8 usage-based circuit breaker;
aggregate target $24, with possible in-flight overshoot. No automatic revision
approval, budget extension, inference rerun, or failed-task replacement.
The existing Lua/HTMLq/Entr experiment continues without modification.

Report all selected tasks, protocol validity, external scores, cost, turns,
regressions, and failure classes. Inspect whether actual architecture-discriminating
traces and representation changes occur before attributing a mechanism. Preserve
unscorable outcomes; a complete-panel mean must not silently drop them. Keep
test blobs outside executor mounts. Audit source/dependency provenance separately;
a hermetic build alone does not certify cleanroom compliance.

The launch protocol and frozen source receipts are authoritative for this run.
No capability improvement or leaderboard eligibility is claimed before results.

## Completed-panel decision — 2026-09-06

All nine trajectories have completed. Artifact macro means are P0 55.8271%,
continuation repair 58.8978%, and adaptive 42.9553%. Native discharge is respectively
3/3, 2/3, and 2/3. Both non-P0 angle-grinder scores come from conserved partial
artifacts after an ambiguous export, not successful native delivery.

Adaptive is not promoted: its lower cost accompanies regressions on two selected
tasks versus P0 and all three versus the repaired-runtime control. The repaired
runtime improves each raw score in this panel but does not pass the native-delivery
nonregression gate. The default policy remains `behavioral`.

See `specs/pro-contract-export-repair.md` for the full table, export-only repair,
paired artifact-preservation tests, and the unresolved original failure cause.
