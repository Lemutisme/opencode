export * as ContractControlTools from "./contract-control"

import { ToolFailure } from "@opencode-ai/llm"
import { Clock, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ProContract } from "../pro-contract"
import { ProContractOpenCode } from "../pro-contract/open-code"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { Snapshot } from "../snapshot"
import { Hash } from "../util/hash"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const contracts = yield* ProContract.Service
    const bindings = yield* ProContractOpenCode.Service
    const permissions = yield* PermissionV2.Service
    const sessions = yield* SessionStore.Service
    const snapshots = yield* Snapshot.Service

    yield* tools
      .register({
        contract_propose: Tool.make({
          description:
            "Propose a persistent Contract when the request requires a future trigger, asynchronous or multi-Session work, durable follow-up, or an artifact whose correctness depends on later external evaluation. When unsure, propose. The exact draft requires principal approval before it is issued.",
          input: Schema.Struct({ spec: ProContract.Spec }),
          output: Schema.Struct({ contractID: ProContract.ID, sessionID: SessionSchema.ID }),
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Contract ${output.contractID} was approved and scheduled in Session ${output.sessionID}. Stop work in this Session; the dedicated Contract executor now owns the obligation.`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const session = yield* sessions.get(context.sessionID)
              if (!session) return yield* new ToolFailure({ message: "Session not found" })
              if (!session.model)
                return yield* new ToolFailure({ message: "Contract proposal requires a selected model" })
              const key = Hash.sha256(`${context.sessionID}:${context.assistantMessageID}:${context.toolCallID}`)
              const contractID = ProContract.ID.make(`pct_${key}`)
              const specHash = ProContract.hashSpec(input.spec)
              yield* permissions.assert({
                id: PermissionV2.ID.create(`per_${key}`),
                action: "contract_issue",
                resources: [specHash],
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
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const issued = yield* bindings.issue({
                id: contractID,
                scope: session.projectID,
                spec: input.spec,
                location: session.location,
                model: session.model,
                now: yield* Clock.currentTimeMillis,
              })
              if (issued.decision.type === "rejected")
                return yield* new ToolFailure({ message: issued.decision.reason })
              if (!issued.execution) return yield* new ToolFailure({ message: "Contract execution was not created" })
              return { contractID, sessionID: issued.execution.sessionID }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({
                      message: error instanceof PermissionV2.CorrectedError ? error.feedback : String(error),
                    }),
              ),
            ),
        }),
        contract_report_ready: Tool.make({
          description:
            "Hand off the active contract for independent verification. State completed checks and every known unresolved assumption; use contract_report_blocked instead when an uncertainty prevents meaningful verification.",
          input: Schema.Struct({
            summary: Schema.NonEmptyString,
            uncertainties: Schema.Array(Schema.NonEmptyString),
          }),
          output: Schema.Struct({ recorded: Schema.Boolean }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const binding = yield* bindings.forSession(context.sessionID)
              if (!binding) return yield* new ToolFailure({ message: "No Contract is bound to this Session" })
              const subjectHash = yield* snapshots.capture()
              if (!subjectHash) return yield* new ToolFailure({ message: "Contract handoff requires a snapshot" })
              const receipt = yield* contracts.reportReady({
                contractID: binding.contractID,
                revision: binding.revision,
                summary: input.summary,
                uncertainties: input.uncertainties,
                subjectHash,
                time: yield* Clock.currentTimeMillis,
              })
              if (receipt.decision.type === "rejected")
                return yield* new ToolFailure({ message: receipt.decision.reason })
              return { recorded: true }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) }),
              ),
            ),
        }),
        contract_report_blocked: Tool.make({
          description:
            "Report that the active contract cannot proceed. This preserves the obligation and schedules retry or escalation.",
          input: Schema.Struct({ reason: Schema.NonEmptyString }),
          output: Schema.Struct({ recorded: Schema.Boolean }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const binding = yield* bindings.forSession(context.sessionID)
              if (!binding) return yield* new ToolFailure({ message: "No Contract is bound to this Session" })
              const receipt = yield* contracts.reportBlocked({
                contractID: binding.contractID,
                revision: binding.revision,
                reason: input.reason,
                time: yield* Clock.currentTimeMillis,
              })
              if (receipt.decision.type === "rejected")
                return yield* new ToolFailure({ message: receipt.decision.reason })
              yield* bindings.reschedule({
                contractID: binding.contractID,
                revision: binding.revision,
                promptID: binding.promptID,
                reason: input.reason,
                now: yield* Clock.currentTimeMillis,
                attempt: "new",
              })
              return { recorded: true }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) }),
              ),
            ),
        }),
        contract_propose_revision: Tool.make({
          description:
            "Petition the issuer to revise the active contract goal or handoff brief. The current obligation remains authoritative until accepted.",
          input: Schema.Struct({
            goal: Schema.NonEmptyString,
            brief: Schema.String.pipe(Schema.optional),
            reason: Schema.NonEmptyString,
          }),
          output: Schema.Struct({ recorded: Schema.Boolean }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const binding = yield* bindings.forSession(context.sessionID)
              if (!binding) return yield* new ToolFailure({ message: "No Contract is bound to this Session" })
              const contract = yield* contracts.get(binding.contractID)
              if (!contract) return yield* new ToolFailure({ message: "Contract not found" })
              const receipt = yield* contracts.petitionRevision({
                contractID: contract.id,
                spec: { ...contract.spec, goal: input.goal, brief: input.brief ?? contract.spec.brief },
                reason: input.reason,
              })
              if (receipt.decision.type === "rejected")
                return yield* new ToolFailure({ message: receipt.decision.reason })
              return { recorded: true }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/contract-control",
  layer,
  deps: [
    ToolRegistry.node,
    PermissionV2.node,
    ProContract.node,
    ProContractOpenCode.node,
    SessionStore.node,
    Snapshot.node,
  ],
})
