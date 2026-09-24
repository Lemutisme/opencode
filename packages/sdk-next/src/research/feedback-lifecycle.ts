export * as ResearchFeedbackLifecycle from "./feedback-lifecycle"

import { Schema } from "effect"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractBlob } from "@opencode-ai/core/pro-contract/blob"
import type { ResearchModel } from "./model"

export const Request = Schema.Struct({
  responseHash: ProContractBlob.Digest,
  findingID: Schema.NonEmptyString,
  previousHash: Schema.optional(ProContractBlob.Digest),
  planHash: Schema.optional(ProContractBlob.Digest),
  subjectHash: Schema.NonEmptyString,
  verificationHash: ProContractBlob.Digest,
  disposition: Schema.Literals(["fixed", "removed", "rebutted", "unresolved"]),
  reason: Schema.NonEmptyString,
  evidence: Schema.NonEmptyArray(ProContractBlob.Digest),
})
export type Request = typeof Request.Type

export const Completion = Schema.Struct({
  version: Schema.Literal(1),
  contractID: ProContract.ID,
  manifestHash: ProContractBlob.Digest,
  context: ProContract.ContextTarget,
  round: Schema.Int,
  reviewVersion: Schema.Int,
  basisVersion: Schema.Int,
  basisHash: ProContractBlob.Digest,
  outcomeHash: ProContractBlob.Digest,
  recordedAt: Schema.Number,
  request: Request,
})
export type Completion = typeof Completion.Type

export const Entry = Schema.Struct({
  hash: ProContractBlob.Digest,
  current: Schema.Boolean,
  completion: Completion,
})

export const Read = Schema.Struct({
  source: Schema.Literals(["verification", "experiment"]),
  path: Schema.NonEmptyString,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(ProContractBlob.maximumBytes)),
  length: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(16_384)),
})

export function current(run: ResearchModel.Run, record: Completion) {
  return (
    record.contractID === run.id &&
    record.manifestHash === run.manifestHash &&
    record.context.revision === run.revision &&
    record.context.specHash === run.specHash &&
    record.round === run.round &&
    record.reviewVersion === run.reviewVersion &&
    record.request.planHash === run.plan?.hash &&
    record.request.subjectHash === run.subjectHash &&
    record.request.verificationHash === run.verificationHash
  )
}
