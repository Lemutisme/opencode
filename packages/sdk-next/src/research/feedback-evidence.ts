export * as ResearchFeedbackEvidence from "./feedback-evidence"

import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractBlob } from "@opencode-ai/core/pro-contract/blob"
import { ProContractKernel } from "@opencode-ai/core/pro-contract/kernel"
import { ProContractObservation } from "@opencode-ai/core/pro-contract/observation"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { ProContractReplay } from "@opencode-ai/core/pro-contract/replay"
import { ProContractJobTable } from "@opencode-ai/core/pro-contract/sql"
import { Hash } from "@opencode-ai/core/util/hash"
import { ResearchModel } from "./model"
import { ResearchProtocol } from "./protocol"
import { ResearchFeedback } from "./review-feedback"
import { ResearchFeedbackLifecycle } from "./feedback-lifecycle"
import { ResearchAdvisoryProtocol } from "./advisory-protocol"
import { ResearchStore } from "./store"
import { parse } from "./tap"

export const Admission = Schema.Struct({
  version: Schema.Literal(2),
  contractID: ProContract.ID,
  planHash: ProContractBlob.Digest,
  manifestHash: ProContractBlob.Digest,
  policy: ResearchModel.ReviewPolicy,
  context: ProContract.ContextTarget,
  outcomeHash: ProContractBlob.Digest,
  responseHash: ProContractBlob.Digest,
})
const Entry = Schema.Struct({
  phase: Schema.Literals(["plan", "delivery"]),
  outcomeHash: ProContractBlob.Digest,
  responseHash: ProContractBlob.Digest,
  outcome: ResearchFeedback.Outcome,
  response: ResearchFeedback.Response,
  raw: Schema.optional(Schema.String),
})
export const Bundle = Schema.Struct({
  ...ResearchModel.Bundle.fields,
  version: Schema.Literal(2),
  policy: ResearchModel.ReviewPolicy,
  feedback: Schema.NonEmptyArray(Entry),
  admissionHash: Schema.optional(ProContractBlob.Digest),
  feedbackProtocol: Schema.optional(Schema.Literal("repair-lifecycle:1")),
  completions: Schema.optional(Schema.Array(ResearchFeedbackLifecycle.Entry)),
})
export type Bundle = typeof Bundle.Type

export const entry = Effect.fnUntraced(function* (
  run: ResearchModel.Run,
  item: NonNullable<ResearchModel.Run["feedbackHistory"]>[number],
) {
  const state = yield* ResearchStore.Service
  if (!item.responseHash)
    return yield* new ResearchModel.Denied({ message: "An independent outcome has no recorded response" })
  const outcome = yield* state
    .json(item.outcomeHash)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchFeedback.Outcome)))
  const response = yield* state
    .json(item.responseHash)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchFeedback.Response, { onExcessProperty: "error" })))
  const invalid =
    ResearchFeedback.responseProtocol(run.input, response) ?? ResearchFeedback.validateResponse(outcome, response)
  if (invalid || outcome.phase !== item.phase)
    return yield* new ResearchModel.Denied({ message: invalid ?? "Feedback phase mismatch" })
  return {
    ...item,
    responseHash: item.responseHash,
    outcome,
    response,
    ...(outcome.rawHash ? { raw: Buffer.from(yield* state.bytes(outcome.rawHash)).toString("utf8") } : {}),
  }
})

export const entries = (run: ResearchModel.Run) => Effect.forEach(run.feedbackHistory ?? [], (item) => entry(run, item))

