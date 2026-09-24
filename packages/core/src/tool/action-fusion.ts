export * as ActionFusionTool from "./action-fusion"

import { ToolFailure } from "@opencode-ai/llm"
import { Clock, Context, Duration, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { makeGlobalNode, makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ProContract } from "../pro-contract"
import { ProContractOpenCode } from "../pro-contract/open-code"
import { ApplyPatchTool } from "./apply-patch"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { WriteTool } from "./write"

export const name = "mutate_run"

export class Policy extends Context.Service<Policy, boolean>()("@opencode/ActionFusion.Policy") {}

export const policyLayer = (setting: string | undefined) => Layer.succeed(Policy, setting === "1")
export const policyNode = makeGlobalNode({
  service: Policy,
  layer: Layer.suspend(() => policyLayer(process.env.OPENCODE_ACTION_FUSION)),
  deps: [],
})

export const Input = Schema.Struct({
  mutation: Schema.Union([
    Schema.Struct({ tool: Schema.Literal("apply_patch"), input: ApplyPatchTool.Input }),
    Schema.Struct({ tool: Schema.Literal("edit"), input: EditTool.Input }),
    Schema.Struct({ tool: Schema.Literal("write"), input: WriteTool.Input }),
  ]),
  run: BashTool.Input,
})

const Stage = Schema.Struct({
  tool: Schema.String,
  callID: Schema.String,
  status: Schema.Literals(["completed", "failed", "unavailable", "skipped"]),
  result: Schema.Unknown,
  structured: Schema.optional(Schema.Unknown),
  outputPaths: Schema.Array(Schema.String),
})

export const Output = Schema.Struct({ mutation: Stage, run: Stage, settled: Schema.Literal(false) })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const registry = yield* ToolRegistry.Service
    const agents = yield* AgentV2.Service
    const permissions = yield* PermissionV2.Service
    const contracts = yield* ProContract.Service
    const bindings = yield* ProContractOpenCode.Service

    const deadline = Effect.fnUntraced(function* (context: Tool.Context) {
      const binding = yield* bindings.forSession(context.sessionID)
      const contract = binding ? yield* contracts.get(binding.contractID) : undefined
      const now = yield* Clock.currentTimeMillis
      if (
        !binding ||
        !contract ||
        contract.status !== "active" ||
        contract.pendingRevision ||
        binding.revision !== contract.revision ||
        !binding.dispatched ||
        binding.leaseOwner !== bindings.owner ||
        (binding.leaseExpiresAt ?? 0) <= now ||
        !contract.spec.authority.includes("filesystem.write") ||
        !contract.spec.authority.includes("process.execute")
      )
        return yield* new ToolFailure({ message: "No active mutation and process delegation for this Session" })
      if (contract.spec.budget.deadline <= now)
        return yield* new ToolFailure({ message: "Contract deadline exhausted" })
      return contract.spec.budget.deadline
    })

    yield* tools
      .register({
        [name]: Tool.withCapability(
          Tool.withSubactions(
            Tool.make({
              description:
                "Apply one patch/edit/write, then run an already-known shell command in the same interaction. Prefer this when creating a probe and running it, or changing code and compiling/testing it. The command runs only after a successful mutation. Each stage uses its original permissions, timeout, output retention and action charge; two executed stages consume two actions. Mutation failure skips the command; command failure keeps the changes. Multi-file patches apply sequentially and may partially fail. Command completion records process exit zero, not semantic test correctness. Results describe working-directory observations, not an isolated snapshot, atomic transaction or Contract settlement. Use separate tools when the command depends on inspecting the mutation result.",
              input: Input,
              output: Output,
              toModelOutput: ({ output }) => [
                {
                  type: "text",
                  text: `Mutation: ${output.mutation.status}\n${resultText(output.mutation.result)}\n\nCommand: ${output.run.status}\n${resultText(output.run.result)}\n\nChanges are retained. No Contract settlement was recorded.`,
                },
              ],
              execute: (input, context) =>
                Effect.gen(function* () {
                  yield* deadline(context)
                  yield* permissions
                    .assert({
                      action: name,
                      resources: [input.mutation.tool],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                    })
                    .pipe(Effect.mapError((error) => new ToolFailure({ message: String(error) })))
                  const agent = yield* agents.get(context.agent)
                  // Capture the existing canonical leaves once; never bypass their policies or re-resolve between stages.
                  const catalog = yield* registry.materialize(agent?.permissions ?? [])
                  if (
                    ![input.mutation.tool, "bash"].every((name) =>
                      catalog.definitions.some((tool) => tool.name === name),
                    )
                  )
                    return yield* new ToolFailure({
                      message: "Mutation or Bash tool is unavailable under the current policy",
                    })
                  const invoke = Effect.fnUntraced(function* (name: string, input: unknown, suffix: string) {
                    const remaining = (yield* deadline(context)) - (yield* Clock.currentTimeMillis)
                    const callID = `${context.toolCallID}:${suffix}`
                    const result = yield* catalog
                      .settle({
                        sessionID: context.sessionID,
                        agent: context.agent,
                        assistantMessageID: context.assistantMessageID,
                        contractExecution: context.contractExecution,
                        executionPermit: context.executionPermit,
                        call: { type: "tool-call", id: callID, name, input },
                      })
                      .pipe(
                        Effect.timeoutOrElse({
                          duration: Duration.millis(Math.max(0, remaining)),
                          orElse: () =>
                            Effect.succeed({
                              result: { type: "error" as const, value: "Contract deadline exhausted during stage" },
                            }),
                        }),
                      )
                    return stage(name, callID, result)
                  })
                  const mutation = yield* invoke(input.mutation.tool, input.mutation.input, "mutation")
                  if (mutation.status !== "completed")
                    return {
                      mutation,
                      run: {
                        tool: "bash",
                        callID: `${context.toolCallID}:run`,
                        status: "skipped" as const,
                        result: "The mutation did not complete successfully; the command was not run.",
                        outputPaths: [],
                      },
                      settled: false as const,
                    }
                  const run = yield* invoke("bash", input.run, "run").pipe(
                    Effect.catchTag("LLM.ToolFailure", (error) =>
                      Effect.succeed({
                        tool: "bash",
                        callID: `${context.toolCallID}:run`,
                        status: "skipped" as const,
                        result: error.message,
                        outputPaths: [],
                      }),
                    ),
                  )
                  return { mutation, run, settled: false as const }
                }).pipe(
                  Effect.mapError((error) =>
                    error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) }),
                  ),
                ),
            }),
          ),
          "compose",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

function stage(tool: string, callID: string, result: ToolRegistry.Settlement): typeof Stage.Type {
  const status =
    result.result.type === "error"
      ? "failed"
      : tool !== "bash"
        ? "completed"
        : Schema.is(Schema.Struct({ exit: Schema.Literal(0), timeout: Schema.optional(Schema.Literal(false)) }))(
              result.output?.structured,
            )
          ? "completed"
          : Schema.is(Schema.Struct({ exit: Schema.Number }))(result.output?.structured) ||
              Schema.is(Schema.Struct({ timeout: Schema.Literal(true) }))(result.output?.structured)
            ? "failed"
            : "unavailable"
  return {
    tool,
    callID,
    status,
    result: result.result,
    structured: result.output?.structured,
    outputPaths: result.outputPaths ?? [],
  }
}

function resultText(result: unknown) {
  if (Schema.is(Schema.Struct({ type: Schema.Literals(["text", "error"]), value: Schema.String }))(result))
    return result.value
  return typeof result === "string" ? result : JSON.stringify(result)
}

const dependencies = [
  ToolRegistry.node,
  AgentV2.node,
  PermissionV2.node,
  ProContract.node,
  ProContractOpenCode.node,
  ApplyPatchTool.node,
  EditTool.node,
  WriteTool.node,
  BashTool.node,
] as const

export const node = makeLocationNode({
  name: "tool/action-fusion",
  deps: dependencies,
  layer,
})

export const configuredNode = makeLocationNode({
  name: "tool/action-fusion-configured",
  deps: [...dependencies, policyNode],
  layer: Layer.unwrap(
    Effect.gen(function* () {
      const enabled = yield* Policy
      return enabled ? layer : Layer.empty
    }),
  ),
})
