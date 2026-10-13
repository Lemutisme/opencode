/** Zero-model, zero-grader receipts for testing the real endpoint classifier. */
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Endpoint } from "./endpoint"

export async function fixture(valid = false, directoryRoot?: string, started = Date.now() - 10000) {
  const root = directoryRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), "pb-endpoint-"))
  const child = Bun.spawn(["/bin/sleep", "60"])
  const fields = (await fs.readFile(`/proc/${child.pid}/stat`, "utf8")).split(")").at(-1)!.trim().split(/\s+/)
  const identity = { pid: child.pid, birth: fields[19]! }
  child.kill("SIGKILL")
  await child.exited
  const directory = path.join(root, "runs", "0-rsi-r1")
  const execution = path.join(directory, "campaign", "executions", "original-native")
  const verification = path.join(directory, "campaign", "verifications", "original-grade")
  const official = path.join(verification, "official")
  await fs.mkdir(path.join(execution, "admission"), { recursive: true })
  await fs.mkdir(path.join(execution, "state"), { recursive: true })
  await fs.mkdir(path.join(verification, "workspace"), { recursive: true })
  await fs.mkdir(path.join(official, "operations"), { recursive: true })
  await fs.mkdir(path.join(official, "submission", "fixture__task.123"), { recursive: true })
  const admission = {
    version: 1, id: "0-rsi-r1", admissionID: "a".repeat(32), cohortToken: "b".repeat(32), cohortRoot: root,
    started, deadline: started + 21600000,
  }
  const assignment = {
    id: admission.id, instance: "fixture__task.123",
    profile: { path: path.join(root, "profile.json"), sha256: "c".repeat(64) },
    task: { path: path.join(root, "task.json"), sha256: "d".repeat(64) },
  }
  const task = {
    id: "pct_original", total: 3,
    verifier: { programbench: { instance: assignment.instance, configuration: { path: path.join(root, "grader.json"), sha256: "e".repeat(64) } } },
  }
  const checkpoint = "f".repeat(64)
  await write(path.join(directory, "ADMISSION.json"), admission)
  await write(path.join(directory, "campaign", "FROZEN.json"), { tests: [{ verifier: task.verifier }] })
  await write(path.join(directory, "ADMITTED.json"), {
    id: admission.id, admissionID: admission.admissionID, task, profile: assignment.profile,
    taskReference: assignment.task, deadline: admission.deadline,
  })
  await write(path.join(execution, "OWNERSHIP.json"), {
    wrapperPID: identity.pid, wrapper: identity, runtime: identity, gateway: identity, deadline: admission.deadline,
  })
  await write(path.join(execution, "FENCED.json"), {
    pid: identity.pid, wrapper: identity, runtime: identity, gateway: identity, deadline: admission.deadline,
    acknowledged: true, wrapperExited: true, runtimeExited: true, gatewayExited: true, time: started + 500,
  })
  await write(path.join(execution, "admission", "input.json"), { deadline: admission.deadline, evaluation: false })
  await write(path.join(execution, "state", "result.json"), { action: "submit", summary: "fixture" })
  await Bun.write(path.join(execution, "requests.jsonl"), JSON.stringify({ type: "admitted", id: "one", time: (started + 200) / 1000 }) + "\n")
  await write(path.join(verification, "VERIFICATION.json"), {
    version: 1, kind: "programbench", verifier: task.verifier, checkpoint, deadline: admission.deadline, started: started + 1000,
    terminal: { task: task.id, execution: path.basename(execution), action: "submit" },
  })
  await write(path.join(verification, "FENCED.json"), {
    acknowledged: true, source: official, deadline: admission.deadline, exitCode: valid ? 0 : 1,
  })
  await write(path.join(official, "control.json"), {
    deadline: admission.deadline, token: "1".repeat(32), root: official, workspace: path.join(verification, "workspace"),
    worker: { pid: identity.pid, start: identity.birth },
  })
  await write(path.join(official, "FENCE.json"), {
    acknowledged: true, errors: [], reason: "complete", token: "1".repeat(32), workerGroup: identity.pid, time: (started + 2000) / 1000,
  })
  const archive = path.join(official, "submission", assignment.instance, "submission.tar.gz")
  await Bun.write(archive, "scripted subject, not a real grader invocation")
  const subjectHash = Bun.SHA256.hash(await Bun.file(archive).bytes(), "hex")
  await write(path.join(official, "SUBJECT.json"), { archive, sha256: subjectHash })
  const operation = path.join(official, "operations", "2".repeat(32) + ".json")
  const detached = path.join(official, "operations", "3".repeat(32) + ".json")
  const stdout = path.join(official, "operations", "3".repeat(32) + ".stdout")
  const exported = path.join(official, "operations", "4".repeat(32) + ".json")
  for (const [file, argv, returncode] of [
    [operation, ["exec", "5".repeat(64), "false"], 1],
    [detached, ["run", "-d", "fixture-image", "sleep", "60"], 0],
    [exported, ["cp", "5".repeat(64) + ":/results.xml", path.join(official, "tmp", "results.xml")], 0],
  ] as const) await write(file, {
    pid: identity.pid, identity: { pid: identity.pid, start: identity.birth }, argv,
    phase: "finished", returncode, started: (started + 1100) / 1000, finished: (started + 1900) / 1000,
  })
  // The real frozen bridge retains run/create stdout, but removes cp tar files
  // before writing a finished receipt. Fixture layout follows that producer.
  await Bun.write(stdout, "5".repeat(64) + "\n")
  const artifacts = Object.fromEntries(await Promise.all(["FENCE.json", "SUBJECT.json"].map(async (name) => [
    name, { path: path.join(official, name), sha256: Bun.SHA256.hash(await Bun.file(path.join(official, name)).bytes(), "hex") },
  ])))
  await write(path.join(official, "RESULT.json"), {
    version: 1, passed: valid ? 2 : null, total: valid ? 3 : null, valid,
    failure: valid ? null : "invalid_evaluation", terminalFailure: null, officialError: null,
    stage: "complete", executedTests: valid ? 3 : 2, subjectHash, instance: assignment.instance,
    configHash: task.verifier.programbench.configuration.sha256, deadline: admission.deadline,
    cleanupAcknowledged: true, scoringTrust: "official-programbench-normal-use", hostileCandidateQualified: false,
    label: "opencode.rsi-grade=" + "1".repeat(32), artifacts,
  })
  if (valid) await write(path.join(directory, "campaign", "FINAL_SCORE.json"), {
    task: task.id, checkpoint, root: verification, result: { passed: 2, total: 3, valid: true },
  })
  const input = {
    directory, admission, assignment, task, checkpoint, aborted: false,
    hostError: valid ? undefined : `Error: Unavailable or mismatched official evidence: ${official}`,
    summary: { contract: "escalated", proposals: 0, comparisons: 0, selectedMethod: "seed", seedMethod: "seed" },
  }
  return { input, root, execution, verification, official, identity, operation, detached, stdout, exported }
}

