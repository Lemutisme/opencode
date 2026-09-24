export * as ResearchReviewer from "./reviewer"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionContextEpochTable } from "@opencode-ai/core/session/sql"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { ResearchModel } from "./model"
import { ResearchStore } from "./store"
import { ResearchProtocol } from "./protocol"

export const make = Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  const sessions = yield* SessionV2.Service
  const state = yield* ResearchStore.Service
  const environment = (run: ResearchModel.Run, directory: string) =>
    Effect.gen(function* () {
      const plugins = yield* PluginInternal.Service
      yield* plugins.wait
      const config = yield* Config.Service
      const agents = yield* AgentV2.Service
      const registry = yield* SystemContextRegistry.Service
      const resolved = yield* agents.resolve(run.input.manifest.reviewer.agent)
      if (
        (!resolved && run.input.manifest.reviewer.agent !== AgentV2.defaultID) ||
        (resolved && resolved.id !== run.input.manifest.reviewer.agent)
      )
        return yield* new ResearchModel.Denied({ message: "Approved reviewer agent is unavailable" })
      const context = yield* SystemContext.initialize(yield* registry.load())
      return {
        configurationHash: ProContractRecognition.fingerprint(yield* config.entries()),
        agentHash: ProContractRecognition.fingerprint(resolved ?? { id: AgentV2.defaultID }),
        instructionsHash: ProContractRecognition.fingerprint(context.snapshot["core/instructions"] ?? null),
      }
    }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) })))
  const capture = Effect.fnUntraced(function* (run: ResearchModel.Run, job: ProContractJob.Job, directory: string) {
    const message = (yield* sessions.messages({ sessionID: job.input.sessionID, order: "desc", limit: 1 }))[0]
    if (
      job.status !== "completed" ||
      message?.type !== "assistant" ||
      !message.time.completed ||
      message.error ||
      !message.finish ||
      !ProContractRecognition.same(
        { ...message.model, variant: message.model.variant ?? "default" },
        { ...job.input.model, variant: job.input.model.variant ?? "default" },
      ) ||
      message.agent !== job.input.agent
    )
      return yield* new ResearchModel.Denied({ message: "Reviewer has no completed final assistant message" })
    const raw = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    const rawHash = (yield* state.blob(Buffer.from(raw))).hash
    const epoch = yield* state.db
      .select()
      .from(SessionContextEpochTable)
      .where(eq(SessionContextEpochTable.session_id, job.input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (
      !epoch ||
      (yield* environment(run, directory)).instructionsHash !==
        ProContractRecognition.fingerprint(epoch.snapshot["core/instructions"] ?? null)
    )
      return yield* new ResearchModel.Denied({
        message: "Reviewer execution instructions differ from approved materials",
      })
    return { raw, rawHash, messageID: message.id, systemHash: yield* state.put(epoch) }
  })
  const prepareEnvironment = (run: ResearchModel.Run, directory: string) =>
    environment(run, directory).pipe(
      Effect.catch((error) =>
        ResearchProtocol.feedback(run.input)
          ? Effect.succeed({ unavailable: error instanceof Error ? error.message : String(error) })
          : Effect.fail(error),
      ),
    )
  return { environment, prepareEnvironment, capture }
})

export function valid(review: ResearchModel.Review, evidence: ReadonlyArray<string>) {
  return (
    !(
      review.verdict === "accept" &&
      (!review.claims.length || review.findings.some((finding) => finding.severity === "blocking"))
    ) &&
    !(review.verdict === "changes_requested" && !review.findings.some((finding) => finding.severity === "blocking")) &&
    review.claims.every((claim) => claim.evidence.every((hash) => evidence.includes(hash)))
  )
}