export const bundle = Effect.fnUntraced(function* (
  run: ResearchModel.Run,
  handoff: ProContract.RecognitionTarget,
  operations: ReadonlyArray<unknown>,
) {
  if (ResearchProtocol.advisory(run.input)) {
    const state = yield* ResearchStore.Service
    const records = yield* advisoryRecords(run)
    const submitted = records.find((item) => item.hash === run.submissionHash)?.record
    const treatment =
      submitted?.reason ??
      records
        .filter((item) => item.current && item.record.kind === "response" && item.record.reason)
        .map((item) => item.record.reason)
        .join("\n\n")
    return Schema.decodeUnknownSync(ResearchAdvisoryProtocol.Bundle)({
      version: 3,
      profile: ResearchProtocol.profile(run.input),
      contractID: run.id,
      round: run.round,
      reviewVersion: run.reviewVersion,
      manifestHash: run.manifestHash,
      subjectHash: run.subjectHash,
      handoff,
      context: run.context,
      verificationHash: run.verificationHash,
      reviewHash: run.reviewHash,
      materialsHash: run.materialsHash,
      verdict: (yield* advisoryEntries(run)).at(-1)?.outcome.review?.verdict ?? "unavailable",
      operations,
      dependencies: run.input.manifest.dependencies,
      isolation: "cooperative",
      planHash: run.plan?.hash,
      planReportHash: run.plan?.reportHash,
      experiment: run.experiment,
      policy: run.input.manifest.reviewPolicy,
      admissionHash: run.plan?.admissionHash,
      submissionHash: run.submissionHash,
      commands: yield* state.commands(run.id),
      commandConflicts: yield* state.commandConflicts(run.id),
      feedback: yield* advisoryEntries(run),
      records,
      treatment: treatment ? { status: "provided", text: treatment } : { status: "not_provided" },
    })
  }
  const feedback = yield* entries(run)
  return Schema.decodeUnknownSync(Bundle)({
    version: 2,
    profile: ResearchProtocol.profile(run.input),
    contractID: run.id,
    round: run.round,
    reviewVersion: run.reviewVersion,
    manifestHash: run.manifestHash,
    subjectHash: run.subjectHash,
    handoff,
    context: run.context,
    verificationHash: run.verificationHash,
    reviewHash: run.reviewHash,
    materialsHash: run.materialsHash,
    verdict: feedback.at(-1)?.outcome.review?.verdict ?? "unavailable",
    operations,
    dependencies: run.input.manifest.dependencies,
    isolation: "cooperative",
    experiment: run.experiment,
    policy: run.input.manifest.reviewPolicy,
    feedback,
    admissionHash: run.plan?.admissionHash,
    ...(ResearchProtocol.lifecycle(run.input)
      ? { feedbackProtocol: run.input.manifest.feedbackProtocol, completions: yield* completions(run) }
      : {}),
  })
})

