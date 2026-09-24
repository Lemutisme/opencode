export * as ResearchFeedback from "./review-feedback"

import { eq } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractBlob } from "@opencode-ai/core/pro-contract/blob"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { ProContractJobTable } from "@opencode-ai/core/pro-contract/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionContextEpochTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Hash } from "@opencode-ai/core/util/hash"
import { ResearchModel } from "./model"
import { ResearchProtocol } from "./protocol"
import { ResearchStore } from "./store"

const Reference = Schema.Struct({ jobID: Schema.NonEmptyString, id: Schema.NonEmptyString })
const Finding = Schema.Struct({
  id: Schema.NonEmptyString,
  severity: Schema.Literals(["blocking", "note", "P1", "P2", "P3"]),
  path: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
  resolution: Schema.NonEmptyString,
  impact: Schema.optional(Schema.NonEmptyString),
  escalation: Schema.optional(Schema.NonEmptyString),
})
const Fields = {
  version: Schema.Literal(2),
  verdict: Schema.Literals(["accept", "changes_requested", "unavailable"]),
  scope: Schema.optional(Schema.Literals(["within_task", "needs_principal_revision", "unclear"])),
  summary: Schema.NonEmptyString,
}
export const WireReview = Schema.Struct({
  ...Fields,
  findings: Schema.Array(Schema.Struct({ ...Finding.fields, evidence: Schema.optional(Schema.Array(Reference)) })),
  claims: Schema.Array(Schema.Struct({ text: Schema.NonEmptyString, evidence: Schema.NonEmptyArray(Reference) })),
})
export const Review = Schema.Struct({
  ...Fields,
  findings: Schema.Array(
    Schema.Struct({ ...Finding.fields, evidence: Schema.optional(Schema.Array(ProContractBlob.Digest)) }),
  ),
  claims: Schema.Array(
    Schema.Struct({ text: Schema.NonEmptyString, evidence: Schema.NonEmptyArray(ProContractBlob.Digest) }),
  ),
})
export type Review = typeof Review.Type

export const References = Schema.Struct({
  version: Schema.Literal(2),
  promptVersion: Schema.optional(Schema.Literal(2)),
  contractID: ProContract.ID,
  phase: Schema.Literals(["plan", "delivery"]),
  round: Schema.Int,
  reviewVersion: Schema.Int,
  jobID: Schema.NonEmptyString,
  context: ProContract.ContextTarget,
  manifestHash: ProContractBlob.Digest,
  materialsHash: ProContractBlob.Digest,
  subjectHash: Schema.NonEmptyString,
  planHash: Schema.optional(ProContractBlob.Digest),
  entries: Schema.NonEmptyArray(
    Schema.Struct({
      id: Schema.NonEmptyString,
      hash: ProContractBlob.Digest,
      label: Schema.optional(Schema.NonEmptyString),
    }),
  ),
})
export type References = typeof References.Type

const Resolved = Schema.Struct({ ...Reference.fields, hash: ProContractBlob.Digest })
export const Resolution = Schema.Struct({
  availability: Schema.Literals(["available", "unavailable"]),
  review: Schema.optional(Review),
  error: Schema.optional(Schema.NonEmptyString),
  resolved: Schema.Array(Resolved),
})
export type Resolution = typeof Resolution.Type

export const Environment = Schema.Union([
  Schema.Struct({
    configurationHash: ProContractBlob.Digest,
    agentHash: ProContractBlob.Digest,
    instructionsHash: ProContractBlob.Digest,
  }),
  Schema.Struct({ unavailable: Schema.NonEmptyString }),
])

