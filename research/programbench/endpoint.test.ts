import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Endpoint } from "./endpoint"
import { addEvaluations, change, fixture } from "./endpoint-fixture"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })
async function setup(valid = false) {
  const value = await fixture(valid)
  roots.push(value.root)
  return value
}

test("a positively fenced isolated invalid official result is UNKNOWN, not zero", async () => {
  const value = await setup()
  const result = await Endpoint.finish(value.input)
  expect(result.classification.errors).toEqual([])
  expect(result.endpoint.outcome).toBe("invalid-official-score")
  expect(result.result.score).toEqual({ passed: null, total: null, valid: false })
  expect(result.result.delivered).toBe(false)
  expect(result.endpoint.cleanup).toEqual({ native: { acknowledged: true }, official: { acknowledged: true } })
})

test("valid linked official evidence keeps the actual partial score", async () => {
  const value = await setup(true)
  const result = await Endpoint.finish(value.input)
  expect(result.classification.errors).toEqual([])
  expect(result.endpoint.outcome).toBe("scored")
  expect(result.result.score).toEqual({ passed: 2, total: 3, valid: true })
})

test("real RSI shape may contain local safety plus candidate official verification", async () => {
  const value = await setup(true)
  await addEvaluations(value)
  const result = await Endpoint.finish(value.input)
  expect(result.classification.errors).toEqual([])
  expect(result.endpoint.outcome).toBe("scored")
  expect(result.endpoint.artifacts.some((item) => item.kind === "local-verifier-fence")).toBe(true)
})

test("isolated original invalid score remains UNKNOWN after complete candidate comparisons", async () => {
  const value = await setup()
  await addEvaluations(value)
  const result = await Endpoint.finish(value.input)
  expect(result.classification.errors).toEqual([])
  expect(result.endpoint.outcome).toBe("invalid-official-score")
})

test("a nonterminal local verifier cannot claim the original terminal identity", async () => {
  const value = await setup(true)
  const evaluations = await addEvaluations(value)
  await change(path.join(evaluations.local, "VERIFICATION.json"), { terminal: { task: value.input.task.id, execution: "candidate-native", action: "submit" } })
  const result = await Endpoint.finish(value.input)
  expect(result.endpoint.outcome).toBe("execution-fault")
})

test.each([
  ["missing native fence", async (value: Awaited<ReturnType<typeof setup>>) => fs.rm(path.join(value.execution, "FENCED.json"))],
  ["unacknowledged cleanup", async (value: Awaited<ReturnType<typeof setup>>) => change(path.join(value.official, "RESULT.json"), { cleanupAcknowledged: false })],
  ["different original deadline", async (value: Awaited<ReturnType<typeof setup>>) => change(path.join(value.official, "RESULT.json"), { deadline: value.input.admission.deadline + 1 })],
  ["different instance", async (value: Awaited<ReturnType<typeof setup>>) => change(path.join(value.official, "RESULT.json"), { instance: "another" })],
  ["different config hash", async (value: Awaited<ReturnType<typeof setup>>) => change(path.join(value.official, "RESULT.json"), { configHash: "0".repeat(64) })],
  ["timeout", async (value: Awaited<ReturnType<typeof setup>>) => change(path.join(value.official, "RESULT.json"), { failure: "deadline" })],
  ["private error not isolated collection", async (value: Awaited<ReturnType<typeof setup>>) => change(path.join(value.official, "RESULT.json"), { officialError: "results_read_failed" })],
  ["missing terminal linkage", async (value: Awaited<ReturnType<typeof setup>>) => fs.rm(path.join(value.verification, "VERIFICATION.json"))],
  ["candidate-only linkage", async (value: Awaited<ReturnType<typeof setup>>) => change(path.join(value.verification, "VERIFICATION.json"), { terminal: null })],
  ["evaluation native mislabel", async (value: Awaited<ReturnType<typeof setup>>) => change(path.join(value.execution, "admission", "input.json"), { evaluation: true })],
  ["checkpoint is not terminal", async (value: Awaited<ReturnType<typeof setup>>) => change(path.join(value.execution, "state", "result.json"), { action: "checkpoint" })],
  ["uncertain Docker operation", async (value: Awaited<ReturnType<typeof setup>>) => change(path.join(value.official, "operations", "operation.json"), { phase: "uncertain" })],
  ["killed Docker operation", async (value: Awaited<ReturnType<typeof setup>>) => change(path.join(value.official, "operations", "operation.json"), { returncode: -9 })],
  ["mutated submission", async (value: Awaited<ReturnType<typeof setup>>) => Bun.write(path.join(value.official, "submission", value.input.assignment.instance, "submission.tar.gz"), "changed")],
  ["stale receipt", async (value: Awaited<ReturnType<typeof setup>>) => fs.utimes(path.join(value.official, "RESULT.json"), new Date(0), new Date(0))],
  ["later solver execution", async (value: Awaited<ReturnType<typeof setup>>) => change(path.join(value.execution, "FENCED.json"), { time: value.input.admission.started + 5000 })],
  ["post-grade provider admission", async (value: Awaited<ReturnType<typeof setup>>) => Bun.write(path.join(value.execution, "requests.jsonl"), JSON.stringify({ type: "admitted", id: "late", time: (value.input.admission.started + 5000) / 1000 }) + "\n")],
  ["foreign subject symlink", async (value: Awaited<ReturnType<typeof setup>>) => {
    const file = path.join(value.official, "submission", value.input.assignment.instance, "submission.tar.gz")
    await fs.rm(file)
    await fs.symlink("/etc/hostname", file)
  }],
] as const)("%s is an execution fault, never isolated UNKNOWN", async (_name, mutate) => {
  const value = await setup()
  await mutate(value)
  const result = await Endpoint.finish(value.input)
  expect(result.endpoint.outcome).toBe("execution-fault")
  expect(result.classification.eligible).toBe(false)
  expect(result.classification.errors.length).toBeGreaterThan(0)
})

test("a real surviving process cannot be cleared by an acknowledged fence", async () => {
  const value = await setup()
  const child = Bun.spawn(["/bin/sleep", "60"])
  try {
    const fields = (await fs.readFile(`/proc/${child.pid}/stat`, "utf8")).split(")").at(-1)!.trim().split(/\s+/)
    const identity = { pid: child.pid, birth: fields[19]! }
    await change(path.join(value.execution, "OWNERSHIP.json"), { runtime: identity })
    await change(path.join(value.execution, "FENCED.json"), { runtime: identity })
    const result = await Endpoint.finish(value.input)
    expect(result.endpoint.outcome).toBe("execution-fault")
    expect(result.endpoint.cleanup.native.acknowledged).toBe(false)
  } finally {
    child.kill("SIGKILL")
    await child.exited
  }
})

test("explicit cancellation never turns into a settled invalid score", async () => {
  const value = await setup()
  const result = await Endpoint.finish({ ...value.input, aborted: true })
  expect(result.endpoint.outcome).toBe("cancelled")
  expect(result.classification.eligible).toBe(false)
})

test("an unrelated host error cannot be hidden behind an invalid grader result", async () => {
  const value = await setup()
  const result = await Endpoint.finish({ ...value.input, hostError: "Error: ledger I/O failure" })
  expect(result.endpoint.outcome).toBe("execution-fault")
  expect(result.classification.eligible).toBe(false)
})
