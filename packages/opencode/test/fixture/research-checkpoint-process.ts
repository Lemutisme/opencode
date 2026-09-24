// Production services with fixture-only barriers after real archive I/O or committed state checkpoints.
// No provider, tools, database operations or coordinator decisions are replaced.
import { Cause, Context, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { ProContractDriver } from "@opencode-ai/core/pro-contract/driver"
import { ProContractDelivery } from "@opencode-ai/core/pro-contract/delivery"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionV2 } from "@opencode-ai/core/session"
import { ExecutionPermit } from "@opencode-ai/core/session/execution-permit"
import { ProContractActivity } from "@opencode-ai/core/pro-contract/activity"
import { Research } from "../../../sdk-next/src/research"
import { ResearchStore } from "../../../sdk-next/src/research/store"
import { ResearchModel } from "../../../sdk-next/src/research/model"

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const gates = new Map<string, { reached: boolean; release: () => void; wait: Promise<void> }>()
      const pause = (name: string) =>
        Effect.suspend(() => {
          const gate = gates.get(name)
          if (!gate) return Effect.void
          gate.reached = true
          return Effect.promise(() => gate.wait)
        })
      const storage = Layer.effect(
        ResearchStore.Service,
        Effect.gen(function* () {
          const real = yield* ResearchStore.Service
          return {
            ...real,
            json: (hash: string) => real.json(hash).pipe(Effect.tap(() => pause("json:" + hash))),
            atomic: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              real.atomic(effect).pipe(
                Effect.tap((result) => {
                  if (typeof result !== "object" || result === null || !("stage" in result)) return Effect.void
                  const run = result as unknown as ResearchModel.Run
                  if (run.stage === "verification" && run.verifierJobID) return pause("verifier-prepared")
                  return Effect.void
                }),
              ),
            put: (value: unknown) =>
              real.put(value).pipe(
                Effect.tap((hash) => pause("put:" + hash)),
                Effect.tap(() =>
                  typeof value === "object" && value !== null && "profile" in value && "reviewHash" in value
                    ? pause("review-archived")
                    : Effect.void,
                ),
              ),
          }
        }),
      ).pipe(Layer.provide(AppNodeBuilder.build(ResearchStore.node)))
      const validator = Layer.effect(
        ProContractRecognition.Service,
        Effect.gen(function* () {
          const real = yield* ProContractRecognition.Service
          const original = real.get(ResearchModel.profile)!
          const wrapped = {
            ...original,
            validate: (input: Parameters<typeof original.validate>[0]) =>
              original
                .validate(input)
                .pipe(Effect.tap((rejection) => (rejection === undefined ? pause("validated") : Effect.void))),
          }
          return {
            get: (profile: string) => (profile === ResearchModel.profile ? wrapped : real.get(profile)),
          }
        }),
      ).pipe(Layer.provide(AppNodeBuilder.build(Research.validatorNode)))
      const base: LayerNode.Replacements = [
        [SessionExecution.node, SessionExecutionLocal.node],
        [
          ProContractDriver.node,
          Layer.succeed(ProContractDriver.Service, ProContractDriver.make([Research.driver, Research.plannedDriver])),
        ],
        [ProContractDelivery.node, Research.deliveryNode],
        [ProContractRecognition.node, validator],
        [ResearchStore.node, storage],
      ]
      const context = yield* Layer.build(
        AppNodeBuilder.build(
          LayerNode.group([
            Research.node,
            ProContractJob.node,
            ProContractOpenCode.node,
            SessionV2.node,
            ExecutionPermit.node,
            LocationServiceMap.node,
            ProContractActivity.node,
          ]),
          [...base, [LocationServiceMap.node, buildLocationServiceMap(base)]],
        ),
      )
      const research = yield* Research.make.pipe(Effect.provideContext(context))
      const contracts = Context.get(context, ProContract.Service)
      const jobs = Context.get(context, ProContractJob.Service)
      const bindings = Context.get(context, ProContractOpenCode.Service)
      const command = Effect.fnUntraced(function* (message: {
        id: string
        action: string
        contractID: string
        input?: unknown
      }) {
        if (message.action === "checkpoint-arm") {
          const gate = Promise.withResolvers<void>()
          gates.set(message.contractID, { reached: false, release: () => gate.resolve(), wait: gate.promise })
          return true
        }
        if (message.action === "checkpoint-status") return gates.get(message.contractID)?.reached ?? false
        if (message.action === "checkpoint-release") {
          gates.get(message.contractID)?.release()
          gates.delete(message.contractID)
          return true
        }
        if (message.action === "job-get") return yield* jobs.get(message.contractID)
        if (message.action === "research-object")
          return Buffer.from(yield* research.object(message.contractID)).toString("utf8")
        const id = ProContract.ID.make(message.contractID)
        if (message.action === "research-issue") return yield* research.issue(message.input as ResearchModel.Input)
        if (message.action === "research-get") return yield* research.get(id)
        if (message.action === "research-history") return yield* research.history(id)
        if (message.action === "research-bundle") return yield* research.bundle(id)
        if (message.action === "research-recover")
          return yield* research.recover(id, message.input as { retry?: boolean })
        if (message.action === "research-cancel") return yield* research.cancel(id)
        if (message.action === "root-info") return yield* contracts.get(id)
        if (message.action === "root-recognition") return (yield* contracts.get(id))?.recognition
        if (message.action === "root-attest")
          return yield* contracts.principalAttest(message.input as Parameters<typeof contracts.principalAttest>[0])
        return yield* Effect.die("Unknown checkpoint command")
      })
      process.on("message", (message: Parameters<typeof command>[0]) => {
        Effect.runFork(
          command(message).pipe(
            Effect.matchCause({
              onFailure: (error) => process.send!({ id: message.id, error: Cause.pretty(error) }),
              onSuccess: (result) => process.send!({ id: message.id, result }),
            }),
          ),
        )
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => gates.forEach((gate) => gate.release())))
      process.send!({ ready: true, owner: bindings.owner })
      yield* Effect.never
    }),
  ),
)
