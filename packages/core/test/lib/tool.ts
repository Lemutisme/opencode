import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { Effect, Option } from "effect"

export const toolIdentity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_tool_test"),
}

export const toolDefinitions = (
  registry: ToolRegistry.Interface,
  permissions?: Parameters<typeof registry.materialize>[0],
) => registry.materialize(permissions).pipe(Effect.map((materialized) => materialized.definitions))

export const settleTool = (registry: ToolRegistry.Interface, input: ToolRegistry.ExecuteInput) =>
  Effect.gen(function* () {
    // This helper simulates a new provider admission. Stale/missing-context tests settle directly.
    const bindings = yield* Effect.serviceOption(ProContractOpenCode.Service)
    const binding = Option.isSome(bindings) ? yield* bindings.value.forSession(input.sessionID) : undefined
    const materialized = yield* registry.materialize()
    return yield* materialized.settle({
      ...input,
      contractExecution: input.contractExecution ?? (binding ? ProContractOpenCode.execution(binding) : undefined),
    })
  })

export const executeTool = (registry: ToolRegistry.Interface, input: ToolRegistry.ExecuteInput) =>
  settleTool(registry, input).pipe(Effect.map((settlement) => settlement.result))