export const Outcome = Schema.Struct({
  ...Resolution.fields,
  version: Schema.Literal(2),
  contractID: ProContract.ID,
  phase: Schema.Literals(["plan", "delivery"]),
  round: Schema.Int,
  reviewVersion: Schema.Int,
  jobID: Schema.NonEmptyString,
  inputHash: ProContractBlob.Digest,
  fingerprint: ProContractBlob.Digest,
  generation: Schema.Int,
  jobStatus: Schema.Literals(["completed", "failed", "interrupted", "cancelled", "unknown"]),
  jobReason: Schema.optional(Schema.String),
  context: ProContract.ContextTarget,
  manifestHash: ProContractBlob.Digest,
  materialsHash: ProContractBlob.Digest,
  subjectHash: Schema.NonEmptyString,
  planHash: Schema.optional(ProContractBlob.Digest),
  referencesHash: ProContractBlob.Digest,
  capture: Schema.Literals(["complete", "partial", "absent"]),
  rawHash: Schema.optional(ProContractBlob.Digest),
  sourceHash: Schema.optional(ProContractBlob.Digest),
  messageID: Schema.optional(SessionMessage.ID),
  systemHash: Schema.optional(ProContractBlob.Digest),
})
export type Outcome = typeof Outcome.Type

// Persist the wire representation: projected message timestamps are decoded DateTime values.
export const encodeSource = Schema.encodeSync(SessionMessage.Message)

export const LegacyResponse = Schema.Struct({
  outcomeHash: ProContractBlob.Digest,
  responses: Schema.Array(
    Schema.Struct({
      findingID: Schema.NonEmptyString,
      disposition: Schema.Literals(["fixed", "rebutted", "unresolved"]),
      reason: Schema.NonEmptyString,
      evidence: Schema.optional(Schema.Array(ProContractBlob.Digest)),
      escalation: Schema.optional(Schema.NonEmptyString),
    }),
  ),
  summary: Schema.NonEmptyString,
  action: Schema.Literals(["continue", "repair", "submit"]),
})
export const PlannedResponse = Schema.Struct({
  ...LegacyResponse.fields,
  version: Schema.Literal(2),
  planChange: Schema.Literals(["retain", "revise"]),
  responses: Schema.Array(
    Schema.Struct({
      findingID: Schema.NonEmptyString,
      disposition: Schema.Literals(["repair_planned", "rebutted", "unresolved"]),
      reason: Schema.NonEmptyString,
      evidence: Schema.optional(Schema.Array(ProContractBlob.Digest)),
      escalation: Schema.optional(Schema.NonEmptyString),
    }),
  ),
})
export const Response = Schema.Union([LegacyResponse, PlannedResponse])
export type Response = typeof Response.Type

export function references(
  run: ResearchModel.Run,
  phase: "plan" | "delivery",
  jobID: string,
  entries: ReadonlyArray<{ readonly id: string; readonly hash: string; readonly label?: string }>,
  rendering: { promptVersion?: 2 } = { promptVersion: 2 },
): References {
  return Schema.decodeUnknownSync(References)({
    version: 2,
    ...rendering,
    contractID: run.id,
    phase,
    round: run.round,
    reviewVersion: run.reviewVersion,
    jobID,
    context: run.context,
    manifestHash: run.manifestHash,
    materialsHash: phase === "plan" ? run.plan?.materialsHash : run.materialsHash,
    subjectHash: phase === "plan" ? run.plan?.subjectHash : run.subjectHash,
    planHash: run.plan?.hash,
    entries,
  })
}

