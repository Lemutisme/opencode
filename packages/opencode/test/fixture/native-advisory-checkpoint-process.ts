// Fixture-only barriers around real commits, archives and native sweep. No authority, job,
// tool, inbox or recovery result is fabricated by these checkpoints.
import { Cause, Context, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractDelivery } from "@opencode-ai/core/pro-contract/delivery"
import { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProContractReplay } from "@opencode-ai/core/pro-contract/replay"
import { ProContractScheduler } from "@opencode-ai/core/pro-contract/scheduler"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { NativeAdvisory } from "../../../sdk-next/src/native-advisory"
import { NativeAdvisoryStore } from "../../../sdk-next/src/native-advisory-store"

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
        NativeAdvisoryStore.Service,
        Effect.gen(function* () {
          const real = yield* NativeAdvisoryStore.Service
          const failOnce = (name: string) =>
            Effect.suspend(() => {
              const gate = gates.get(name)
              if (!gate || gate.reached) return Effect.void
              gate.reached = true
              return real.db.run("SELECT * FROM injected_loop_failure").pipe(Effect.orDie)
            })
          return {
            ...real,
            timedRegistrations: () =>
              failOnce("loop-attempt-scan").pipe(Effect.andThen(() => real.timedRegistrations())),
            observe: (...args: Parameters<typeof real.observe>) =>
              failOnce("loop-attempt-observe").pipe(Effect.andThen(() => real.observe(...args))),
            unfinished: () => failOnce("loop-request-scan").pipe(Effect.andThen(() => real.unfinished())),
            put: (value: unknown) =>
              Effect.gen(function* () {
                if (
                  typeof value === "object" &&
                  value !== null &&
                  "job" in value &&
                  typeof value.job === "object" &&
                  value.job !== null &&
                  "status" in value.job &&
                  value.job.status === "completed"
                )
                  yield* pause("completed")
                return yield* real.put(value)
              }),
            atomic: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
              real.atomic(operation).pipe(
                Effect.tap((result) => {
                  if (typeof result !== "object" || result === null || !("phase" in result)) return Effect.void
                  if (result.phase === "accepted") return pause("accepted")
                  if (result.phase === "job") return pause("prepared")
                  return Effect.void
                }),
              ),
            save: (previous: NativeAdvisoryStore.Request | undefined, next: NativeAdvisoryStore.Request) =>
              real
                .save(previous, next)
                .pipe(
                  Effect.tap((saved) =>
                    saved.phase === "accepted" && saved.actual && !previous?.actual
                      ? pause("actual")
                      : saved.phase === "collected" && previous?.phase !== "collected"
                        ? pause("collected")
                        : Effect.void,
                  ),
                ),
          }
        }),
      ).pipe(Layer.provide(AppNodeBuilder.build(NativeAdvisoryStore.node)))
      const binding = Layer.effect(
        ProContractOpenCode.Service,
        Effect.gen(function* () {
          const real = yield* ProContractOpenCode.Service
          return {
            ...real,
            sweep: (...args: Parameters<typeof real.sweep>) =>
              pause("sweep").pipe(Effect.andThen(() => real.sweep(...args))),
            setAdmission: (input: Parameters<typeof real.setAdmission>[0]) =>
              real
                .setAdmission(input)
                .pipe(
                  Effect.tap((result) =>
                    input.open && input.session === "preserve" && result.binding ? pause("reopened") : Effect.void,
                  ),
                ),
            claim: (...args: Parameters<typeof real.claim>) =>
              Effect.gen(function* () {
                const current = yield* real.get(args[0])
                if (current?.admission?.input?.once) yield* pause("claim-after-reopen")
                return yield* real.claim(...args)
              }),
          }
        }),
      ).pipe(Layer.provide(AppNodeBuilder.build(ProContractOpenCode.node)))
      const delivery: { handler?: ProContractDelivery.Handler } = {}
      const base: LayerNode.Replacements = [
        [SessionExecution.node, SessionExecutionLocal.node],
        [NativeAdvisoryStore.node, storage],
        [ProContractOpenCode.node, binding],
        [
          ProContractDelivery.node,
          Layer.succeed(ProContractDelivery.Service, {
            get: (profile) => (profile === "native" ? delivery.handler : undefined),
          }),
        ],
      ]
      const context = yield* Layer.build(
        AppNodeBuilder.build(
          LayerNode.group([
            NativeAdvisory.node,
            NativeAdvisoryStore.node,
            ProContract.node,
            ProContractOpenCode.node,
            ProContractJob.node,
            SessionV2.node,
            ProContractScheduler.liveNode,
            LocationServiceMap.node,
          ]),
          [...base, [LocationServiceMap.node, buildLocationServiceMap(base)]],
        ),
      )
      const native = Context.get(context, NativeAdvisory.Service)
      const bindings = Context.get(context, ProContractOpenCode.Service)
      const contracts = Context.get(context, ProContract.Service)
      const sessions = Context.get(context, SessionV2.Service)
      const jobs = Context.get(context, ProContractJob.Service)
      const locations = Context.get(context, LocationServiceMap.Service)
      delivery.handler = {
        ...native.handler,
        node: (input) =>
          Effect.gen(function* () {
            const before = gates.get("node-error-before")
            if (before) {
              before.reached = true
              return yield* new ProContractDelivery.Denied({ message: "Fixture node failed before admission" })
            }
            const beforeDefect = gates.get("node-defect-before")
            if (beforeDefect) {
              beforeDefect.reached = true
              return yield* Effect.die(new Error("Fixture node defect before admission"))
            }
            const result = yield* native.handler.node!(input)
            const after = gates.get("node-error-after")
            if (after && result === "intercept") {
              after.reached = true
              return yield* new ProContractDelivery.Denied({
                message: "Fixture lost the return after committed admission",
              })
            }
            const afterDefect = gates.get("node-defect-after")
            if (afterDefect && result === "intercept") {
              afterDefect.reached = true
              return yield* Effect.die(new Error("Fixture node defect after committed admission"))
            }
            if (result === "intercept") yield* pause("node-return")
            return result
          }),
      }
      yield* native.start()
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
        if (message.action === "native-issue") {
          const input = message.input as {
            issue: Parameters<typeof native.issue>[0]
            configuration: Parameters<typeof native.issue>[1]
          }
          return yield* native.issue(input.issue, input.configuration)
        }
        if (message.action === "native-object")
          return Buffer.from(yield* native.object(message.contractID)).toString("utf8")
        if (message.action === "native-history") return yield* native.history(message.contractID)
        if (message.action === "job-get") return yield* jobs.get(message.contractID)
        if (message.action === "session-context")
          return yield* sessions.context((message.input as { sessionID: SessionV2.ID }).sessionID)
        const id = ProContract.ID.make(message.contractID)
        if (message.action === "replay-report") {
          const binding = yield* bindings.get(id)
          if (!binding) return yield* Effect.die("Missing replay binding")
          return yield* Effect.gen(function* () {
            const replay = yield* ProContractReplay.Service
            return yield* replay.report({ contractID: id, evidenceHash: (message.input as { hash: string }).hash })
          }).pipe(Effect.provide(locations.get(binding.location)))
        }
        if (message.action === "native-requests") return yield* native.requests(id)
        if (message.action === "native-attempt") {
          const state = Context.get(context, NativeAdvisoryStore.Service)
          const binding = yield* bindings.get(id)
          return binding ? yield* state.attempt(id, binding.revision, binding.attempts) : undefined
        }
        if (message.action === "native-attachment") return yield* native.attachment(id)
        if (message.action === "root-info") return yield* contracts.get(id)
        if (message.action === "get") return yield* bindings.get(id)
        return yield* Effect.die("Unknown native checkpoint command")
      })
      process.on("message", (message: Parameters<typeof command>[0]) => {
        Effect.runFork(
          command(message).pipe(
            Effect.matchCause({
              onFailure: (cause) => process.send!({ id: message.id, error: Cause.pretty(cause) }),
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
