import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractActivity } from "@opencode-ai/core/pro-contract/activity"
import { ProContractDriver } from "@opencode-ai/core/pro-contract/driver"
import { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { ExecutionPermit } from "@opencode-ai/core/session/execution-permit"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { testEffect } from "../../core/test/lib/effect"
import { make } from "../src/contract-jobs"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ProContract.node,
      ProContractOpenCode.node,
      ProContractJob.node,
      ProContractActivity.node,
      ExecutionPermit.node,
      SessionV2.node,
      LocationServiceMap.node,
    ]),
    [
      [SessionExecution.node, SessionExecution.noopLayer],
      [LocationServiceMap.node, buildLocationServiceMap()],
    ],
  ),
)

describe("Host controlled job orchestration", () => {
  for (const kind of ["review", "verify"] as const) {
    it.effect(`rejects a delayed ${kind} start after the original zero-work lease was recovered`, () =>
      Effect.gen(function* () {
        const bindings = yield* ProContractOpenCode.Service
        const jobs = yield* ProContractJob.Service
        const sessions = yield* SessionV2.Service
        const activity = yield* ProContractActivity.Service
        const issued = yield* bindings.issue({
          id: ProContract.ID.create(),
          scope: "host-race",
          now: 0,
          spec: {
            ...ProContract.defaultSpec("Review candidate", 0),
            budget: { deadline: 120_000 },
            authority: ["filesystem.read", "process.execute"],
          },
          location: { directory: AbsolutePath.make("/project") },
          model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test") },
        })
        const created = yield* jobs.create({
          id: crypto.randomUUID(),
          kind,
          contractID: issued.contract!.id,
          context: issued.contract!.recognition.context!.target,
          driver: ProContractDriver.native.identity,
          inputHash: "a".repeat(64),
          sessionID: SessionV2.ID.create(),
          promptID: SessionMessage.ID.create(),
          location: issued.execution!.location,
          model: issued.execution!.model,
          agent: AgentV2.ID.make("build"),
          prompt: { text: "Inspect fixed candidate" },
          verification:
            kind === "verify"
              ? { subjectHash: "b".repeat(64), policy: { checks: [], protected: [], artifacts: [] } }
              : undefined,
        })
        const committed = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        // Delay only the return of the real transactional start, before host execution begins.
        const host = yield* make.pipe(
          Effect.provideService(ProContractJob.Service, {
            ...jobs,
            start: (id) =>
              jobs.start(id).pipe(
                Effect.tap(() => Deferred.succeed(committed, undefined)),
                Effect.tap(() => Deferred.await(release)),
              ),
          }),
        )
        const start = yield* (
          kind === "review"
            ? host.start(created.input.id).pipe(Effect.asVoid)
            : host.verify(created.input.id).pipe(Effect.asVoid)
        ).pipe(Effect.forkChild)
        yield* Deferred.await(committed)
        expect(activity.has(created.input.contractID)).toBe(false)
        yield* TestClock.adjust("31 seconds")
        const recovered = yield* jobs.recover(created.input.id)
        yield* Deferred.succeed(release, undefined)
        expect((yield* Fiber.await(start))._tag).toBe("Failure")
        expect(yield* jobs.get(created.input.id)).toEqual(recovered)
        expect(yield* jobs.operations(created.input.contractID)).toHaveLength(0)
        expect((yield* sessions.get(created.input.sessionID).pipe(Effect.exit))._tag).toBe("Failure")
        expect(activity.has(created.input.contractID)).toBe(false)
      }),
    )
  }
})
