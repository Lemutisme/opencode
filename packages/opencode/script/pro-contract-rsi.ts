#!/usr/bin/env bun

import { Option, Schema } from "effect"

const Splits = ["private", "confirmation", "ood"] as const
const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  baselineHash: Schema.String,
  candidateHash: Schema.String,
  budgetHash: Schema.String,
  splits: Schema.Struct({
    private: Schema.Array(Schema.String),
    confirmation: Schema.Array(Schema.String),
    ood: Schema.Array(Schema.String),
  }),
  evaluators: Schema.Struct({
    private: Schema.String,
    confirmation: Schema.String,
    ood: Schema.String,
  }),
  selection: Schema.Struct({
    replicates: PositiveInt,
    minMeanDelta: Schema.Number,
    maxTaskRegression: NonNegative,
    maxCostRatio: NonNegative,
    maxAttemptRegression: NonNegative,
  }),
})

const Run = Schema.Struct({
  split: Schema.Literals(Splits),
  task: Schema.String,
  replicate: NonNegativeInt,
  harnessHash: Schema.String,
  evaluatorHash: Schema.String,
  budgetHash: Schema.String,
  budgetCompliant: Schema.Boolean,
  utility: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  cost: NonNegative,
  attempts: NonNegativeInt,
  manualInterventions: NonNegativeInt,
  violations: Schema.Array(Schema.String),
})

const args = process.argv.slice(2)
if (args.length < 2 || args.length > 3) {
  console.error("usage: bun script/pro-contract-rsi.ts <manifest.json> <runs.json> [report.json]")
  process.exit(1)
}

const manifestResult = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))(await Bun.file(args[0]).text())
const runsResult = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Run)))(await Bun.file(args[1]).text())
if (Option.isNone(manifestResult) || Option.isNone(runsResult)) {
  console.error("manifest or run records do not match the RSI experiment schema")
  process.exit(1)
}
const manifest = manifestResult.value
const runs = runsResult.value

const reasons: string[] = []
const taskSplits = new Map<string, (typeof Splits)[number]>()
const records = new Map<string, (typeof runs)[number]>()

if (manifest.baselineHash === manifest.candidateHash) reasons.push("baseline and candidate hashes are identical")
if (manifest.selection.maxCostRatio <= 0) reasons.push("maxCostRatio must be greater than zero")

Splits.forEach((split) => {
  if (manifest.splits[split].length === 0) reasons.push(`${split} split is empty`)
  manifest.splits[split].forEach((task) => {
    const previous = taskSplits.get(task)
    if (previous) reasons.push(`task ${task} appears in both ${previous} and ${split}`)
    taskSplits.set(task, split)
  })
})

runs.forEach((run) => {
  const expectedSplit = taskSplits.get(run.task)
  if (!expectedSplit) reasons.push(`run references unknown task ${run.task}`)
  if (expectedSplit && expectedSplit !== run.split)
    reasons.push(`task ${run.task} is recorded in ${run.split}, expected ${expectedSplit}`)
  if (run.harnessHash !== manifest.baselineHash && run.harnessHash !== manifest.candidateHash)
    reasons.push(`run ${run.task}/${run.replicate} has an unknown harness hash`)
  if (run.evaluatorHash !== manifest.evaluators[run.split])
    reasons.push(`run ${run.task}/${run.replicate} has the wrong evaluator hash`)
  if (run.budgetHash !== manifest.budgetHash) reasons.push(`run ${run.task}/${run.replicate} has the wrong budget hash`)
  if (!run.budgetCompliant) reasons.push(`run ${run.task}/${run.replicate} exceeded its frozen budget`)
  if (run.manualInterventions > 0) reasons.push(`run ${run.task}/${run.replicate} had a manual intervention`)
  if (run.violations.length > 0)
    reasons.push(`run ${run.task}/${run.replicate} reported violations: ${run.violations.join(", ")}`)
  if (run.replicate >= manifest.selection.replicates)
    reasons.push(`run ${run.task}/${run.replicate} was not preregistered`)

  const key = `${run.split}\0${run.task}\0${run.replicate}\0${run.harnessHash}`
  if (records.has(key)) reasons.push(`duplicate run ${run.task}/${run.replicate}/${run.harnessHash}`)
  records.set(key, run)
})

