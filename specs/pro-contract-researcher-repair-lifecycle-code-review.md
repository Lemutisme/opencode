# Independent implementation review: repair lifecycle

2026-09-21. Reviewer: `/root/lifecycle_design_review`, independent of the implementation and test author.

Scope: incremental source changes against `/workspace/researcher-followup-20260921T005437Z/baseline/files`, chiefly `packages/sdk-next/src/research/{feedback-lifecycle,feedback-completion,feedback-evidence,feedback-control,review-feedback,model,protocol,index,planning,adapters}.ts`, plus explicit evaluation protocol issuance and completion archive roots. The baseline inventory contains 6,583 files and has hash `1ff371074290c0d18e34799c42ef36567fd1d740d128345292d4b6cc1b561cb6`. No comparison to Git HEAD was substituted for this baseline.

Final disposition: **approved for the reviewed lifecycle, citation, and archive integration scope; C1–C6 are closed and no blocking finding remains**. Final passing evidence and scope limits are recorded in the signoff at the end. This file preserves findings as they were raised and records the fixes observed during review.

No source was edited by this reviewer, no real provider was called, and no historical database or experiment artifact was opened or modified. A local schema-decoding probe and a byte-comparison script were run; their results are below. An initial probe invocation failed because `bun` was absent from PATH, then succeeded using `/tmp/opencode-research-toolchain/bun-linux-x64/bun` from `packages/sdk-next`.

## Findings raised during source review

### C1 — Completion must verify the current delivery review, not only its stage

Initial `completionBasis` checked delivery-feedback stage and formal verification/admission, while `completionRequest` verified only the original response's review. It did not validate the current delivery outcome/job. A missing, corrupted, or substituted current review could therefore escape the append/read boundary and be rejected only later at final publication. This did not satisfy the requirement that the record follow an intact independent review of this exact candidate.

Required fix: require current feedback outcome to equal `run.reviewHash`, then call the current-outcome validator before mechanical evidence validation. A valid unavailable outcome must remain allowed; this integrity check must not introduce an available-accept requirement for advisory work.

Observed closure: `feedback-evidence.ts:235-248` now binds the current outcome and calls `reviewer.validate(run, run.feedback.outcomeHash)`. Source-level issue closed; corruption and valid-unavailable regressions remain required.

### C2 — Append evidence I/O needs an individual operation timeout

Initial `review_completion` held the write transaction while loading its current and historical evidence, writing basis and completion blobs, and validating prior chains, without an operation timeout. The read command had a 30-second/remaining-deadline bound, but append did not. Post-I/O deadline checking alone cannot bound a stalled I/O operation or a transaction waiting on such an operation.

Required fix: wrap the append transaction in an individual timeout capped by the original remaining deadline, retaining the final original-execution authorization and CAS before commit. Timeout must roll back the durable append; an unreferenced content-addressed blob alone is not an admitted record.

Observed closure: `feedback-completion.ts:112-164` now captures the original deadline and applies `min(30_000, remaining)` around the transaction. Source-level issue closed; deadline-crossing and rollback regressions remain required.

### C3 — Original response evidence integrity was deferred until submission

Initial `completionRequest` loaded and validated the original response object and its review but did not read evidence blobs cited by that original response. `entry` read the original raw reviewer output, while the final publication validator was the only path reading all response citations. A completion could therefore be admitted or historically replayed while its original response contained missing or corrupt evidence.

Required fix: read and hash-verify original response citation blobs at the completion boundary. These remain citations/claims; verifying their bytes must not assign them semantic authority.

Observed closure: `feedback-evidence.ts:280-282` now reads every selected original response evidence blob before checking the target finding and completion basis. Source-level issue closed; original-response corruption regression remains required.

### C4 — New citation rendering lost the selector-to-material association

The initial new renderer at `review-feedback.ts:173` listed only `{jobID,id}` objects. Delivery map entries such as `evidence-0`, `plan-0`, `plan-1`, and `plan-2` no longer exposed which material each selected. The old rendered map provided hashes linking those IDs to evidence; new maps were not separately materialized for reviewers. Copyable syntax alone cannot tell a reviewer that `plan-2` denotes experiment verification, or which file `evidence-0` denotes.