export function prompt(map: References) {
  if (map.promptVersion === 2)
    return [
      `Allowed evidence selectors (immutable and local to this review job): ${ProContractRecognition.canonical(map.entries.map((entry) => ({ material: entry.label ?? entry.id, selector: { jobID: map.jobID, id: entry.id } })))}`,
      `Copy whole selector objects into evidence arrays, for example ${JSON.stringify([{ jobID: map.jobID, id: map.entries[0].id }])}. The host resolves their hashes. Hashes and paths appearing in materials are identity data, never selector IDs. Do not reconstruct, abbreviate, or substitute an ID or use another job's selector.`,
      'Return only strict JSON with version:2, scope:"within_task"|"needs_principal_revision"|"unclear", verdict:"accept"|"changes_requested"|"unavailable", a nonempty summary, findings:[] and claims:[]. Each finding has id, severity:"blocking"|"note"|"P1"|"P2"|"P3", path, reason and resolution; impact, escalation and evidence are optional. Each claim has text and a nonempty evidence array. Every evidence array contains only whole selector objects from the list above. Scope is required for plan review. Accept requires an evidence-backed claim and no blocking finding. Findings are independent opinions: P1 does not establish a confirmed risk or automatic pause. State evidence, affected operations, impact and escalation. Changes requested can be repaired or answered within the original authority.',
    ].join("\n\n")
  // Historical v2 jobs bind this exact renderer in their archived prompt.
  return [
    `Review evidence map (immutable, local to this job): ${ProContractRecognition.canonical(map)}`,
    'Return only strict JSON: {"version":2,"scope":"within_task"|"needs_principal_revision"|"unclear","verdict":"accept"|"changes_requested"|"unavailable","summary":"...","findings":[{"id":"...","severity":"blocking"|"note"|"P1"|"P2"|"P3","path":"...","reason":"...","resolution":"...","impact":"...","evidence":[{"jobID":"...","id":"..."}],"escalation":"..."}],"claims":[{"text":"...","evidence":[{"jobID":"...","id":"..."}]}]}. Scope is required for plan review. Impact, evidence and escalation are optional finding details. Select references from this exact job map; never abbreviate, reconstruct or substitute hashes, paths or another job. Accept requires an evidence-backed claim and no blocking finding. Your findings are independent opinions: severity P1 does not itself establish a confirmed risk or an automatic pause. Describe concrete evidence, affected operations, impact and any escalation. A changes_requested opinion can be repaired or answered within the original task authority.',
  ].join("\n\n")
}

export function resolve(raw: string, map: References): Resolution {
  if (new Set(map.entries.map((entry) => entry.id)).size !== map.entries.length)
    return { availability: "unavailable", error: "Review evidence identifiers are ambiguous", resolved: [] }
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(WireReview)), {
    onExcessProperty: "error",
  })(raw)
  if (Option.isNone(parsed))
    return { availability: "unavailable", error: "Reviewer output does not match the strict v2 schema", resolved: [] }
  const review = parsed.value
  if (map.phase === "plan" && !review.scope)
    return { availability: "unavailable", error: "Plan review is missing its scope opinion", resolved: [] }
  if (new Set(review.findings.map((finding) => finding.id)).size !== review.findings.length)
    return { availability: "unavailable", error: "Reviewer finding identifiers are ambiguous", resolved: [] }
  const citations = [
    ...review.claims.flatMap((claim) => claim.evidence),
    ...review.findings.flatMap((finding) => finding.evidence ?? []),
  ]
  if (citations.some((reference) => reference.jobID !== map.jobID))
    return { availability: "unavailable", error: "Evidence reference belongs to another review job", resolved: [] }
  if (citations.some((reference) => !map.entries.some((entry) => entry.id === reference.id)))
    return { availability: "unavailable", error: "Unknown evidence reference in reviewer output", resolved: [] }
  const resolved = citations.map((reference) => ({
    ...reference,
    hash: map.entries.find((entry) => entry.id === reference.id)!.hash,
  }))
  if (
    review.verdict === "accept" &&
    (!review.claims.length || review.findings.some((finding) => finding.severity === "blocking"))
  )
    return { availability: "unavailable", error: "Accept lacks support or conflicts with a blocking finding", resolved }
  return {
    availability: review.verdict === "unavailable" ? "unavailable" : "available",
    ...(review.verdict === "unavailable" ? { error: "Reviewer explicitly reported unavailable" } : {}),
    review: {
      ...review,
      findings: review.findings.map((finding) => ({
        ...finding,
        evidence: finding.evidence?.map((reference) => resolved.find((item) => item.id === reference.id)!.hash),
      })),
      claims: review.claims.map((claim) => ({
        ...claim,
        evidence: claim.evidence.map((reference) => resolved.find((item) => item.id === reference.id)!.hash) as [
          string,
          ...string[],
        ],
      })),
    },
    resolved,
  }
}

