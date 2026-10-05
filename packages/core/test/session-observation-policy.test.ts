import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { Effect, Layer, Stream, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionObservationPack } from "@opencode-ai/core/session/observation-pack"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { node } from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { SessionObservationTools } from "@opencode-ai/core/tool/observation"
import { Tool } from "@opencode-ai/core/tool/tool"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("ObservationPack promotion policy", () => {
  ;[
    { setting: undefined, contract: true, enabled: true, name: "defaults on for Contracts" },
    { setting: undefined, contract: false, enabled: false, name: "leaves ordinary Sessions unchanged" },
    {
      setting: "0",
      contract: true,
      enabled: false,
      name: "rolls back Contract packing even with explicit registration",
    },
    { setting: "1", contract: false, enabled: true, name: "preserves explicit opt-in for ordinary Sessions" },
    { setting: "invalid", contract: true, enabled: false, name: "does not enable an unrecognized host setting" },
  ].forEach((scenario) => {
    it.live(scenario.name, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          const requests: LLMRequest[] = []
          const text = "persisted observation\n".repeat(1000)
          const responses = [text, "continue", "continue"].map((text, index) => [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({ id: `call-${index}`, name: "read", input: { text } }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ])
          const client = Layer.succeed(
            LLMClient.Service,
            LLMClient.Service.of({
              prepare: () => Effect.die("unused"),
              generate: () => Effect.die("unused"),
              stream: ((request: LLMRequest) => {
                requests.push(request)
                return Stream.fromIterable(responses.shift() ?? [])
              }) as unknown as LLMClientShape["stream"],
            }),
          )
          return Effect.gen(function* () {
            const db = (yield* Database.Service).db
            const location = yield* Location.Service
            const agents = yield* AgentV2.Service
            const applications = yield* ApplicationTools.Service
            const sessions = yield* SessionV2.Service
            const runner = yield* SessionRunner.Service
            const contracts = yield* ProContract.Service
            const bindings = yield* ProContractOpenCode.Service
            const ref = ModelV2.Ref.make({ id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") })
            yield* db
              .insert(ProjectTable)
              .values({ id: location.project.id, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)
            yield* agents.transform((draft) =>
              draft.update(AgentV2.defaultID, (agent) => {
                agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
              }),
            )
            yield* applications.register({
              read: Tool.make({
                description: "Produce a deterministic observation",
                input: Schema.Struct({ text: Schema.String }),
                output: Schema.String,
                execute: (input) => Effect.succeed(input.text),
                toModelOutput: ({ output }) => [{ type: "text", text: output }],
              }),
            })
            const binding = scenario.contract
              ? yield* Effect.gen(function* () {
                  const id = ProContract.ID.make("pct_observation_default")
                  const spec = ProContract.defaultSpec("Use the observed data", Date.now())
                  yield* contracts.issue({
                    id,
                    scope: "policy",
                    executor: "opencode",
                    spec: { ...spec, authority: ["filesystem.read"] },
                  })
                  yield* bindings.create({
                    contractID: id,
                    revision: 1,
                    location: { directory: AbsolutePath.make(tmp.path) },
                    model: ref,
                    nextActionAt: 0,
                  })
                  yield* contracts.activate(id, 1, Date.now())
                  return yield* bindings.claim(id, Date.now())
                })
              : undefined
            if (scenario.contract && !binding) return yield* Effect.die("Expected an active Contract")
            const session = yield* sessions.create({
              ...(binding ? { id: binding.sessionID } : {}),
              location: { directory: AbsolutePath.make(tmp.path) },
              model: ref,
            })
            yield* sessions.prompt({
              sessionID: session.id,
              prompt: Prompt.make({ text: "Read and continue" }),
              resume: false,
            })
            yield* runner.run({ sessionID: session.id, force: true })
            expect(requests).toHaveLength(4)
            expect(requests[0]?.tools.some((tool) => tool.name === SessionObservationPack.toolName)).toBe(
              scenario.enabled,
            )
            expect(JSON.stringify(requests[1]?.messages)).toContain(JSON.stringify(text).slice(1, -1))
            expect(JSON.stringify(requests[2]?.messages)).toContain(JSON.stringify(text).slice(1, -1))
            expect(JSON.stringify(requests[3]?.messages).includes("session-text-v1")).toBe(scenario.enabled)
            expect(JSON.stringify(yield* sessions.context(session.id))).toContain(JSON.stringify(text).slice(1, -1))
            if (binding) {
              expect(yield* bindings.get(binding.contractID)).toMatchObject({
                turnsUsed: 4,
                actionsUsed: 3,
                attempts: 1,
              })
              expect((yield* contracts.get(binding.contractID))?.status).toBe("active")
            }
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(
                LayerNode.group([
                  node,
                  SessionV2.node,
                  Database.node,
                  Location.node,
                  AgentV2.node,
                  ApplicationTools.node,
                  ProContract.node,
                  ProContractOpenCode.node,
                  scenario.setting === "0" ? SessionObservationTools.node : SessionObservationTools.configuredNode,
                ]),
                [
                  [Global.node, Global.layerWith({ data: tmp.path })],
                  [Location.node, Location.boundNode({ directory: AbsolutePath.make(tmp.path) })],
                  [Snapshot.node, Snapshot.noopLayer],
                  [SessionExecution.node, SessionExecution.noopLayer],
                  [LayerNodePlatform.llmClient, client],
                  [SessionObservationPack.policyNode, SessionObservationPack.policyLayer(scenario.setting)],
                  [
                    SessionRunnerModel.node,
                    SessionRunnerModel.layerWith(() =>
                      Effect.succeed(Model.make({ id: "test", provider: "test", route: OpenAIChat.route })),
                    ),
                  ],
                ],
              ),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  })
})