Required fix: render named entries adjacent to their exact selector object, with stable material roles or allowlisted evidence paths. Keep hashes as archived identity data rather than a competing citation syntax. A deterministic prompt test must verify the label/object association for both plan and delivery jobs.

Status when raised: open; sent to the implementation owner. The repair should preserve the exact old renderer for maps without the new prompt discriminator.

### C5 — Bare plan hash expands completion evidence beyond the specified allowlist

The initial completion allowlist included `run.plan.hash` separately from verification and experiment evidence (`feedback-evidence.ts:305`), and the prompt advertised a plan-only completion citation. The design defines the nonempty completion citation set as current formal verification/experiment evidence; plan identity is already bound by the separate request `planHash` field. Adding a naked plan citation is a protocol choice beyond that declared set.

Smallest fix: remove bare plan hashes from completion evidence choices while retaining `planHash` as identity. Alternatively explicitly amend the design if plan artifacts should be independently admissible completion evidence. This is an evidence-source scope issue, not a request for the host to decide whether a repair is semantically successful.

Status when raised: open clarification; sent to the implementation owner.

## Reviewed implementation boundaries

The following structures are consistent with the approved design, subject to the regressions below:

- Issuance defaults only new v2 tasks to `repair-lifecycle:1`. Exact retries inherit the existing field and preserve historical omission; lifecycle under v1 is rejected. `driver.ts` explicitly chooses `response:1` for the existing feedback-development evaluation.
- Response schema and protocol checks separate legacy `fixed` responses from new versioned intentions. Revision requires repair, final-only rejects revision, and response handling remains read/control-only. Required available-accept gates remain intact; unresolved and planned repairs do not become an advisory veto.
- Delivery revision reopens exploration and invalidates admission/experiments. Same-plan delivery repair reopens execution and invalidates candidate evidence. The new plan command still admits only the next exact plan version within the original agreement.
- Completion binds a selected original response/finding, current candidate/plan/verification, verified jobs, and nonempty allowed evidence. Host-generated `basisVersion`/`basisHash` preserves the exact pre-append durable run. Historical validation uses that run's round, plan, context, and protected inputs rather than the latest state.
- During this review the author strengthened historical validation to require the exact immediate successor durable event to equal the basis plus the new completion hash. This prevents a detached, content-addressed record from masquerading as an admitted append.
- Exact retries are checked before stale-predecessor rejection, preserve the original record/time, and require current applicability and execution authority. New requests use the latest per-response/finding predecessor. The append changes run version without making its own exact retry impossible.
- Completion applicability includes contract/manifest/spec, round/review version, plan, subject, and delivery verification. Historical validity is separate from current applicability and semantic success. Publication context advancement does not itself invalidate a completion.
- The reader selects verification or experiment from the current run and resolves only allowlisted relative paths. It checks full blob identity and size, bounds returned slices, and rechecks current identity/authority/deadline after I/O.
- Final bundles explicitly include lifecycle protocol and completion records. Exact recognition compares those fields to freshly validated run history. Archive collection now seeds `completionHashes`, allowing recursive collection of the record, basis, and cited blobs.
- Earlier completion claims enter later reviewer materials; the current post-review append does not mutate the already frozen material or pretend to have been reviewed. The author also identified the need to copy earlier cited evidence files into the later review directory.

The implementation of `completions` must continue validating an old record without requiring that the original command deadline is still in the future. New append/read authorization is where current execution and deadline belong; historical proof only checks that the admitted record was made before its original deadline.

## Independent checks and remaining regression obligations

The old-v2 prompt renderer body was compared as text to the supplied baseline and is byte-identical. A pure local Effect Schema probe decoded a version-2 response with `planChange: retain` and an `unresolved` finding both directly and nested in another struct; both retained `version` and `planChange`. Thus the legacy-first union does not silently strip these lifecycle fields in the tested shape.

No independent production-host test suite has been run yet because the implementation owner is adding and running the relevant fixtures. The first local production workflow log was observed to fail a transcript-string expectation; no final passing result is claimed here. Test evidence must distinguish test-fixture/assertion defects from implementation defects, preserving failed logs.

