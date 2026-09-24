export * as ExecutionContext from "./execution-context"

import { Context, Effect } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { realpath } from "node:fs/promises"
import path from "node:path"

/** Captured by a trusted execution boundary, inherited by its permission and effectful leaves. */
export const Current = Context.Reference<
  | {
      readonly sessionID: string
      readonly contractID?: string
      readonly replay?: string
      readonly process?: boolean
      readonly deadline: number
      readonly readOnly?: boolean
      readonly directory?: string
      readonly verification?: <A, E, R>(detail: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
      readonly check: Effect.Effect<void>
    }
  | undefined
>("@opencode/ExecutionContext", { defaultValue: () => undefined })

export const check = Effect.gen(function* () {
  const current = yield* Current
  if (current) yield* current.check
})

/** Read-only jobs cannot use external-directory permission or a symlink to leave their Location. */
export const readPath = (target: string) =>
  Effect.gen(function* () {
    const current = yield* Current
    if (!current) return
    yield* current.check
    if (!current.readOnly || !current.directory) return
    const resolved = yield* Effect.tryPromise(() => Promise.all([realpath(current.directory!), realpath(target)])).pipe(
      Effect.mapError(() => new ToolFailure({ message: "Reviewer path could not be resolved within its Location" })),
    )
    const relative = path.relative(resolved[0], resolved[1])
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return yield* new ToolFailure({ message: "Reviewer path is outside its fixed Location" })
    yield* current.check
  })
