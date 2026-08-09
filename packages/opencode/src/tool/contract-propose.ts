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

export const Parameters = Schema.Struct({ spec: ProContract.Spec })
export const formationMetadataKey = "procontractFormation"

type Metadata = {
  contractID: ProContract.ID
  sessionID: string
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
        "Propose a persistent Contract when the request requires a future trigger, asynchronous or multi-Session work, durable follow-up, or later external evaluation. Set spec.goal to the optimization objective and evidence.claim to the exact proposition the evidence may settle. A requirement may set policy: true only when its discharged Contract's exact goal is the principal-ratified execution policy. An implementation Contract that promises a build command or named output artifact must include evidence.replay with finite checks and every required artifact path. Preserve user-supplied quality criteria and stopping rules in the brief. Budgets and attempt limits are exact shared ceilings; budget.deadline is an absolute Unix timestamp in milliseconds. The exact draft requires principal approval before it is issued.",
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
          const draft = ProContract.normalizeSpec(input.spec)
          const configuredPolicy = (yield* config.get()).contract_policy
          const inherited =
            configuredPolicy && !draft.requires.some((requirement) => requirement.policy)
              ? {
                  ...draft,
                  requires: [
                    ...draft.requires.filter((requirement) => requirement.contractID !== configuredPolicy.contractID),
                    configuredPolicy,
                  ],
                }
              : draft
          const request = ctx.messages
            .findLast((item) => item.info.role === "user")
            ?.parts.flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
            .join("\n")
          const spec = request
            ? {
                ...inherited,
                brief: [inherited.brief, `Original request:\n${request}`].filter(Boolean).join("\n\n"),
              }
            : inherited
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
                `Requires: ${spec.requires.map((item) => `${item.contractID}@${item.revision}${item.policy ? " (policy)" : ""}`).join(", ") || "none"}`,
                `Settlement claim: ${ProContract.evidenceClaim(spec)}`,
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
