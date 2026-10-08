export * as Endpoint from "./endpoint"

import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"

type ObjectValue = Record<string, unknown>
type Reference = { path: string; sha256: string }
type Artifact = Reference & { kind: string }
export type Admission = {
  version: number
  id: string
  admissionID: string
  cohortToken: string
  cohortRoot: string
  started: number
  deadline: number
}
export type Assignment = { id: string; instance: string; profile: Reference; task: Reference }
type Input = {
  directory: string
  admission: Admission
  assignment: Assignment
  task: { id: string; total: number; verifier: { programbench: { instance: string; configuration: Reference } } }
  checkpoint?: string
  aborted: boolean
  hostError?: string
  summary: {
    contract: string
    proposals: number
    comparisons: number
    selectedMethod: string
    seedMethod: string
  }
}

/** An endpoint is an operator receipt, not an RSI verifier result. Invalid
 * grading never becomes a zero, a discharge, a retry, or learning feedback. */
export async function finish(input: Input) {
  const artifacts: Artifact[] = []
  const predicates: Record<string, boolean> = {}
  const errors: string[] = []
  const cleanup = { native: { acknowledged: false }, official: { acknowledged: false } }
  const state: { score?: { passed: number; total: number; valid: true }; verification?: string; invalid?: boolean } = {}
  const check = (name: string, condition: boolean) => {
    predicates[name] = condition
    if (!condition) throw new Error(name)
  }
  const read = async (file: string, kind: string) => {
    const reference = await owned(input.directory, file, kind, input.admission.started)
    artifacts.push(reference)
    return object(JSON.parse(await Bun.file(reference.path).text()))
  }
  try {
    check("allocation.identity", input.directory === path.join(input.admission.cohortRoot, "runs", input.admission.id)
      && input.assignment.id === input.admission.id && input.admission.version === 1)
    check("admission.interval", Number.isSafeInteger(input.admission.started) && Number.isSafeInteger(input.admission.deadline)
      && input.admission.deadline === input.admission.started + 21600000)
    check("admission.tokens", /^[a-f0-9]{32}$/.test(input.admission.admissionID) && /^[a-f0-9]{32}$/.test(input.admission.cohortToken))
    const admission = await read(path.join(input.directory, "ADMISSION.json"), "admission")
    check("admission.unchanged", ["id", "admissionID", "cohortToken", "cohortRoot", "started", "deadline"].every(
      (key) => admission[key] === input.admission[key as keyof Admission],
    ))
    const admitted = await read(path.join(input.directory, "ADMITTED.json"), "task-admission")
    check("task.admission", admitted.id === input.admission.id && admitted.admissionID === input.admission.admissionID
      && admitted.deadline === input.admission.deadline && object(admitted.task).id === input.task.id
      && object(admitted.profile).sha256 === input.assignment.profile.sha256
      && object(admitted.taskReference).sha256 === input.assignment.task.sha256)
    check("instance.identity", input.assignment.instance === input.task.verifier.programbench.instance)
    const frozen = await read(path.join(input.directory, "campaign", "FROZEN.json"), "campaign-configuration")
    check("campaign.tests", Array.isArray(frozen.tests))
    const tests = (frozen.tests as unknown[]).map(object)
    const executions = await directories(path.join(input.directory, "campaign", "executions"))
    check("native.present", executions.length > 0)
    const natives = await gather(executions.map(async (execution) => {
      const ownership = await read(path.join(execution, "OWNERSHIP.json"), "native-ownership")
      const fence = await read(path.join(execution, "FENCED.json"), "native-fence")
      const admitted = await read(path.join(execution, "admission", "input.json"), "native-admission")
      check(`native.${path.basename(execution)}.deadline`, ownership.deadline === input.admission.deadline
        && fence.deadline === input.admission.deadline && admitted.deadline === input.admission.deadline
        && typeof admitted.evaluation === "boolean")
      check(`native.${path.basename(execution)}.acknowledged`, fence.acknowledged === true
        && fence.wrapperExited === true && fence.runtimeExited === true && fence.gatewayExited === true)
      for (const role of ["wrapper", "runtime", "gateway"]) {
        const identity = object(ownership[role])
        check(`native.${path.basename(execution)}.${role}.identity`, identity.pid === object(fence[role]).pid
          && identity.birth === object(fence[role]).birth && (role !== "wrapper" || identity.pid === fence.pid))
        check(`native.${path.basename(execution)}.${role}.exited`, await exited(identity))
      }
      check(`native.${path.basename(execution)}.time`, time(fence.time, input.admission.started, input.admission.deadline))
      return { execution, fence, admitted }
    }))
    cleanup.native.acknowledged = true
    const verifications = await directories(path.join(input.directory, "campaign", "verifications"))
    check("official.present", verifications.length > 0)
    const grades = await gather(verifications.map(async (verification) => {
      const link = await read(path.join(verification, "VERIFICATION.json"), "verification")
      check(`verification.${path.basename(verification)}.kind`, link.version === 1
        && (link.kind === "local" || link.kind === "programbench") && link.deadline === input.admission.deadline
        && time(link.started, input.admission.started, input.admission.deadline))
      check(`verification.${path.basename(verification)}.frozen-verifier`, link.terminal === null
        ? tests.some((test) => JSON.stringify(test.verifier) === JSON.stringify(link.verifier))
        : JSON.stringify(link.verifier) === JSON.stringify(input.task.verifier))
      if (link.kind === "local") {
        const fence = await read(path.join(verification, "FENCED.json"), "local-verifier-fence")
        const score = await read(path.join(verification, "stdout.json"), "local-verifier-result")
        check(`local.${path.basename(verification)}.nonterminal`, link.terminal === null)
        check(`local.${path.basename(verification)}.acknowledged`, fence.acknowledged === true && fence.exitCode === 0
          && fence.deadline === input.admission.deadline && time(fence.time, Number(link.started), input.admission.deadline)
          && await exited(object(fence.wrapper)))
        check(`local.${path.basename(verification)}.valid`, score.valid === true && Number.isSafeInteger(score.total)
          && Number(score.total) > 0 && Number.isSafeInteger(score.passed) && Number(score.passed) >= 0
          && Number(score.passed) <= Number(score.total))
        return { verification, link, score, fence, wrapper: fence, completed: Number(fence.time) }
      }
      const official = path.join(verification, "official")
      const fence = await read(path.join(official, "FENCE.json"), "official-fence")
      const wrapper = await read(path.join(verification, "FENCED.json"), "official-wrapper-fence")
      const score = await read(path.join(official, "RESULT.json"), "official-result")
      const control = await read(path.join(official, "control.json"), "official-control")
      const verifier = object(object(link.verifier).programbench)
      check(`official.${path.basename(verification)}.verifier`, score.instance === verifier.instance
        && score.configHash === object(verifier.configuration).sha256 && (link.terminal !== null || score.valid === true))
      check(`official.${path.basename(verification)}.acknowledged`, score.cleanupAcknowledged === true && fence.acknowledged === true
        && wrapper.acknowledged === true && Array.isArray(fence.errors) && fence.errors.length === 0)
      check(`official.${path.basename(verification)}.ownership`, wrapper.source === official && control.root === official
        && control.workspace === path.join(verification, "workspace") && typeof fence.token === "string"
        && /^[a-f0-9]{32}$/.test(fence.token) && control.token === fence.token
        && score.label === `opencode.rsi-grade=${fence.token}` && fence.workerGroup === object(control.worker).pid)
      check(`official.${path.basename(verification)}.deadline`, link.deadline === input.admission.deadline
        && score.deadline === input.admission.deadline && control.deadline === input.admission.deadline
        && wrapper.deadline === input.admission.deadline)
      check(`official.${path.basename(verification)}.worker-exited`, await exited(object(control.worker), "start"))
      return { verification, link, score, fence, wrapper, completed: Number(fence.time) * 1000 }
    }))
    cleanup.official.acknowledged = true
    const terminal = grades.filter((grade) => grade.link.terminal !== null)
    check("terminal.unique", terminal.length === 1)
    const grade = terminal[0]!
    const link = object(grade.link.terminal)
    check("terminal.link", grade.link.version === 1 && grade.link.kind === "programbench" && link.task === input.task.id
      && (link.action === "submit" || link.action === "blocked") && typeof link.execution === "string"
      && grade.link.checkpoint === input.checkpoint && typeof input.checkpoint === "string" && /^[a-f0-9]{64}$/.test(input.checkpoint))
    const native = natives.find((entry) => path.basename(entry.execution) === link.execution)
    check("terminal.original-native", native !== undefined && native.admitted.evaluation === false)
    const handoff = await read(path.join(native!.execution, "state", "result.json"), "native-handoff")
    check("terminal.handoff", handoff.action === link.action)
    check("terminal.in-time", time(grade.link.started, input.admission.started, input.admission.deadline)
      && typeof native!.fence.time === "number" && native!.fence.time <= Number(grade.link.started)
      && time(Number(grade.fence.time) * 1000, Number(grade.link.started), input.admission.deadline))
    // All solver executions, including candidate-panel executions, must precede
    // the terminal grader. Its private outcome cannot steer later solving.
    check("terminal.no-later-execution", natives.every((entry) => Number(entry.fence.time) <= Number(grade.link.started)))
    check("terminal.no-later-evaluation", grades.every((entry) => entry === grade || entry.completed <= Number(grade.link.started)))
    for (const entry of natives) {
      const journal = await owned(input.directory, path.join(entry.execution, "requests.jsonl"), "provider-journal", input.admission.started)
      artifacts.push(journal)
      for await (const line of createInterface({ input: createReadStream(journal.path), crlfDelay: Infinity })) {
        if (!line) continue
        const request = object(JSON.parse(line))
        if (request.type === "admitted" || request.type === "tool-admitted")
          check(`terminal.no-later-admission.${path.basename(entry.execution)}.${String(request.id ?? request.pid)}`,
            time(Number(request.time) * 1000, input.admission.started, Math.min(Number(entry.fence.time), Number(grade.link.started))))
      }
    }
    const official = path.join(grade.verification, "official")
    const subject = await read(path.join(official, "SUBJECT.json"), "official-subject")
    check("official.identity", grade.score.version === 1 && grade.score.instance === input.assignment.instance
      && grade.score.configHash === input.task.verifier.programbench.configuration.sha256
      && grade.score.scoringTrust === "official-programbench-normal-use" && grade.score.hostileCandidateQualified === false)
    check("official.completed", grade.score.stage === "complete" && grade.fence.reason === "complete"
      && Number.isSafeInteger(grade.score.executedTests) && Number(grade.score.executedTests) >= 0)
    check("official.subject-path", typeof subject.archive === "string"
      && subject.archive === path.join(official, "submission", input.assignment.instance, "submission.tar.gz"))
    const archive = await owned(input.directory, String(subject.archive), "subject-archive", input.admission.started)
    artifacts.push(archive)
    check("official.subject-hash", archive.sha256 === subject.sha256 && subject.sha256 === grade.score.subjectHash)
    const references = object(grade.score.artifacts)
    for (const name of ["FENCE.json", "SUBJECT.json"]) {
      const reference = object(references[name])
      const file = artifacts.find((item) => item.path === path.join(official, name))!
      check(`official.artifact.${name}`, reference.path === file.path && reference.sha256 === file.sha256)
    }
    const operations = await fs.readdir(path.join(official, "operations"))
    check("official.operations-present", operations.length > 0 && operations.every((name) => name.endsWith(".json")))
    for (const name of operations) {
      const operation = await read(path.join(official, "operations", name), "official-operation")
      check(`official.operation.${name}`, operation.phase === "finished" && Number.isSafeInteger(operation.returncode) && Number(operation.returncode) >= 0
        && time(Number(operation.started) * 1000, Number(grade.link.started), input.admission.deadline)
        && time(Number(operation.finished) * 1000, Number(operation.started) * 1000, input.admission.deadline))
    }
    check("terminal.not-cancelled", !input.aborted && !await Bun.file(path.join(input.admission.cohortRoot, "CANCEL")).exists()
      && !await Bun.file(path.join(input.directory, "campaign", "CANCEL")).exists())
    check("terminal.before-deadline", Date.now() <= input.admission.deadline)
    if (grade.score.valid === true) {
      check("score.bounds", Number.isSafeInteger(grade.score.passed) && grade.score.total === input.task.total
        && Number(grade.score.passed) >= 0 && Number(grade.score.passed) <= input.task.total && grade.wrapper.exitCode === 0)
      check("score.host-returned", input.hostError === undefined)
      const final = await read(path.join(input.directory, "campaign", "FINAL_SCORE.json"), "final-score")
      const result = object(final.result)
      check("score.final-link", final.task === input.task.id && final.checkpoint === input.checkpoint && final.root === grade.verification
        && result.valid === true && result.passed === grade.score.passed && result.total === grade.score.total)
      state.score = { passed: Number(grade.score.passed), total: input.task.total, valid: true }
    } else {
      check("unknown.exact-invalid-class", grade.score.valid === false && grade.score.passed === null && grade.score.total === null
        && grade.score.failure === "invalid_evaluation" && grade.score.terminalFailure === null && grade.score.officialError === null
        && grade.wrapper.exitCode === 1)
      check("unknown.not-accepted", input.hostError === `Error: Unavailable or mismatched official evidence: ${official}`
        && input.summary.contract !== "discharged"
        && !await Bun.file(path.join(input.directory, "campaign", "FINAL_SCORE.json")).exists())
      state.invalid = true
    }
    state.verification = grade.verification
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  const outcome = errors.length ? (input.aborted ? "cancelled" : "execution-fault")
    : state.score ? "scored" : state.invalid ? "invalid-official-score" : "execution-fault"
  const finished = Date.now()
  const identity = {
    version: 1,
    id: input.admission.id,
    admissionID: input.admission.admissionID,
    cohortToken: input.admission.cohortToken,
    instance: input.assignment.instance,
    deadline: input.admission.deadline,
    profileSha256: input.assignment.profile.sha256,
    taskSha256: input.assignment.task.sha256,
    outcome,
    finished,
  }
  const result = {
    ...identity,
    valid: outcome === "scored",
    score: outcome === "scored" ? state.score : { passed: null, total: null, valid: false },
    verification: state.verification ?? null,
    ...input.summary,
    delivered: outcome === "scored" && input.summary.contract === "discharged",
    adopted: input.summary.selectedMethod !== input.summary.seedMethod,
  }
  await write(path.join(input.directory, "RESULT.json"), result)
  artifacts.push(await owned(input.directory, path.join(input.directory, "RESULT.json"), "result", input.admission.started))
  const classification = { ...identity, eligible: outcome === "scored" || outcome === "invalid-official-score", predicates, errors }
  await write(path.join(input.directory, "CLASSIFICATION.json"), classification)
  artifacts.push(await owned(input.directory, path.join(input.directory, "CLASSIFICATION.json"), "classification", input.admission.started))
  const endpoint = { ...identity, cleanup, artifacts }
  await write(path.join(input.directory, "ENDPOINT.json"), endpoint)
  return { endpoint, classification, result }
}

function object(value: unknown): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a JSON object")
  return value as ObjectValue
}