// Used before publication and again inside exact recognition. It does not grant authority.
export const validate = Effect.fnUntraced(function* (run: ResearchModel.Run) {
  if (ResearchProtocol.advisory(run.input)) return yield* validateAdvisory(run)
  const state = yield* ResearchStore.Service
  const reviewer = yield* ResearchFeedback.make
  if (
    !ResearchProtocol.feedback(run.input) ||
    !run.reviewHash ||
    !run.verificationHash ||
    !run.subjectHash ||
    run.feedback?.phase !== "delivery" ||
    run.feedback.outcomeHash !== run.reviewHash ||
    !run.feedback.responseHash
  )
    return "Current reviewed candidate and explicit submission response are required"
  if (!ProContractRecognition.same(yield* state.json(run.manifestHash), run.input.manifest))
    return "Frozen manifest changed"
  const history = yield* entries(run)
  if (!history.length || new Set(history.map((item) => item.outcomeHash)).size !== history.length)
    return "Feedback history is absent or ambiguous"
  for (const entry of history) {
    const invalid = yield* reviewer.validate(run, entry.outcomeHash, { current: false })
    if (invalid) return invalid
    for (const response of entry.response.responses)
      for (const hash of response.evidence ?? []) yield* state.bytes(hash)
  }
  yield* completions(run)
  const current = history.at(-1)!
  if (
    current.outcomeHash !== run.reviewHash ||
    current.responseHash !== run.feedback.responseHash ||
    current.response.action !== "submit" ||
    current.outcome.phase !== "delivery" ||
    current.outcome.subjectHash !== run.subjectHash ||
    current.outcome.planHash !== run.plan?.hash ||
    current.outcome.round !== run.round ||
    current.outcome.reviewVersion !== run.reviewVersion ||
    current.outcome.materialsHash !== run.materialsHash ||
    current.outcome.jobID !== run.reviewJobID ||
    current.outcome.referencesHash !== run.referencesHash
  )
    return "Submission is not bound to the current candidate and feedback"
  const context = current.outcome.context
  const published = run.stage === "ready" || run.stage === "accepted"
  if (
    context.revision !== run.revision ||
    context.specHash !== run.specHash ||
    (published ? context.version + 2 !== run.context.version : !ProContractRecognition.same(context, run.context))
  )
    return "Feedback and publication context chain changed"
  if (
    ResearchProtocol.required(run.input, "delivery") &&
    (current.outcome.availability !== "available" || current.outcome.review?.verdict !== "accept")
  )
    return "Delivery policy requires an available independent accept"
  const invalid = yield* verification(run, run.verificationHash, "delivery", context)
  if (invalid) return invalid
  if (!run.input.planning) return run.experiment ? "Final-only task cannot claim a planned experiment" : undefined
  const planError = yield* admission(run, context)
  if (planError) return planError
  if (!run.experiment || !run.plan) return "Formal experiment is unavailable"
  const plan = run.plan
  if (
    run.experiment.planHash !== plan.hash ||
    run.experiment.approvalHash !== plan.admissionHash ||
    run.experiment.subjectHash !== run.subjectHash
  )
    return "Formal experiment belongs to another candidate or plan admission"
  return yield* verification(run, run.experiment.verificationHash, "experiment", context)
})

export const admission = Effect.fnUntraced(function* (run: ResearchModel.Run, context = run.context) {
  const state = yield* ResearchStore.Service
  const reviewer = yield* ResearchFeedback.make
  const plan = run.plan
  if (
    !plan?.admitted ||
    !plan.admissionHash ||
    !plan.reportHash ||
    !run.runner ||
    plan.value.scope !== "within_task" ||
    !ResearchProtocol.protectedPaths(plan.value, run.input.manifest) ||
    !ProContractRecognition.same(yield* state.json(plan.hash), plan.value) ||
    !ProContractRecognition.same(plan.value.agreement, {
      revision: run.revision,
      specHash: run.specHash,
      manifestHash: run.manifestHash,
    }) ||
    run.runner.hash !== Hash.sha256(ResearchProtocol.runner(run.input.manifest)) ||
    Buffer.from(yield* state.bytes(run.runner.hash)).toString("utf8") !== ResearchProtocol.runner(run.input.manifest)
  )
    return "Current host plan admission or runner identity is unavailable"
  if (ResearchProtocol.advisory(run.input)) {
    const receipt = yield* state
      .json(plan.admissionHash)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchAdvisoryProtocol.Admission)))
    if (!ProContractRecognition.same(receipt, { ...ResearchAdvisoryProtocol.admission(run), context }))
      return "Host plan admission does not bind its authorization and current plan"
    return yield* reviewer.validate(run, plan.reportHash, { current: false })
  }
  const receipt = yield* state.json(plan.admissionHash).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Admission)))
  const selected = run.feedbackHistory?.find((item) => item.outcomeHash === plan.reportHash)
  const opinion = selected ? yield* entry(run, selected) : undefined
  if (
    !opinion ||
    opinion.phase !== "plan" ||
    opinion.response.action !== "continue" ||
    !ProContractRecognition.same(receipt, {
      version: 2,
      contractID: run.id,
      planHash: plan.hash,
      manifestHash: run.manifestHash,
      policy: run.input.manifest.reviewPolicy,
      context,
      outcomeHash: opinion.outcomeHash,
      responseHash: opinion.responseHash,
    }) ||
    !ProContractRecognition.same(opinion.outcome.context, context) ||
    opinion.outcome.planHash !== plan.hash ||
    opinion.outcome.subjectHash !== plan.subjectHash ||
    opinion.outcome.materialsHash !== plan.materialsHash ||
    opinion.outcome.jobID !== plan.jobID ||
    opinion.outcome.referencesHash !== plan.referencesHash ||
    (ResearchProtocol.required(run.input, "plan") &&
      (opinion.outcome.availability !== "available" ||
        opinion.outcome.review?.verdict !== "accept" ||
        opinion.outcome.review.scope !== "within_task"))
  )
    return "Host plan admission does not bind its policy, original opinion and response"

  return yield* reviewer.validate(run, plan.reportHash, { current: false })
})

