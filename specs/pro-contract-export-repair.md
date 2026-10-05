# ProContract export isolation — 2026-09-06

## Decision

Keep the frozen P0 baseline and the original `behavioral` policy. Do not promote
the adaptive policy or describe a higher artifact score as a successful delivery.
Treat nonregression as a release gate on specified tests, not as a guarantee on
unseen tasks or stochastic future trajectories.

This patch narrows the dependency graph of `contract export` and preserves
previously discarded adapter failure diagnostics. It does not change search
prompts, tools, replay policy, budgets, revision authority, or attestation rules
relative to the frozen continuation-repair binary.

## Completed development panel

The previously launched nine Luna Max trajectories are complete. These are three
selected development tasks, not another 200-task benchmark result.

| Arm                              | Pueue    | angle-grinder | ngrrram  | Artifact macro mean | Native discharge | Model cost |
| -------------------------------- | -------- | ------------- | -------- | ------------------- | ---------------- | ---------- |
| P0 + behavioral                  | 12.0690% | 59.0426%      | 96.3696% | 55.8271%            | 3/3              | $2.0463    |
| Continuation repair + behavioral | 17.0846% | 61.2589%      | 98.3498% | 58.8978%            | 2/3              | $1.5756    |
| Continuation repair + adaptive   | 14.1066% | 23.6702%      | 91.0891% | 42.9553%            | 2/3              | $0.8847    |

The repaired and adaptive angle-grinder scores describe conserved **partial
artifacts**. Both native runs remain `lost_server / export_ambiguous`; neither is
retroactively discharged. Evaluation-valid means the artifact was evaluable,
not that native delivery succeeded. All nine artifacts have valid evaluations.

The repair bundle improves raw scores on all three selected tasks, but loses one
native delivery. Adaptive is cheaper but regresses on two tasks versus P0 and on
all three versus the repair control. Neither arm passes the development
nonregression gate. This panel cannot identify a general representation-selection
mechanism or establish effects on unseen tasks.

Source panel:
`/home/duozhou/run-artifacts/procontract-programbench-adaptive-luna-max-3x3-20260906-v1/PANEL.md`

## What was diagnosed

The adapter previously caught `WorkspaceError` during export without recording
its diagnostic. Missing output then became `export_ambiguous`, classified as
`lost_server`. That label alone does not establish that the server crashed.

Separately, the old export command entered the full CLI application runtime and
built the complete Location service map, including execution and search services.
Materializing an already identified snapshot does not require those services.
This is an unnecessary dependency and a potential failure source; it has **not**
been established as the cause of the two historical failures.

The new `ProContractExport` service reads the Contract and its persisted binding,
then builds only the Snapshot dependency graph for that Location. The CLI uses a
dedicated runtime instead of the complete application runtime. Each materialization
gets a fresh Location layer, avoiding reuse of another call's configuration.
The existing Snapshot implementation still performs the actual export.

The adapter now writes `procontract-export-error.json`, bound to the Contract,
revision and handoff hash. Diagnostics are credential-redacted before truncation,
bounded to 16,384 characters, and included in control-artifact credential scans.
Raw Docker command output remains excluded. Exact-tree reconciliation and native
completion classifications are unchanged; no retry, approval or weaker acceptance
condition is added.

## Verification

No new provider inference was run. All Docker probes used copies, disabled
network access, and no real provider credentials. The original state, cache and
candidate inventories were checked before and after each valid reproduction.

Five frozen artifacts were tested with their prior binary and the new exporter:
the three angle-grinder candidates plus the repaired Pueue and ngrrram candidates.
All ten exports succeeded. For every pair:

- The exported Git tree equals the original handoff hash.
- Working-tree checks are clean.
- Every exported file's content or symlink target, mode and ownership matches.
- Original state, cache and candidate inventories remain unchanged.

Observed mean export invocation time was 2.4867 seconds before and 1.4322 seconds
after, a 42.41% reduction. There is one observation per artifact and binary, with
non-randomized order on a shared host. This is a diagnostic measurement, not a
statistically established speedup or a benchmark capability improvement.

Additional old/new controls exported the repaired angle-grinder snapshot while a
second server had actively initialized the candidate Location through the file
search API. Both passed. A malformed model-catalog control also passed in both
versions; it does not identify the original failure. Early probes with incorrectly
copied ownership failed before reaching export; those were setup errors and are
not counted as reproduced product failures.

The six inference-related source modules match the preceding frozen binary's
source hashes. The new binary changes only the export service and export CLI
relative to that source overlay. The original P0 binaries and historical campaign
records are not replaced.

Validation: 157 Core tests and 529 ProgramBench tests passed; one separate
image-building integration test was deselected. The artifact probes did use real
Docker. Core and OpenCode package typechecks passed. Core coverage includes exact
subject preservation, outstanding duty after export, missing Contract/binding,
challenge-cleared handoff, missing snapshot without live-workspace substitution,
existing-destination protection and snapshot-disable policy. Adapter coverage
includes existing ambiguous-export reconciliation and redaction before truncation.

Artifact root:
`/home/duozhou/run-artifacts/procontract-export-repair-20260906-v1/`

Important artifacts: `verification.json`, `reproduce.py`, `scoped-overlay/manifest.json`,
`binaries/scoped/opencode.build.json`, `matrix-*/result.json`,
`matrix-*/export-inventory.json`, `core-tests.log`, `programbench-tests.log`.

## Release gate and remaining uncertainty

The original live export failures have not been reproduced: old and new binaries
both export their preserved states successfully. The underlying transient cause
remains unknown. Dependency isolation and diagnostic retention are verified;
complete resolution of those live failures is not.

For a future capability promotion, freeze the runtime and adapter before running
a matched-budget panel. Require no selected-instance score regression, no loss of
evaluation validity or native delivery, no hidden failed-instance replacement,
and compliance with the original resource ceilings. Report actual turns, cost and
time separately. A raw-score improvement cannot compensate for a lost delivery.
An export-only replay cannot satisfy this capability gate.

If a live export fails again, retain its bounded diagnostic and original state
before choosing the next intervention. Do not approve a revision, weaken exact
identity, increase budgets, rerun inference silently, or overwrite history to make
the failure disappear. Broader paired or repeated tests remain necessary before
claiming general capability nonregression.
