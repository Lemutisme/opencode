export * as ResearchFeedbackCompletion from "./feedback-completion"

import { isUtf8 } from "node:buffer"
import { Clock, Effect, Schema } from "effect"
import { ProContract } from "@opencode-ai/core/pro-contract"
import type { ProContractDelivery } from "@opencode-ai/core/pro-contract/delivery"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { ResearchModel } from "./model"
import { ResearchProtocol } from "./protocol"
import { ResearchStore } from "./store"
import { ResearchFeedbackEvidence } from "./feedback-evidence"
import { ResearchFeedbackLifecycle } from "./feedback-lifecycle"

export const details = Effect.fnUntraced(function* (run: ResearchModel.Run) {
  const state = yield* ResearchStore.Service
  const records = yield* ResearchFeedbackEvidence.completions(run)
  const responses = yield* Effect.forEach(
    (run.feedbackHistory ?? []).filter((item) => !!item.responseHash),
    (item) => ResearchFeedbackEvidence.entry(run, item),
  )
  const sources =
    run.feedback?.phase === "delivery"
      ? yield* Effect.forEach(
          [
            { source: "verification", hash: run.verificationHash! },
            ...(run.experiment ? [{ source: "experiment", hash: run.experiment.verificationHash }] : []),
          ],
          (item) =>
            state.json(item.hash).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.Verification)),
              Effect.map((value) => ({ source: item.source, verificationHash: item.hash, files: value.evidence })),
            ),
        )
      : []
  return {
    basis: { planHash: run.plan?.hash, subjectHash: run.subjectHash, verificationHash: run.verificationHash },
    targets: responses.flatMap((entry) =>
      entry.response.responses.map((item) => ({
        outcomeHash: entry.outcomeHash,
        responseHash: entry.responseHash,
        ...item,
        previousHash: records.findLast(
          (record) =>
            record.completion.request.responseHash === entry.responseHash &&
            record.completion.request.findingID === item.findingID,
        )?.hash,
      })),
    ),
    sources,
    completions: records,
  }
})

