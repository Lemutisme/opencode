export * as ProContractPromotion from "./promotion"

import { Schema } from "effect"
import { Hash } from "../util/hash"

export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Protocol = Schema.Struct({
  version: Schema.Literal(1),
  performanceRule: Schema.Literal("task-pareto"),
  evaluatorHash: Digest,
  tests: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      total: Schema.Int.check(Schema.isGreaterThan(0)),
      performance: Schema.optional(
        Schema.Struct({
          panel: Schema.Literals(["development", "confirmation"]),
          task: Schema.NonEmptyString,
          replicate: Schema.NonEmptyString,
        }),
      ),
    }),
  ),
  requiredFull: Schema.optional(Schema.Array(Schema.NonEmptyString)),
})
export type Protocol = typeof Protocol.Type

export const Row = Schema.Struct({
  id: Schema.NonEmptyString,
  passed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThan(0)),
  valid: Schema.Boolean,
})
export type Row = typeof Row.Type

export const Evidence = Schema.Struct({
  protocolHash: Digest,
  candidateHash: Digest,
  baselineHash: Digest,
  receiptHash: Digest,
  rows: Schema.Array(Row),
  baseline: Schema.Array(Row),
})
export type Evidence = typeof Evidence.Type

export function hashProtocol(input: unknown) {
  return Hash.sha256(JSON.stringify(requireProtocol(input)))
}

export function requireProtocol(input: unknown): Protocol {
  const protocol = Schema.decodeUnknownSync(Protocol, { onExcessProperty: "error" })(input)
  if (!protocol.tests.length || new Set(protocol.tests.map((test) => test.id)).size !== protocol.tests.length)
    throw new Error("A nonempty, uniquely named fixed test manifest is required")
  if (!protocol.tests.some((test) => !test.performance)) throw new Error("Fixed safety tests are required")
  ;["development", "confirmation"].forEach((panel) => {
    const tests = protocol.tests.filter((test) => test.performance?.panel === panel)
    if (!tests.length) throw new Error("Development and confirmation evidence are required")
    new Set(tests.map((test) => test.performance!.task)).forEach((task) => {
      const repeats = tests.filter((test) => test.performance!.task === task).map((test) => test.performance!.replicate)
      if (repeats.length < 2 || new Set(repeats).size !== repeats.length)
        throw new Error("At least two distinct fixed repetitions per performance task are required")
    })
  })
  const assigned = new Set(
    protocol.tests.flatMap((test) => (test.performance ? [`${test.performance.panel}:${test.performance.task}`] : [])),
  )
  if ((protocol.requiredFull ?? []).some((task) => !assigned.has(task)))
    throw new Error("A required full pass is not assigned to the protocol")
  return protocol
}

/** Complete evidence can fail qualification; malformed or incomplete evidence is an infrastructure error, not a score. */
export function qualify(input: unknown, report: unknown, retainedFull: readonly string[] = []) {
  const protocol = requireProtocol(input)
  const evidence = Schema.decodeUnknownSync(Evidence, { onExcessProperty: "error" })(report)
  if (evidence.protocolHash !== hashProtocol(protocol)) throw new Error("Stale or foreign evaluation protocol")
  const tasks = [
    ...new Set(
      protocol.tests.flatMap((test) =>
        test.performance ? [`${test.performance.panel}:${test.performance.task}`] : [],
      ),
    ),
  ]
  if (!Array.isArray(retainedFull) || retainedFull.some((task) => !tasks.includes(task)))
    throw new Error("A retained full pass is not assigned to the protocol")
  const tables = [evidence.baseline, evidence.rows].map((rows) => {
    if (rows.length !== protocol.tests.length || new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new Error("Missing or duplicate evaluation tests")
    const table = new Map(rows.map((row) => [row.id, row]))
    return protocol.tests.map((test) => {
      const row = table.get(test.id)
      if (!row || row.total !== test.total || row.passed > row.total)
        throw new Error("Test identity, score, or denominator changed")
      if (!row.valid) throw new Error("Incomplete evaluator evidence")
      return { ...row, performance: test.performance }
    })
  })
  const safety = tables.every((rows) => rows.filter((row) => !row.performance).every((row) => row.passed === row.total))
  const summaries = tasks.map((task) => {
    const scores = tables.map((rows) => {
      const repeats = rows.filter(
        (row) => row.performance && `${row.performance.panel}:${row.performance.task}` === task,
      )
      return {
        full: repeats.every((row) => row.passed === row.total),
        sum: repeats.map((row) => [BigInt(row.passed), BigInt(row.total)] as const).reduce(add, [0n, 1n]),
      }
    })
    return {
      task,
      full: scores[1].full,
      baselineFull: scores[0].full,
      // Both sides have the same frozen repetitions. Comparing exact sums compares their means without rounding.
      gain: scores[1].sum[0] * scores[0].sum[1] - scores[0].sum[0] * scores[1].sum[1],
    }
  })
  const improved = summaries.filter((task) => task.gain > 0n).map((task) => task.task)
  const regressed = summaries.filter((task) => task.gain < 0n).map((task) => task.task)
  const full = summaries.filter((task) => task.full).map((task) => task.task)
  const baselineFull = summaries.filter((task) => task.baselineFull).map((task) => task.task)
  const lostFull = [...new Set([...baselineFull, ...retainedFull])].filter((task) => !full.includes(task))
  return {
    eligible:
      safety &&
      improved.length > 0 &&
      regressed.length === 0 &&
      lostFull.length === 0 &&
      (protocol.requiredFull ?? []).every((task) => full.includes(task)),
    safety,
    improved,
    regressed,
    full,
    baselineFull,
    lostFull,
  }
}

function add(left: readonly [bigint, bigint], right: readonly [bigint, bigint]): readonly [bigint, bigint] {
  const numerator = left[0] * right[1] + right[0] * left[1]
  const denominator = left[1] * right[1]
  const divisor = gcd(numerator, denominator)
  return [numerator / divisor, denominator / divisor]
}

function gcd(left: bigint, right: bigint): bigint {
  return right === 0n ? left : gcd(right, left % right)
}
