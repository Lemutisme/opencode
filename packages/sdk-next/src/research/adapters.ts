export * as ResearchAdapters from "./adapters"

import { eq } from "drizzle-orm"
import { Clock, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractDelivery } from "@opencode-ai/core/pro-contract/delivery"
import { ProContractDriver } from "@opencode-ai/core/pro-contract/driver"
import { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { ProContractObservation } from "@opencode-ai/core/pro-contract/observation"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { ProContractReplay } from "@opencode-ai/core/pro-contract/replay"
import { ProContractJobTable } from "@opencode-ai/core/pro-contract/sql"
import { SessionContextEpochTable } from "@opencode-ai/core/session/sql"
import { ProContractKernel } from "@opencode-ai/core/pro-contract/kernel"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Hash } from "@opencode-ai/core/util/hash"
import { ResearchModel } from "./model"
import { ResearchStore } from "./store"
import { parse } from "./tap"
import { ResearchProtocol } from "./protocol"
import { ResearchPlanning } from "./planning"
import { ResearchPlanEvidence } from "./plan-evidence"
import { ResearchFeedbackControl } from "./feedback-control"
import { ResearchFeedbackEvidence } from "./feedback-evidence"
import { ResearchFeedbackCompletion } from "./feedback-completion"
import { ResearchAdvisoryControl } from "./advisory-control"
import { ResearchAdvisoryProtocol } from "./advisory-protocol"

export const driver: ProContractDriver.Driver = {
  identity: ResearchModel.profile,
  activate: () => true,
  // An expired dispatched worker is unknown work, not an automatic retry opportunity.
  claim: ({ binding }) => !binding.dispatched,
  heartbeat: () => true,
  outcome: ({ outcome }) =>
    ["completed", "retryable-error"].includes(outcome.type) ? { type: "retry", attempt: "same" } : { type: "wait" },
}

export const policy = ResearchProtocol.policy

export const plannedDriver: ProContractDriver.Driver = { ...driver, identity: ResearchModel.plannedProfile }

export const deliveryNode = makeGlobalNode({
  service: ProContractDelivery.Service,
  layer: Layer.effect(
    ProContractDelivery.Service,
    Effect.gen(function* () {
      const state = yield* ResearchStore.Service
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const jobs = yield* ProContractJob.Service
      const fs = yield* FSUtil.Service
      const messages = yield* SessionStore.Service
      const observations = yield* ProContractObservation.Service
      const handler: ProContractDelivery.Handler = {
        command: (input) =>
          Effect.gen(function* () {
            const run = yield* state.get(input.execution.contractID)
            if (run && ResearchProtocol.advisory(run.input)) return yield* ResearchAdvisoryControl.command(input)
            if (input.kind === "review_response") return yield* ResearchFeedbackControl.command(input)
            if (input.kind === "review_completion" || input.kind === "read_review_evidence")
              return yield* ResearchFeedbackCompletion.command(input)
            return yield* ResearchPlanning.command(input)
          }).pipe(
            Effect.provideService(ResearchStore.Service, state),
            Effect.provideService(ProContract.Service, contracts),
            Effect.provideService(ProContractOpenCode.Service, bindings),
            Effect.provideService(ProContractJob.Service, jobs),
            Effect.provideService(FSUtil.Service, fs),
            Effect.provideService(SessionStore.Service, messages),
            Effect.provideService(ProContractObservation.Service, observations),
            Effect.mapError((error) => new ProContractDelivery.Denied({ message: error.message })),
          ),
        request: (input) =>
          state
            .atomic(
              Effect.gen(function* () {
                yield* bindings.authorize(input.execution)
                const run = yield* state.get(input.execution.contractID)
                const contract = yield* contracts.get(input.execution.contractID)
                const binding = yield* bindings.get(input.execution.contractID)
                if (run && ResearchProtocol.advisory(run.input))
                  return yield* new ResearchModel.Denied({
                    message:
                      "Use contract_request prepare_candidate with the view returned by research_view; candidate identity cannot be inferred from the latest run",
                  })
                if (
                  !run ||
                  !contract ||
                  !binding ||
                  run.stage !== "execution" ||
                  contract.recognition.context?.profile !== ResearchProtocol.profile(run.input) ||
                  !ProContractRecognition.same(contract.recognition.context.target, run.context) ||
                  contract.specHash !== run.specHash ||
                  (yield* Clock.currentTimeMillis) >= run.input.spec.budget.deadline
                )
                  return yield* new ResearchModel.Denied({
                    message: "Research delivery request is no longer admissible",
                  })
                if (
                  run.input.planning &&
                  (!ResearchProtocol.planAdmitted(run) ||
                    !ResearchProtocol.planAdmission(run) ||
                    !run.experiment ||
                    run.experiment.planHash !== run.plan?.hash ||
                    run.experiment.approvalHash !== ResearchProtocol.planAdmission(run))
                )
                  return yield* new ResearchModel.Denied({
                    message: "Delivery requires the current approved plan and a successful formal experiment",
                  })
                const closed = yield* bindings.setAdmission({
                  expected: binding,
                  context: run.context,
                  open: false,
                  reason: "Research delivery requested; waiting for cleanup",
                })
                if (!closed.binding) return yield* new ResearchModel.Denied({ message: closed.conflict! })
                yield* state.save(run, {
                  ...run,
                  stage: "freezing",
                  purpose: undefined,
                  request: input,
                  captureID: crypto.randomUUID(),
                  reason: undefined,
                })
              }),
            )
            .pipe(Effect.mapError((error) => new ProContractDelivery.Denied({ message: error.message }))),
      }
      return {
        get: (profile: string) =>
          [ResearchModel.profile, ResearchModel.plannedProfile].includes(profile) ? handler : undefined,
      }
    }),
  ),
  deps: [
    ResearchStore.node,
    ProContract.node,
    ProContractOpenCode.node,
    ProContractJob.node,
    FSUtil.node,
    SessionStore.node,
    ProContractObservation.node,
  ],
})

