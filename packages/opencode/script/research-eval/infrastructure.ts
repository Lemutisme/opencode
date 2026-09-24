import { Schema } from "effect"

const Milliseconds = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(21_600_000))
export const Infrastructure = Schema.Struct({
  version: Schema.Literal(1),
  startup: Milliseconds,
  operation: Milliseconds,
  cleanup: Milliseconds,
  journal: Schema.optional(Schema.Literal("cas:1")),
})
export type Infrastructure = typeof Infrastructure.Type

export function infrastructure(value: unknown, evaluation?: string) {
  if (value === undefined) return undefined
  const policy = Schema.decodeUnknownSync(Infrastructure, { onExcessProperty: "error" })(value)
  if (!["repair-lifecycle-v1", "advisory-v3"].includes(evaluation ?? ""))
    throw new Error("Infrastructure policy requires explicit lifecycle or advisory evaluation")
  return policy
}