export const advisoryRecords = Effect.fnUntraced(function* (run: ResearchModel.Run) {
  const state = yield* ResearchStore.Service
  const history = yield* state.history(run.id)
  const records: { hash: string; current: boolean; record: ResearchAdvisoryProtocol.Record }[] = []
  for (const hash of run.advisoryRecords ?? []) {
    const record = yield* state
      .json(hash)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchAdvisoryProtocol.Record)))
    const basis = history.find((item) => item.version === record.basisVersion)?.data
    if (
      !basis ||
      record.contractID !== run.id ||
      record.manifestHash !== run.manifestHash ||
      record.basisHash !== ProContractRecognition.fingerprint(basis) ||
      !ProContractRecognition.same(yield* state.json(record.basisHash), basis) ||
      !ProContractRecognition.same(record.context, basis.context) ||
      !ProContractRecognition.same(
        basis.advisoryRecords ?? [],
        records.map((item) => item.hash),
      ) ||
      record.recordedAt >= basis.input.spec.budget.deadline ||
      !Number.isFinite(record.recordedAt) ||
      record.planHash !== basis.plan?.hash ||
      record.subjectHash !== basis.subjectHash ||
      record.verificationHash !== basis.verificationHash
    )
      return yield* new ResearchModel.Denied({ message: "Advisory record does not match its original durable basis" })
    if (record.target) {
      if (!basis.feedbackHistory?.some((item) => item.outcomeHash === record.target!.outcomeHash))
        return yield* new ResearchModel.Denied({ message: "Advisory target belongs to another material version" })
      const outcome = yield* state
        .json(record.target.outcomeHash)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchFeedback.Outcome)))
      if (!outcome.review?.findings.some((finding) => finding.id === record.target!.findingID))
        return yield* new ResearchModel.Denied({ message: "Advisory target finding changed" })
      const previous = records.findLast((item) => ProContractRecognition.same(item.record.target, record.target))
      if (record.previousHash !== previous?.hash)
        return yield* new ResearchModel.Denied({ message: "Advisory record predecessor changed" })
    }
    const allowed = yield* advisorySources(basis)
    if (record.evidence.some((hash) => !allowed.some((source) => source.hash === hash)))
      return yield* new ResearchModel.Denied({ message: "Advisory record evidence belongs to another view" })
    for (const evidence of record.evidence) yield* state.bytes(evidence)
    records.push({
      hash,
      record,
      current:
        record.planHash === run.plan?.hash &&
        record.subjectHash === run.subjectHash &&
        record.verificationHash === run.verificationHash,
    })
  }
  return records
})

