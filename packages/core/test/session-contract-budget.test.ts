import { expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { AgentV2 } from "../src/agent"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { LayerNode } from "../src/effect/layer-node"
import { Location } from "../src/location"
import { ModelV2 } from "../src/model"
import { ProContract } from "../src/pro-contract"
import { ProContractOpenCode } from "../src/pro-contract/open-code"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { ProviderV2 } from "../src/provider"
import { ReferenceGuidance } from "../src/reference/guidance"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { Prompt } from "../src/session/prompt"
import { SessionProjector } from "../src/session/projector"
import { SessionRunner } from "../src/session/runner"
import { node } from "../src/session/runner/llm"
import { SessionRunnerModel } from "../src/session/runner/model"
import { SkillGuidance } from "../src/skill/guidance"
import { Snapshot } from "../src/snapshot"
import { SystemContext } from "../src/system-context"
import { ToolRegistry } from "../src/tool/registry"
import { Tool } from "../src/tool/tool"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { adjust } from "effect/testing/TestClock"
import { it } from "./lib/effect"

const location = { directory: AbsolutePath.make("/project") }
const model = ModelV2.Ref.make({ id: ModelV2.ID.make("catalog-alias"), providerID: ProviderV2.ID.make("fake") })
const contractID = ProContract.ID.make("pct_runner_budget")

const layer = (stream: LLMClientShape["stream"]) =>
  AppNodeBuilder.build(
    LayerNode.group([
      node,
      Database.node,
      AgentV2.node,
      ToolRegistry.node,
      ProContract.node,
      ProContractOpenCode.node,
      SessionV2.node,
      SessionProjector.node,
    ]),
    [
      [Location.node, Location.boundNode(location)],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, SessionExecution.noopLayer],
      [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
      [
        SkillGuidance.node,
        Layer.succeed(
          SkillGuidance.Service,
          SkillGuidance.Service.of({ load: () => Effect.succeed(SystemContext.empty) }),
        ),
      ],
      [
        ReferenceGuidance.node,
        Layer.succeed(
          ReferenceGuidance.Service,
          ReferenceGuidance.Service.of({ load: () => Effect.succeed(SystemContext.empty) }),
        ),
      ],
      [
        SessionRunnerModel.node,
        // A catalog alias may legitimately resolve to a different wire model ID.
        SessionRunnerModel.layerWith(() => Effect.succeed(Model.make({ id: "wire-model", provider: "fake", route }))),
      ],
      [
        LayerNodePlatform.llmClient,
        Layer.succeed(
          LLMClient.Service,
          LLMClient.Service.of({
            prepare: () => Effect.die("unused"),
            generate: () => Effect.die("unused"),
            stream,
          }),
        ),
      ],
    ],
  )

const setup = (budget: ProContract.Spec["budget"]) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const contracts = yield* ProContract.Service
    const bindings = yield* ProContractOpenCode.Service
    const sessions = yield* SessionV2.Service
    const now = yield* Clock.currentTimeMillis
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* bindings.issue({
      id: contractID,
      scope: "runner-budget",
      spec: { ...ProContract.defaultSpec("Complete the work", now), budget },
      location,
      model,
      now,
    })
    yield* contracts.activate(contractID, 1, now)
    const binding = yield* bindings.claim(contractID, now)
    if (!binding) return yield* Effect.die("Expected an active execution binding")
    yield* sessions.create({ id: binding.sessionID, location, model })
    yield* sessions.prompt({
      id: binding.promptID,
      sessionID: binding.sessionID,
      prompt: Prompt.make({ text: "Complete the work" }),
      resume: false,
    })
    return binding
  })

const toolCall = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: "read-1", name: "read", input: {} }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]
const completed = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

