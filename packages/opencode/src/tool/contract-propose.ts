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
export const formationMetadataKey = "procontractFormation"

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
        "Propose a persistent Contract when the request requires a future trigger, asynchronous or multi-Session work, durable follow-up, or an artifact whose correctness depends on later external evaluation. Use evidence.replay when finite repository checks or required artifacts can mechanically verify the frozen candidate. Budgets are shared across all attempts, so reserve remediation headroom. budget.deadline is a Unix timestamp in milliseconds; shorter values use the standard 24-hour deadline. When unsure, propose. The exact normalized draft requires principal approval before it is issued.",
      parameters: Parameters,
      execute: (input, ctx) =>
        Effect.gen(function* () {
          const agent = yield* agents.get(ctx.agent)
          if (!agent || agent.mode !== "primary")
            return yield* Effect.die("Only a primary agent may propose a Contract")
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          if (!session.model) return yield* Effect.die("Contract proposal requires a selected model")
          const now = yield* Clock.currentTimeMillis
          const draft = {
            ...input.spec,
            resolution: {
              ...input.spec.resolution,
              maxAttempts: Math.max(input.spec.resolution.maxAttempts, 2),
            },
            budget: {
              turns: Math.max(input.spec.budget.turns, 1_000),
              actions: Math.max(input.spec.budget.actions, 10_000),
              deadline: Math.max(input.spec.budget.deadline, now + 24 * 60 * 60 * 1_000),
            },
          }
          const request = ctx.messages
            .findLast((item) => item.info.role === "user")
            ?.parts.flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
            .join("\n")
          const spec = request
            ? { ...draft, brief: [draft.brief, `Original request:\n${request}`].filter(Boolean).join("\n\n") }
            : draft
          const key = Hash.sha256(`${ctx.sessionID}:${ctx.messageID}:${ctx.callID ?? ""}`)
          const contractID = ProContract.ID.make(`pct_${key}`)
          const specHash = ProContract.hashSpec(spec)
          yield* ctx.ask({
            permission: "contract_issue",
            patterns: [specHash],
            always: [],
            metadata: {
              contractID,
              specHash,
              goal: spec.goal,
              details: [
                spec.brief ? `Brief: ${spec.brief}` : undefined,
                `Trigger: ${JSON.stringify(spec.trigger)}`,
                `Authority: ${spec.authority.join(", ")}`,
                `Budget: ${spec.budget.turns} turns, ${spec.budget.actions} actions, deadline ${spec.budget.deadline}`,
                `Requires: ${spec.requires.map((item) => `${item.contractID}@${item.revision}`).join(", ") || "none"}`,
                `Evidence: ${spec.evidence.type}${spec.evidence.replay ? ` + replay (${spec.evidence.replay.checks.length} checks)` : ""}`,
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
            now,
          })
          if (issued.decision.type === "rejected") return yield* Effect.die(issued.decision.reason)
          if (!issued.execution) return yield* Effect.die("Contract execution was not created")
          yield* sessions.setMetadata({
            sessionID: session.id,
            metadata: { ...session.metadata, [formationMetadataKey]: "contract" },
          })
          return {
            title: "Contract issued",
            output: `Contract ${contractID} was approved and scheduled in Session ${issued.execution.sessionID}. Stop work in this Session; the dedicated Contract executor now owns the obligation.`,
            metadata: { contractID, sessionID: issued.execution.sessionID },
          }
        }),
    }
  }),
)

const ContinueParameters = Schema.Struct({ reason: Schema.NonEmptyString })

export const ContractContinueTool = Tool.define<
  typeof ContinueParameters,
  Record<string, never>,
  Agent.Service | Session.Service
>(
  "contract_continue",
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service

    return {
      description:
        "Declare that both the work and its validation can finish in this Session. Do not use when an artifact will be evaluated or reviewed later; when unsure, propose a Contract.",
      parameters: ContinueParameters,
      execute: (input, ctx) =>
        Effect.gen(function* () {
          const agent = yield* agents.get(ctx.agent)
          if (!agent || agent.mode !== "primary")
            return yield* Effect.die("Only a primary agent may decide Contract formation")
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          if (session.metadata?.[formationMetadataKey] === "contract")
            return yield* Effect.die("A signed Contract cannot be replaced by an ordinary-work decision")
          yield* ctx.ask({
            permission: "contract_continue",
            patterns: [ctx.sessionID],
            always: [],
            metadata: { reason: input.reason },
          })
          yield* sessions.setMetadata({
            sessionID: session.id,
            metadata: { ...session.metadata, [formationMetadataKey]: "ordinary" },
          })
          return {
            title: "Continuing without Contract",
            output: `Formation decision recorded: ${input.reason}`,
            metadata: {},
          }
        }),
    }
  }),
)
