# Independent design review: repair lifecycle, citations, usage supplement

2026-09-21. Review of `specs/pro-contract-researcher-repair-lifecycle.md`, initial design SHA-256 `8b4584b8fa7b4e7bad29d1aa51a0ecc262dc96eb1c894d5dc6e447368fa1b985`.

Disposition: the proposed scope is appropriate, but four integration blockers and two lifecycle edge cases need explicit design resolution before implementation. The root agent has received the findings and proposed closures for the four blockers; this initial artifact records the issues before those amendments are reviewed.

This was a source and design review. No provider was called, no historical database was opened, and no source or historical artifact was changed. The reviewed implementation files were byte-equal to the supplied 6,583-file baseline, whose inventory hash is `1ff371074290c0d18e34799c42ef36567fd1d740d128345292d4b6cc1b561cb6`. The source baseline, rather than Git HEAD, is the comparison boundary.

## Blocking findings

### D1 — Preserve historical v2 prompt rendering during validation

The initial design's B section preserves v1 hash syntax but does not preserve historical v2 jobs. `ResearchFeedback.capture` validates that the archived job prompt contains `prompt(map)` (`packages/sdk-next/src/research/review-feedback.ts:255`). `validate` replays `capture` against the archived job (`review-feedback.ts:415` onward). Replacing `ResearchFeedback.prompt` with the new selector-only rendering therefore invalidates historical v2 outcomes even when their raw output, map, resolution, job fingerprint, and source are unchanged.

The failure also affects old outcomes retained in a new candidate's history and exact recognition. Preserving only the v1 branch at `planning.ts:413` and `index.ts:1075` does not fix it.

Required fix: retain the exact old v2 renderer for references without a newly frozen rendering discriminator. Add an optional discriminator such as `promptVersion: 2` to newly issued reference maps and dispatch renderer validation using the archived map. Expected-map reconstruction inside `capture` must preserve that discriminator instead of silently applying a new default to an old map. Keep the old wire resolver strict; invalid historical hashes must remain invalid.

Required regression: an archived old-v2 plan outcome and old-v2 delivery outcome still validate after the new renderer is installed, including when retained in later history and during exact recognition. New job prompts expose concrete `{jobID,id}` objects and no competing hash citation list. Legacy v1 still uses exact hashes.

### D2 — The current completion cannot be an input to the review that precedes it

Initial A.1 requires `review_completion` after the current independent delivery review, but also says final reviewer materials retain completion records. Current materials are constructed and hashed before the review job is created (`packages/sdk-next/src/research/index.ts:992-1018`, `1043-1078`). The proposed completion depends on the candidate's already completed review/feedback stage. Inserting that completion into the same review's materials creates an evidence cycle or requires silently replacing an already frozen material blob.

Required fix: state the temporal boundary precisely. A delivery reviewer can receive earlier completion history. The completion appended after that review is a Researcher assertion bound to the reviewed candidate and formal evidence, retained in the final bundle and external trajectory evaluation. Do not claim the preceding reviewer assessed that later assertion. A subsequent review may assess it as prior history. This resolves the cycle without another provider call or an extra mandatory review.

Required regression: the material blob and current review outcome remain unchanged when a completion is appended; final bundle and evaluator contain the completion; the record does not acquire an implied semantic-approval flag.

### D3 — Completion needs a validation boundary independent of submission and unanswered current feedback

The intended append happens before the current response. Existing `ResearchFeedbackEvidence.validate` requires the current explicit submission response (`packages/sdk-next/src/research/feedback-evidence.ts:111-115`). Existing `entries` rejects any historical outcome without a response (`feedback-evidence.ts:50-51`), and `admission` calls `entries` for the entire history (`feedback-evidence.ts:174`). Thus neither the final submission validator nor the whole-history admission helper can be reused directly for an append while current delivery feedback is unanswered. The implementation would reject every valid completion or accidentally require a response first, after which `review_response` closes admission and leaves feedback (`feedback-control.ts:107-143`).

Historical validation has a second constraint: the existing mechanical verifier derives expected job fingerprints and protected inputs from the supplied run's current round and plan (`feedback-evidence.ts:240-282`). Applying it to an old completion using the latest run would reject legitimate retained evidence after a plan or round change, or validate against the wrong protected inputs.

Required fix: reuse/extract a submission-independent verifier for exact frozen verification jobs and evidence. Admission validation should load its selected original plan outcome/response rather than require every later outcome to be answered. Completion validation must validate its selected original response and current mechanical basis without calling final bundle validation. Keep whole-history strictness at publication. Store a host-created reference to the pre-append durable run, such as `basisVersion` and `basisHash`; historical replay must locate and verify that exact history row and validate with its plan, round, review version, context, runner, candidate, and experiment. Treat latest applicability separately from historical validity.

