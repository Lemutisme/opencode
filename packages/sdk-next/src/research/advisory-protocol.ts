export * as ResearchAdvisoryProtocol from "./advisory-protocol"

import { Schema } from "effect"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractBlob } from "@opencode-ai/core/pro-contract/blob"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { ResearchModel } from "./model"
import { ResearchFeedback } from "./review-feedback"

export const Admission = Schema.Struct({
  version: Schema.Literal(3),
  contractID: ProContract.ID,
  planHash: ProContractBlob.Digest,
  manifestHash: ProContractBlob.Digest,
  policy: ResearchModel.ReviewPolicy,
  context: ProContract.ContextTarget,
})

export const Plan = Schema.Struct({
  view: Schema.NonEmptyString,
  scope: ResearchModel.Plan.fields.scope,
  question: Schema.NonEmptyString,
  hypothesis: Schema.NonEmptyString,
  baseline: Schema.NonEmptyString,
  implementation: Schema.NonEmptyString,
  method: Schema.NonEmptyString,
  controls: Schema.NonEmptyString,
  data: Schema.NonEmptyString,
  evaluation: Schema.NonEmptyString,
  uncertainties: Schema.NonEmptyString,
  protected: Schema.Array(Schema.NonEmptyString),
})
export const Action = Schema.Struct({ view: Schema.NonEmptyString })
export const Resume = Schema.Struct({ view: Schema.NonEmptyString, replan: Schema.optional(Schema.Boolean) })
export const Submit = Schema.Struct({ view: Schema.NonEmptyString, treatment: Schema.optional(Schema.NonEmptyString) })
export const Target = Schema.Struct({ review: Schema.NonEmptyString, finding: Schema.NonEmptyString })
export const Note = Schema.Struct({
  view: Schema.NonEmptyString,
  target: Schema.optional(Target),
  previous: Schema.optional(Schema.NonEmptyString),
  disposition: Schema.optional(
    Schema.Literals(["adopted", "repair_planned", "rebutted", "unresolved", "fixed", "removed"]),
  ),
  reason: Schema.NonEmptyString,
  evidence: Schema.optional(Schema.Array(Schema.NonEmptyString)),
})
export const Record = Schema.Struct({
  version: Schema.Literal(3),
  contractID: ProContract.ID,
  manifestHash: ProContractBlob.Digest,
  context: ProContract.ContextTarget,
  basisHash: ProContractBlob.Digest,
  basisVersion: Schema.Int,
  recordedAt: Schema.Number,
  kind: Schema.Literals(["response", "intent", "completion", "submission"]),
  target: Schema.optional(Schema.Struct({ outcomeHash: ProContractBlob.Digest, findingID: Schema.NonEmptyString })),
  previousHash: Schema.optional(ProContractBlob.Digest),
  disposition: Note.fields.disposition,
  reason: Schema.optional(Schema.NonEmptyString),
  evidence: Schema.Array(ProContractBlob.Digest),
  planHash: Schema.optional(ProContractBlob.Digest),
  subjectHash: Schema.optional(Schema.NonEmptyString),
  verificationHash: Schema.optional(ProContractBlob.Digest),
})
export type Record = typeof Record.Type
export const Entry = Schema.Struct({
  phase: Schema.Literals(["plan", "delivery"]),
  outcomeHash: ProContractBlob.Digest,
  outcome: ResearchFeedback.Outcome,
  raw: Schema.optional(Schema.String),
  unaddressed: Schema.Array(Schema.String),
})
export const Bundle = Schema.Struct({
  ...ResearchModel.Bundle.fields,
  version: Schema.Literal(3),
  policy: ResearchModel.ReviewPolicy,
  feedback: Schema.Array(Entry),
  admissionHash: Schema.optional(ProContractBlob.Digest),
  submissionHash: ProContractBlob.Digest,
  commands: Schema.Array(Schema.Unknown),
  commandConflicts: Schema.Array(Schema.Unknown),
  records: Schema.Array(Schema.Struct({ hash: ProContractBlob.Digest, current: Schema.Boolean, record: Record })),
  treatment: Schema.Struct({
    status: Schema.Literals(["provided", "not_provided"]),
    text: Schema.optional(Schema.String),
  }),
})
export type Bundle = typeof Bundle.Type

/** An audit append does not change the material that an already issued view names. */
export function basis(run: ResearchModel.Run) {
  return ProContractRecognition.fingerprint({
    id: run.id,
    context: run.context,
    manifestHash: run.manifestHash,
    round: run.round,
    reviewVersion: run.reviewVersion,
    stage: run.stage,
    planHash: run.plan?.hash,
    admissionHash: run.plan?.admissionHash,
    subjectHash: run.subjectHash,
    verificationHash: run.verificationHash,
    experiment: run.experiment,
    outcomes: run.feedbackHistory?.map((item) => item.outcomeHash),
  })
}
export function admission(run: ResearchModel.Run) {
  return {
    version: 3 as const,
    contractID: run.id,
    planHash: run.plan!.hash,
    manifestHash: run.manifestHash,
    policy: run.input.manifest.reviewPolicy!,
    context: run.context,
  }
}
