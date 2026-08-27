import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ModelV2 } from "@opencode-ai/core/model"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Hash } from "@opencode-ai/core/util/hash"
import { Clock, Effect, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  spec: ProContract.Spec,
  evaluation: ProContract.EvaluationPlan.pipe(Schema.optional),
})
export const formationMetadataKey = "procontractFormation"

type Metadata = {
  contractID: ProContract.ID
  sessionID: string
  evaluationContractID?: ProContract.ID
}

export const ContractProposeTool = Tool.define<
  typeof Parameters,
  Metadata,
  Agent.Service | Config.Service | ProContractOpenCode.Service | Session.Service
>(
  "contract_propose",
  Effect.gen(function* () {
    const bindings = yield* ProContractOpenCode.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service

    return {
      description:
        "Propose a persistent Contract when the request requires a future trigger, asynchronous or multi-Session work, durable follow-up, or later external evaluation. Set spec.goal to the current optimization objective, spec.policy only to an exact policy offered to future Contracts, and evidence.claim to the exact proposition the evidence may settle. When delivery evidence does not settle the intended quality claim, include evaluation so that dependent evaluation is persisted before execution starts. A requirement may set policy: true only when its discharged source Contract defines the principal-ratified spec.policy. An implementation Contract that promises a build command or named output artifact must include evidence.replay with finite checks and every required artifact path. Preserve user-supplied quality criteria and stopping rules in the brief. Budgets and attempt limits are exact shared ceilings; budget.deadline is an absolute Unix timestamp in milliseconds. The exact draft requires principal approval before it is issued.",
      parameters: Parameters,
      execute: (input, ctx) =>
        Effect.gen(function* () {
          const agent = yield* agents.get(ctx.agent)
          if (!agent || agent.mode !== "primary")
            return yield* Effect.die("Only a primary agent may propose a Contract")
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          if (session.metadata?.[formationMetadataKey] === "contract")
            return yield* Effect.die("This Session already delegated its obligation to a Contract")
          if (!session.model) return yield* Effect.die("Contract proposal requires a selected model")
          const now = yield* Clock.currentTimeMillis
          const request = ctx.messages
            .findLast((item) => item.info.role === "user")
            ?.parts.flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
            .join("\n")
          const compiled = ProContractOpenCode.compileSpec({
            spec: input.spec,
            request,
            configuredPolicy: (yield* config.get()).contract_policy,
            evaluation: input.evaluation,
          })
          if (compiled.type === "rejected") return yield* Effect.die(compiled.reason)
          const spec = compiled.spec
          const key = Hash.sha256(`${ctx.sessionID}:${ctx.messageID}:${ctx.callID ?? ""}`)
          const contractID = ProContract.ID.make(`pct_${key}`)
          const specHash = compiled.specHash
          yield* ctx.ask({
            permission: "contract_issue",
            patterns: [specHash, ...(input.evaluation ? [compiled.manifestHash] : [])],
            always: [],
            metadata: {
              contractID,
              specHash,
              goal: spec.goal,
              details: [
                spec.brief ? `Brief: ${spec.brief}` : undefined,
                spec.policy ? `Future policy: ${spec.policy}` : undefined,
                `Trigger: ${JSON.stringify(spec.trigger)}`,
                `Authority: ${spec.authority.join(", ")}`,
                `Budget: ${spec.budget.turns} turns, ${spec.budget.actions} actions, deadline ${spec.budget.deadline}`,
                `Requires: ${spec.requires.map((item) => `${item.contractID}@${item.revision}${item.policy ? " (policy)" : ""}`).join(", ") || "none"}`,
                `Settlement claim: ${ProContract.evidenceClaim(spec)}`,
                `Evidence: ${spec.evidence.type}${spec.evidence.replay ? ` + replay (${spec.evidence.replay.checks.length} checks)` : ""}`,
                input.evaluation
                  ? `Evaluation: ${input.evaluation.evaluatorHash}, deadline ${input.evaluation.deadline}`
                  : "Evaluation: none; delivery settlement is final for this scope",
                `Compiler manifest: ${compiled.manifestHash}`,
                `Resolution: ${spec.resolution.maxAttempts} attempts, ${spec.resolution.retryDelay} ms retry delay`,
              ]
                .filter((item) => item !== undefined)
                .join("\n"),
            },
          })
          const issued = yield* bindings.issue({
            id: contractID,
            scope: session.projectID,
            spec,
            location: { directory: AbsolutePath.make(session.directory), workspaceID: session.workspaceID },
            model: ModelV2.Ref.make({
              id: session.model.id,
              providerID: session.model.providerID,
              variant: session.model.variant ? ModelV2.VariantID.make(session.model.variant) : undefined,
            }),
            evaluation: input.evaluation,
            now,
          })
          if (issued.decision.type === "rejected") return yield* Effect.die(issued.decision.reason)
          if (issued.evaluation?.decision.type === "rejected") return yield* Effect.die(issued.evaluation.decision.reason)
          if (!issued.execution) return yield* Effect.die("Contract execution was not created")
          yield* sessions.setMetadata({
            sessionID: session.id,
            metadata: { ...session.metadata, [formationMetadataKey]: "contract" },
          })
          return {
            title: "Contract issued",
            output: `Contract ${contractID} was approved and scheduled in Session ${issued.execution.sessionID}.${issued.evaluation?.contract ? ` Evaluation ${issued.evaluation.contract.id} remains outstanding until independent evidence settles the quality claim.` : ""} Stop work in this Session; the dedicated Contract executor now owns the obligation.`,
            metadata: {
              contractID,
              sessionID: issued.execution.sessionID,
              evaluationContractID: issued.evaluation?.contract?.id,
            },
          }
        }),
    }
  }),
)