Required regressions: append with unanswered current delivery feedback; then respond and submit. Preserve a completion through a later same-plan repair and a revised-plan repair; old evidence stays valid as history and becomes inapplicable to the new candidate. Mutation or substitution of the historical basis row must fail. Historical validation must not depend on the original deadline still being in the future; only new command admission does.

### D4 — Feedback currently has no way to read its formal archived evidence

The design asks the Researcher to read current evidence before appending a completion. `read_experiment` authorizes only exploration/execution and specifically requires execution (`packages/sdk-next/src/research/planning.ts:45`, `137`). Completion is confined to delivery feedback. Generated outputs are intentionally absent from the worker workspace (`packages/sdk-next/src/research/protocol.ts:110`). Final-only tasks have no planned experiment reader at all. Showing legal evidence hashes cannot supply the underlying evidence bytes.

Required fix: add a bounded read/control-only evidence reader for lifecycle delivery feedback, or an equivalently narrow extension. A concrete shape is `read_review_evidence` with `source: verification|experiment`, an exact allowlisted relative path, offset, and bounded length. Final-only tasks use verification. Derive identity and blob hash from the current run; never accept arbitrary blob hashes or host paths. Recheck the same original execution, candidate, run version, and deadline after I/O. Do not close admission or enable writes. Follow the existing reader's byte limit and operation timeout.

Required regressions: current verification and experiment evidence can be read in feedback; final-only verification can be read; unknown paths, arbitrary hashes, cross-candidate reads, old-plan experiment reads, out-of-range slices, changed authority, and deadline-crossing I/O fail.

## Lifecycle edge cases that need explicit rules

### D5 — Final-only cannot take the revise-to-exploration transition

New v2 issuance defaults to the lifecycle for both planned and final-only tasks. The initial transition table allows delivery `planChange: revise` to enter exploration, but `ResearchPlanning.command` rejects any task without `input.planning` (`packages/sdk-next/src/research/planning.ts:43`). Such a final-only task would be stranded in an unusable phase.

Required fix: for final-only lifecycle responses require `planChange: retain`, meaning there is no internal plan to revise, and reject `revise` without changing stage or authority. Within-task implementation repairs still use the normal final-only repair path. Alternatively make the field planned-only, but a fixed `retain` rule is a smaller protocol change.

Required regression: final-only lifecycle repair/completion/submission works, and revise is rejected atomically. External task changes continue to require the Principal's revision.

### D6 — Define exact retry precedence and host timestamp stability

Initial A.1 promises exact retry idempotence, a server-generated time, and stale-predecessor rejection. Without an explicit ordering, retrying a successful append either produces a new hash due to the new time or fails because the former predecessor is no longer the current head.

Required fix: identify a request independently of the generated record timestamp. Under valid current execution authority and the original deadline, check for the exact stored request and return its original hash/time without a new history row before treating its predecessor as stale. A different request with that old predecessor must fail. State whether an exact retry remains readable after later appends; returning the original receipt while the current command remains authorized is consistent and simplest. Do not bypass expiry or execution fencing merely to serve a retry.

Required regressions: exact retry does not append or change time; changed payload with the same predecessor fails; an older exact retry after a later append returns the original receipt according to the chosen rule; expired or displaced execution fails before and after evidence I/O.

## Usage supplement review

The design's separation is correct: transport completion, operation status, and usage knowledge are independent facts. `ProContractJob.observe` only persists usage from consumed model events (`packages/core/src/pro-contract/job.ts:484-493`); a gateway can retain a complete terminal response after the runner has stopped consuming. The gateway already retains complete/truncated flags and raw body bytes (`packages/opencode/script/research-eval/provider.ts:205-221`), and result/failure archives bind `transportHash` (`instance.ts:348`, `449`). No Core finish event or operation-status edit is needed.

No additional architectural blocker was found for C. The following concrete constraints should be frozen rather than left to a broad parser:

- Support only the archived Chat Completions and Responses SSE formats already permitted by this gateway. Reject unsupported or malformed streams as unresolved. Require HTTP success, complete untruncated capture, valid terminal protocol completion and usable nonnegative finite token counts. A gateway `complete` observation alone is insufficient: it is emitted even by `finish(false)` (`provider.ts:208-223`).
- Require one uniquely matched provider request/wire identity for an operation. Deduplicate identical captures, retain their provenance, and leave conflicting bodies, conflicting terminal usage, missing request rows, multi-request operations, and ambiguous attribution unresolved. Script requests do not acquire provider tokens.
- Verify original result/failure object, transport object, and archived operation identity. Normal archived operations are in collected evidence; retained failures expose them in `partial[0]` (`instance.ts:406-409`). If the operation archive is unavailable, preserve the unknown item. Do not fall back to opening a historical live database.
- Transport identity consists of contract, session, operation, and job (`observe.ts:16`). Execution identity/deadline are properties of the matched archived operation's `source` (`core/src/pro-contract/job.ts:68-74`), not independently observed transport fields. Inherit them from that uniquely matched archived object and label their provenance accordingly.
- Derive stable fact identity from original source hashes and request/operation identity, excluding output path and reconciliation time. Repeating into a different directory should retain fact IDs. A copied duplicate capture must not create a second charge.
- Preserve inclusive token semantics: input includes cached tokens; output includes reasoning tokens (`packages/llm/src/schema/events.ts:10-26`). Compare all mutually known normalized fields, not only the total. Never add reasoning/cache a second time. Keep cost unknown; no price estimate is authorized or needed.
- Present original known totals, confirmed totals, supplemental totals, effective known totals, remaining unknown items, and unchanged execution status distinctly. A conflict must remain visibly unresolved even if the original ledger had a known number. Counts and score hashes remain untouched.

