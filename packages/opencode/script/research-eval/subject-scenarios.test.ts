import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import { subjectGeneralization } from "./subject-scenarios"
import { publish } from "./corpus"
import { issue } from "./driver"
import { digest, duration } from "./ledger"

test("subject study keeps all source groups and exposes provenance limits without a hidden numeric answer", () => {
  const item = subjectGeneralization()[0]
  const data = JSON.parse(item.packet.files["data.json"]) as {
    features: string[]
    rows: { id: string; subject: string; label: number; x: number[] }[]
    source: { sourceDiscrepancy: string }
  }
  expect(data.rows).toHaveLength(195)
  expect(data.features).toHaveLength(22)
  expect(new Set(data.rows.map((r) => r.subject)).size).toBe(32)
  expect(new Set(data.rows.map((r) => r.id)).size).toBe(195)
  expect(
    data.rows.every((r) => r.id.startsWith(r.subject + "_") && r.x.length === 22 && r.x.every(Number.isFinite)),
  ).toBe(true)
  expect(data.source.sourceDiscrepancy).toContain("31 people")
  expect(data.source.sourceDiscrepancy).toContain("32 distinct")
  expect(item.oracle).not.toHaveProperty("expected")
  const exposed = publish(item.packet)
  expect(exposed).not.toHaveProperty("plan")
  expect(exposed).not.toHaveProperty("preparation")
  expect(exposed.brief).toContain("Choose your own")
  expect(exposed.brief).toContain("evidence-insufficient")
  expect(exposed.files["analysis.mjs"]).not.toContain("centroid")
})

test("actual study harness runs distinct grouped designs and accepts uncertain reports without certifying the method", async () => {
  const item = subjectGeneralization()[0]
  for (const design of ["leave-one-code-out", "two-group-folds"]) {
    const directory = await mkdtemp("/tmp/research-subject-harness-")
    await Promise.all(
      Object.entries(item.packet.files).map(([file, value]) => Bun.write(path.join(directory, file), value)),
    )
    await Bun.write(
      path.join(directory, "analysis.mjs"),
      item.packet.preparation["analysis.mjs"].replace('design = "leave-one-code-out"', 'design = "' + design + '"'),
    )
    await Bun.write(path.join(directory, "report.json"), item.packet.preparation["report.json"])
    const child = Bun.spawn(["/usr/bin/node", "--test", "acceptance.mjs"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
    for (const name of item.packet.expectedTests) expect(stdout).toContain(name)
    const result = await Bun.file(path.join(directory, "result.json")).json()
    expect(result.design).toBe(design)
    expect(result.evaluatedSubjects).toBe(32)
    expect(result.folds).toHaveLength(design === "leave-one-code-out" ? 32 : 2)
    expect(result.baselineBalancedAccuracy).toBe(0.5)
    for (const fold of result.folds) {
      expect(fold.trainSubjects.filter((id: string) => fold.testSubjects.includes(id))).toEqual([])
      expect(fold.predictions.map((p: { subject: string }) => p.subject).sort()).toEqual(fold.testSubjects.toSorted())
    }
    expect(await Bun.file(path.join(directory, "data.json")).text()).toBe(item.packet.files["data.json"])
  }
})

test("subject study retains advisory authorization and deadline-only boundaries and rejects legacy evaluation", () => {
  const item = subjectGeneralization()[0]
  const context = {
    directory: "/unused",
    contractID: "pct_" + item.packet.id,
    issuedAt: 1000,
    worker: { providerID: "test", id: "worker" },
    reviewer: { providerID: "test", id: "reviewer" },
    executable: "/usr/bin/node",
    executableHash: digest("fixture"),
    timeout: 1000,
  } as Omit<Parameters<typeof issue>[1], "evaluation">
  expect(() => issue(publish(item.packet), context)).toThrow("explicit evaluation")
  expect(() => issue(publish(item.packet), { ...context, evaluation: "feedback-v2" })).toThrow("explicit evaluation")
  const issued = issue(publish(item.packet), { ...context, evaluation: "advisory-v3" })
  expect(issued.spec.budget).toEqual({ deadline: 1000 + duration })
  expect(issued.manifest.reviewPolicy).toEqual({ version: 3, plan: "advisory", delivery: "advisory" })
  expect(issued.manifest).not.toHaveProperty("feedbackProtocol")
})
