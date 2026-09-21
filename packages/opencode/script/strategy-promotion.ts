#!/usr/bin/env bun

import { Option, Schema } from "effect"

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegativeInt = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const PositiveInt = NonNegativeInt.check(Schema.isGreaterThan(0))
const Identity = Schema.NonEmptyString.check(Schema.isPattern(/^[^\0]+$/))
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

const Strategy = Schema.Struct({
  version: Schema.Literal(1),
  mechanismClass: Schema.Literal("execution-policy-text-v1"),
  generation: NonNegativeInt,
  policyHash: Hash,
  parentPolicyHash: Schema.optional(Hash),
  text: Schema.String,
})

const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  incumbent: Strategy,
  candidate: Strategy,
  tasks: Schema.Array(Identity),
  replicates: PositiveInt,
  evaluatorHash: Hash,
  budgetHash: Hash,
})

const Run = Schema.Struct({
  task: Identity,
  replicate: NonNegativeInt,
  policyHash: Hash,
  evaluatorHash: Hash,
  budgetHash: Hash,
  budgetCompliant: Schema.Boolean,
  complete: Schema.Boolean,
  delivered: Schema.Boolean,
  passed: NonNegativeInt,
  total: PositiveInt,
  cost: Schema.NullOr(NonNegative),
  manualInterventions: NonNegativeInt,
  violations: Schema.Array(Schema.String),
})

const args = process.argv.slice(2)
if (args.length < 2 || args.length > 3) {
  console.error("usage: bun script/strategy-promotion.ts <manifest.json> <runs.json> [report.json]")
  process.exit(1)
}

const manifestResult = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))(await Bun.file(args[0]).text())
const runsResult = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Run)))(await Bun.file(args[1]).text())
if (Option.isNone(manifestResult) || Option.isNone(runsResult)) {
  console.error("manifest or run records do not match the strategy-promotion schema")
  process.exit(1)
}

const manifest = { ...manifestResult.value, tasks: [...manifestResult.value.tasks].sort() }
const runs = [...runsResult.value].sort((left, right) => {
  const a = recordKey(left.task, left.replicate, left.policyHash)
  const b = recordKey(right.task, right.replicate, right.policyHash)
  return a < b ? -1 : a > b ? 1 : 0
})
const reasons: string[] = []
const records = new Map<string, (typeof runs)[number]>()
const policies = [manifest.incumbent.policyHash, manifest.candidate.policyHash]

if (manifest.tasks.length === 0) reasons.push("task set is empty")
if (new Set(manifest.tasks).size !== manifest.tasks.length) reasons.push("task set contains duplicates")
if (manifest.incumbent.policyHash === manifest.candidate.policyHash)
  reasons.push("incumbent and candidate policy hashes are identical")
if (manifest.candidate.parentPolicyHash !== manifest.incumbent.policyHash)
  reasons.push("candidate parentPolicyHash does not identify the incumbent")
if (manifest.candidate.generation !== manifest.incumbent.generation + 1)
  reasons.push("candidate generation does not immediately follow the incumbent")

for (const strategy of [manifest.incumbent, manifest.candidate]) {
  if (!strategy.text.trim() || strategy.text.includes("\0"))
    reasons.push(`policy ${strategy.policyHash} has invalid text`)
  if (new Bun.CryptoHasher("sha256").update(strategy.text).digest("hex") !== strategy.policyHash)
    reasons.push(`policy ${strategy.policyHash} does not match its exact text`)
}

for (const run of runs) {
  if (!manifest.tasks.includes(run.task)) reasons.push(`run references unknown task ${run.task}`)
  if (!policies.includes(run.policyHash)) reasons.push(`run ${run.task}/${run.replicate} has an unknown policy hash`)
  if (run.replicate >= manifest.replicates) reasons.push(`run ${run.task}/${run.replicate} was not preregistered`)
  if (run.evaluatorHash !== manifest.evaluatorHash)
    reasons.push(`run ${run.task}/${run.replicate} has the wrong evaluator hash`)
  if (run.budgetHash !== manifest.budgetHash) reasons.push(`run ${run.task}/${run.replicate} has the wrong budget hash`)
  if (!run.budgetCompliant) reasons.push(`run ${run.task}/${run.replicate} exceeded its frozen budget`)
  if (!run.complete) reasons.push(`run ${run.task}/${run.replicate}/${run.policyHash} is incomplete`)
  if (run.passed > run.total) reasons.push(`run ${run.task}/${run.replicate}/${run.policyHash} passed more than total`)
  if (run.manualInterventions > 0)
    reasons.push(`run ${run.task}/${run.replicate}/${run.policyHash} had a manual intervention`)
  if (run.violations.length > 0)
    reasons.push(`run ${run.task}/${run.replicate}/${run.policyHash} reported violations: ${run.violations.join(", ")}`)

  const key = recordKey(run.task, run.replicate, run.policyHash)
  if (records.has(key)) reasons.push(`duplicate run ${run.task}/${run.replicate}/${run.policyHash}`)
  records.set(key, run)
}

// Unique admitted slots form a subset of the frozen Cartesian product. Equal
// cardinality proves completeness without allocating attacker-sized replicate arrays.
const expectedRuns = BigInt(manifest.tasks.length) * BigInt(manifest.replicates)
if (BigInt(records.size) !== expectedRuns * 2n)
  reasons.push(`missing or extra runs: expected ${expectedRuns * 2n}, received ${records.size}`)