export async function change(file: string, values: Record<string, unknown>) {
  await write(file, { ...await Bun.file(file).json(), ...values })
}

export async function addEvaluations(value: Awaited<ReturnType<typeof fixture>>) {
  const started = value.input.admission.started
  const execution = path.join(value.input.directory, "campaign", "executions", "candidate-native")
  await fs.cp(value.execution, execution, { recursive: true })
  await change(path.join(execution, "FENCED.json"), { time: started + 300 })
  await change(path.join(execution, "admission", "input.json"), { evaluation: true })
  await Bun.write(path.join(execution, "requests.jsonl"), JSON.stringify({ type: "admitted", id: "candidate", time: (started + 100) / 1000 }) + "\n")
  const verification = path.join(value.input.directory, "campaign", "verifications", "candidate-grade")
  await fs.cp(value.verification, verification, { recursive: true })
  // Rebase fixture identities; this is synthetic evidence, never a copied real
  // score or an invocation of the official grader.
  for await (const file of new Bun.Glob("**/*.json").scan({ cwd: verification, absolute: true }))
    await Bun.write(file, (await Bun.file(file).text()).replaceAll(value.verification, verification))
  await change(path.join(verification, "VERIFICATION.json"), { terminal: null, started: started + 350 })
  await change(path.join(verification, "FENCED.json"), { exitCode: 0 })
  await change(path.join(verification, "official", "RESULT.json"), { valid: true, passed: 2, total: 3, failure: null })
  await change(path.join(verification, "official", "FENCE.json"), { time: (started + 450) / 1000 })
  for (const name of [value.operation, value.detached, value.exported])
    await change(path.join(verification, "official", "operations", path.basename(name)), { started: (started + 375) / 1000, finished: (started + 425) / 1000 })
  const local = path.join(value.input.directory, "campaign", "verifications", "local-safety")
  const verifier = { directory: path.join(value.input.directory, "campaign", "checkpoints", "local-checker"), command: ["/usr/bin/python3", "/verifier/judge.py"] }
  await change(path.join(value.input.directory, "campaign", "FROZEN.json"), { tests: [{ verifier: value.input.task.verifier }, { verifier }] })
  await fs.mkdir(local)
  await write(path.join(local, "VERIFICATION.json"), {
    version: 1, kind: "local", verifier, checkpoint: value.input.checkpoint, deadline: value.input.admission.deadline,
    terminal: null, started: started + 200,
  })
  await write(path.join(local, "FENCED.json"), {
    acknowledged: true, wrapper: value.identity, deadline: value.input.admission.deadline, exitCode: 0, time: started + 250,
  })
  await write(path.join(local, "stdout.json"), { valid: true, passed: 1, total: 1 })
  return { execution, verification, local }
}