The narrowest sufficient implementation is an offline reader plus immutable sidecar and derived report for the existing archived formats, accepting one unique terminal request per operation. Supporting aggregation across several requests or a generic billing system is unnecessary for the observed defect.

## Compatibility and integration acceptance conditions

The proposed independent `feedbackProtocol` is preferable to overloading advisory/required review policy. Preserve field absence in old manifests during issuance retry; do not materialize `response:1` into an old manifest or change its input hash. New v2 issuance may default to `repair-lifecycle:1`; explicit `response:1` stays available. Reject lifecycle under v1. The frozen development scenario should retain its response protocol without modifying existing frozen source or scoring truth.

The protocol switch must reach every response decoder and archive consumer, not only the command. Current `feedback-evidence.ts:34`, `57`, `evaluate.ts:290`, and `feedback-evaluate.ts:28` assume the old response schema. New records must survive actual bundle generation and exact recognition (`adapters.ts:160-194`) and enter `archive.collect`'s initial hash roots (`archive.ts:67-86`). The archive's recursive hash scan can follow a completion only after its first hash is seeded. Bundle omission must fail recognition; historical bundles with absent lifecycle fields must remain byte-identical and valid.

Keep the host's conclusion narrow: identity, ordering, authorization and evidence binding are mechanically validated. `fixed`, `removed`, and `rebutted` remain researcher claims for independent semantic judgment. Unresolved or unfinished intentions do not become a blanket advisory veto, while explicit required available-accept gates remain unchanged.

The requested deterministic host/HTTP regressions and package typechecks are sufficient for this implementation review. Another real calibration, cohort launch, historical score rewrite, or generic workflow engine is unnecessary.

## Amended design closure

The root agent amended the design after receiving this review. I independently reread the complete amended design and the separate `independent/accounting-investigation.md` source investigation. The reviewed amended design SHA-256 is `ab1154f0a09795146d059047003c73991103ad3952af99c6d557d9de06301184`.

Disposition: **design blockers closed; implementation may proceed within the three stated work packages**. This approves the design boundary, not an implementation that has not yet been reviewed or tested.

| Finding | Amended design resolution |
| --- | --- |
| D1 | New maps freeze `promptVersion:2`; absent field retains exact old-v2 renderer and map reconstruction. |
| D2 | Current reviewer sees frozen candidate/evidence and earlier history. Later completion is a Researcher assertion retained for delivery/external evaluation, without retroactive reviewer approval or another automatic review. |
| D3 | Submission-independent mechanics and selected admission validation; final publication remains strict. Host `basisVersion`/`basisHash` binds the pre-append durable run, and historical replay uses its original plan/round/context/job. |
| D4 | Bounded `read_review_evidence` in lifecycle delivery feedback supports verification/experiment allowlisted paths and final-only verification, with authority/deadline checks around I/O. |
| D5 | Final-only explicitly rejects revise. |
| D6 | Canonical stored-request lookup precedes stale-predecessor rejection, returns original hash/time, and retains current authority/deadline/candidate checks. |

Two implementation interpretations were sent to the root agent with closure. First, D6's “same current basis” means unchanged candidate/plan/verification/round; it cannot mean that current `run.version` equals the original pre-append `basisVersion`, because the successful append itself changes run version. Exact retry locates the original stored basis; a new append uses current CAS fencing. Second, D4 must retain an individual I/O timeout capped by the original remaining deadline, as the existing read helper does, in addition to the returned byte-slice limit. These refine the stated bounded-I/O and idempotence requirements without expanding scope.

Section C now fixes the supported archived protocols, terminal-completion rule, unique real provider request chain, cohort/result/operation/transport provenance, inherited execution identity, conflicting snapshots, stable fact identity, inclusive token accounting, disputed effective values, unknown cost, separate reconciliation code identity, and output outside the historical tree. The independent accounting investigation confirms the specific archived R3 fact while preserving the uncertainty about the exact internal interruption race winner. No new design blocker was found.

The original findings above remain unchanged as the review history. Their regression expectations and the archive/bundle/exact-recognition acceptance conditions remain obligations for implementation and independent code review.
