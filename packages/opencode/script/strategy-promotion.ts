#!/usr/bin/env bun

import { Option, Schema } from "effect"

const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

const Strategy = Schema.Struct({
  version: Schema.Literal(1),
  mechanismClass: Schema.Literal("execution-policy-text-v1"),
  generation: NonNegativeInt,
  policyHash: Schema.String,
  parentPolicyHash: Schema.optional(Schema.String),
  text: Schema.String,
})

const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  incumbent: Strategy,
  candidate: Strategy,
  tasks: Schema.Array(Schema.String),
  replicates: PositiveInt,
  evaluatorHash: Schema.String,
  budgetHash: Schema.String,
})

const Run = Schema.Struct({
  task: Schema.String,
  replicate: NonNegativeInt,
  policyHash: Schema.String,
  evaluatorHash: Schema.String,
  budgetHash: Schema.String,
  budgetCompliant: Schema.Boolean,
  complete: Schema.Boolean,
  passed: NonNegativeInt,
  total: PositiveInt,
  cost: NonNegative,
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

const manifest = manifestResult.value
const runs = runsResult.value
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
  if (!strategy.text.trim() || strategy.text.includes("\0")) reasons.push(`policy ${strategy.policyHash} has invalid text`)
  if (new Bun.CryptoHasher("sha256").update(strategy.text).digest("hex") !== strategy.policyHash)
    reasons.push(`policy ${strategy.policyHash} does not match its exact text`)
}

for (const run of runs) {
  if (!manifest.tasks.includes(run.task)) reasons.push(`run references unknown task ${run.task}`)
  if (!policies.includes(run.policyHash)) reasons.push(`run ${run.task}/${run.replicate} has an unknown policy hash`)
  if (run.replicate >= manifest.replicates) reasons.push(`run ${run.task}/${run.replicate} was not preregistered`)
  if (run.evaluatorHash !== manifest.evaluatorHash) reasons.push(`run ${run.task}/${run.replicate} has the wrong evaluator hash`)
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

const expectedKeys = manifest.tasks.flatMap((task) =>
  Array.from({ length: manifest.replicates }).flatMap((_, replicate) =>
    policies.map((policyHash) => recordKey(task, replicate, policyHash)),
  ),
)
for (const key of expectedKeys) {
  if (!records.has(key)) reasons.push(`missing run ${key.replaceAll("\0", "/")}`)
}

const incumbent = summarize(manifest.incumbent.policyHash)
const candidate = summarize(manifest.candidate.policyHash)
const lostFullPasses = incumbent.fullPasses.filter((task) => !candidate.fullPasses.includes(task))
const gainedFullPasses = candidate.fullPasses.filter((task) => !incumbent.fullPasses.includes(task))
if (lostFullPasses.length > 0) reasons.push(`candidate lost full passes: ${lostFullPasses.join(", ")}`)

const objective = compare()
if (objective.decision === "reject") reasons.push(objective.reason)

const canonicalRuns = [...runs].sort((left, right) =>
  recordKey(left.task, left.replicate, left.policyHash).localeCompare(
    recordKey(right.task, right.replicate, right.policyHash),
  ),
)
const manifestHash = new Bun.CryptoHasher("sha256").update(JSON.stringify(manifest)).digest("hex")
const runsHash = new Bun.CryptoHasher("sha256").update(JSON.stringify(canonicalRuns)).digest("hex")
const body = {
  version: 1,
  decision: reasons.length === 0 ? "accept" : "reject",
  reasons,
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
  const selected = expectedKeys.flatMap((key) => {
    const parts = key.split("\0")
    if (parts[2] !== policyHash) return []
    const run = records.get(key)
    return run ? [run] : []
  })
  const fullPasses = manifest.tasks.filter((task) =>
    Array.from({ length: manifest.replicates }).every((_, replicate) => {
      const run = records.get(recordKey(task, replicate, policyHash))
      return run?.complete === true && run.passed === run.total
    }),
  )
  const mean = selected.reduce(
    (total, run) => add(total, { numerator: BigInt(run.passed), denominator: BigInt(run.total) }),
    { numerator: 0n, denominator: 1n },
  )
  const divisor = BigInt(selected.length || 1)
  return {
    expectedRuns: manifest.tasks.length * manifest.replicates,
    runs: selected.length,
    fullPasses,
    fullPassCount: fullPasses.length,
    meanPassRate:
      selected.length === 0 ? null : Number(mean.numerator) / Number(mean.denominator * divisor),
    meanPassRateExact:
      selected.length === 0 ? null : `${mean.numerator}/${mean.denominator * divisor}`,
    cost: selected.reduce((total, run) => total + run.cost, 0),
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
  if (candidate.cost < incumbent.cost) return { decision: "accept", metric: "cost", reason: "" }
  return {
    decision: "reject",
    metric: "cost",
    reason: candidate.cost === incumbent.cost ? "candidate provides no strict improvement" : "candidate cost is higher",
  }
}

function add(
  left: { numerator: bigint; denominator: bigint },
  right: { numerator: bigint; denominator: bigint },
) {
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