export const validatorNode = makeGlobalNode({
  service: ProContractRecognition.Service,
  layer: Layer.effect(
    ProContractRecognition.Service,
    Effect.gen(function* () {
      const state = yield* ResearchStore.Service
      const messages = yield* SessionStore.Service
      const observations = yield* ProContractObservation.Service
      const validator: ProContractRecognition.Validator = {
        identity: ResearchModel.profile,
        validate: (input) =>
          Effect.gen(function* () {
            const run = yield* state.get(input.contract.id)
            const context = input.contract.recognition.context
            if (
              !run ||
              !["ready", "accepted"].includes(run.stage) ||
              !context?.admitted ||
              context.profile !== ResearchProtocol.profile(run.input) ||
              context.referenceHash !== input.evidenceHash ||
              run.bundleHash !== input.evidenceHash ||
              !ProContractRecognition.same(run.published, input.expected) ||
              !ProContractRecognition.same(run.context, context.target)
            )
              return "Research bundle is not currently admitted"
            if (ResearchProtocol.feedback(run.input)) {
              const bundle = yield* state
                .json(input.evidenceHash)
                .pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(
                      Schema.Union([ResearchFeedbackEvidence.Bundle, ResearchAdvisoryProtocol.Bundle]),
                    ),
                  ),
                )
              if (
                bundle.contractID !== run.id ||
                bundle.round !== run.round ||
                bundle.reviewVersion !== run.reviewVersion ||
                bundle.subjectHash !== run.subjectHash ||
                bundle.manifestHash !== run.manifestHash ||
                bundle.verificationHash !== run.verificationHash ||
                bundle.reviewHash !== run.reviewHash ||
                bundle.materialsHash !== run.materialsHash ||
                bundle.admissionHash !== run.plan?.admissionHash ||
                bundle.profile !== ResearchProtocol.profile(run.input) ||
                !ProContractRecognition.same(bundle.handoff, run.handoff) ||
                !ProContractRecognition.same(bundle.experiment, run.experiment) ||
                !ProContractRecognition.same(bundle.policy, run.input.manifest.reviewPolicy) ||
                !ProContractRecognition.same(bundle.dependencies, run.input.manifest.dependencies) ||
                bundle.handoff.handoffID !== input.expected.handoffID ||
                bundle.handoff.subjectHash !== input.expected.subjectHash ||
                bundle.handoff.revision !== input.expected.revision ||
                bundle.handoff.specHash !== input.expected.specHash ||
                !input.contract.spec.brief.includes(`Research acceptance manifest: ${run.manifestHash}`)
              )
                return "Submitted feedback bundle identity changed"
              return yield* Effect.gen(function* () {
                if (ResearchProtocol.advisory(run.input)) {
                  if (bundle.version !== 3) return "Candidate bundle protocol changed"
                  const expected = yield* ResearchFeedbackEvidence.bundle(
                    { ...run, context: bundle.context },
                    run.handoff!,
                    bundle.operations,
                  )
                  if (!ProContractRecognition.same(bundle, expected))
                    return "Advisory bundle does not preserve original opinions, records and missing treatment"
                  return yield* ResearchFeedbackEvidence.validate(run)
                }
                if (bundle.version !== 2) return "Legacy feedback bundle protocol changed"
                const entries = yield* ResearchFeedbackEvidence.entries(run)
                if (
                  !ProContractRecognition.same(bundle.feedback, entries) ||
                  !ProContractRecognition.same(
                    bundle.completions,
                    ResearchProtocol.lifecycle(run.input)
                      ? yield* ResearchFeedbackEvidence.completions(run)
                      : undefined,
                  ) ||
                  bundle.feedbackProtocol !==
                    (ResearchProtocol.lifecycle(run.input) ? run.input.manifest.feedbackProtocol : undefined) ||
                  !ProContractRecognition.same(bundle.context, entries.at(-1)?.outcome.context) ||
                  bundle.verdict !== (entries.at(-1)?.outcome.review?.verdict ?? "unavailable")
                )
                  return "Submitted feedback bundle does not preserve original opinions and responses"
                return yield* ResearchFeedbackEvidence.validate(run)
              }).pipe(
                Effect.provideService(ResearchStore.Service, state),
                Effect.provideService(SessionStore.Service, messages),
                Effect.provideService(ProContractObservation.Service, observations),
              )
            }
            const bundle = yield* state
              .json(input.evidenceHash)
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.Bundle)))
            const manifest = yield* state
              .json(bundle.manifestHash)
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.Manifest)))
            const verification = yield* state
              .json(bundle.verificationHash)
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.Verification)))
            const review = yield* state
              .json(bundle.reviewHash)
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.ReviewReport)))
            if (
              !ProContractRecognition.same(bundle.handoff, run.handoff) ||
              !ProContractRecognition.same(bundle.context, review.context) ||
              bundle.context.version + 1 !== run.context.version ||
              verification.context.revision !== bundle.context.revision ||
              verification.context.specHash !== bundle.context.specHash ||
              verification.context.version >= bundle.context.version ||
              bundle.contractID !== run.id ||
              bundle.round !== run.round ||
              bundle.reviewVersion !== run.reviewVersion ||
              bundle.subjectHash !== run.subjectHash ||
              bundle.manifestHash !== run.manifestHash ||
              bundle.verificationHash !== run.verificationHash ||
              bundle.reviewHash !== run.reviewHash ||
              bundle.materialsHash !== run.materialsHash ||
              bundle.profile !== ResearchProtocol.profile(run.input) ||
              bundle.verdict !== "accept" ||
              review.review.verdict !== "accept" ||
              review.review.findings.some((finding) => finding.severity === "blocking") ||
              !review.review.claims.length ||
              verification.verdict !== "passed" ||
              verification.subjectHash !== bundle.subjectHash ||
              review.subjectHash !== bundle.subjectHash ||
              verification.manifestHash !== bundle.manifestHash ||
              review.manifestHash !== bundle.manifestHash ||
              review.materialsHash !== bundle.materialsHash ||
              bundle.handoff.handoffID !== input.expected.handoffID ||
              bundle.handoff.subjectHash !== input.expected.subjectHash ||
              bundle.handoff.revision !== input.expected.revision ||
              bundle.handoff.specHash !== input.expected.specHash ||
              run.specHash !== input.contract.specHash ||
              !input.contract.spec.brief.includes(`Research acceptance manifest: ${run.manifestHash}`) ||
              !ProContractRecognition.same(manifest, run.input.manifest)
            )
              return "Research bundle identities or verdicts do not match"
            for (const report of [verification, review]) {
              const job = (yield* state.db
                .select()
                .from(ProContractJobTable)
                .where(eq(ProContractJobTable.id, report.jobID))
                .get()
                .pipe(Effect.orDie))?.data
              if (
                !job ||
                job.status !== "completed" ||
                job.fingerprint !== report.fingerprint ||
                job.generation !== report.generation ||
                job.input.contractID !== run.id ||
                job.input.inputHash !== report.inputHash ||
                !ProContractRecognition.same(job.input.context, report.context)
              )
                return "Research report lacks a completed original job"
              if (
                report === verification &&
                (job.input.id !== run.verifierJobID ||
                  job.input.kind !== "verify" ||
                  !ProContractRecognition.same(job.result, verification.replay) ||
                  job.input.verification?.subjectHash !== bundle.subjectHash ||
                  !ProContractRecognition.same(job.input.verification.policy, policy(manifest, run.runner)) ||
                  !ProContractRecognition.same(
                    job.input.verification.additionalProtected,
                    run.input.planning ? ResearchProtocol.additionalProtected(run) : undefined,
                  ) ||
                  !ProContractRecognition.same(
                    job.input.verification.freshArtifacts ?? [],
                    manifest.artifacts
                      .filter((artifact) => artifact.kind === "generated")
                      .map((artifact) => artifact.path),
                  ))
              )
                return "Mechanical report is not from the approved verifier job"
              if (report === review) {
                if (
                  job.input.id !== run.reviewJobID ||
                  job.input.kind !== "review" ||
                  job.input.location.directory !== run.reviewDirectory ||
                  !ProContractRecognition.same(job.input.model, manifest.reviewer.model) ||
                  job.input.agent !== manifest.reviewer.agent ||
                  !ProContractRecognition.same(job.input.context, bundle.context)
                )
                  return "Reviewer job identity changed"
                const final = (yield* messages.context(job.input.sessionID)).at(-1)
                if (final?.id !== review.messageID) return "Reviewer report is not the final source message"
                const epoch = yield* state.db
                  .select()
                  .from(SessionContextEpochTable)
                  .where(eq(SessionContextEpochTable.session_id, job.input.sessionID))
                  .get()
                  .pipe(Effect.orDie)
                if (!epoch || !ProContractRecognition.same(yield* state.json(review.systemHash), epoch))
                  return "Reviewer system context evidence changed"
                const message = yield* messages.message(review.messageID)
                if (
                  !message ||
                  message.sessionID !== job.input.sessionID ||
                  message.message.type !== "assistant" ||
                  !message.message.time.completed ||
                  message.message.error ||
                  !message.message.finish ||
                  !ProContractRecognition.same(
                    { ...message.message.model, variant: message.message.model.variant ?? "default" },
                    { ...job.input.model, variant: job.input.model.variant ?? "default" },
                  ) ||
                  message.message.agent !== job.input.agent
                )
                  return "Reviewer report has no exact completed source message"
                const raw = message.message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n")
                if (
                  Hash.sha256(raw) !== review.rawHash ||
                  Buffer.from(yield* state.bytes(review.rawHash)).toString("utf8") !== raw ||
                  !ProContractRecognition.same(
                    yield* Schema.decodeUnknownEffect(
                      Schema.UnknownFromJsonString.pipe(Schema.decodeTo(ResearchModel.Review)),
                    )(raw),
                    review.review,
                  )
                )
                  return "Reviewer report differs from its recorded output"
              }
            }
            const replay = yield* state
              .json(verification.replay.evidenceHash)
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ProContractReplay.ReportSchema)))
            if (
              replay.contractID !== run.id ||
              replay.subjectHash !== bundle.subjectHash ||
              replay.incomplete ||
              !replay.passed ||
              replay.checks.length !== 1 ||
              replay.policyHash !== ProContractKernel.hashReplay(policy(manifest, run.runner)) ||
              !ProContractRecognition.same(
                replay.protectedBefore?.map((file) => ({ path: file.path, hash: file.exists ? file.hash : undefined })),
                [
                  ...manifest.verification.harness,
                  ...(run.input.planning ? ResearchProtocol.additionalProtected(run) : []),
                ],
              ) ||
              !ProContractRecognition.same(
                replay.protected.map((file) => ({ path: file.path, hash: file.exists ? file.hash : undefined })),
                [
                  ...manifest.verification.harness,
                  ...(run.input.planning ? ResearchProtocol.additionalProtected(run) : []),
                ],
              )
            )
              return "Mechanical replay is incomplete or belongs to another candidate"
            const observed = replay.checks[0].observation
            if (
              !ProContractRecognition.same(yield* observations.get(observed.handle), observed.receipt) ||
              observed.receipt.execution !== "completed" ||
              !observed.receipt.stdout?.complete ||
              !observed.receipt.stderr?.complete ||
              observed.receipt.exit !== 0 ||
              !ProContractRecognition.same(observed.receipt.argv, policy(manifest, run.runner).checks[0].argv)
            )
              return "Mechanical output provenance is unavailable"
            const stdout = yield* state.bytes(observed.receipt.stdout.hash)
            if (parse(Buffer.from(stdout).toString("utf8"), manifest.verification).verdict !== "passed")
              return "Mechanical explicit test requirements were not satisfied"
            yield* state.bytes(observed.receipt.stderr.hash)
            const materials = yield* state.json(bundle.materialsHash).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    contractID: ProContract.ID,
                    subjectHash: Schema.String,
                    manifestHash: Schema.String,
                    verificationHash: Schema.String,
                    task: Schema.Unknown,
                    manifest: Schema.Unknown,
                    environment: Schema.Struct({ instructionsHash: Schema.String }),
                  }),
                ),
              ),
            )
            const epoch = yield* state
              .json(review.systemHash)
              .pipe(
                Effect.flatMap(
                  Schema.decodeUnknownEffect(Schema.Struct({ snapshot: Schema.Record(Schema.String, Schema.Unknown) })),
                ),
              )
            if (
              materials.contractID !== run.id ||
              materials.subjectHash !== run.subjectHash ||
              materials.manifestHash !== run.manifestHash ||
              materials.verificationHash !== bundle.verificationHash ||
              !ProContractRecognition.same(materials.task, run.input.spec) ||
              !ProContractRecognition.same(materials.manifest, manifest) ||
              materials.environment.instructionsHash !==
                ProContractRecognition.fingerprint(epoch.snapshot["core/instructions"] ?? null)
            )
              return "Reviewer materials do not describe this exact task and instruction context"
            for (const evidence of verification.evidence) {
              if ((yield* state.bytes(evidence.hash)).length !== evidence.bytes)
                return "Mechanical evidence size changed"
            }
            for (const artifact of manifest.artifacts) {
              const recorded = replay.artifacts.find((file) => file.path === artifact.path)
              if (
                !recorded?.captured ||
                !recorded.before ||
                recorded.captureError ||
                recorded.before?.captureError ||
                (recorded.before?.exists && !recorded.before.captured) ||
                recorded.hash !== recorded.captured.hash ||
                (artifact.kind === "generated" && !recorded.generated) ||
                (yield* state.bytes(recorded.captured.hash)).length !== recorded.captured.bytes
              )
                return "Required artifact bytes or generation provenance are unavailable"
            }
            for (const file of replay.artifacts) {
              if (
                file.before?.captured &&
                (yield* state.bytes(file.before.captured.hash)).length !== file.before.captured.bytes
              )
                return "Artifact pre-execution bytes are unavailable"
            }
            const available = new Set([
              bundle.verificationHash,
              bundle.materialsHash,
              ...ResearchProtocol.planEvidence(run),
              ...verification.evidence.map((item) => item.hash),
            ])
            if (review.review.claims.some((claim) => claim.evidence.some((hash) => !available.has(hash))))
              return "Reviewer conclusions cite unavailable evidence"
            return yield* ResearchPlanEvidence.validate(run, bundle).pipe(
              Effect.provideService(ResearchStore.Service, state),
              Effect.provideService(SessionStore.Service, messages),
              Effect.provideService(ProContractObservation.Service, observations),
            )
          }).pipe(Effect.catch(() => Effect.succeed("Research evidence is missing, malformed or corrupt"))),
      }
      const planned = { ...validator, identity: ResearchModel.plannedProfile }
      return {
        get: (profile: string) =>
          profile === ResearchModel.profile
            ? validator
            : profile === ResearchModel.plannedProfile
              ? planned
              : undefined,
      }
    }),
  ),
  deps: [ResearchStore.node, SessionStore.node, ProContractObservation.node],
})