export async function addRefusal(value: Awaited<ReturnType<typeof fixture>>) {
  await fs.rm(path.join(value.input.directory, "campaign", "verifications"), { recursive: true })
  await fs.rm(path.join(value.execution, "state", "result.json"))
  await fs.rm(path.join(value.input.directory, "campaign", "FINAL_SCORE.json"), { force: true })
  await change(path.join(value.input.directory, "campaign", "FROZEN.json"), { tests: [] })
  await write(path.join(value.root, "FROZEN.json"), { sdkDirectory: path.resolve(import.meta.dir, "../..") })
  value.input.hostError = `Error: Native worker failed; inspect ${value.execution}`
  const event = { error: { message: "Invalid prompt: potentially violating our usage policy. Please try again with a different prompt", type: null, code: "400" } }
  const records = [
    { type: "admitted", id: "refused", time: (value.input.admission.started + 100) / 1000 },
    { type: "provider-error", id: "refused", time: (value.input.admission.started + 200) / 1000, status: 200, body: JSON.stringify(event), event },
    { type: "finished", id: "refused", time: (value.input.admission.started + 300) / 1000, complete: false, usage: null, usageIncomplete: true, cost: null },
  ]
  await Bun.write(path.join(value.execution, "requests.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n")
  return records
}

async function write(file: string, value: unknown) {
  await Bun.write(file, JSON.stringify(value))
}

if (import.meta.main) {
  const value = await fixture(process.argv.includes("--valid"), process.env.PROGRAMBENCH_FIXTURE_ROOT)
  if (process.argv.includes("--mixed")) await addEvaluations(value)
  if (process.argv.includes("--refusal")) await addRefusal(value)
  const result = await Endpoint.finish(value.input)
  await write(path.join(value.root, "FIXTURE.json"), { directory: value.input.directory, allocation: value.input.assignment, admission: value.input.admission, returncode: result.endpoint.outcome === "scored" ? 0 : 1 })
  console.log(JSON.stringify({ root: value.root, outcome: result.endpoint.outcome, errors: result.classification.errors }))
}