export const advisoryEntries = Effect.fnUntraced(function* (run: ResearchModel.Run) {
  const state = yield* ResearchStore.Service
  const records = yield* advisoryRecords(run)
  return yield* Effect.forEach(run.feedbackHistory ?? [], (item) =>
    Effect.gen(function* () {
      const outcome = yield* state
        .json(item.outcomeHash)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchFeedback.Outcome)))
      return {
        phase: item.phase,
        outcomeHash: item.outcomeHash,
        outcome,
        ...(outcome.rawHash ? { raw: Buffer.from(yield* state.bytes(outcome.rawHash)).toString("utf8") } : {}),
        unaddressed: (outcome.review?.findings ?? [])
          .filter(
            (finding) =>
              !records.some(
                (entry) =>
                  entry.record.target?.outcomeHash === item.outcomeHash && entry.record.target.findingID === finding.id,
              ),
          )
          .map((finding) => finding.id),
      }
    }),
  )
})

export const advisorySources = Effect.fnUntraced(function* (run: ResearchModel.Run) {
  const state = yield* ResearchStore.Service
  const sources: { id: string; hash: string; label: string }[] = []
  for (const [label, hash] of [
    ["plan", run.plan?.hash],
    ["verification", run.verificationHash],
    ["experiment", run.lastExperiment?.verificationHash ?? run.experiment?.verificationHash],
  ] as const) {
    if (!hash) continue
    sources.push({ id: `e${sources.length + 1}`, hash, label })
    if (label === "plan") continue
    const result = yield* state.json(hash).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.Verification)))
    for (const file of result.evidence)
      sources.push({ id: `e${sources.length + 1}`, hash: file.hash, label: `${label}:${file.path}` })
  }
  return sources
})

const validateAdvisory = Effect.fnUntraced(function* (run: ResearchModel.Run) {
  const state = yield* ResearchStore.Service
  const reviewer = yield* ResearchFeedback.make
  if (!run.reviewHash || !run.verificationHash || !run.subjectHash || !run.submissionHash)
    return "Current verified candidate and explicit submission are required"
  if (!ProContractRecognition.same(yield* state.json(run.manifestHash), run.input.manifest))
    return "Frozen manifest changed"
  const history = yield* advisoryEntries(run)
  const current = history.at(-1)
  if (
    !current ||
    current.outcomeHash !== run.reviewHash ||
    current.phase !== "delivery" ||
    current.outcome.subjectHash !== run.subjectHash ||
    current.outcome.planHash !== run.plan?.hash ||
    current.outcome.round !== run.round ||
    current.outcome.reviewVersion !== run.reviewVersion ||
    current.outcome.materialsHash !== run.materialsHash ||
    current.outcome.jobID !== run.reviewJobID ||
    current.outcome.referencesHash !== run.referencesHash ||
    new Set(history.map((item) => item.outcomeHash)).size !== history.length
  )
    return "Candidate checkpoint does not bind the current materials"
  for (const entry of history) {
    const invalid = yield* reviewer.validate(run, entry.outcomeHash, { current: false })
    if (invalid) return invalid
  }
  const context = current.outcome.context
  const published = ["ready", "accepted"].includes(run.stage)
  if (
    context.revision !== run.revision ||
    context.specHash !== run.specHash ||
    (published ? context.version + 2 !== run.context.version : !ProContractRecognition.same(context, run.context))
  )
    return "Candidate publication context chain changed"
  const submitted = (yield* advisoryRecords(run)).find((item) => item.hash === run.submissionHash)
  if (!submitted?.current || submitted.record.kind !== "submission")
    return "Explicit submission belongs to another candidate"
  const invalid = yield* verification(run, run.verificationHash, "delivery", context)
  if (invalid) return invalid
  if (!run.input.planning) return run.experiment ? "Final-only task cannot claim a planned experiment" : undefined
  const planError = yield* admission(run, context)
  if (planError) return planError
  if (
    !run.experiment ||
    run.experiment.planHash !== run.plan?.hash ||
    run.experiment.approvalHash !== run.plan?.admissionHash ||
    run.experiment.subjectHash !== run.subjectHash
  )
    return "Formal experiment belongs to another candidate or plan admission"
  return yield* verification(run, run.experiment.verificationHash, "experiment", context)
})

