export * as StrategyTools from "./strategy"

import { ToolFailure } from "@opencode-ai/llm"
import { Clock, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { ProContract } from "../pro-contract"
import { ProContractOpenCode } from "../pro-contract/open-code"
import { ProContractStrategy } from "../pro-contract/strategy"
import { Snapshot } from "../snapshot"
import { BashTool } from "./bash"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const Output = Schema.Struct({ state: ProContractStrategy.State, guidance: Schema.String })
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const registry = yield* ToolRegistry.Service
    const agents = yield* AgentV2.Service
    const bindings = yield* ProContractOpenCode.Service
    const contracts = yield* ProContract.Service
    const strategies = yield* ProContractStrategy.Service
    const snapshots = yield* Snapshot.Service
    const active = Effect.fnUntraced(function* (context: Tool.Context) {
      const binding = yield* bindings.forSession(context.sessionID)
      const contract = binding ? yield* contracts.get(binding.contractID) : undefined
      if (
        !binding ||
        !contract ||
        contract.status !== "active" ||
        binding.revision !== contract.revision ||
        !binding.dispatched ||
        binding.leaseOwner !== bindings.owner ||
        (binding.leaseExpiresAt ?? 0) <= (yield* Clock.currentTimeMillis)
      )
        return yield* new ToolFailure({ message: "An active bound Contract is required" })
      const deadline = contract.spec.budget.deadline
      if (deadline === undefined || !Number.isFinite(deadline) || deadline <= (yield* Clock.currentTimeMillis))
        return yield* new ToolFailure({ message: "Strategy execution requires a live original Contract deadline" })
      return { ...contract, executionDeadline: deadline }
    })
    const load = Effect.fnUntraced(function* (context: Tool.Context) {
      const contract = yield* active(context)
      const state = yield* strategies.read(context.sessionID)
      if (!state || state.specHash !== contract.specHash)
        return yield* new ToolFailure({
          message: "Call strategy_plan with public task requirements before verification or submission",
        })
      return { contract, state }
    })
    yield* tools
      .register({
        strategy_plan: Tool.make({
          description:
            "Install a durable execution plan, separate from the immutable Contract. Quote the task's public requirements and provide meaningful, bounded, non-mutating check commands. Cover semantics and real-consumer roundtrips, not just file existence. The plan cannot be replaced to erase a failing criterion. General dependencies may be installed; never use hidden tests or benchmark solutions.",
          input: Schema.Struct({
            criteria: Schema.NonEmptyArray(ProContractStrategy.Criterion),
            reason: Schema.optional(Schema.NonEmptyString),
          }),
          output: Output,
          execute: (input, context) =>
            strategies.exclusive(
              context.sessionID,
              Effect.gen(function* () {
                const contract = yield* active(context)
                const previous = yield* strategies.read(context.sessionID)
                if (previous && previous.specHash !== contract.specHash)
                  return yield* new ToolFailure({ message: "The strategy belongs to different Contract terms" })
                const state = yield* Effect.try({
                  try: () =>
                    previous
                      ? ProContractStrategy.revise(
                          previous,
                          contract.spec.goal,
                          [...input.criteria],
                          input.reason ?? "",
                        )
                      : ProContractStrategy.plan(contract.specHash, contract.spec.goal, [...input.criteria]),
                  catch: (error) => new ToolFailure({ message: String(error) }),
                })
                yield* strategies.write(context.sessionID, state)
                return { state, guidance: ProContractStrategy.guidance(state) }
              }),
            ),
        }),
        strategy_status: Tool.make({
          description:
            "Recover the durable strategy plan, real check outcomes, and selected next strategy after compaction or a failure. This does not modify the Contract or claim completion.",
          input: Schema.Struct({}),
          output: Output,
          execute: (_input, context) =>
            Effect.gen(function* () {
              const loaded = yield* load(context)
              return { state: loaded.state, guidance: ProContractStrategy.guidance(loaded.state) }
            }),
        }),
        strategy_verify: Tool.withSubactions(
          Tool.make({
            description:
              "Execute all public plan checks through the normal Bash tool, with its existing permissions, resource isolation, output capture and shared budget accounting. Failed checks route to another strategy without a new attempt. Candidate changes during verification invalidate the batch. A passing batch only permits submission to the independent final evaluator; it does not settle the Contract.",
            input: Schema.Struct({}),
            output: Output,
            execute: (_input, context) =>
              strategies.exclusive(
                context.sessionID,
                Effect.gen(function* () {
                  const loaded = yield* load(context)
                  if (!loaded.contract.spec.authority.includes("process.execute"))
                    return yield* new ToolFailure({
                      message: "Public checks require approved process.execute authority",
                    })
                  yield* strategies.write(context.sessionID, { ...loaded.state, ready: false })
                  const agent = yield* agents.get(context.agent)
                  const catalog = yield* registry.materialize(agent?.permissions ?? [])
                  if (!catalog.definitions.some((definition) => definition.name === "bash"))
                    return yield* new ToolFailure({ message: "Bash is unavailable under the current policy" })
                  const before = yield* snapshots.capture()
                  if (!before) return yield* new ToolFailure({ message: "Candidate snapshot unavailable" })
                  const checks = yield* Effect.forEach(loaded.state.criteria, (criterion) =>
                    Effect.gen(function* () {
                      const remaining = loaded.contract.executionDeadline - (yield* Clock.currentTimeMillis)
                      if (remaining <= 0)
                        return yield* new ToolFailure({ message: "Original Contract deadline exhausted" })
                      const settled = yield* catalog
                        .settle({
                          sessionID: context.sessionID,
                          agent: context.agent,
                          assistantMessageID: context.assistantMessageID,
                          call: {
                            type: "tool-call",
                            id: `${context.toolCallID}:${criterion.id}`,
                            name: "bash",
                            input: { command: criterion.command, timeout: Math.min(criterion.timeout, remaining) },
                          },
                        })
                        .pipe(
                          Effect.timeoutOrElse({
                            duration: remaining,
                            orElse: () =>
                              Effect.fail(
                                new ToolFailure({
                                  message: "Original Contract deadline exhausted during public verification",
                                }),
                              ),
                          }),
                          Effect.mapError((error) =>
                            error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) }),
                          ),
                        )
                      const passed =
                        settled.result.type !== "error" &&
                        Schema.is(Schema.Struct({ exit: Schema.Literal(0), truncated: Schema.Literal(false) }))(
                          settled.output?.structured,
                        )
                      const observation =
                        settled.output?.content
                          .filter((item) => item.type === "text")
                          .map((item) => item.text)
                          .join("\n") ?? String(settled.result.value)
                      return { criterion: criterion.id, passed, observation: observation.slice(0, 8_000) }
                    }),
                  )
                  const after = yield* snapshots.capture()
                  if (!after) return yield* new ToolFailure({ message: "Candidate snapshot unavailable" })
                  const state = ProContractStrategy.conclude(loaded.state, checks, before, after)
                  yield* strategies.write(context.sessionID, state)
                  return { state, guidance: ProContractStrategy.guidance(state) }
                }),
              ),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

const dependencies = [
  ToolRegistry.node,
  ProContract.node,
  ProContractOpenCode.node,
  ProContractStrategy.node,
  Snapshot.node,
  AgentV2.node,
  BashTool.node,
] as const
export const node = makeLocationNode({ name: "tool/strategy", layer, deps: dependencies })
export const configuredNode = makeLocationNode({
  name: "tool/strategy/configured",
  layer: Layer.suspend(() => (process.env.OPENCODE_STRATEGY_PORTFOLIO === "1" ? layer : Layer.empty)),
  deps: dependencies,
})