function time(value: unknown, start: number, end: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= start && value <= end
}

async function owned(root: string, file: string, kind: string, started: number): Promise<Artifact> {
  if (path.resolve(file) !== file || !file.startsWith(root + path.sep) || await fs.realpath(file) !== file)
    throw new Error(`Artifact is not canonical within its allocation: ${kind}`)
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.uid !== process.getuid!() || stat.mtimeMs + 1 < started)
    throw new Error(`Artifact is nonregular, foreign or stale: ${kind}`)
  const hash = new Bun.CryptoHasher("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return { kind, path: file, sha256: hash.digest("hex") }
}

async function directories(root: string) {
  return (await fs.readdir(root, { withFileTypes: true })).map((entry) => {
    if (!entry.isDirectory()) throw new Error("Non-directory in host execution catalog")
    return path.join(root, entry.name)
  }).sort()
}

async function exited(identity: ObjectValue, birth = "birth") {
  if (!Number.isSafeInteger(identity.pid) || Number(identity.pid) <= 1 || typeof identity[birth] !== "string"
    || !/^\d+$/.test(String(identity[birth]))) throw new Error("Missing process PID/birth identity")
  const stat = await fs.readFile(`/proc/${identity.pid}/stat`, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return undefined
    throw error
  })
  if (stat === undefined) return true
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)
  if (!fields[19]) throw new Error("Malformed process identity")
  return fields[19] !== identity[birth] || fields[0] === "Z" || fields[0] === "X"
}

async function write(file: string, value: unknown) {
  await Bun.write(file + ".tmp", JSON.stringify(value, null, 2) + "\n")
  await fs.rename(file + ".tmp", file)
}

async function gather<T>(promises: Promise<T>[]) {
  const results = await Promise.allSettled(promises)
  const failure = results.find((result) => result.status === "rejected")
  if (failure?.status === "rejected") throw failure.reason
  return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
}
