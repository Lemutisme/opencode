import { expect } from "bun:test"
import { LLMClient, LLMError, LLMEvent, Model, type LLMRequest } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Clock, Deferred, Effect, Fiber, Layer, Scope, Stream } from "effect"
import { Config } from "../src/config"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { LayerNode } from "../src/effect/layer-node"
import { Location } from "../src/location"
import { ModelV2 } from "../src/model"
import { ProContract } from "../src/pro-contract"
import { ProContractOpenCode } from "../src/pro-contract/open-code"
import { ProContractReason } from "../src/pro-contract/reason"
import { ProContractScheduler } from "../src/pro-contract/scheduler"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionExecutionLocal } from "../src/session/execution/local"
import { SessionRunnerModel } from "../src/session/runner/model"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const ambient = "PRIVATE_AMBIENT_REASONING_SENTINEL"
const answer = "Try a discriminating test before another repair. This is an unverified suggestion."

function fixture<A, E>(
  run: (
    input: ProContractReason.Input,
    requests: LLMRequest[],
  ) => Effect.Effect<
    A,
    E,
    | ProContractReason.Service
    | ProContract.Service
    | ProContractOpenCode.Service
    | ProContractScheduler.Service
    | SessionV2.Service
    | SessionExecution.Service
    | Scope.Scope
  >,
  stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError> = () =>
    Stream.fromArray([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.textStart({ id: "answer" }),
      LLMEvent.textDelta({ id: "answer", text: answer }),
      LLMEvent.textEnd({ id: "answer" }),
      LLMEvent.stepFinish({ index: 0, reason: "stop" }),
      LLMEvent.finish({ reason: "stop" }),
    ]),
  duration = 15_000,
) {
  return Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    yield* Effect.promise(() => Bun.write(path.join(directory.path, "AGENTS.md"), ambient))
    yield* Effect.promise(() => mkdir(path.join(directory.path, "private"), { mode: 0o700 }))
    const requests: LLMRequest[] = []
    return yield* Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const now = yield* Clock.currentTimeMillis
      const id = ProContract.ID.create()
      const spec = {
        ...ProContract.defaultSpec("Authorize this frozen executable research method", now),
        budget: { deadline: now + duration },
      }
      yield* contracts.issue({ id, scope: "reason-fixture", spec, executor: "reviewer" })
      yield* contracts.activate(id, 1, now)
      yield* contracts.reportReady({
        contractID: id,
        revision: 1,
        summary: "Independent permission to run the frozen method, not an improvement claim",
        uncertainties: [],
        subjectHash: "frozen-research-method",
        time: now,
      })
      const approved = yield* contracts.principalAttest({
        contractID: id,
        revision: 1,
        specHash: ProContract.hashSpec(spec),
        subjectHash: "frozen-research-method",
        evidenceHash: "independent-method-authorization",
      })
      const attestationID = approved.state.contracts[id]?.attestationID
      if (!attestationID) return yield* Effect.die("Authorization fixture did not settle")
      return yield* run(
        {
          id: ProContract.ID.create(),
          scope: "reason-fixture",
          model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("reason") }),
          authorization: {
            contractID: id,
            revision: 1,
            specHash: ProContract.hashSpec(spec),
            subjectHash: "frozen-research-method",
            attestationID,
          },
          prompt: "How should a researcher distinguish stalled repair from useful continued exploration?",
          deadline: now + duration,
          location: Location.Ref.make({ directory: AbsolutePath.make(path.join(directory.path, "private")) }),
          executionPolicy: "Use the current task and allowed experience only. Propose, never authorize.",
        },
        requests,
      )
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            ProContractReason.node,
            ProContract.node,
            ProContractOpenCode.node,
            ProContractScheduler.node,
            SessionV2.node,
            SessionExecution.node,
          ]),
          [
            [SessionExecution.node, SessionExecutionLocal.node],
            [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
            [
              SessionRunnerModel.node,
              SessionRunnerModel.layerWith(() =>
                Effect.succeed(Model.make({ id: "reason", provider: "fixture", route })),
              ),
            ],
            [
              LayerNodePlatform.llmClient,
              Layer.succeed(
                LLMClient.Service,
                LLMClient.Service.of({
                  prepare: () => Effect.die("This fixture cannot call an external provider"),
                  generate: () => Effect.die("This fixture cannot call an external provider"),
                  stream: (request) => {
                    requests.push(request)
                    return stream(request)
                  },
                }),
              ),
            ],
          ],
        ),
      ),
    )
  })
}

