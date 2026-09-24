export * as ResearchPlanEvidence from "./plan-evidence"

import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { ProContractKernel } from "@opencode-ai/core/pro-contract/kernel"
import { ProContractObservation } from "@opencode-ai/core/pro-contract/observation"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { ProContractReplay } from "@opencode-ai/core/pro-contract/replay"
import { ProContractJobTable } from "@opencode-ai/core/pro-contract/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionContextEpochTable } from "@opencode-ai/core/session/sql"
import { Hash } from "@opencode-ai/core/util/hash"
import { ResearchModel } from "./model"
import { ResearchProtocol } from "./protocol"
import { ResearchReviewer } from "./reviewer"
import { ResearchStore } from "./store"
import { parse } from "./tap"

// This validator deliberately has no Contract service dependency: recognition calls it from Core.
export const validate = Effect.fnUntraced(function* (run: ResearchModel.Run, bundle: ResearchModel.Bundle) {
  if (!run.input.planning) return bundle.experiment ? "Final-only profile cannot claim a planned experiment" : undefined
  const state = yield* ResearchStore.Service
  const messages = yield* SessionStore.Service
  const observations = yield* ProContractObservation.Service
  const plan = run.plan
  const experiment = run.experiment
  if (
    !plan?.approved ||
    !plan.reportHash ||
    !experiment ||
    !run.runner ||
    !ProContractRecognition.same(bundle.experiment, experiment) ||
    experiment.planHash !== plan.hash ||
    experiment.approvalHash !== plan.reportHash ||
    experiment.subjectHash !== bundle.subjectHash ||
    plan.value.scope !== "within_task" ||
    !ResearchProtocol.protectedPaths(plan.value, run.input.manifest)
  )
    return "Current plan approval and exact experiment are required"
  if (
    run.runner.hash !== Hash.sha256(ResearchProtocol.runner(run.input.manifest)) ||
    Buffer.from(yield* state.bytes(run.runner.hash)).toString("utf8") !== ResearchProtocol.runner(run.input.manifest)
  )
    return "Approved host runner evidence is unavailable"
  const report = yield* state
    .json(plan.reportHash)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.PlanReport)))
  const verification = yield* state
    .json(experiment.verificationHash)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.Verification)))
  const final = yield* state
    .json(bundle.verificationHash)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.Verification)))
  if (
    !ProContractRecognition.same(yield* state.json(plan.hash), plan.value) ||
    !ProContractRecognition.same(plan.value.agreement, {
      revision: run.revision,
      specHash: run.specHash,
      manifestHash: run.manifestHash,
    }) ||
    !ProContractRecognition.same(report.agreement, plan.value.agreement) ||
    report.planHash !== plan.hash ||
    report.manifestHash !== run.manifestHash ||
    report.subjectHash !== plan.subjectHash ||
    report.materialsHash !== plan.materialsHash ||
    report.review.verdict !== "accept" ||
    report.review.scope !== "within_task" ||
    !ResearchReviewer.valid(report.review, [plan.hash, report.materialsHash]) ||
    !ProContractRecognition.same(report.context, verification.context) ||
    !ProContractRecognition.same(report.context, final.context) ||
    report.context.version + 1 !== bundle.context.version ||
    bundle.context.version + 1 !== run.context.version ||
    verification.verdict !== "passed" ||
    verification.subjectHash !== bundle.subjectHash ||
    verification.manifestHash !== run.manifestHash
  )
    return "Plan approval or experiment does not bind the exact task and handoff chain"
  for (const item of [report, verification]) {
    const job = (yield* state.db
      .select()
      .from(ProContractJobTable)
      .where(eq(ProContractJobTable.id, item.jobID))
      .get()
      .pipe(Effect.orDie))?.data
    if (
      !job ||
      job.status !== "completed" ||
      job.input.contractID !== run.id ||
      job.input.driver !== ResearchModel.plannedProfile ||
      job.fingerprint !== item.fingerprint ||
      job.generation !== item.generation ||
      job.input.inputHash !== item.inputHash ||
      !ProContractRecognition.same(job.input.context, item.context)
    )
      return "Plan or experiment job provenance is unavailable"
    if (item === report) {
      if (
        job.input.id !== plan.jobID ||
        job.input.kind !== "review" ||
        job.input.inputHash !== plan.materialsHash ||
        job.input.location.directory !== plan.directory ||
        job.input.agent !== run.input.manifest.reviewer.agent ||
        !ProContractRecognition.same(job.input.model, run.input.manifest.reviewer.model)
      )
        return "Plan reviewer identity changed"
      const message = yield* messages.message(report.messageID)
      if (
        (yield* messages.context(job.input.sessionID)).at(-1)?.id !== report.messageID ||
        !message ||
        message.sessionID !== job.input.sessionID ||
        message.message.type !== "assistant" ||
        !message.message.time.completed ||
        message.message.error ||
        !message.message.finish ||
        message.message.agent !== job.input.agent ||
        !ProContractRecognition.same(
          { ...message.message.model, variant: message.message.model.variant ?? "default" },
          { ...job.input.model, variant: job.input.model.variant ?? "default" },
        )
      )
        return "Plan review lacks its completed final source message"
      const raw = message.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      if (
        Hash.sha256(raw) !== report.rawHash ||
        Buffer.from(yield* state.bytes(report.rawHash)).toString("utf8") !== raw ||
        !ProContractRecognition.same(
          yield* Schema.decodeUnknownEffect(
            Schema.UnknownFromJsonString.pipe(Schema.decodeTo(ResearchModel.PlanReview)),
            { onExcessProperty: "error" },
          )(raw),
          report.review,
        )
      )
        return "Plan review differs from recorded output"
      const epoch = yield* state.db
        .select()
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, job.input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!epoch || !ProContractRecognition.same(yield* state.json(report.systemHash), epoch))
        return "Plan reviewer system context changed"
      const material = yield* state.json(report.materialsHash).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              contractID: Schema.String,
              agreement: Schema.Unknown,
              task: Schema.Unknown,
              manifest: Schema.Unknown,
              manifestHash: Schema.String,
              plan: Schema.Unknown,
              planHash: Schema.String,
              subjectHash: Schema.String,
              environment: Schema.Struct({ instructionsHash: Schema.String }),
            }),
          ),
        ),
      )
      if (
        material.contractID !== run.id ||
        material.planHash !== plan.hash ||
        material.subjectHash !== plan.subjectHash ||
        material.manifestHash !== run.manifestHash ||
        !ProContractRecognition.same(material.plan, plan.value) ||
        !ProContractRecognition.same(material.agreement, plan.value.agreement) ||
        !ProContractRecognition.same(material.task, run.input.spec) ||
        !ProContractRecognition.same(material.manifest, run.input.manifest) ||
        material.environment.instructionsHash !==
          ProContractRecognition.fingerprint(epoch.snapshot["core/instructions"] ?? null)
      )
        return "Plan reviewer materials changed"
    }
    if (
      item === verification &&
      (job.input.kind !== "verify" ||
        !ProContractRecognition.same(job.result, verification.replay) ||
        job.input.verification?.subjectHash !== bundle.subjectHash ||
        !ProContractRecognition.same(
          job.input.verification.policy,
          ResearchProtocol.policy(run.input.manifest, run.runner, plan.value.protected),
        ) ||
        !ProContractRecognition.same(
          job.input.verification.freshArtifacts,
          run.input.manifest.artifacts.filter((file) => file.kind === "generated").map((file) => file.path),
        ) ||
        job.input.inputHash !==
          ProContractRecognition.fingerprint({
            subject: bundle.subjectHash,
            manifest: run.manifestHash,
            round: run.round,
            planHash: plan.hash,
            approvalHash: plan.reportHash,
            purpose: "experiment",
          }))
    )
      return "Formal experiment did not use the approved policy and plan"
  }
  const replay = yield* state
    .json(verification.replay.evidenceHash)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ProContractReplay.ReportSchema)))
  const policy = ResearchProtocol.policy(run.input.manifest, run.runner, plan.value.protected)
  if (
    replay.contractID !== run.id ||
    replay.subjectHash !== bundle.subjectHash ||
    !replay.passed ||
    replay.incomplete ||
    replay.policyHash !== ProContractKernel.hashReplay(policy) ||
    replay.checks.length !== 1 ||
    !ProContractRecognition.same(
      replay.protectedBefore?.map((file) => ({ path: file.path, hash: file.exists ? file.hash : undefined })),
      policy.protected,
    ) ||
    !ProContractRecognition.same(
      replay.protected.map((file) => ({ path: file.path, hash: file.exists ? file.hash : undefined })),
      policy.protected,
    )
  )
    return "Formal experiment protected inputs or protocol changed"
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
    return "Formal experiment test execution is unavailable"
  yield* state.bytes(observed.receipt.stderr.hash)
  for (const file of verification.evidence)
    if ((yield* state.bytes(file.hash)).length !== file.bytes) return "Formal experiment evidence bytes changed"
  for (const artifact of run.input.manifest.artifacts) {
    const file = replay.artifacts.find((file) => file.path === artifact.path)
    if (
      !file?.captured ||
      !file.before ||
      file.captureError ||
      file.before.captureError ||
      file.hash !== file.captured.hash ||
      (artifact.kind === "generated" && !file.generated) ||
      (file.before.exists && !file.before.captured) ||
      (yield* state.bytes(file.captured.hash)).length !== file.captured.bytes
    )
      return "Formal experiment artifact provenance is unavailable"
    if (file.before.captured && (yield* state.bytes(file.before.captured.hash)).length !== file.before.captured.bytes)
      return "Formal experiment input bytes changed"
  }
  return undefined
})
