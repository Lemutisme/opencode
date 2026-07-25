export * as ProContractScheduler from "./scheduler"

import { Clock, Context, Effect, Layer, Schedule } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { ProContract } from "../pro-contract"
import { SessionV2 } from "../session"
import { ProContractOpenCode } from "./open-code"

export interface Interface {
  readonly runOnce: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractScheduler") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const contracts = yield* ProContract.Service
    const bindings = yield* ProContractOpenCode.Service
    const sessions = yield* SessionV2.Service

    const runOnce = Effect.fn("ProContractScheduler.runOnce")(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* Effect.forEach(
        yield* contracts.due(now),
        (contract) =>
          Effect.gen(function* () {
            if (contract.executor !== "opencode") return
            if (now >= contract.spec.budget.deadline) {
              yield* contracts.escalate({
                contractID: contract.id,
                revision: contract.revision,
                reason: "OpenCode deadline exhausted while waiting",
                time: now,
              })
              return
            }
            if (!(yield* bindings.get(contract.id))) {
              yield* contracts.escalate({
                contractID: contract.id,
                revision: contract.revision,
                reason: "OpenCode execution binding is missing",
                time: now,
              })
              return
            }
            yield* contracts.activate(contract.id, contract.revision, now)
          }),
        { discard: true },
      )
      const active = yield* sessions.active
      yield* bindings.heartbeat(active, now)
      yield* Effect.forEach(
        yield* bindings.due(now),
        (binding) =>
          Effect.gen(function* () {
            const contract = yield* contracts.get(binding.contractID)
            if (!contract || contract.status !== "active") return
            if (now >= contract.spec.budget.deadline) {
              yield* contracts.escalate({
                contractID: contract.id,
                revision: contract.revision,
                reason: "OpenCode deadline exhausted",
                time: now,
              })
              return
            }
            if (active.has(binding.sessionID)) return
            const current = yield* bindings.claim(contract.id, now)
            if (!current) return
            yield* Effect.gen(function* () {
              yield* sessions.create({ id: current.sessionID, location: current.location, model: current.model })
              const prompt = {
                id: current.promptID,
                sessionID: current.sessionID,
                prompt: { text: "Reconcile the active contract and advance it within the delegated authority." },
                delivery: "queue" as const,
              }
              yield* sessions.prompt({ ...prompt, resume: false })
              yield* sessions.prompt(prompt)
            }).pipe(
              Effect.catchCause((cause) =>
                bindings
                  .reschedule({
                    contractID: current.contractID,
                    revision: current.revision,
                    promptID: current.promptID,
                    reason: "OpenCode dispatch failed",
                    now,
                    attempt: "same",
                  })
                  .pipe(
                    Effect.andThen(
                      Effect.logError("Failed to dispatch contract", cause).pipe(
                        Effect.annotateLogs({ contractID: current.contractID }),
                      ),
                    ),
                  ),
              ),
            )
          }),
        { discard: true },
      )
    })

    return Service.of({ runOnce })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [ProContract.node, ProContractOpenCode.node, SessionV2.node],
})

export const liveNode = makeGlobalNode({
  name: "pro-contract-scheduler-live",
  layer: Layer.effectDiscard(
    Service.use((scheduler) =>
      scheduler.runOnce().pipe(
        Effect.catchCause((cause) => Effect.logError("ProContract scheduler cycle failed", cause)),
        Effect.repeat(Schedule.spaced("1 second")),
        Effect.forkScoped,
        Effect.asVoid,
      ),
    ),
  ),
  deps: [node],
})