export function validateResponse(outcome: Outcome, response: Response) {
  if (response.outcomeHash !== ProContractRecognition.fingerprint(outcome))
    return "Feedback response belongs to another outcome"
  if (outcome.phase === "plan" && response.action === "submit") return "Plan feedback cannot submit a candidate"
  if (outcome.phase === "delivery" && response.action === "continue")
    return "Delivery feedback requires an explicit repair or submission"
  const ids = outcome.review?.findings.map((finding) => finding.id) ?? []
  if (
    new Set(response.responses.map((item) => item.findingID)).size !== response.responses.length ||
    response.responses.length !== ids.length ||
    response.responses.some((item) => !ids.includes(item.findingID))
  )
    return "Every original finding needs exactly one response; unknown or duplicate findings are invalid"
  if (!response.summary.trim() || response.responses.some((item) => !item.reason.trim()))
    return "Feedback requires a substantive summary and reasons"
  if ("version" in response && response.planChange === "revise" && response.action !== "repair")
    return "A declared plan change requires replanning before execution or submission"
  return undefined
}

export function responseProtocol(input: ResearchModel.Input, response: Response) {
  if (ResearchProtocol.lifecycle(input) !== "version" in response)
    return "Response does not match the task's frozen feedback protocol"
  if ("version" in response && response.planChange === "revise" && !input.planning)
    return "Final-only research has no delegated plan revision stage"
  return undefined
}