// This boundary deliberately does not require the current delivery response or submission.
export const completionBasis = Effect.fnUntraced(function* (run: ResearchModel.Run) {
  const state = yield* ResearchStore.Service
  const reviewer = yield* ResearchFeedback.make
  if (
    (!ResearchProtocol.lifecycle(run.input) && !ResearchProtocol.advisory(run.input)) ||
    run.stage !== "feedback" ||
    run.feedback?.phase !== "delivery" ||
    run.feedback.responseHash ||
    run.feedback.outcomeHash !== run.reviewHash ||
    !run.verificationHash ||
    !run.subjectHash
  )
    return "Completion evidence requires the current verified delivery feedback stage"
  const outcome = yield* state
    .json(run.feedback.outcomeHash)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchFeedback.Outcome)))
  if (
    outcome.phase !== "delivery" ||
    outcome.referencesHash !== run.referencesHash ||
    !ProContractRecognition.same(outcome.context, run.context)
  )
    return "Completion feedback identity changed"
  const reviewError = yield* reviewer.validate(run, run.feedback.outcomeHash)
  if (reviewError) return reviewError
  const invalid = yield* verification(run, run.verificationHash, "delivery", run.context)
  if (invalid) return invalid
  if (!run.input.planning) return run.experiment ? "Final-only task cannot claim a planned experiment" : undefined
  const planError = yield* admission(run)
  if (planError) return planError
  if (
    !run.experiment ||
    run.experiment.planHash !== run.plan?.hash ||
    run.experiment.approvalHash !== run.plan?.admissionHash ||
    run.experiment.subjectHash !== run.subjectHash
  )
    return "Completion requires the current plan and a successful formal experiment"
  return yield* verification(run, run.experiment.verificationHash, "experiment", run.context)
})

export const completionRequest = Effect.fnUntraced(function* (
  run: ResearchModel.Run,
  request: ResearchFeedbackLifecycle.Request,
) {
  const state = yield* ResearchStore.Service
  const reviewer = yield* ResearchFeedback.make
  if (
    request.planHash !== run.plan?.hash ||
    request.subjectHash !== run.subjectHash ||
    request.verificationHash !== run.verificationHash ||
    !request.reason.trim() ||
    new Set(request.evidence).size !== request.evidence.length
  )
    return "Completion identity, reason or evidence changed"
  const matches = (run.feedbackHistory ?? []).filter((item) => item.responseHash === request.responseHash)
  if (matches.length !== 1) return "Completion response is absent or ambiguous in this task"
  const selected = yield* entry(run, matches[0])
  for (const response of selected.response.responses)
    for (const hash of response.evidence ?? []) yield* state.bytes(hash)
  if (!selected.response.responses.some((item) => item.findingID === request.findingID))
    return "Completion finding does not belong to its original response"
  const reviewError = yield* reviewer.validate(run, selected.outcomeHash, { current: false })
  if (reviewError) return reviewError
  if ("version" in selected.response && selected.response.planChange === "revise") {
    if (!selected.outcome.planHash || !run.plan) return "Declared plan revision has no plan evidence"
    const original = yield* state
      .json(selected.outcome.planHash)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.Plan)))
    if (run.plan.hash === selected.outcome.planHash || run.plan.value.version <= original.version)
      return "Declared method change requires a newer admitted plan before completion"
  }
  const invalid = yield* completionBasis(run)
  if (invalid) return invalid
  const evidence = yield* Effect.forEach(
    [run.verificationHash!, ...(run.experiment ? [run.experiment.verificationHash] : [])],
    (hash) =>
      state.json(hash).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.Verification)),
        Effect.map((value) => [hash, ...value.evidence.map((item) => item.hash)]),
      ),
  )
  const allowed = evidence.flat()
  if (request.evidence.some((hash) => !allowed.includes(hash)))
    return "Completion evidence is outside the verified candidate allowlist"
  for (const hash of request.evidence) yield* state.bytes(hash)
  return undefined
})