export const command = (input: Parameters<NonNullable<ProContractDelivery.Handler["command"]>>[0]) =>
  Effect.gen(function* () {
    const state = yield* ResearchStore.Service
    if (input.kind === "read_review_evidence") {
      const run = yield* authorize(input.execution)
      const request = yield* Schema.decodeUnknownEffect(ResearchFeedbackLifecycle.Read, { onExcessProperty: "error" })(
        input.payload,
      )
      return yield* Effect.gen(function* () {
        const invalid = yield* ResearchFeedbackEvidence.completionBasis(run)
        if (invalid) return yield* new ResearchModel.Denied({ message: invalid })
        const hash = request.source === "experiment" ? run.experiment?.verificationHash : run.verificationHash
        if (!hash || !ResearchProtocol.literal(request.path))
          return yield* new ResearchModel.Denied({ message: "Requested feedback evidence source is unavailable" })
        const result = yield* state
          .json(hash)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.Verification)))
        const matches = result.evidence.filter((item) => item.path === request.path)
        if (matches.length !== 1)
          return yield* new ResearchModel.Denied({ message: "Path is outside the current feedback evidence allowlist" })
        const bytes = yield* state.bytes(matches[0].hash)
        if (bytes.length !== matches[0].bytes || request.offset > bytes.length)
          return yield* new ResearchModel.Denied({ message: "Feedback evidence bytes or offset changed" })
        const after = yield* authorize(input.execution)
        if (
          after.verificationHash !== run.verificationHash ||
          after.plan?.hash !== run.plan?.hash ||
          after.subjectHash !== run.subjectHash ||
          after.experiment?.verificationHash !== run.experiment?.verificationHash ||
          !ProContractRecognition.same(after.context, run.context)
        )
          return yield* new ResearchModel.Denied({ message: "Feedback evidence changed during inspection" })
        const content = Buffer.from(bytes.subarray(request.offset, request.offset + request.length))
        const encoding = isUtf8(content) ? "utf8" : "base64"
        return {
          source: request.source,
          verificationHash: hash,
          subjectHash: run.subjectHash,
          planHash: run.plan?.hash,
          path: request.path,
          hash: matches[0].hash,
          totalBytes: bytes.length,
          offset: request.offset,
          returnedBytes: content.length,
          eof: request.offset + content.length === bytes.length,
          encoding,
          content: content.toString(encoding),
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: Math.max(0, Math.min(30_000, run.input.spec.budget.deadline - (yield* Clock.currentTimeMillis))),
          orElse: () => Effect.fail(new ResearchModel.Denied({ message: "Feedback evidence read deadline exhausted" })),
        }),
      )
    }
    if (input.kind !== "review_completion")
      return yield* new ResearchModel.Denied({ message: "Unknown feedback lifecycle request" })
    const deadline = (yield* authorize(input.execution)).input.spec.budget.deadline
    return yield* state
      .atomic(
        Effect.gen(function* () {
          const run = yield* authorize(input.execution)
          const request = yield* Schema.decodeUnknownEffect(ResearchFeedbackLifecycle.Request, {
            onExcessProperty: "error",
          })(input.payload)
          const invalid = yield* ResearchFeedbackEvidence.completionRequest(run, request)
          if (invalid) return yield* new ResearchModel.Denied({ message: invalid })
          const records = yield* ResearchFeedbackEvidence.completions(run)
          const retry = records.findLast(
            (item) => item.current && ProContractRecognition.same(item.completion.request, request),
          )
          if (retry) {
            yield* authorize(input.execution)
            return { recorded: true, completionHash: retry.hash, repeated: true }
          }
          const previous = records.findLast(
            (item) =>
              item.completion.request.responseHash === request.responseHash &&
              item.completion.request.findingID === request.findingID,
          )
          if (request.previousHash !== previous?.hash)
            return yield* new ResearchModel.Denied({
              message: "Completion predecessor is stale or belongs to another finding",
            })
          const basisHash = yield* state.put(run)
          const record: ResearchFeedbackLifecycle.Completion = {
            version: 1,
            contractID: run.id,
            manifestHash: run.manifestHash,
            context: run.context,
            round: run.round,
            reviewVersion: run.reviewVersion,
            basisVersion: run.version,
            basisHash,
            outcomeHash: run.feedbackHistory!.find((item) => item.responseHash === request.responseHash)!.outcomeHash,
            recordedAt: yield* Clock.currentTimeMillis,
            request,
          }
          const hash = yield* state.put(record)
          yield* authorize(input.execution)
          yield* state.save(run, { ...run, completionHashes: [...(run.completionHashes ?? []), hash] })
          return { recorded: true, completionHash: hash, repeated: false }
        }),
      )
      .pipe(
        Effect.timeoutOrElse({
          duration: Math.max(0, Math.min(30_000, deadline - (yield* Clock.currentTimeMillis))),
          orElse: () => Effect.fail(new ResearchModel.Denied({ message: "Completion recording deadline exhausted" })),
        }),
      )
  })

const authorize = Effect.fnUntraced(function* (execution: ProContractOpenCode.Execution) {
  const bindings = yield* ProContractOpenCode.Service
  const contracts = yield* ProContract.Service
  const state = yield* ResearchStore.Service
  yield* bindings.authorize(execution)
  const run = yield* state.get(execution.contractID)
  const contract = yield* contracts.get(execution.contractID)
  const binding = yield* bindings.get(execution.contractID)
  if (
    !run ||
    !contract ||
    !binding ||
    !ResearchProtocol.lifecycle(run.input) ||
    run.stage !== "feedback" ||
    run.feedback?.phase !== "delivery" ||
    run.feedback.responseHash ||
    contract.status !== "active" ||
    contract.pendingRevision ||
    contract.specHash !== run.specHash ||
    !ProContractRecognition.same(contract.recognition.context?.target, run.context) ||
    !contract.spec.authority.includes("filesystem.read") ||
    (binding.admission?.capabilities && !binding.admission.capabilities.includes("read")) ||
    (yield* Clock.currentTimeMillis) >= run.input.spec.budget.deadline
  )
    return yield* new ResearchModel.Denied({
      message: "Feedback evidence request is outside current execution authority",
    })
  return run
})
