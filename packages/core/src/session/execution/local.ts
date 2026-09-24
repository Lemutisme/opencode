import { LLMError } from "@opencode-ai/llm"
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
import { ProContractJob } from "../../pro-contract/job"
import { ProContractActivity } from "../../pro-contract/activity"
import { ExecutionPermit } from "../execution-permit"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const bindings = yield* ProContractOpenCode.Service
    const jobs = yield* ProContractJob.Service
    const activity = yield* ProContractActivity.Service
    const permits = yield* ExecutionPermit.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        const attempt = yield* bindings.forSession(sessionID)
        if (
          attempt &&
          (!attempt.dispatched ||
            attempt.leaseOwner !== bindings.owner ||
            (attempt.leaseExpiresAt ?? 0) <= (yield* Clock.currentTimeMillis))
        )
          return undefined
        const permit = yield* permits.capture(sessionID)
        const run = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const exit = yield* restore(
              SessionRunner.Service.use((runner) => runner.run({ sessionID, force, executionPermit: permit })).pipe(
                Effect.provide(locations.get(session.location)),
                Effect.tapCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
                ),
              ),
            ).pipe(Effect.exit)
            const inspected =
              (attempt || permit.job) && Exit.isSuccess(exit)
                ? yield* store.context(sessionID).pipe(Effect.exit)
                : undefined
            const failure = Exit.isFailure(exit) ? exit : inspected && Exit.isFailure(inspected) ? inspected : undefined
            const error = failure ? Option.getOrUndefined(Cause.findErrorOption(failure.cause)) : undefined
            const lastAssistant =
              inspected && Exit.isSuccess(inspected)
                ? inspected.value.findLast((message) => message.type === "assistant")
                : undefined
            if (attempt)
              yield* bindings.complete({
                execution: ProContractOpenCode.execution(attempt),
                outcome: {
                  type:
                    error instanceof LLMError && !error.retryable
                      ? "terminal-error"
                      : error instanceof MessageDecodeError || error instanceof ContextSnapshotDecodeError
                        ? "invalid-session"
                        : failure && Cause.hasInterruptsOnly(failure.cause)
                          ? "interrupted"
                          : !failure && lastAssistant?.finish !== "error"
                            ? "completed"
                            : "retryable-error",
                  reason:
                    error instanceof LLMError && !error.retryable
                      ? "OpenCode provider returned a terminal error"
                      : Exit.isSuccess(exit)
                        ? "OpenCode execution ended without settlement"
                        : "OpenCode execution failed",
                },
                now: yield* Clock.currentTimeMillis,
              })
            if (permit.job)
              yield* jobs.finish(
                permit.job,
                failure
                  ? Cause.hasInterrupts(failure.cause)
                    ? "interrupted"
                    : "failed"
                  : lastAssistant?.finish === "error"
                    ? "failed"
                    : "completed",
              )
            if (failure) return yield* failure
            return undefined
          }),
        )
        return yield* attempt
          ? bindings.dispatch(ProContractOpenCode.execution(attempt), run)
          : permit.source
            ? activity.run(permit.source.contractID, run)
            : run
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
  deps: [
    SessionStore.node,
    LocationServiceMap.node,
    ProContractOpenCode.node,
    ProContractJob.node,
    ProContractActivity.node,
    ExecutionPermit.node,
  ],
})

export * as SessionExecutionLocal from "./local"