Final review should require actual-host coverage of default issuance and legacy retry omission, old v1 and old/new v2 review validation, revised-plan and same-plan repair, final-only lifecycle, required/advisory behavior, repair versus deletion claims, unfinished intentions remaining deliverable, exact retry and stale predecessor, candidate/plan/round changes, damaged current and original evidence, historical basis/append-chain tampering, and deadline or authority loss during I/O. Bundle generation, archive collection and exact recognition must consume the new records in those tests, rather than validating helper output alone. Run package typechecks and relevant tests from package directories; no real calibration is needed.

## Source rereview while regressions are being completed

C4 is closed at source level: new immutable map entries have optional human-readable labels, and the renderer emits each material label adjacent to its exact selector. Plan jobs label the proposed plan and frozen background; delivery jobs label verification, evidence array index/path, current plan, independent plan outcome and experiment verification. Maps without `promptVersion` still use the unchanged old renderer. C5 is closed: the completion allowlist now contains verification/experiment result hashes and their evidence hashes only; bare plan hash remains an identity field.

The new actual-host fixtures were inspected, independently of their author. They drive replan → formal experiment → completion → correction → submission → exact external attestation; test a later revised candidate retaining old completion identity and distinguishing removal; submit with a valid unavailable advisory review; allow a final-only task to disclose unfinished intentions; and inject evidence corruption and deadline crossings at actual archive I/O checkpoints. These are meaningful boundary tests. Their final execution results remain pending at this review point.

### C6 — Later reviewers need the original finding and response behind earlier completions

The implementation copies an earlier completion record and its completion-evidence blobs into the later review directory (`index.ts:1044-1048` at review time), but the completion exposes its original outcome and response only by hash. The original outcome/response blobs are not copied, and `previousCompletionClaims` does not embed their contents. A later reviewer asked to assess that earlier claim cannot inspect the actual original finding or response, especially after the plan changes.

Required fix: include the corresponding immutable original outcome/response context in later review materials, or materialize those blobs and any raw original review needed to understand them. Preserve their original candidate identity; do not reinterpret an old finding as if it had been raised against the latest candidate. Final bundles already embed original feedback entries, so this concerns the reviewer material path specifically.

Status: sent to the implementation owner; awaiting source rereview. This is the remaining material-completeness finding, alongside pending regression evidence. No semantic approval or additional mandatory review is requested.

## Final source rereview

C6 is closed. `index.ts` now embeds previously answered original outcome/response/raw entries in `materials.previousCompletionFeedback` and materializes their outcome, response, raw-output and response-citation blobs. Earlier completion records and their cited evidence remain separately materialized. This supplies the original finding context while preserving original subject identities and the fact that a newly appended completion was not reviewed retroactively.

`completionBasis` was further checked: the current outcome must be delivery phase, match `run.referencesHash`, and have the exact current context before the reviewer-source replay and mechanical verification checks. This adds identity validation without an available-accept veto. Both valid available and valid unavailable advisory outcomes remain possible.

The archive regression invokes the real `collect` implementation with a deterministic read-only object port, then checks every written object. The newly seeded completion links to its basis and proof, and all are retained even for a cancelled task with no bundle. It exercises archive traversal and persistence rather than duplicating the traversal in the test.

Source disposition: **C1–C6 closed; no remaining source blocker found in the reviewed lifecycle/citation implementation**. The reviewed design and Chinese/English overview and handoff preserve the intended limits: new v2 default issuance, historical response protocol, unchanged required acceptance, mechanical provenance rather than semantic success, original deadlines, no fifth calibration or 66-case cohort, and no historical score rewrite. The latest handoff's “new tasks” shorthand is understood in its surrounding explicit v2/legacy distinction; the detailed design remains authoritative.

Validation evidence read directly at this point:

| Evidence | Observed result |
| --- | --- |
| `validation/lifecycle-process-2.log` | 8 new actual-host lifecycle tests passed; 0 failed. |
| `validation/sdk-unit-final.log` | 47 tests across 5 files passed; 0 failed. |
| `validation/eval-unit-1.log` | 23 tests across 6 files passed; 0 failed, including archive coverage. |
| `validation/opencode-typecheck-2.log` | Typecheck invocation returned without diagnostics; the implementation owner reports successful completion. |
| `validation/sdk-typecheck-3.log` | Latest inspected SDK check failed with TS2322 in the new label-rendering test: mapped array did not retain the nonempty tuple type. Sent to the implementation owner; a passing rerun is required. |
| `validation/feedback-process-final.log` | Full production workflow suite still running; a complete passing result is not yet claimed. |

Final implementation signoff therefore remains conditioned only on fixing/rerunning the SDK typecheck and completion of the full workflow regression run. The old failed fixture logs remain part of the evidence rather than being overwritten. The earlier path mismatch was corrected from `result.txt` to the real `artifacts/result.txt` inventory path; the passing second lifecycle run supports that correction.

Coverage limit: new commands directly exercise post-I/O deadline failure. Existing production store/authorizer regressions separately cover stale versions, owner leases, generations and context changes; this review does not claim a separate takeover fault was injected at each new command's I/O checkpoint. Historical renderer compatibility was additionally established by byte comparison against the baseline. Those limits do not identify a source defect or imply semantic model capability.

The reviewed source inventory hash is `326973d3b25b27f1141dbae128e37b83b8116a2c9495235141f16d45aac14eca`, calculated as SHA-256 of a sorted compact JSON map from the ten lifecycle source paths listed at the beginning of this report plus `research-eval/{driver,archive,archive.test}.ts` to their file SHA-256 values. Subsequent source changes require rereview; test-only typing fixes do not change this source boundary.

## Independent final signoff

2026-09-21. I reread the final validation logs, inspected the nonempty-tuple test fix, and recomputed the reviewed source inventory. Its hash remains `326973d3b25b27f1141dbae128e37b83b8116a2c9495235141f16d45aac14eca`; the reviewed runtime source and archive test are unchanged from the source rereview. The historical v2 renderer body remains byte-identical to the supplied baseline. The final design, including the explicit implementation-review clarifications, has SHA-256 `db2cee04b3deed2426a567170d78d66ea37eddd13a2b91375355b16ab9fe9ad3`.

The selector test typing fix replaces a widened mapped array with an explicit two-entry tuple. It retains both labels and the same renderer/resolver assertions; it does not weaken the tested behavior. The previous type error and earlier fixture failures remain preserved in their original logs.

| Final evidence | Result |
| --- | --- |
| `validation/feedback-process-final.log` | 26 passed, 0 failed, 247 assertions; complete actual-host workflow suite, including lifecycle and legacy/required compatibility. |
| `validation/sdk-unit-final.log` | 47 passed, 0 failed, 146 assertions across 5 files. |
| `validation/sdk-selector-final.log` | 25 passed, 0 failed, 81 assertions after the test-only tuple fix; this overlaps the earlier SDK total and is not 25 additional distinct tests. |
| `validation/eval-unit-1.log` | 23 passed, 0 failed, 565 assertions across 6 files, including completion archive roots. |
| `validation/sdk-typecheck-final.log` | No diagnostics; runner reported exit 0. |
| `validation/opencode-typecheck-reviewed.log` | No diagnostics; runner reported exit 0. |

**Signed disposition: approved within this reviewed scope.** All raised implementation findings are closed, the required final typecheck issue is fixed, and the full host compatibility suite completed successfully. The earlier 8-test lifecycle result is a subset of the final host suite, not an additional independent count.

This signoff covers source review of the repair lifecycle, v2 citation rendering and historical compatibility, response protocol issuance, completion evidence/history/authority boundaries, review material completeness, archive roots, and their listed deterministic validation. It does not assert that a model will reliably revise its plan or make semantically correct repair claims. Required review and external Principal recognition remain distinct from those claims.

The accounting implementation has a separate independent review and is not re-certified by this lifecycle signoff. The root agent's additional eight-instance local v2 evaluation integration run was still underway when this signoff was made; its result must be listed separately when available and is not represented as completed here. No heavy suite was rerun by this reviewer, no real provider was invoked, and no historical artifact or database was changed.