it.effect("deadline-only execution keeps tools beyond generic agent steps and permits catalog aliases", () => {
  const requests: LLMRequest[] = []
  return Effect.gen(function* () {
    const binding = yield* setup({ deadline: 60_000 })
    const agents = yield* AgentV2.Service
    const registry = yield* ToolRegistry.Service
    const runner = yield* SessionRunner.Service
    const bindings = yield* ProContractOpenCode.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.defaultID, (agent) => {
        agent.steps = 1
      }),
    )
    yield* registry.register({
      read: Tool.make({
        description: "Read",
        input: Schema.Struct({}),
        output: Schema.String,
        execute: () => Effect.succeed("done"),
      }),
    })
    yield* runner.run({ sessionID: binding.sessionID, force: true })
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.tools.map((tool) => tool.name))).toEqual([["read"], ["read"]])
    expect(requests.map((request) => request.toolChoice)).toEqual([undefined, undefined])
    expect(String(requests[0]?.model.id)).toBe("wire-model")
    expect(yield* bindings.get(contractID)).toMatchObject({ turnsUsed: 2, actionsUsed: 1 })
  }).pipe(
    Effect.provide(
      layer((request) => {
        requests.push(request)
        return Stream.fromIterable(requests.length === 1 ? toolCall : completed)
      }),
    ),
  )
})

it.effect("the original deadline interrupts unfinished tools after the provider has completed", () => {
  const requests: LLMRequest[] = []
  return Effect.gen(function* () {
    const binding = yield* setup({ deadline: 1_000 })
    const started = yield* Deferred.make<void>()
    const registry = yield* ToolRegistry.Service
    const runner = yield* SessionRunner.Service
    const sessions = yield* SessionV2.Service
    const bindings = yield* ProContractOpenCode.Service
    yield* registry.register({
      read: Tool.make({
        description: "Read that never settles",
        input: Schema.Struct({}),
        output: Schema.String,
        execute: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      }),
    })
    const running = yield* runner.run({ sessionID: binding.sessionID, force: true }).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* adjust("999 millis")
    expect(running.pollUnsafe()).toBeUndefined()
    yield* adjust("1 millis")
    const result = yield* Fiber.await(running)
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
    expect(requests).toHaveLength(1)
    expect(yield* bindings.get(contractID)).toMatchObject({ turnsUsed: 1, actionsUsed: 1 })
    expect(yield* sessions.messages({ sessionID: binding.sessionID })).toContainEqual(
      expect.objectContaining({
        type: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "tool", state: expect.objectContaining({ status: "error" }) }),
        ]),
      }),
    )
  }).pipe(
    Effect.provide(
      layer((request) => {
        requests.push(request)
        return Stream.fromIterable(toolCall)
      }),
    ),
  )
})

it.effect("the original deadline bounds an unfinished provider turn", () => {
  const requests: LLMRequest[] = []
  return Effect.gen(function* () {
    const binding = yield* setup({ deadline: 1_000 })
    const runner = yield* SessionRunner.Service
    const running = yield* runner.run({ sessionID: binding.sessionID, force: true }).pipe(Effect.forkChild)
    yield* adjust("1 second")
    const result = yield* Fiber.await(running)
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
    expect(requests).toHaveLength(1)
  }).pipe(
    Effect.provide(
      layer((request) => {
        requests.push(request)
        return Stream.concat(Stream.fromIterable([LLMEvent.stepStart({ index: 0 })]), Stream.fromEffect(Effect.never))
      }),
    ),
  )
})

for (const changed of [
  { ...model, id: ModelV2.ID.make("replacement") },
  { ...model, providerID: ProviderV2.ID.make("replacement") },
  { ...model, variant: ModelV2.VariantID.make("replacement") },
]) {
  it.effect(`a generic model switch cannot change the bound execution: ${JSON.stringify(changed)}`, () => {
    const requests: LLMRequest[] = []
    return Effect.gen(function* () {
      const binding = yield* setup({ deadline: 60_000 })
      const sessions = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      yield* sessions.switchModel({ sessionID: binding.sessionID, model: changed })
      yield* runner.run({ sessionID: binding.sessionID, force: true })
      expect(requests).toHaveLength(0)
      expect(yield* bindings.get(contractID)).toMatchObject({ model, turnsUsed: 0, actionsUsed: 0 })
      expect(yield* contracts.get(contractID)).toMatchObject({
        status: "escalated",
        escalation: { reason: "OpenCode execution model does not match its binding" },
      })
    }).pipe(
      Effect.provide(
        layer((request) => {
          requests.push(request)
          return Stream.fromIterable(completed)
        }),
      ),
    )
  })
}
