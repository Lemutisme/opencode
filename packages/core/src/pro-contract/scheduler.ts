export * as ProContractScheduler from "./scheduler"

import { Clock, Context, Effect, Layer, Option, Schedule } from "effect"
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
            if (now >= contract.spec.budget.deadline) {
              yield* contracts.escalate({
                contractID: contract.id,
                revision: contract.revision,
                reason:
                  contract.executor === "opencode"
                    ? "OpenCode deadline exhausted while waiting"
                    : "External evaluation deadline exhausted while waiting",
                time: now,
              })
              return
            }
            if (contract.executor !== "opencode") return
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
              const existing = Option.getOrUndefined(yield* sessions.get(current.sessionID).pipe(Effect.option))
              yield* sessions.create({ id: current.sessionID, location: current.location, model: current.model })
              const dependencies = existing
                ? []
                : yield* Effect.forEach(contract.spec.requires, (requirement) =>
                    contracts
                      .get(requirement.contractID)
                      .pipe(Effect.map((dependency) => (dependency ? { requirement, dependency } : undefined))),
                  )
              const policy = dependencies.find((item) => item?.requirement.policy)?.dependency.spec.policy
              const prompt = {
                id: current.promptID,
                sessionID: current.sessionID,
                prompt: {
                  text: existing
                    ? "Continue the approved task after a transient execution interruption."
                    : [
                        contract.spec.brief || contract.spec.goal,
                        ...(policy ? ["Ratified execution policy:", policy] : []),
                        ...dependencies.flatMap((item) =>
                          item && !item.requirement.policy
                            ? [
                                `Verified prerequisite: ${item.dependency.spec.goal}` +
                                  (item.dependency.handoff ? `\n${item.dependency.handoff.summary}` : ""),
                              ]
                            : [],
                        ),
                        ...(contract.blocked ? [`Previous attempt blocked:\n${contract.blocked.reason}`] : []),
                        ...(contract.challenge?.disclosure === "executor" && contract.challenge.summary
                          ? [`Verifier challenge:\n${contract.challenge.summary}`]
                          : []),
                        "When the task is ready for independent verification, call contract_report_ready. If work is blocked, call contract_report_blocked. If the approved terms must change, call contract_propose_revision.",
                      ].join("\n\n"),
                },
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
