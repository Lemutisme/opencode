import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(tmpdir(), "pro-contract-rsi-"))
const splits = ["private", "confirmation", "ood"] as const
let sequence = 0

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("capability RSI promotion gate", () => {
  test("accepts a complete paired improvement", async () => {
    const result = await runGate(manifest(), runs())

    expect(result.code).toBe(0)
    expect(result.report.decision).toBe("accept")
    expect(result.report.reasons).toEqual([])
    expect(result.report.overall).toMatchObject({ expectedPairs: 6, pairs: 6, costRatio: 1 })
    expect(result.report.overall.meanDelta).toBeCloseTo(0.1)
  })

  test("rejects regressions, excess cost, excess attempts, and violations", async () => {
    const changed = runs().map((run) =>
      run.harnessHash === "candidate" && run.task === "private-task" && run.replicate === 0
        ? { ...run, utility: 0.3, cost: 2, attempts: 2, violations: ["escaped sandbox"] }
        : run,
    )
    const result = await runGate(manifest(), changed)
    const reasons = result.report.reasons.join("\n")

    expect(result.code).toBe(1)
    expect(reasons).toContain("escaped sandbox")
    expect(reasons).toContain("cost ratio")
    expect(reasons).toContain("attempt regression")
    expect(reasons).toContain("paired utility regression")
  })

  test("rejects a bad paired tail even when mean utility improves", async () => {
    const changed = runs().map((run) => {
      if (run.harnessHash !== "candidate" || run.task !== "private-task") return run
      return { ...run, utility: run.replicate === 0 ? 0.57 : 0.83 }
    })
    const result = await runGate(manifest(), changed)

    expect(result.report.overall.meanDelta).toBeGreaterThan(0)
    expect(result.report.reasons.some((reason: string) => reason.startsWith("paired utility regression"))).toBe(true)
  })

  test("rejects overlapping evaluation splits", async () => {
    const input = manifest()
    const changed = { ...input, splits: { ...input.splits, ood: ["private-task"] } }
    const result = await runGate(changed, runs(changed))

    expect(result.code).toBe(1)
    expect(result.report.reasons).toContain("task private-task appears in both private and ood")
  })

  test("rejects a missing baseline or candidate pair", async () => {
    const input = runs()
    input.pop()
    const result = await runGate(manifest(), input)

    expect(result.code).toBe(1)
    expect(result.report.reasons.some((reason: string) => reason.startsWith("missing run"))).toBe(true)
  })

  test("writes the same content-addressed report for the same experiment", async () => {
    const first = await runGate(manifest(), runs())
    const second = await runGate(manifest(), runs())

    expect(first.stdout).toBe(first.written)
    expect(second.stdout).toBe(first.stdout)
    expect(second.report.reportHash).toBe(first.report.reportHash)
  })
})

function manifest() {
  return {
    version: 1 as const,
    baselineHash: "baseline",
    candidateHash: "candidate",
    budgetHash: "budget",
    splits: {
      private: ["private-task"],
      confirmation: ["confirmation-task"],
      ood: ["ood-task"],
    },
    evaluators: {
      private: "private-evaluator",
      confirmation: "confirmation-evaluator",
      ood: "ood-evaluator",
    },
    selection: {
      replicates: 2,
      minMeanDelta: 0,
      maxTaskRegression: 0.02,
      maxCostRatio: 1,
      maxAttemptRegression: 0,
    },
  }
}

function runs(input = manifest()) {
  return splits.flatMap((split) =>
    input.splits[split].flatMap((task) =>
      Array.from({ length: input.selection.replicates }).flatMap((_, replicate) => [
        {
          split,
          task,
          replicate,
          harnessHash: input.baselineHash,
          evaluatorHash: input.evaluators[split],
          budgetHash: input.budgetHash,
          budgetCompliant: true,
          utility: 0.6,
          cost: 1,
          attempts: 1,
          manualInterventions: 0,
          violations: [] as string[],
        },
        {
          split,
          task,
          replicate,
          harnessHash: input.candidateHash,
          evaluatorHash: input.evaluators[split],
          budgetHash: input.budgetHash,
          budgetCompliant: true,
          utility: 0.7,
          cost: 1,
          attempts: 1,
          manualInterventions: 0,
          violations: [] as string[],
        },
      ]),
    ),
  )
}

async function runGate(input: ReturnType<typeof manifest>, records: ReturnType<typeof runs>) {
  const id = sequence++
  const manifestFile = path.join(root, `${id}-manifest.json`)
  const runsFile = path.join(root, `${id}-runs.json`)
  const reportFile = path.join(root, `${id}-report.json`)
  await Promise.all([Bun.write(manifestFile, JSON.stringify(input)), Bun.write(runsFile, JSON.stringify(records))])
  const proc = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "pro-contract-rsi.ts"), manifestFile, runsFile, reportFile],
    {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const result = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  expect(result[1]).toBe("")
  return {
    code: result[2],
    stdout: result[0],
    written: await Bun.file(reportFile).text(),
    report: JSON.parse(result[0]),
  }
}