it.live("native reasoning returns durable unverified text, not acceptance, and reconciles exact retries", () =>
  fixture((input, requests) =>
    Effect.gen(function* () {
      const reason = yield* ProContractReason.Service
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const sessions = yield* SessionV2.Service
      const observed = yield* reason.run(input)
      expect(observed).toMatchObject({ status: "unverified", summary: answer, usage: { turns: 1, actions: 0 } })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools ?? []).toEqual([])
      expect(requests[0]?.toolChoice?.type).toBe("none")
      expect(JSON.stringify(requests[0])).not.toContain(ambient)
      expect(JSON.stringify(requests[0])).toContain(input.executionPolicy)
      expect(JSON.stringify(requests[0])).toContain(input.prompt)
      expect(yield* contracts.get(input.id)).toMatchObject({
        status: "released",
        spec: { authority: [], requires: [], budget: { deadline: input.deadline } },
      })
      expect((yield* contracts.get(input.id))?.attestationID).toBeUndefined()
      expect((yield* contracts.get(input.id))?.spec.budget.turns).toBeUndefined()
      expect((yield* contracts.get(input.id))?.spec.budget.actions).toBeUndefined()
      expect(yield* bindings.get(input.id)).toMatchObject({ mode: "reason", turnsUsed: 1, actionsUsed: 0 })
      expect(
        (yield* sessions.messages({ sessionID: observed.sessionID })).some((message) => message.type === "assistant"),
      ).toBe(true)
      expect(yield* reason.run(input)).toEqual(observed)
      expect(yield* reason.run({ ...input, prompt: "Conflicting retry" }).pipe(Effect.flip)).toBeInstanceOf(
        ProContractReason.Unavailable,
      )
      expect(yield* reason.run({ ...input, deadline: input.deadline + 10_000 }).pipe(Effect.flip)).toBeInstanceOf(
        ProContractReason.Unavailable,
      )
      yield* contracts.challenge({
        contractID: input.authorization.contractID,
        revision: input.authorization.revision,
        subjectHash: input.authorization.subjectHash,
        evidenceHash: "Withdraw method execution, not past observations",
        disclosure: "sealed",
        time: yield* Clock.currentTimeMillis,
      })
      expect(yield* reason.run(input)).toEqual(observed)
      expect(requests).toHaveLength(1)
    }),
  ),
)

it.live("native reasoning exact concurrent retry and scheduler cannot replay a claimed request", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    return yield* fixture(
      (input, requests) =>
        Effect.gen(function* () {
          const reason = yield* ProContractReason.Service
          const bindings = yield* ProContractOpenCode.Service
          const scheduler = yield* ProContractScheduler.Service
          const execution = yield* SessionExecution.Service
          const running = yield* reason.run(input).pipe(Effect.forkScoped)
          yield* Deferred.await(started)
          expect(yield* reason.run(input).pipe(Effect.flip)).toBeInstanceOf(ProContractReason.Unavailable)
          expect(yield* bindings.due(input.deadline - 1)).toEqual([])
          yield* scheduler.runOnce()
          expect(requests).toHaveLength(1)
          yield* Deferred.succeed(finish, undefined)
          const result = yield* Fiber.join(running)
          yield* execution.resume(result.sessionID)
          expect(requests).toHaveLength(1)
          expect((yield* execution.active).size).toBe(0)
        }),
      () =>
        Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish)))).pipe(
          Stream.flatMap(() =>
            Stream.fromArray([
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.textStart({ id: "answer" }),
              LLMEvent.textDelta({ id: "answer", text: answer }),
              LLMEvent.textEnd({ id: "answer" }),
              LLMEvent.stepFinish({ index: 0, reason: "stop" }),
              LLMEvent.finish({ reason: "stop" }),
            ]),
          ),
        ),
    )
  }),
)

it.live("native reasoning cancellation stops coordinator-owned provider work and forbids replay", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    return yield* fixture(
      (input, requests) =>
        Effect.gen(function* () {
          const reason = yield* ProContractReason.Service
          const execution = yield* SessionExecution.Service
          const contracts = yield* ProContract.Service
          const scheduler = yield* ProContractScheduler.Service
          const running = yield* reason.run(input).pipe(Effect.forkScoped)
          yield* Deferred.await(started)
          yield* Fiber.interrupt(running)
          yield* Deferred.await(stopped)
          expect((yield* execution.active).size).toBe(0)
          expect((yield* contracts.get(input.id))?.status).toBe("escalated")
          expect(yield* reason.run(input).pipe(Effect.flip)).toBeInstanceOf(ProContractReason.Unavailable)
          yield* scheduler.runOnce()
          expect(requests).toHaveLength(1)
        }),
      () =>
        Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))).pipe(
          Stream.ensuring(Deferred.succeed(stopped, undefined)),
        ),
    )
  }),
)

