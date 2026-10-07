export * as RSI from "./rsi.js"

import { Schema } from "effect"
import { Hash } from "@opencode/util/hash"

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Positive = Schema.Int.check(Schema.isGreaterThan(0))

export const Method = Schema.Struct({ instructions: Schema.NonEmptyString })
export type Method = typeof Method.Type

export const Handoff = Schema.Struct({
  action: Schema.Literals(["submit", "checkpoint", "propose", "blocked"]),
  summary: Schema.NonEmptyString,
  method: Schema.optional(Method),
})
export const Execution = Schema.Struct({
  id: Schema.String,
  task: Schema.String,
  parent: Schema.Struct({ hash: Digest, grant: Schema.String }),
  method: Digest,
  input: Digest,
  output: Digest,
  deadline: Schema.Number,
  evaluation: Schema.Boolean,
  fenced: Schema.Literal(true),
  handoff: Handoff,
  assignment: Schema.optional(
    Schema.Struct({ test: Schema.String, repeat: Schema.Int, side: Schema.Literals(["baseline", "candidate"]) }),
  ),
})
export const Verification = Schema.Struct({
  artifact: Digest,
  verifier: Digest,
  passed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Positive,
  valid: Schema.Boolean,
})

export const Protocol = Schema.Struct({
  version: Schema.Literal(1),
  environment: Digest,
  performanceRule: Schema.Literal("task-pareto"),
  tests: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      panel: Schema.Literals(["safety", "development", "confirmation"]),
      repeats: Positive,
      total: Positive,
      checkpoint: Digest,
      verifier: Digest,
    }),
  ),
})
export type Protocol = typeof Protocol.Type

export const Measurement = Schema.Struct({
  side: Schema.Literals(["baseline", "candidate"]),
  test: Schema.NonEmptyString,
  repeat: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  passed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Positive,
  valid: Schema.Boolean,
  artifact: Digest,
  execution: Digest,
  verification: Digest,
})
export type Measurement = typeof Measurement.Type

export function method(value: unknown) {
  const decoded = Schema.decodeUnknownSync(Method)(value, { onExcessProperty: "error" })
  if (
    !decoded.instructions.trim() ||
    decoded.instructions.includes("\0") ||
    Buffer.byteLength(decoded.instructions) > 65536
  )
    throw new Error("Method must contain 1–65536 bytes of nonempty UTF-8 instructions without NUL")
  return decoded
}

export function protocol(value: unknown) {
  const decoded = Schema.decodeUnknownSync(Protocol)(value, { onExcessProperty: "error" })
  if (new Set(decoded.tests.map((test) => test.id)).size !== decoded.tests.length)
    throw new Error("Test identities must be unique across panels")
  for (const panel of ["safety", "development", "confirmation"])
    if (!decoded.tests.some((test) => test.panel === panel)) throw new Error(`Missing ${panel} panel`)
  if (decoded.tests.some((test) => test.panel !== "safety" && test.repeats < 2))
    throw new Error("Performance evidence requires at least two fixed repeats per task")
  return decoded
}

/** Complete measurements are evidence. This pure comparison cannot grant execution. */
export function compare(protocol: Protocol, measurements: readonly Measurement[], retained: readonly string[] = []) {
  const expected = protocol.tests.reduce((sum, test) => sum + test.repeats * 2, 0)
  if (measurements.length !== expected) throw new Error("Incomplete paired evidence")
  const keys = measurements.map((row) => `${row.side}:${row.test}:${row.repeat}`)
  if (new Set(keys).size !== expected) throw new Error("Duplicate paired evidence")
  if (new Set(measurements.map((row) => row.execution)).size !== expected)
    throw new Error("Every fixed repeat must identify a distinct execution")
  const tasks = protocol.tests.map((test) => {
    const sides = (["baseline", "candidate"] as const).map((side) => {
      const rows = Array.from({ length: test.repeats }, (_, repeat) =>
        measurements.find((row) => row.side === side && row.test === test.id && row.repeat === repeat),
      )
      if (rows.some((row) => !row || !row.valid || row.total !== test.total || row.passed > row.total))
        throw new Error(`Missing, invalid or mismatched evidence: ${side}:${test.id}`)
      return {
        passed: rows.reduce((sum, row) => sum + BigInt(row!.passed), 0n),
        full: rows.every((row) => row!.passed === test.total),
      }
    })
    return { id: test.id, panel: test.panel, baseline: sides[0], candidate: sides[1] }
  })
  if (retained.some((id) => !tasks.some((task) => task.id === id)))
    throw new Error("Frozen panel is missing an established full-pass task")
  const full = [...new Set([...retained, ...tasks.filter((task) => task.baseline.full).map((task) => task.id)])]
  const reasons = tasks.flatMap((task) => [
    ...(task.panel === "safety" && (!task.baseline.full || !task.candidate.full) ? [`safety:${task.id}`] : []),
    ...(task.panel !== "safety" && task.candidate.passed < task.baseline.passed ? [`regression:${task.id}`] : []),
    ...(full.includes(task.id) && !task.candidate.full ? [`full-pass-lost:${task.id}`] : []),
  ])
  if (!tasks.some((task) => task.panel !== "safety" && task.candidate.passed > task.baseline.passed))
    reasons.push("no-strict-improvement")
  return {
    eligible: reasons.length === 0,
    reasons,
    retained: reasons.length
      ? full
      : [...new Set([...full, ...tasks.filter((task) => task.candidate.full).map((task) => task.id)])],
  }
}

export const hash = (value: unknown) => Hash.sha256(JSON.stringify(value))
