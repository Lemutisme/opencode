import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(tmpdir(), "strategy-promotion-"))
const incumbentText = "inspect one example"
const candidateText = "independently falsify the frozen candidate"
const incumbentHash = hash(incumbentText)
const candidateHash = hash(candidateText)
let sequence = 0

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("strategy promotion", () => {
  test("prefers a retained new full pass despite lower mean and higher cost", async () => {
    const records = runs()
    records.find((run) => run.task === "a" && run.policyHash === candidateHash)!.passed = 10
    records.find((run) => run.task === "b" && run.policyHash === candidateHash)!.passed = 1
    records.filter((run) => run.policyHash === candidateHash).forEach((run) => (run.cost = 10))

    const result = await gate(manifest(), records)

    expect(result.code).toBe(0)
    expect(result.report.decision).toBe("accept")
    expect(result.report.decisiveMetric).toBe("full-pass-count")
    expect(result.report.gainedFullPasses).toEqual(["a"])
  })

  test("never trades away an incumbent full pass", async () => {
    const records = runs()
    records.find((run) => run.task === "a" && run.policyHash === incumbentHash)!.passed = 10
    records.find((run) => run.task === "b" && run.policyHash === candidateHash)!.passed = 10

    const result = await gate(manifest(), records)

    expect(result.code).toBe(1)
    expect(result.report.reasons).toContain("candidate lost full passes: a")
  })

  test("uses exact mean only when full passes are retained and tied", async () => {
    const records = runs()
    records.find((run) => run.task === "a" && run.policyHash === candidateHash)!.passed = 9

    const result = await gate(manifest(), records)

    expect(result.code).toBe(0)
    expect(result.report.decisiveMetric).toBe("mean-pass-rate")
  })

  test("uses cost only after full passes and mean tie", async () => {
    const records = runs()
    records.filter((run) => run.policyHash === candidateHash).forEach((run) => (run.cost = 0.5))

    const result = await gate(manifest(), records)

    expect(result.code).toBe(0)
    expect(result.report.decisiveMetric).toBe("cost")
  })

  test("rejects incomplete or unauthorized evidence", async () => {
    const records = runs()
    records[0]!.complete = false
    records[1]!.violations = ["changed evaluator"]

    const result = await gate(manifest(), records)

    expect(result.code).toBe(1)
    expect(result.report.reasons.join("\n")).toContain("incomplete")
    expect(result.report.reasons.join("\n")).toContain("changed evaluator")
  })

  test("canonicalizes run order for report identity", async () => {
    const first = await gate(manifest(), runs())
    const second = await gate(manifest(), runs().reverse())

    expect(second.report.runsHash).toBe(first.report.runsHash)
    expect(second.report.reportHash).toBe(first.report.reportHash)
  })
})

function manifest() {
  return {
    version: 1 as const,
    incumbent: {
      version: 1 as const,
      mechanismClass: "execution-policy-text-v1" as const,
      generation: 0,
      policyHash: incumbentHash,
      text: incumbentText,
    },
    candidate: {
      version: 1 as const,
      mechanismClass: "execution-policy-text-v1" as const,
      generation: 1,
      policyHash: candidateHash,
      parentPolicyHash: incumbentHash,
      text: candidateText,
    },
    tasks: ["a", "b"],
    replicates: 1,
    evaluatorHash: "evaluator",
    budgetHash: "six-hours",
  }
}

function runs() {
  return manifest().tasks.flatMap((task) =>
    [incumbentHash, candidateHash].map((policyHash) => ({
      task,
      replicate: 0,
      policyHash,
      evaluatorHash: "evaluator",
      budgetHash: "six-hours",
      budgetCompliant: true,
      complete: true,
      passed: 8,
      total: 10,
      cost: 1,
      manualInterventions: 0,
      violations: [] as string[],
    })),
  )
}

async function gate(input: ReturnType<typeof manifest>, records: ReturnType<typeof runs>) {
  const id = sequence++
  const manifestFile = path.join(root, `${id}-manifest.json`)
  const runsFile = path.join(root, `${id}-runs.json`)
  await Promise.all([Bun.write(manifestFile, JSON.stringify(input)), Bun.write(runsFile, JSON.stringify(records))])
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "strategy-promotion.ts"), manifestFile, runsFile], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const result = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  expect(result[1]).toBe("")
  return { code: result[2], report: JSON.parse(result[0]) }
}

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}
