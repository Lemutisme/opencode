export * as ProContractScheduler from "./scheduler"

import { Cause, Clock, Context, Effect, Layer, Option, Schedule } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { ProContract } from "../pro-contract"
import { SessionV2 } from "../session"
import { SessionExecution } from "../session/execution"
import { SessionInput } from "../session/input"
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
    const sessionExecution = yield* SessionExecution.Service
    const database = yield* Database.Service

    const runOnce = Effect.fn("ProContractScheduler.runOnce")(function* () {
      const now = yield* Clock.currentTimeMillis
      const active = yield* sessions.active
      yield* Effect.forEach(yield* bindings.sweep(active, now), (id) => sessions.interrupt(id).pipe(Effect.ignore), {
        discard: true,
      })
      // Interruption waits for the drain finalizer; close requests can now retire
      // their lease. In-flight dispatch is separately fenced by the binding service.
      yield* bindings.sweep(yield* sessions.active, now)
      yield* Effect.forEach(
        yield* contracts.due(now),
        (contract) =>
          Effect.gen(function* () {
            if (contract.executor !== "opencode") return
            if (!(yield* bindings.get(contract.id))) {
              yield* ProContract.withCommandGuard(
                contracts.escalate({
                  contractID: contract.id,
                  revision: contract.revision,
                  reason: "OpenCode execution binding is missing",
                  time: now,
                }),
                () =>
                  Effect.gen(function* () {
                    const current = yield* contracts.get(contract.id)
                    return current?.status !== "dormant" || (yield* bindings.get(contract.id))
                      ? "Contract execution state changed"
                      : undefined
                  }),
              )
              return
            }
            yield* bindings.activate(contract.id, contract.revision, now)
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Contract activation failed", cause).pipe(
                Effect.annotateLogs({ contractID: contract.id }),
              ),
            ),
          ),
        { discard: true },
      )
      yield* bindings.heartbeat(yield* sessions.active, now)
      yield* Effect.forEach(
        yield* bindings.due(now),
        (binding) =>
          Effect.gen(function* () {
            if ((yield* sessions.active).has(binding.sessionID)) return
            const current = yield* bindings.claim(binding.contractID, now)
            if (!current) return
            const execution = ProContractOpenCode.execution(current)
            yield* bindings.dispatch(
              execution,
              Effect.gen(function* () {
                // Build task material from the phase actually claimed, never
                // from the scheduler's earlier eligibility snapshot.
                const contract = yield* bindings.authorize(execution)
                const existing = Option.getOrUndefined(yield* sessions.get(current.sessionID).pipe(Effect.option))
                yield* sessions.create({ id: current.sessionID, location: current.location, model: current.model })
                const saved = yield* SessionInput.find(database.db, current.promptID)
                // Shared counters outlive Sessions. Only durable input/history in
                // this Session can justify omitting the original task material.
                const continuing =
                  existing &&
                  ((yield* SessionInput.hasPending(database.db, current.sessionID, "queue")) ||
                    (yield* sessions.context(current.sessionID)).some((message) => message.type === "user"))
                const dependencies = continuing
                  ? []
                  : yield* Effect.forEach(contract.spec.requires, (requirement) =>
                      contracts
                        .get(requirement.contractID)
                        .pipe(Effect.map((dependency) => (dependency ? { requirement, dependency } : undefined))),
                    )
                const prompt = {
                  id: current.promptID,
                  sessionID: current.sessionID,
                  prompt: saved?.prompt ?? {
                    text:
                      current.admission?.input?.text ??
                      (continuing
                        ? "Continue the approved task after a transient execution interruption."
                        : [
                            contract.spec.brief || contract.spec.goal,
                            ...(current.executionPolicy ? ["Execution policy:", current.executionPolicy] : []),
                            ...(contract.spec.evidence.replay
                              ? [
                                  "Use contract_check for snapshot-bound replay feedback while improving the candidate. It does not hand off or settle the Contract, and failures do not start a new attempt.",
                                ]
                              : []),
                            ...dependencies.flatMap((item) =>
                              item
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
                          ].join("\n\n")),
                  },
                  delivery: saved?.delivery ?? current.admission?.input?.delivery ?? ("queue" as const),
                }
                const admitted = yield* bindings.admit(execution, sessions.prompt({ ...prompt, resume: false }))
                if (admitted) yield* sessionExecution.wake(current.sessionID)
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.uninterruptible(
                    Effect.gen(function* () {
                      // wake transfers cleanup to the independent Session drain.
                      // Cancelling dispatch must not retire that drain's live lease.
                      if (!(yield* sessions.active).has(current.sessionID))
                        yield* bindings.complete({
                          execution,
                          outcome: { type: "dispatch-failed", reason: "OpenCode dispatch failed" },
                          now: yield* Clock.currentTimeMillis,
                        })
                      if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause).pipe(Effect.orDie)
                      yield* Effect.logError("Failed to dispatch contract", cause).pipe(
                        Effect.annotateLogs({ contractID: current.contractID }),
                      )
                    }),
                  ),
                ),
              ),
            )
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause).pipe(Effect.orDie)
                : Effect.logError("Contract dispatch cycle failed", cause).pipe(
                    Effect.annotateLogs({ contractID: binding.contractID }),
                  ),
            ),
          ),
        { discard: true },
      )
    })
    return Service.of({ runOnce })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [ProContract.node, ProContractOpenCode.node, SessionV2.node, SessionExecution.node, Database.node],
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
