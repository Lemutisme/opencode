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
    expect(first.report.promotion).toBe(false)
  })

  test("canonicalizes task order", async () => {
    const first = await gate(manifest(), runs())
    const second = await gate({ ...manifest(), tasks: [...manifest().tasks].reverse() }, runs().reverse())
    expect(second.report).toEqual(first.report)
  })

  test("does not count rounded or undelivered full passes", async () => {
    const records = runs().map((run) => ({ ...run, total: 100000, passed: 99999 }))
    records.find((run) => run.policyHash === candidateHash)!.passed = 100000
    records.find((run) => run.policyHash === candidateHash)!.delivered = false
    const result = await gate(manifest(), records)
    expect(result.report.candidate.fullPassCount).toBe(0)
    expect(result.report.incumbent.fullPassCount).toBe(0)
    expect(result.code).toBe(1)
  })

  test("requires every replicate for a robust full pass", async () => {
    const records = runs().flatMap((run) => [
      { ...run, passed: 10 },
      { ...run, replicate: 1, passed: run.policyHash === candidateHash ? 9 : 10 },
    ])
    const result = await gate({ ...manifest(), replicates: 2 }, records)
    expect(result.report.incumbent.fullPassCount).toBe(2)
    expect(result.report.candidate.fullPassCount).toBe(0)
    expect(result.code).toBe(1)
  })

  test("rejects denominator reduction instead of creating a full pass", async () => {
    const records = runs()
    records.find((run) => run.policyHash === candidateHash)!.total = 8
    const result = await gate(manifest(), records)
    expect(result.code).toBe(1)
    expect(result.report.reasons.join("\n")).toContain("changed the evaluation denominator")
    expect(result.report.decisiveMetric).toBeNull()
  })

  test("keeps missing measurements unknown", async () => {
    const result = await gate(manifest(), runs().slice(1))
    expect(result.code).toBe(1)
    expect(result.report.incumbent.meanPassRate).toBeNull()
    expect(result.report.decisiveMetric).toBeNull()
  })

  test("rejects missing large replicate sets without materializing slots", async () => {
    const result = await gate({ ...manifest(), replicates: Number.MAX_SAFE_INTEGER }, [])
    expect(result.code).toBe(1)
    expect(result.report.incumbent.meanPassRate).toBeNull()
    expect(result.report.incumbent.expectedRuns).toBe("18014398509481982")
  })

  test("unknown cost cannot win a tie but cannot veto a full-pass gain", async () => {
    const records = runs().map((run) => ({ ...run, cost: null }))
    const tied = await gate(manifest(), records)
    expect(tied.code).toBe(1)
    expect(tied.report.reasons).toContain("cost tie-break requires complete accounting")
    records.find((run) => run.policyHash === candidateHash)!.passed = 10
    const improved = await gate(manifest(), records)
    expect(improved.code).toBe(0)
    expect(improved.report.decisiveMetric).toBe("full-pass-count")
  })

  test.each(["policyHash", "evaluatorHash", "budgetHash"] as const)("rejects mismatched %s", async (key) => {
    const records = runs().map((run) => ({ ...run, [key]: hash("wrong") }))
    const result = await gate(manifest(), records)
    expect(result.code).toBe(1)
    expect(result.report.decisiveMetric).toBeNull()
  })

  test.each(["text", "parentPolicyHash", "generation"] as const)("rejects changed strategy %s", async (key) => {
    const input = manifest()
    const candidate = {
      ...input.candidate,
      [key]: key === "generation" ? 3 : key === "text" ? "tampered" : hash("wrong"),
    }
    const result = await gate({ ...input, candidate }, runs())
    expect(result.code).toBe(1)
  })

  test.each(["duplicate", "extra", "budget", "intervention", "overcount"])("rejects %s evidence", async (failure) => {
    const records = runs()
    if (failure === "duplicate") records.push(records[0])
    if (failure === "extra") records.push({ ...records[0], task: "unknown" })
    if (failure === "budget") records[0].budgetCompliant = false
    if (failure === "intervention") records[0].manualInterventions = 1
    if (failure === "overcount") records[0].passed = 11
    const result = await gate(manifest(), records)
    expect(result.code).toBe(1)
    expect(result.report.decisiveMetric).toBeNull()
  })

  test("invalid numeric and identity fields fail schema admission", async () => {
    for (const changed of [
      { passed: 1.5 },
      { passed: Number.MAX_SAFE_INTEGER + 1 },
      { cost: -1 },
      { total: 0 },
      { task: "a\0b" },
    ]) {
      const result = await gate(manifest(), [{ ...runs()[0], ...changed }, ...runs().slice(1)])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("do not match")
      expect(result.report).toBeNull()
    }
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
    evaluatorHash: hash("evaluator"),
    budgetHash: hash("six-hours"),
  }
}

function runs() {
  return manifest().tasks.flatMap((task) =>
    [incumbentHash, candidateHash].map((policyHash) => ({
      task,
      replicate: 0,
      policyHash,
      evaluatorHash: hash("evaluator"),
      budgetHash: hash("six-hours"),
      budgetCompliant: true,
      complete: true,
      delivered: true,
      passed: 8,
      total: 10,
      cost: 1,
      manualInterventions: 0,
      violations: [] as string[],
    })),
  )
}

async function gate(input: unknown, records: unknown) {
  const id = sequence++
  const manifestFile = path.join(root, `${id}-manifest.json`)
  const runsFile = path.join(root, `${id}-runs.json`)
  await Promise.all([Bun.write(manifestFile, JSON.stringify(input)), Bun.write(runsFile, JSON.stringify(records))])
  const proc = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "strategy-promotion.ts"), manifestFile, runsFile],
    {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const result = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code: result[2], stderr: result[1], report: result[0] ? JSON.parse(result[0]) : null }
}

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}
