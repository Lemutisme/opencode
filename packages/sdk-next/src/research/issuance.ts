export * as ResearchIssuance from "./issuance"

import { Cause, Clock, Effect, Exit } from "effect"

export type Event = {
  contractID: string
  phase: string
  event: "start" | "exit"
  at: number
  outcome?: "succeeded" | "failed" | "interrupted"
  error?: string
}

/** Trusted caller observation only; never part of the task's authority or manifest. */
export function trace(contractID: string, observe?: (event: Event) => void) {
  return <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
    !observe
      ? effect
      : Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          yield* Effect.sync(() => observe({ contractID, phase, event: "start", at }))
          return yield* effect.pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                const at = yield* Clock.currentTimeMillis
                yield* Effect.sync(() =>
                  observe({
                    contractID,
                    phase,
                    event: "exit",
                    at,
                    outcome: Exit.isSuccess(exit)
                      ? "succeeded"
                      : Cause.hasInterrupts(exit.cause)
                        ? "interrupted"
                        : "failed",
                    ...(Exit.isFailure(exit) ? { error: Cause.pretty(exit.cause) } : {}),
                  }),
                )
              }),
            ),
          )
        })
}
