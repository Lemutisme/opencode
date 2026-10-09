import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Endpoint } from "./endpoint"
import { addEvaluations, change, fixture } from "./endpoint-fixture"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })
async function setup(valid = false, started?: number) {
  const value = await fixture(valid, undefined, started)
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
  expect(result.endpoint.artifacts.find((item) => item.path === value.stdout)).toEqual({
    kind: "official-operation-stdout", path: value.stdout,
    sha256: Bun.SHA256.hash(await Bun.file(value.stdout).bytes(), "hex"),
  })
})

test("valid linked official evidence keeps the actual partial score", async () => {
  const value = await setup(true)
  const result = await Endpoint.finish(value.input)
  expect(result.classification.errors).toEqual([])
  expect(result.endpoint.outcome).toBe("scored")
  expect(result.result.score).toEqual({ passed: 2, total: 3, valid: true })
  expect(result.endpoint.artifacts.filter((item) => item.kind === "official-operation").length).toBe(3)
  expect(result.endpoint.artifacts.filter((item) => item.kind === "official-operation-stdout").length).toBe(1)
  expect(new Set(result.endpoint.artifacts.map((item) => item.path)).size).toBe(result.endpoint.artifacts.length)
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
  ["uncertain Docker operation", async (value: Awaited<ReturnType<typeof setup>>) => change(value.operation, { phase: "uncertain" })],
  ["running Docker operation", async (value: Awaited<ReturnType<typeof setup>>) => change(value.operation, { phase: "running" })],
  ["failed Docker operation", async (value: Awaited<ReturnType<typeof setup>>) => change(value.operation, { phase: "failed" })],
  ["killed Docker operation", async (value: Awaited<ReturnType<typeof setup>>) => change(value.operation, { returncode: -9 })],
  ["operation before grader start", async (value: Awaited<ReturnType<typeof setup>>) => change(value.operation, { started: value.input.admission.started / 1000 })],
  ["operation after original deadline", async (value: Awaited<ReturnType<typeof setup>>) => change(value.operation, { finished: (value.input.admission.deadline + 1) / 1000 })],
  ["orphan stdout", async (value: Awaited<ReturnType<typeof setup>>) => Bun.write(path.join(value.official, "operations", "6".repeat(32) + ".stdout"), "5".repeat(64))],
  ["stdout attached to exec", async (value: Awaited<ReturnType<typeof setup>>) => Bun.write(value.operation.replace(/\.json$/, ".stdout"), "5".repeat(64))],
  ["missing detached run stdout", async (value: Awaited<ReturnType<typeof setup>>) => fs.rm(value.stdout)],
  ["unsupported attached run", async (value: Awaited<ReturnType<typeof setup>>) => change(value.detached, { argv: ["run", "fixture-image"] })],
  ["missing operation argv", async (value: Awaited<ReturnType<typeof setup>>) => change(value.operation, { argv: null })],
  ["non-string operation argv", async (value: Awaited<ReturnType<typeof setup>>) => change(value.operation, { argv: ["exec", 1] })],
  ["invalid container identity stdout", async (value: Awaited<ReturnType<typeof setup>>) => Bun.write(value.stdout, "not a container ID\n")],
  ["stale stdout", async (value: Awaited<ReturnType<typeof setup>>) => fs.utimes(value.stdout, new Date(0), new Date(0))],
  ["stdout predating its paired operation", async (value: Awaited<ReturnType<typeof setup>>) => {
    const before = new Date(value.input.admission.started + 1050)
    await fs.utimes(value.stdout, before, before)
  }],
  ["symlink stdout", async (value: Awaited<ReturnType<typeof setup>>) => {
    await fs.rm(value.stdout)
    await fs.symlink(value.operation, value.stdout)
  }],
  ["directory stdout", async (value: Awaited<ReturnType<typeof setup>>) => {
    await fs.rm(value.stdout)
    await fs.mkdir(value.stdout)
  }],
  ["FIFO stdout", async (value: Awaited<ReturnType<typeof setup>>) => {
    await fs.rm(value.stdout)
    expect(await Bun.spawn(["mkfifo", value.stdout]).exited).toBe(0)
  }],
  ["symlink operation receipt", async (value: Awaited<ReturnType<typeof setup>>) => {
    await fs.rm(value.operation)
    await fs.symlink(value.exported, value.operation)
  }],
  ["retained cp tar", async (value: Awaited<ReturnType<typeof setup>>) => Bun.write(value.exported.replace(/\.json$/, ".tar"), "leftover")],
  ["unknown operation entry", async (value: Awaited<ReturnType<typeof setup>>) => Bun.write(path.join(value.official, "operations", "unexpected.txt"), "leftover")],
  ["non-producer receipt name", async (value: Awaited<ReturnType<typeof setup>>) => fs.rename(value.operation, path.join(value.official, "operations", "operation.json"))],
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

const sudo = Bun.which("sudo")
const canChangeOwner = process.getuid?.() === 0 || sudo !== null && Bun.spawnSync([sudo, "-n", "true"]).exitCode === 0
test.skipIf(!canChangeOwner)("a foreign-owner stdout companion cannot enter the artifact manifest", async () => {
  const value = await setup(true)
  const owner = process.getuid?.() === 0 ? 65534 : 0
  const command = ["chown", String(owner), value.stdout]
  expect(await Bun.spawn(process.getuid?.() === 0 ? command : [sudo!, "-n", ...command]).exited).toBe(0)
  const result = await Endpoint.finish(value.input)
  expect(result.endpoint.outcome).toBe("execution-fault")
  expect(result.classification.errors).toEqual(["Artifact is nonregular, foreign or stale: official-operation-stdout"])
})

test("historical inspection is read-only, labelled diagnostic, and cannot publish an endpoint", async () => {
  const value = await setup(true, Date.now() - 21610000)
  await Bun.write(path.join(value.root, "CANCEL"), "later cohort cancellation")
  const observation = { diagnostic: true as const, observedAt: value.input.admission.started + 9000, cancelled: false }
  const result = await Endpoint.inspect(value.input, observation)
  expect(result.diagnostic).toBe(true)
  expect(result.observation).toEqual(observation)
  expect(result.classification.outcome).toBe("scored")
  expect(result.classification.errors).toEqual([])
  expect(result.score).toEqual({ passed: 2, total: 3, valid: true })
  expect("endpoint" in result).toBe(false)
  expect("version" in result).toBe(false)
  for (const name of ["RESULT.json", "CLASSIFICATION.json", "ENDPOINT.json"])
    expect(await Bun.file(path.join(value.input.directory, name)).exists()).toBe(false)
})

test.each(["deadline", "cancellation"] as const)("diagnostic context cannot bypass the live publisher's %s gate", async (gate) => {
  const value = await setup(true, gate === "deadline" ? Date.now() - 21610000 : undefined)
  if (gate === "cancellation") await Bun.write(path.join(value.root, "CANCEL"), "explicit cancellation")
  const observation = { diagnostic: true as const, observedAt: value.input.admission.started + 9000, cancelled: false }
  expect((await Endpoint.inspect(value.input, observation)).classification.outcome).toBe("scored")
  expect((await Endpoint.inspect(value.input)).classification.outcome).toBe("execution-fault")
  const published = await Reflect.apply(Endpoint.finish, undefined, [value.input, observation])
  expect(published.endpoint.outcome).toBe("execution-fault")
  expect(published.classification.errors).toEqual([gate === "deadline" ? "terminal.before-deadline" : "terminal.not-cancelled"])
  expect((await Bun.file(path.join(value.input.directory, "ENDPOINT.json")).json()).outcome).toBe("execution-fault")
})

test("historical cancellation and malformed observation contexts remain diagnostic failures", async () => {
  const value = await setup(true)
  const cancelled = await Endpoint.inspect(value.input, { diagnostic: true, observedAt: Date.now(), cancelled: true })
  expect(cancelled.classification.outcome).toBe("execution-fault")
  expect(cancelled.classification.errors).toEqual(["terminal.not-cancelled"])
  const malformed = await Endpoint.inspect(value.input, { diagnostic: true, observedAt: Number.NaN, cancelled: false })
  expect(malformed.classification.outcome).toBe("execution-fault")
  expect(malformed.classification.errors).toEqual(["observation.valid"])
})
