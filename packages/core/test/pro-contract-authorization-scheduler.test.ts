import { expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProContractScheduler } from "@opencode-ai/core/pro-contract/scheduler"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Clock, Deferred, Effect, Layer, Stream } from "effect"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

it.live(
  "scheduler revocation interrupts the actual local Session provider and fences further work",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const requests: LLMRequest[] = []
      const location = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
      const model = ModelV2.Ref.make({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test") })

      yield* Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const scheduler = yield* ProContractScheduler.Service
        const sessions = yield* SessionV2.Service
        const execution = yield* SessionExecution.Service
        const now = yield* Clock.currentTimeMillis
        const grantID = ProContract.ID.make("pct_scheduler_method_grant")
        const taskID = ProContract.ID.make("pct_scheduler_authorized_task")
        const spec = {
          ...ProContract.defaultSpec("Authorize the frozen execution method", now),
          budget: { deadline: now + 60_000 },
        }
        const issued = yield* contracts.issue({
          id: grantID,
          scope: "scheduler-authorization",
          spec,
          executor: "reviewer",
        })
        expect(issued.decision).toEqual({ type: "accepted" })
        expect((yield* contracts.activate(grantID, 1, now)).decision).toEqual({ type: "accepted" })
        expect(
          (yield* contracts.reportReady({
            contractID: grantID,
            revision: 1,
            summary: "Method evaluated independently",
            uncertainties: [],
            subjectHash: "frozen-method",
            time: now,
          })).decision,
        ).toEqual({ type: "accepted" })
        const accepted = yield* contracts.principalAttest({
          contractID: grantID,
          revision: 1,
          specHash: ProContract.hashSpec(spec),
          subjectHash: "frozen-method",
          evidenceHash: "independent-method-evidence",
        })
        expect(accepted.decision).toEqual({ type: "accepted" })
        const attestationID = accepted.state.contracts[grantID]?.attestationID
        if (!attestationID) return yield* Effect.die("Method authorization was not accepted")
        const admitted = yield* bindings.issue({
          id: taskID,
          scope: "scheduler-authorization",
          spec: { ...ProContract.defaultSpec("Finish the ordinary task", now), budget: spec.budget },
          location,
          model,
          executionPolicy: "Use the independently authorized method",
          authorization: {
            contractID: grantID,
            revision: 1,
            specHash: ProContract.hashSpec(spec),
            subjectHash: "frozen-method",
            attestationID,
          },
          now,
        })
        expect(admitted.decision).toEqual({ type: "accepted" })
        const binding = admitted.execution
        if (!binding) return yield* Effect.die("Task execution was not admitted")
        const manual = yield* bindings.issue({
          id: ProContract.ID.make("pct_scheduler_manual_observation"),
          scope: "scheduler-authorization",
          spec: { ...ProContract.defaultSpec("Produce a host-owned observation", now), budget: spec.budget },
          location,
          model,
          authorization: binding.authorization,
          mode: "reason",
          now,
        })
        expect(manual.decision).toEqual({ type: "accepted" })
        const expires = (yield* Clock.currentTimeMillis) + 100
        const expired = yield* Effect.forEach(["dormant", "active"] as const, (status) =>
          Effect.gen(function* () {
            const id = ProContract.ID.make(`pct_scheduler_expired_${status}`)
            const receipt = yield* bindings.issue({
              id,
              scope: "scheduler-authorization",
              spec: {
                ...ProContract.defaultSpec("Retire an abandoned native observation", now),
                budget: { deadline: expires },
              },
              location,
              model,
              authorization: binding.authorization,
              mode: "reason",
              now,
            })
            expect(receipt.decision).toEqual({ type: "accepted" })
            if (status === "active") {
              yield* contracts.activate(id, 1, now)
              expect(yield* bindings.claim(id, now)).toBeDefined()
            }
            return id
          }),
        )
        yield* Effect.sleep(Math.max(0, expires - (yield* Clock.currentTimeMillis) + 1))

        // Nothing in this ownership chain is substituted: scheduler -> SessionV2 ->
        // SessionExecutionLocal -> LocationServiceMap -> SessionRunner -> provider stream.
        yield* scheduler.runOnce()
        yield* Deferred.await(started)
        expect((yield* contracts.get(manual.contract!.id))?.status).toBe("dormant")
        expect((yield* bindings.get(manual.contract!.id))?.attempts).toBe(0)
        yield* Effect.forEach(expired, (id) =>
          Effect.gen(function* () {
            expect(yield* contracts.get(id)).toMatchObject({ status: "escalated" })
            expect((yield* contracts.get(id))?.escalation?.reason).toContain("deadline exhausted")
            expect(yield* bindings.get(id)).toMatchObject({ turnsUsed: 0, actionsUsed: 0 })
          }),
        )
        expect((yield* sessions.active).has(binding.sessionID)).toBe(true)
        expect((yield* execution.active).has(binding.sessionID)).toBe(true)
        expect(yield* bindings.get(taskID)).toMatchObject({ turnsUsed: 1, actionsUsed: 0 })
        expect(requests).toHaveLength(1)

        expect(
          (yield* contracts.challenge({
            contractID: grantID,
            revision: 1,
            subjectHash: "frozen-method",
            evidenceHash: "method-authorization-withdrawal",
            disclosure: "sealed",
            time: yield* Clock.currentTimeMillis,
          })).decision,
        ).toEqual({ type: "accepted" })
        yield* scheduler.runOnce()
        yield* Deferred.await(stopped)

        expect((yield* sessions.active).has(binding.sessionID)).toBe(false)
        expect((yield* execution.active).has(binding.sessionID)).toBe(false)
        expect(yield* contracts.get(taskID)).toMatchObject({
          status: "escalated",
          escalation: { reason: `OpenCode execution authorization withdrawn: ${grantID}` },
        })
        const rejected = yield* ToolRegistry.Service.use((registry) =>
          settleTool(registry, {
            ...toolIdentity,
            sessionID: binding.sessionID,
            call: { type: "tool-call", id: "after-revocation", name: "read", input: { filePath: "candidate.txt" } },
          }),
        ).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
        expect(rejected.result).toEqual({ type: "error", value: "Contract action budget exhausted" })
        expect(yield* bindings.reserveTurn(binding.sessionID, yield* Clock.currentTimeMillis)).toBe(false)
        expect(yield* bindings.current(binding.sessionID, yield* Clock.currentTimeMillis)).toBeUndefined()

        yield* scheduler.runOnce()
        // An explicit resume cannot use the still-persisted old lease to call the provider again.
        yield* execution.resume(binding.sessionID)
        expect(requests).toHaveLength(1)
        expect(yield* bindings.get(taskID)).toMatchObject({ turnsUsed: 1, actionsUsed: 0 })
        expect(yield* contracts.quiet("scheduler-authorization")).toMatchObject({
          quiet: false,
          outstanding: expect.arrayContaining([taskID]),
        })
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              ProContract.node,
              ProContractScheduler.node,
              ProContractOpenCode.node,
              SessionV2.node,
              SessionExecution.node,
              LocationServiceMap.node,
            ]),
            [
              [SessionExecution.node, SessionExecutionLocal.node],
              [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
              [
                SessionRunnerModel.node,
                SessionRunnerModel.layerWith(() => Effect.succeed(Model.make({ id: "test", provider: "test", route }))),
              ],
              [
                LayerNodePlatform.llmClient,
                Layer.succeed(
                  LLMClient.Service,
                  LLMClient.Service.of({
                    prepare: () => Effect.die("No network provider is used by this test"),
                    generate: () => Effect.die("No network provider is used by this test"),
                    stream: (request) => {
                      requests.push(request)
                      return Stream.concat(
                        Stream.fromEffect(
                          Deferred.succeed(started, undefined).pipe(Effect.as(LLMEvent.stepStart({ index: 0 }))),
                        ),
                        Stream.fromEffect(Effect.never),
                      ).pipe(Stream.ensuring(Deferred.succeed(stopped, undefined)))
                    },
                  }),
                ),
              ],
            ],
          ),
        ),
      )
    }).pipe(Effect.timeout("15 seconds")),
  20_000,
)
