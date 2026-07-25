import { Cause, Clock, Effect, Exit, Layer, Option } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { ContextSnapshotDecodeError, MessageDecodeError } from "../error"
import { SessionExecution } from "../execution"
import { ProContractOpenCode } from "../../pro-contract/open-code"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const contracts = yield* ProContractOpenCode.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        const attempt = yield* contracts.forSession(sessionID)
        if (
          attempt &&
          (!attempt.dispatched ||
            attempt.leaseOwner !== contracts.owner ||
            (attempt.leaseExpiresAt ?? 0) <= (yield* Clock.currentTimeMillis))
        )
          return undefined
        const exit = yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
          Effect.exit,
        )
        const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
        const replaceSession =
          Exit.isSuccess(exit) || error instanceof MessageDecodeError || error instanceof ContextSnapshotDecodeError
        if (attempt)
          yield* contracts.reschedule({
            contractID: attempt.contractID,
            revision: attempt.revision,
            promptID: attempt.promptID,
            reason: Exit.isSuccess(exit) ? "OpenCode execution ended without settlement" : "OpenCode execution failed",
            now: yield* Clock.currentTimeMillis,
            attempt: replaceSession ? "new" : "same",
          })
        if (Exit.isFailure(exit)) return yield* exit
        return undefined
      }),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, ProContractOpenCode.node],
})

export * as SessionExecutionLocal from "./local"
