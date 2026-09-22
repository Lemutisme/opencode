# OTA: strict growth without task regression

The operator's 2026-09-22 instruction supersedes the earlier 1 pp proposal:
“只要是增长就可以晋升。只要是有下降就不能晋升”.

`performanceRule: "task-pareto"` requires every assigned instance's mean over
its fixed repeats to be nondecreasing, and at least one to increase strictly.
Comparisons use exact rational scores, not rounded percentages or an epsilon.
One task's improvement (even a new full pass) cannot offset another task's loss.
Individual stochastic repeats are not the unit of the regression veto; instances
are. Both development and confirmation must have complete, valid observations.
All-tied candidates do not promote. Safety, retained/required robust full passes,
runtime probation, fencing and rollback remain mandatory. There is no mean margin
or zero/sentinel value in this mode. Explicit legacy margin profiles retain their
old semantics. The normative Kernel and Schema are unchanged.

## Versioned handoff, not a live predicate edit

The original cohort at `procontract-sol-ota-rsi-20260921` remains frozen. Its H1
rejection and all subsequent observations remain historical facts. The new
cohort is `/home/duozhou/run-artifacts/procontract-sol-ota-pareto-20260922`.

The external transition owner waits for the in-flight `job-79-1` (H2) comparison
to finish, requests cancellation of the old controller, and requires acknowledged
process/worker fencing before launching the new authority. No old scores are
dropped, retried or relabeled. The chosen readmission target is the already fully
evaluated H1, fixed before H2 completes; no selection from H2 confirmation results.

The new profile pins an operator readmission manifest: the original qualification
event, independently scored paired receipts, exact S/H identities, unchanged test
assignments and a private, sealed H0-compatible memory snapshot. These observations
are re-adjudicated under the new protocol. This is explicitly **post-hoc operational
readmission**, not fresh evaluation or a preregistered improvement claim.

The supervisor accepts that manifest only at an untouched new authority, after
fencing. It records the original protocol/evidence, then performs a new Kernel
settlement using a distinct protocol identity and receipt. H1 cold-starts in H mode
with a private memory fork and may change only S. H0 and its sealed memory remain
the rollback target. A restart during the trial retains existing rollback/no-retry
semantics; it does not replay the readmission. Runtime health must still be observed.

`AUTHORIZATION.json`, `READMISSION.json`, `QUALIFICATION.json`, `TRANSITION.json`,
`STATUS.json`, and the new `ota.sqlite` distinguish authorization, waiting, actual
admission, probation and health. A prepared transition is not an executed switch.
`CANCEL` in the new root cancels either the waiting transition or its running OTA.