export const completions = Effect.fnUntraced(function* (run: ResearchModel.Run) {
  const state = yield* ResearchStore.Service
  const hashes = run.completionHashes ?? []
  if (hashes.length && (!ResearchProtocol.lifecycle(run.input) || new Set(hashes).size !== hashes.length))
    return yield* new ResearchModel.Denied({ message: "Completion history conflicts with its frozen protocol" })
  const history = hashes.length ? yield* state.history(run.id) : []
  const records: (typeof ResearchFeedbackLifecycle.Entry.Type)[] = []
  for (const hash of hashes) {
    const completion = yield* state
      .json(hash)
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ResearchFeedbackLifecycle.Completion, { onExcessProperty: "error" })),
      )
    const basis = history.find((item) => item.version === completion.basisVersion)?.data
    if (
      !basis ||
      completion.contractID !== run.id ||
      completion.manifestHash !== run.manifestHash ||
      basis.inputHash !== run.inputHash ||
      basis.manifestHash !== run.manifestHash ||
      basis.version >= run.version ||
      !ProContractRecognition.same(history.find((item) => item.version === basis.version + 1)?.data, {
        ...basis,
        version: basis.version + 1,
        completionHashes: [...(basis.completionHashes ?? []), hash],
      }) ||
      completion.basisHash !== ProContractRecognition.fingerprint(basis) ||
      !ProContractRecognition.same(yield* state.json(completion.basisHash), basis) ||
      !ProContractRecognition.same(completion.context, basis.context) ||
      completion.round !== basis.round ||
      completion.reviewVersion !== basis.reviewVersion ||
      completion.recordedAt >= basis.input.spec.budget.deadline ||
      !Number.isFinite(completion.recordedAt) ||
      completion.recordedAt < 0 ||
      !ProContractRecognition.same(
        basis.completionHashes ?? [],
        records.map((item) => item.hash),
      ) ||
      completion.outcomeHash !==
        basis.feedbackHistory?.find((item) => item.responseHash === completion.request.responseHash)?.outcomeHash
    )
      return yield* new ResearchModel.Denied({ message: "Completion does not match its original durable basis" })
    const previous = records.findLast(
      (item) =>
        item.completion.request.responseHash === completion.request.responseHash &&
        item.completion.request.findingID === completion.request.findingID,
    )
    if (completion.request.previousHash !== previous?.hash)
      return yield* new ResearchModel.Denied({ message: "Completion predecessor chain changed" })
    const invalid = yield* completionRequest(basis, completion.request)
    if (invalid) return yield* new ResearchModel.Denied({ message: invalid })
    records.push({ hash, completion, current: ResearchFeedbackLifecycle.current(run, completion) })
  }
  return records
})