export const make = Effect.gen(function* () {
  const state = yield* ResearchStore.Service
  const messages = yield* SessionStore.Service

  const capture = Effect.fnUntraced(function* (
    run: ResearchModel.Run,
    phase: "plan" | "delivery",
    job: ProContractJob.Job,
    referencesHash: string,
    persist: boolean,
  ) {
    if (job.status === "prepared" || job.status === "open" || job.owner || job.leaseExpiresAt)
      return yield* new ResearchModel.Denied({ message: "Review job must be stopped before collecting feedback" })
    const map = yield* state
      .json(referencesHash)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(References, { onExcessProperty: "error" })))
    if (
      !ProContractRecognition.same(
        map,
        references(
          run,
          phase,
          job.input.id,
          map.entries,
          map.promptVersion ? { promptVersion: map.promptVersion } : {},
        ),
      ) ||
      ProContractRecognition.fingerprint(job.input) !== job.fingerprint ||
      job.input.contractID !== run.id ||
      job.input.kind !== "review" ||
      job.input.driver !== ResearchProtocol.profile(run.input) ||
      job.input.inputHash !==
        ProContractRecognition.fingerprint({ materialsHash: map.materialsHash, referencesHash }) ||
      !ProContractRecognition.same(job.input.context, map.context) ||
      job.input.agent !== run.input.manifest.reviewer.agent ||
      !ProContractRecognition.same(job.input.model, run.input.manifest.reviewer.model) ||
      job.input.location.directory !== (phase === "plan" ? run.plan?.directory : run.reviewDirectory) ||
      !job.input.prompt.text?.includes(prompt(map))
    )
      return yield* new ResearchModel.Denied({ message: "Review job or evidence map identity changed" })
    const material = yield* state.json(map.materialsHash).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            contractID: Schema.String,
            task: Schema.Unknown,
            manifest: Schema.Unknown,
            manifestHash: Schema.String,
            subjectHash: Schema.String,
            planHash: Schema.optional(Schema.String),
            plan: Schema.optional(Schema.Unknown),
            planReview: Schema.optional(Schema.Unknown),
            verificationHash: Schema.optional(ProContractBlob.Digest),
            verification: Schema.optional(ResearchModel.Verification),
            experiment: Schema.optional(ResearchModel.Experiment),
            environment: Schema.Unknown,
          }),
        ),
      ),
    )
    const environment = yield* Schema.decodeUnknownEffect(Environment, { onExcessProperty: "error" })(
      material.environment,
    )
    if (
      material.contractID !== run.id ||
      material.manifestHash !== run.manifestHash ||
      material.subjectHash !== map.subjectHash ||
      !ProContractRecognition.same(material.task, run.input.spec) ||
      !ProContractRecognition.same(material.manifest, run.input.manifest) ||
      material.planHash !== map.planHash ||
      (map.planHash && ProContractRecognition.fingerprint(material.plan) !== map.planHash)
    )
      return yield* new ResearchModel.Denied({ message: "Reviewer materials do not match the frozen task" })
    if (
      phase === "delivery" &&
      (!material.verificationHash ||
        !material.verification ||
        ProContractRecognition.fingerprint(material.verification) !== material.verificationHash ||
        material.verification.subjectHash !== map.subjectHash ||
        material.verification.manifestHash !== map.manifestHash)
    )
      return yield* new ResearchModel.Denied({ message: "Reviewer materials lack the exact candidate verification" })
    const allowed =
      phase === "plan"
        ? [map.materialsHash, map.planHash]
        : [
            map.materialsHash,
            material.verificationHash,
            ...(material.verification?.evidence.map((item) => item.hash) ?? []),
            material.planHash,
            ...(material.planReview ? [ProContractRecognition.fingerprint(material.planReview)] : []),
            material.experiment?.verificationHash,
          ]
    if (
      new Set(map.entries.map((entry) => entry.id)).size !== map.entries.length ||
      map.entries.some((entry) => !allowed.includes(entry.hash))
    )
      return yield* new ResearchModel.Denied({
        message: "Review evidence map is ambiguous or outside its job materials",
      })
    // These are already archived inputs; a damaged blob is a hard failure, never reviewer unavailability.
    for (const entry of map.entries) yield* state.bytes(entry.hash)
    const context = yield* messages.context(job.input.sessionID)
    const message = context.filter((item) => item.type === "assistant").at(-1)
    const epoch = yield* state.db
      .select()
      .from(SessionContextEpochTable)
      .where(eq(SessionContextEpochTable.session_id, job.input.sessionID))
      .get()
      .pipe(Effect.orDie)
    const raw = message?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    const source = message ? encodeSource(message) : undefined
    const complete =
      job.status === "completed" &&
      !!message &&
      message.id === context.at(-1)?.id &&
      !!message.time.completed &&
      !message.error &&
      !!message.finish &&
      message.agent === job.input.agent &&
      ProContractRecognition.same(
        { ...message.model, variant: message.model.variant ?? "default" },
        { ...job.input.model, variant: job.input.model.variant ?? "default" },
      ) &&
      !!epoch &&
      "instructionsHash" in environment &&
      environment.instructionsHash === ProContractRecognition.fingerprint(epoch.snapshot["core/instructions"] ?? null)
    const outcome: Outcome = {
      ...(complete
        ? resolve(raw!, map)
        : {
            availability: "unavailable" as const,
            error:
              "unavailable" in environment
                ? `Reviewer environment unavailable: ${environment.unavailable}`
                : "Reviewer has no completed final source message with the approved instruction context",
            resolved: [],
          }),
      version: 2,
      contractID: run.id,
      phase,
      round: run.round,
      reviewVersion: run.reviewVersion,
      jobID: job.input.id,
      inputHash: job.input.inputHash,
      fingerprint: job.fingerprint,
      generation: job.generation,
      jobStatus: job.status,
      jobReason: job.reason,
      context: map.context,
      manifestHash: map.manifestHash,
      materialsHash: map.materialsHash,
      subjectHash: map.subjectHash,
      planHash: map.planHash,
      referencesHash,
      capture: complete ? "complete" : message ? "partial" : "absent",
      ...(message
        ? { messageID: message.id, rawHash: Hash.sha256(raw!), sourceHash: ProContractRecognition.fingerprint(source) }
        : {}),
      ...(epoch ? { systemHash: ProContractRecognition.fingerprint(epoch) } : {}),
    }
    if (persist) {
      if (message) {
        yield* state.blob(Buffer.from(raw!))
        yield* state.put(source)
      }
      if (epoch) yield* state.put(epoch)
      yield* state.put(outcome)
    }
    return { hash: ProContractRecognition.fingerprint(outcome), outcome }
  })

  const collect = (
    run: ResearchModel.Run,
    phase: "plan" | "delivery",
    job: ProContractJob.Job,
    referencesHash: string,
  ) => capture(run, phase, job, referencesHash, true)

  // Rebuild from the actual immutable job and source. No decoding or blob error is downgraded to unavailable.
  const validate = Effect.fnUntraced(function* (
    run: ResearchModel.Run,
    outcomeHash: string,
    options?: { readonly current?: boolean },
  ) {
    const outcome = yield* state
      .json(outcomeHash)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Outcome, { onExcessProperty: "error" })))
    if (outcome.rawHash) yield* state.bytes(outcome.rawHash)
    if (outcome.systemHash) yield* state.json(outcome.systemHash)
    if (outcome.sourceHash) {
      const source = yield* state
        .json(outcome.sourceHash)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionMessage.Message)))
      if (source.id !== outcome.messageID || source.type !== "assistant")
        return "Review source archive has a different message identity"
    }
    const map = yield* state
      .json(outcome.referencesHash)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(References, { onExcessProperty: "error" })))
    const job = (yield* state.db
      .select()
      .from(ProContractJobTable)
      .where(eq(ProContractJobTable.id, outcome.jobID))
      .get()
      .pipe(Effect.orDie))?.data
    if (
      !job ||
      job.status !== outcome.jobStatus ||
      job.reason !== outcome.jobReason ||
      job.fingerprint !== outcome.fingerprint ||
      job.generation !== outcome.generation ||
      outcome.contractID !== run.id ||
      outcome.manifestHash !== run.manifestHash ||
      outcome.context.revision !== run.revision ||
      outcome.context.specHash !== run.specHash ||
      outcome.context.version > run.context.version ||
      outcome.round > run.round ||
      outcome.reviewVersion > run.reviewVersion ||
      (options?.current !== false &&
        (outcome.round !== run.round ||
          outcome.reviewVersion !== run.reviewVersion ||
          outcome.planHash !== run.plan?.hash ||
          outcome.subjectHash !== (outcome.phase === "plan" ? run.plan?.subjectHash : run.subjectHash) ||
          outcome.materialsHash !== (outcome.phase === "plan" ? run.plan?.materialsHash : run.materialsHash) ||
          outcome.jobID !== (outcome.phase === "plan" ? run.plan?.jobID : run.reviewJobID)))
    )
      return "Review outcome identity differs from its original job or current candidate"
    const original = {
      ...run,
      round: outcome.round,
      reviewVersion: outcome.reviewVersion,
      context: outcome.context,
      subjectHash: outcome.subjectHash,
      materialsHash: outcome.materialsHash,
      reviewDirectory: job.input.location.directory,
      plan: outcome.planHash
        ? {
            ...run.plan!,
            hash: outcome.planHash,
            directory: outcome.phase === "plan" ? job.input.location.directory : run.plan?.directory,
            materialsHash: outcome.phase === "plan" ? outcome.materialsHash : run.plan?.materialsHash,
            subjectHash: outcome.phase === "plan" ? outcome.subjectHash : run.plan?.subjectHash,
          }
        : undefined,
    }
    const replayed = yield* capture(original, outcome.phase, job, outcome.referencesHash, false)
    if (!ProContractRecognition.same(replayed.outcome, outcome) || replayed.hash !== outcomeHash)
      return "Review outcome differs from its original source or evidence resolution"
    if (outcome.rawHash) {
      const raw = Buffer.from(yield* state.bytes(outcome.rawHash)).toString("utf8")
      if (Hash.sha256(raw) !== outcome.rawHash) return "Review raw output changed"
    }
    if (outcome.systemHash) yield* state.json(outcome.systemHash)
    if (map.entries.some((entry) => !/^[a-f0-9]{64}$/.test(entry.hash)))
      return "Review evidence mapping contains an invalid hash"
    return undefined
  })
  return { collect, validate }
})