it.live("native reasoning original deadline interrupts a stalled provider without resetting usage", () =>
  fixture(
    (input, requests) =>
      Effect.gen(function* () {
        const reason = yield* ProContractReason.Service
        const execution = yield* SessionExecution.Service
        const bindings = yield* ProContractOpenCode.Service
        expect(yield* reason.run(input).pipe(Effect.flip)).toBeInstanceOf(ProContractReason.Unavailable)
        expect((yield* execution.active).size).toBe(0)
        expect(yield* bindings.get(input.id)).toMatchObject({ turnsUsed: 1, actionsUsed: 0 })
        expect(yield* reason.run({ ...input, deadline: Date.now() + 60_000 }).pipe(Effect.flip)).toBeInstanceOf(
          ProContractReason.Unavailable,
        )
        expect(requests).toHaveLength(1)
      }),
    () => Stream.fromEffect(Effect.never),
    750,
  ),
)

it.live("native reasoning rejects unsolicited tools without execution or another provider attempt", () =>
  fixture(
    (input, requests) =>
      Effect.gen(function* () {
        const reason = yield* ProContractReason.Service
        const bindings = yield* ProContractOpenCode.Service
        const contracts = yield* ProContract.Service
        expect(yield* reason.run(input).pipe(Effect.flip)).toBeInstanceOf(ProContractReason.Unavailable)
        expect(requests).toHaveLength(1)
        expect(yield* bindings.get(input.id)).toMatchObject({ turnsUsed: 1, actionsUsed: 0 })
        expect((yield* contracts.get(input.id))?.attestationID).toBeUndefined()
      }),
    () =>
      Stream.fromArray([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "escape", name: "bash", input: { command: "touch /tmp/reason-escape" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]),
  ),
)

it.live("native reasoning rejects provider-executed tools as ungranted observations", () =>
  fixture(
    (input, requests) =>
      Effect.gen(function* () {
        const reason = yield* ProContractReason.Service
        const bindings = yield* ProContractOpenCode.Service
        expect(yield* reason.run(input).pipe(Effect.flip)).toBeInstanceOf(ProContractReason.Unavailable)
        expect(requests).toHaveLength(1)
        expect(yield* bindings.get(input.id)).toMatchObject({ turnsUsed: 1, actionsUsed: 0 })
      }),
    () =>
      Stream.fromArray([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "remote-escape", name: "web_search", input: {}, providerExecuted: true }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]),
  ),
)

it.live("native reasoning overflow cannot trigger ambient compaction or another provider attempt", () =>
  fixture(
    (input, requests) =>
      Effect.gen(function* () {
        const reason = yield* ProContractReason.Service
        const bindings = yield* ProContractOpenCode.Service
        expect(yield* reason.run(input).pipe(Effect.flip)).toBeInstanceOf(ProContractReason.Unavailable)
        expect(requests).toHaveLength(1)
        expect(yield* bindings.get(input.id)).toMatchObject({ turnsUsed: 1, actionsUsed: 0 })
      }),
    () =>
      Stream.fromArray([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]),
  ),
)

it.live("withdrawing native reasoning authorization interrupts the provider without accepting its response", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    return yield* fixture(
      (input, requests) =>
        Effect.gen(function* () {
          const reason = yield* ProContractReason.Service
          const execution = yield* SessionExecution.Service
          const contracts = yield* ProContract.Service
          const running = yield* reason.run(input).pipe(Effect.exit, Effect.forkScoped)
          yield* Deferred.await(started)
          yield* contracts.challenge({
            contractID: input.authorization.contractID,
            revision: input.authorization.revision,
            subjectHash: input.authorization.subjectHash,
            evidenceHash: "Method permission withdrawn during request",
            disclosure: "sealed",
            time: yield* Clock.currentTimeMillis,
          })
          expect((yield* Fiber.join(running))._tag).toBe("Failure")
          yield* Deferred.await(stopped)
          expect((yield* execution.active).size).toBe(0)
          expect((yield* contracts.get(input.id))?.status).toBe("escalated")
          expect(requests).toHaveLength(1)
        }),
      () =>
        Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))).pipe(
          Stream.ensuring(Deferred.succeed(stopped, undefined)),
        ),
    )
  }),
)