runs
  .filter((run) => run.policyHash === manifest.incumbent.policyHash)
  .forEach((baseline) => {
    const successor = records.get(recordKey(baseline.task, baseline.replicate, manifest.candidate.policyHash))
    if (successor && baseline.total !== successor.total)
      reasons.push(`run ${baseline.task}/${baseline.replicate} changed the evaluation denominator`)
  })

const incumbent = summarize(manifest.incumbent.policyHash)
const candidate = summarize(manifest.candidate.policyHash)
const lostFullPasses = incumbent.fullPasses.filter((task) => !candidate.fullPasses.includes(task))
const gainedFullPasses = candidate.fullPasses.filter((task) => !incumbent.fullPasses.includes(task))
if (lostFullPasses.length > 0) reasons.push(`candidate lost full passes: ${lostFullPasses.join(", ")}`)

// Incomplete or conflicting records cannot define a winner, even provisionally.
const objective = reasons.length > 0 ? { decision: "reject", metric: null, reason: "invalid evidence" } : compare()
if (objective.decision === "reject") reasons.push(objective.reason)

const manifestHash = new Bun.CryptoHasher("sha256").update(JSON.stringify(manifest)).digest("hex")
const runsHash = new Bun.CryptoHasher("sha256").update(JSON.stringify(runs)).digest("hex")
const body = {
  version: 1,
  decision: reasons.length === 0 ? "accept" : "reject",
  reasons: [...new Set(reasons)].sort(),
  promotion: false,
  evidenceScope: "Caller-supplied records only; acceptance neither authenticates evidence nor authorizes deployment.",
  objective: "retain-full-passes, then full-pass-count, mean-pass-rate, cost",
  incumbent,
  candidate,
  lostFullPasses,
  gainedFullPasses,
  decisiveMetric: objective.metric,
  manifestHash,
  runsHash,
}
const reportHash = new Bun.CryptoHasher("sha256").update(JSON.stringify(body)).digest("hex")
const output = `${JSON.stringify({ ...body, reportHash }, null, 2)}\n`

if (args[2]) await Bun.write(args[2], output)
process.stdout.write(output)
if (reasons.length > 0) process.exitCode = 1

function recordKey(task: string, replicate: number, policyHash: string) {
  return `${task}\0${replicate}\0${policyHash}`
}

function summarize(policyHash: string) {
  const selected = [...records.values()].filter(
    (run) => run.policyHash === policyHash && manifest.tasks.includes(run.task) && run.replicate < manifest.replicates,
  )
  const fullPasses = manifest.tasks.filter((task) => {
    const trials = selected.filter((run) => run.task === task)
    return (
      trials.length === manifest.replicates &&
      trials.every((run) => run.complete && run.delivered && run.passed === run.total)
    )
  })
  const mean = selected.reduce(
    (total, run) => add(total, { numerator: BigInt(run.delivered ? run.passed : 0), denominator: BigInt(run.total) }),
    { numerator: 0n, denominator: 1n },
  )
  const complete =
    expectedRuns > 0n && BigInt(selected.length) === expectedRuns && selected.every((run) => run.complete)
  const cost = selected.reduce((total, run) => total + (run.cost ?? 0), 0)
  return {
    expectedRuns: expectedRuns.toString(),
    runs: selected.length,
    fullPasses,
    fullPassCount: fullPasses.length,
    // Divide before converting large exact sums: Number(bigint)/Number(bigint) can become Infinity/Infinity.
    meanPassRate: complete ? Number((mean.numerator * 10n ** 15n) / (mean.denominator * expectedRuns)) / 1e15 : null,
    meanPassRateExact: complete ? `${mean.numerator}/${mean.denominator * expectedRuns}` : null,
    cost: complete && selected.every((run) => run.cost !== null) && Number.isFinite(cost) ? cost : null,
  }
}

function compare() {
  if (candidate.fullPassCount !== incumbent.fullPassCount)
    return candidate.fullPassCount > incumbent.fullPassCount
      ? { decision: "accept", metric: "full-pass-count", reason: "" }
      : { decision: "reject", metric: "full-pass-count", reason: "candidate has fewer full passes" }
  const mean = compareExact(candidate.meanPassRateExact, incumbent.meanPassRateExact)
  if (mean !== 0)
    return mean > 0
      ? { decision: "accept", metric: "mean-pass-rate", reason: "" }
      : { decision: "reject", metric: "mean-pass-rate", reason: "candidate mean pass rate is lower" }
  if (candidate.cost === null || incumbent.cost === null)
    return { decision: "reject", metric: "cost", reason: "cost tie-break requires complete accounting" }
  if (candidate.cost < incumbent.cost) return { decision: "accept", metric: "cost", reason: "" }
  return {
    decision: "reject",
    metric: "cost",
    reason: candidate.cost === incumbent.cost ? "candidate provides no strict improvement" : "candidate cost is higher",
  }
}

function add(left: { numerator: bigint; denominator: bigint }, right: { numerator: bigint; denominator: bigint }) {
  const numerator = left.numerator * right.denominator + right.numerator * left.denominator
  const denominator = left.denominator * right.denominator
  const divisor = gcd(numerator, denominator)
  return { numerator: numerator / divisor, denominator: denominator / divisor }
}

function gcd(left: bigint, right: bigint): bigint {
  const remainder = left % right
  if (remainder === 0n) return right
  return gcd(right, remainder)
}

function compareExact(left: string | null, right: string | null) {
  if (left === null || right === null) return 0
  const [leftNumerator, leftDenominator] = left.split("/").map(BigInt)
  const [rightNumerator, rightDenominator] = right.split("/").map(BigInt)
  const difference = leftNumerator * rightDenominator - rightNumerator * leftDenominator
  return difference > 0n ? 1 : difference < 0n ? -1 : 0
}
