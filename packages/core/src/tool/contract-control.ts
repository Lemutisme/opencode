export * as ContractControlTools from "./contract-control"

import { ToolFailure } from "@opencode-ai/llm"
import { Clock, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ProContract } from "../pro-contract"
import { ProContractOpenCode } from "../pro-contract/open-code"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const contracts = yield* ProContract.Service
    const bindings = yield* ProContractOpenCode.Service

    yield* tools
      .register({
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
              const receipt = yield* contracts.reportReady({
                contractID: binding.contractID,
                revision: binding.revision,
                summary: input.summary,
                uncertainties: input.uncertainties,
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
  deps: [ToolRegistry.node, ProContract.node, ProContractOpenCode.node],
})
