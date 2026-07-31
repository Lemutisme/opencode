import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ModelV2 } from "@opencode-ai/core/model"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Hash } from "@opencode-ai/core/util/hash"
import { Clock, Effect, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({ spec: ProContract.Spec })

type Metadata = {
  contractID: ProContract.ID
  sessionID: string
}

export const ContractProposeTool = Tool.define<
  typeof Parameters,
  Metadata,
  Agent.Service | ProContractOpenCode.Service | Session.Service
>(
  "contract_propose",
  Effect.gen(function* () {
    const bindings = yield* ProContractOpenCode.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service

    return {
      description:
        "Propose a persistent Contract when the user's intent requires a future trigger, asynchronous or multi-Session work, durable follow-up, or evidence-gated completion. Do not contract ordinary local work. The exact draft requires principal approval before it is issued.",
      parameters: Parameters,
      execute: (input, ctx) =>
        Effect.gen(function* () {
          const agent = yield* agents.get(ctx.agent)
          if (!agent || agent.mode !== "primary")
            return yield* Effect.die("Only a primary agent may propose a Contract")
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          if (!session.model) return yield* Effect.die("Contract proposal requires a selected model")
          const key = Hash.sha256(`${ctx.sessionID}:${ctx.messageID}:${ctx.callID ?? ""}`)
          const contractID = ProContract.ID.make(`pct_${key}`)
          const specHash = ProContract.hashSpec(input.spec)
          yield* ctx.ask({
            permission: "contract_issue",
            patterns: [specHash],
            always: [],
            metadata: {
              contractID,
              specHash,
              goal: input.spec.goal,
              details: [
                input.spec.brief ? `Brief: ${input.spec.brief}` : undefined,
                `Trigger: ${JSON.stringify(input.spec.trigger)}`,
                `Authority: ${input.spec.authority.join(", ")}`,
                `Budget: ${input.spec.budget.turns} turns, ${input.spec.budget.actions} actions, deadline ${input.spec.budget.deadline}`,
                `Requires: ${input.spec.requires.map((item) => `${item.contractID}@${item.revision}`).join(", ") || "none"}`,
                `Evidence: ${input.spec.evidence.type}`,
                `Resolution: ${input.spec.resolution.maxAttempts} attempts, ${input.spec.resolution.retryDelay} ms retry delay`,
              ]
                .filter((item) => item !== undefined)
                .join("\n"),
            },
          })
          const issued = yield* bindings.issue({
            id: contractID,
            scope: session.projectID,
            spec: input.spec,
            location: { directory: AbsolutePath.make(session.directory), workspaceID: session.workspaceID },
            model: ModelV2.Ref.make({
              id: session.model.id,
              providerID: session.model.providerID,
              variant: session.model.variant ? ModelV2.VariantID.make(session.model.variant) : undefined,
            }),
            now: yield* Clock.currentTimeMillis,
          })
          if (issued.decision.type === "rejected") return yield* Effect.die(issued.decision.reason)
          if (!issued.execution) return yield* Effect.die("Contract execution was not created")
          return {
            title: "Contract issued",
            output: `Contract ${contractID} was approved and scheduled in Session ${issued.execution.sessionID}. Stop work in this Session; the dedicated Contract executor now owns the obligation.`,
            metadata: { contractID, sessionID: issued.execution.sessionID },
          }
        }),
    }
  }),
)