const expectedKeys = Splits.flatMap((split) =>
  manifest.splits[split].flatMap((task) =>
    Array.from({ length: manifest.selection.replicates }).flatMap((_, replicate) =>
      [manifest.baselineHash, manifest.candidateHash].map((hash) => `${split}\0${task}\0${replicate}\0${hash}`),
    ),
  ),
)
expectedKeys.forEach((key) => {
  if (!records.has(key)) reasons.push(`missing run ${key.replaceAll("\0", "/")}`)
})

const summaries = Object.fromEntries(Splits.map((split) => [split, summarize([split])]))
const overall = summarize(Splits)
if (expectedKeys.every((key) => records.has(key))) {
  if (overall.meanDelta !== null && overall.meanDelta < manifest.selection.minMeanDelta)
    reasons.push(`mean utility delta ${overall.meanDelta} is below ${manifest.selection.minMeanDelta}`)
  if (overall.costRatio === null || overall.costRatio > manifest.selection.maxCostRatio)
    reasons.push(`cost ratio ${overall.costRatio ?? "undefined"} exceeds ${manifest.selection.maxCostRatio}`)
  if (overall.attemptRegression !== null && overall.attemptRegression > manifest.selection.maxAttemptRegression)
    reasons.push(`attempt regression ${overall.attemptRegression} exceeds ${manifest.selection.maxAttemptRegression}`)
  if (overall.worstPairDelta !== null && overall.worstPairDelta < -manifest.selection.maxTaskRegression)
    reasons.push(`paired utility regression ${-overall.worstPairDelta} exceeds ${manifest.selection.maxTaskRegression}`)
}

const manifestHasher = new Bun.CryptoHasher("sha256")
manifestHasher.update(JSON.stringify(manifest))
const runsHasher = new Bun.CryptoHasher("sha256")
runsHasher.update(JSON.stringify(runs))
const body = {
  version: 1,
  decision: reasons.length === 0 ? "accept" : "reject",
  reasons,
  baselineHash: manifest.baselineHash,
  candidateHash: manifest.candidateHash,
  manifestHash: manifestHasher.digest("hex"),
  runsHash: runsHasher.digest("hex"),
  splits: summaries,
  overall,
}
const reportHasher = new Bun.CryptoHasher("sha256")
reportHasher.update(JSON.stringify(body))
const report = { ...body, reportHash: reportHasher.digest("hex") }
const output = `${JSON.stringify(report, null, 2)}\n`

if (args[2]) await Bun.write(args[2], output)
process.stdout.write(output)
if (report.decision === "reject") process.exitCode = 1

function summarize(selected: ReadonlyArray<(typeof Splits)[number]>) {
  const pairs = selected.flatMap((split) =>
    manifest.splits[split].flatMap((task) =>
      Array.from({ length: manifest.selection.replicates }).flatMap((_, replicate) => {
        const baseline = records.get(`${split}\0${task}\0${replicate}\0${manifest.baselineHash}`)
        const candidate = records.get(`${split}\0${task}\0${replicate}\0${manifest.candidateHash}`)
        return baseline && candidate ? [{ task, baseline, candidate }] : []
      }),
    ),
  )
  const mean = (values: ReadonlyArray<number>) =>
    values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length
  const tasks = [...new Set(pairs.map((pair) => pair.task))].map((task) => {
    const taskPairs = pairs.filter((pair) => pair.task === task)
    const baselineUtility = mean(taskPairs.map((pair) => pair.baseline.utility)) ?? 0
    const candidateUtility = mean(taskPairs.map((pair) => pair.candidate.utility)) ?? 0
    return { task, baselineUtility, candidateUtility, delta: candidateUtility - baselineUtility }
  })
  const baselineCost = pairs.reduce((total, pair) => total + pair.baseline.cost, 0)
  const candidateCost = pairs.reduce((total, pair) => total + pair.candidate.cost, 0)

  return {
    expectedPairs:
      selected.reduce((total, split) => total + manifest.splits[split].length, 0) * manifest.selection.replicates,
    pairs: pairs.length,
    baselineUtility: mean(pairs.map((pair) => pair.baseline.utility)),
    candidateUtility: mean(pairs.map((pair) => pair.candidate.utility)),
    meanDelta: mean(pairs.map((pair) => pair.candidate.utility - pair.baseline.utility)),
    worstPairDelta:
      pairs.length === 0 ? null : Math.min(...pairs.map((pair) => pair.candidate.utility - pair.baseline.utility)),
    costRatio: baselineCost === 0 ? (candidateCost === 0 ? 1 : null) : candidateCost / baselineCost,
    attemptRegression: mean(pairs.map((pair) => pair.candidate.attempts - pair.baseline.attempts)),
    tasks,
  }
}
