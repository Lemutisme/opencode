import { Effect } from "effect"
import path from "path"

export function formationFaultBarrier(point: "before_commit" | "after_commit_before_binding") {
  const directory = process.env.OPENCODE_TEST_CONTRACT_FORMATION_BARRIER
  const selected = process.env.OPENCODE_TEST_CONTRACT_FORMATION_BARRIER_POINT
  if (!directory || selected !== point) return Effect.void
  if (process.env.NODE_ENV !== "test") return Effect.die("Contract formation fault barrier requires NODE_ENV=test")
  return Effect.gen(function* () {
    yield* Effect.promise(() => Bun.write(path.join(directory, `${point}.ready`), String(process.pid)))
    while (!(yield* Effect.promise(() => Bun.file(path.join(directory, `${point}.release`)).exists())))
      yield* Effect.sleep("10 millis")
  })
}