export const verification = Effect.fnUntraced(function* (
  run: ResearchModel.Run,
  hash: string,
  purpose: "delivery" | "experiment",
  context: ProContract.ContextTarget,
) {
  const state = yield* ResearchStore.Service
  const observations = yield* ProContractObservation.Service
  const result = yield* state.json(hash).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.Verification)))
  const job = (yield* state.db
    .select()
    .from(ProContractJobTable)
    .where(eq(ProContractJobTable.id, result.jobID))
    .get()
    .pipe(Effect.orDie))?.data
  const policy = ResearchProtocol.policy(
    run.input.manifest,
    run.runner,
    purpose === "experiment" ? run.plan!.value.protected : [],
  )
  const protectedFiles = [
    ...policy.protected,
    ...(run.input.planning && purpose === "delivery" ? ResearchProtocol.additionalProtected(run) : []),
  ]
  if (
    result.verdict !== "passed" ||
    result.subjectHash !== run.subjectHash ||
    result.manifestHash !== run.manifestHash ||
    !ProContractRecognition.same(result.context, context) ||
    !job ||
    job.status !== "completed" ||
    ProContractRecognition.fingerprint(job.input) !== job.fingerprint ||
    job.fingerprint !== result.fingerprint ||
    job.generation !== result.generation ||
    job.input.contractID !== run.id ||
    job.input.driver !== ResearchProtocol.profile(run.input) ||
    job.input.kind !== "verify" ||
    job.input.inputHash !== result.inputHash ||
    !ProContractRecognition.same(job.input.context, context) ||
    !ProContractRecognition.same(job.result, result.replay) ||
    job.input.verification?.subjectHash !== run.subjectHash ||
    !ProContractRecognition.same(job.input.verification.policy, policy) ||
    !ProContractRecognition.same(
      job.input.verification.additionalProtected,
      run.input.planning && purpose === "delivery" ? ResearchProtocol.additionalProtected(run) : undefined,
    ) ||
    !ProContractRecognition.same(
      job.input.verification.freshArtifacts ?? [],
      run.input.manifest.artifacts.filter((file) => file.kind === "generated").map((file) => file.path),
    ) ||
    (purpose === "delivery" && job.input.id !== run.verifierJobID) ||
    result.inputHash !==
      ProContractRecognition.fingerprint({
        subject: run.subjectHash,
        manifest: run.manifestHash,
        round: run.round,
        ...(run.input.planning ? { planHash: run.plan!.hash, approvalHash: run.plan!.admissionHash, purpose } : {}),
      })
  )
    return "Mechanical evidence lacks the exact original completed job and admitted protocol"
  const replay = yield* state
    .json(result.replay.evidenceHash)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ProContractReplay.ReportSchema)))
  if (
    replay.contractID !== run.id ||
    replay.subjectHash !== run.subjectHash ||
    replay.incomplete ||
    !replay.passed ||
    replay.checks.length !== 1 ||
    replay.policyHash !== ProContractKernel.hashReplay(policy) ||
    !ProContractRecognition.same(
      replay.protectedBefore?.map((file) => ({ path: file.path, hash: file.exists ? file.hash : undefined })),
      protectedFiles,
    ) ||
    !ProContractRecognition.same(
      replay.protected.map((file) => ({ path: file.path, hash: file.exists ? file.hash : undefined })),
      protectedFiles,
    )
  )
    return "Mechanical replay or protected inputs changed"
  const observed = replay.checks[0].observation
  if (
    !ProContractRecognition.same(yield* observations.get(observed.handle), observed.receipt) ||
    observed.receipt.execution !== "completed" ||
    observed.receipt.exit !== 0 ||
    !observed.receipt.stdout?.complete ||
    !observed.receipt.stderr?.complete ||
    !ProContractRecognition.same(observed.receipt.argv, policy.checks[0].argv) ||
    parse(
      Buffer.from(yield* state.bytes(observed.receipt.stdout.hash)).toString("utf8"),
      run.input.manifest.verification,
    ).verdict !== "passed"
  )
    return "Mechanical execution evidence is unavailable"
  yield* state.bytes(observed.receipt.stderr.hash)
  for (const item of result.evidence)
    if ((yield* state.bytes(item.hash)).length !== item.bytes) return "Mechanical evidence bytes changed"
  for (const artifact of run.input.manifest.artifacts) {
    const file = replay.artifacts.find((item) => item.path === artifact.path)
    if (
      !file?.captured ||
      !file.before ||
      file.captureError ||
      file.before.captureError ||
      (file.before.exists && !file.before.captured) ||
      file.hash !== file.captured.hash ||
      (artifact.kind === "generated" && !file.generated) ||
      (yield* state.bytes(file.captured.hash)).length !== file.captured.bytes
    )
      return "Required artifact provenance is unavailable"
    if (file.before.captured && (yield* state.bytes(file.before.captured.hash)).length !== file.before.captured.bytes)
      return "Formal experiment input bytes changed"
  }
  return undefined
})
