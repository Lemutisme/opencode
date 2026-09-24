import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import { requiredCalculation } from "./required-scenarios"
import { publish } from "./corpus"
import { issue } from "./driver"
import { digest, duration } from "./ledger"

test("mandatory signed calculation has a real starting defect; the other starting implementation and report are correct", async () => {
  for (const item of requiredCalculation()) {
    const data = JSON.parse(item.packet.files["data.json"]) as { a: number[]; b: number[] }
    const expected = data.a.reduce((sum, value, index) => sum + data.b[index] - value, 0) / data.a.length
    const code = await import(
      "data:text/javascript;base64," + Buffer.from(item.packet.files["analysis.mjs"]).toString("base64")
    )
    const report = JSON.parse(item.packet.files["report.json"])
    expect(item.oracle.expected.effect).toBe(expected)
    expect(expected).toBe(item.oracle.instance.defective ? 1 : 2)
    expect(code.effect(data.a, data.b)).toBe(item.oracle.instance.defective ? 2.5 : expected)
    expect(report.effect).toBe(code.effect(data.a, data.b))
    expect(report.conclusion).toBe("positive")
    expect(item.oracle.expected.conclusion).toBe(item.oracle.instance.defective ? "negative" : "positive")
    expect(code.rate([], 0)).toBeNull()
    expect(code.rate([1, 2, 2, 3], 2)).toBe(0.75)
    // These perturbations exercise the signed public specification independently of the frozen dataset.
    const reference = await import(
      "data:text/javascript;base64," + Buffer.from(item.packet.preparation["analysis.mjs"]).toString("base64")
    )
    expect(reference.effect([1, 3], [3, 1])).toBe(0)
    expect(reference.effect([5, 7], [2, 4])).toBe(-3)
    expect(reference.effect(data.a, data.b)).toBe(expected)
    expect(code.effect([5, 7], [2, 4])).toBe(item.oracle.instance.defective ? 3 : -3)
    const publicTask = publish(item.packet)
    for (const field of ["oracle", "plan", "preparation", "defective", "expected"])
      expect(publicTask).not.toHaveProperty(field)
  }
})

test("fixed formal harness passes initial smoke but exports the actual wrong value, so correctness cannot be inferred from acceptance", async () => {
  for (const item of requiredCalculation()) {
    const directory = await mkdtemp("/tmp/research-required-calculation-")
    await Promise.all(
      Object.entries(item.packet.files).map(([file, text]) => Bun.write(path.join(directory, file), text)),
    )
    const child = Bun.spawn(["/usr/bin/node", "--test", "acceptance.mjs"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exit, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exit, error }).toEqual({ exit: 0, error: "" })
    for (const name of item.packet.expectedTests) expect(output).toContain(name)
    const result = await Bun.file(path.join(directory, "result.json")).json()
    expect(result.effect).toBe(item.oracle.instance.defective ? 2.5 : 2)
    expect(result.primaryIDs).toEqual(item.oracle.population.primaryIDs)
    expect(result.observations).toBe(8)
  }
})

test("new tasks issue only under explicit advisory v3 with original deadline and no aggregate cap", () => {
  for (const item of requiredCalculation()) {
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
    const task = issue(publish(item.packet), { ...context, evaluation: "advisory-v3" })
    expect(task.spec.budget).toEqual({ deadline: 1000 + duration })
    expect(task.manifest.reviewPolicy).toEqual({ version: 3, plan: "advisory", delivery: "advisory" })
    expect(task.manifest).not.toHaveProperty("feedbackProtocol")
    expect(task.manifest.verification.harness.map((file) => String(file.path))).toEqual([
      "acceptance.mjs",
      "data.json",
      "report.schema.json",
    ])
  }
})
