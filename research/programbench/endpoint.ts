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
export type Input = {
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
type Observation = { diagnostic: true; observedAt: number; cancelled: boolean }

/** An endpoint is an operator receipt, not an RSI verifier result. Invalid
 * grading never becomes a zero, a discharge, a retry, or learning feedback. */
export async function finish(input: Input) {
  const inspected = await classify(input)
  const identity = {
    version: 1,
    id: input.admission.id,
    admissionID: input.admission.admissionID,
    cohortToken: input.admission.cohortToken,
    instance: input.assignment.instance,
    deadline: input.admission.deadline,
    profileSha256: input.assignment.profile.sha256,
    taskSha256: input.assignment.task.sha256,
    outcome: inspected.outcome,
    finished: Date.now(),
  }
  const result = {
    ...identity,
    valid: inspected.outcome === "scored",
    score: inspected.score,
    verification: inspected.verification,
    ...input.summary,
    delivered: inspected.outcome === "scored" && input.summary.contract === "discharged",
    adopted: input.summary.selectedMethod !== input.summary.seedMethod,
  }
  await write(path.join(input.directory, "RESULT.json"), result)
  inspected.artifacts.push(await owned(input.directory, path.join(input.directory, "RESULT.json"), "result", input.admission.started))
  const classification = { ...identity, eligible: inspected.eligible, predicates: inspected.predicates, errors: inspected.errors }
  await write(path.join(input.directory, "CLASSIFICATION.json"), classification)
  inspected.artifacts.push(await owned(input.directory, path.join(input.directory, "CLASSIFICATION.json"), "classification", input.admission.started))
  if (inspected.cleanup.official.state === "not-admitted") {
    const file = path.join(input.directory, "VERIFICATION-INVENTORY.json")
    await write(file, { ...identity, state: "not-admitted", admitted: [], directory: path.join(input.directory, "campaign", "verifications") })
    inspected.artifacts.push(await owned(input.directory, file, "verification-inventory", input.admission.started))
  }
  const endpoint = { ...identity, cleanup: inspected.cleanup, artifacts: inspected.artifacts }
  await write(path.join(input.directory, "ENDPOINT.json"), endpoint)
  return { endpoint, classification, result }
}

/** Read-only diagnostics, never a publishable endpoint or retroactive admission.
 * A recorded observation can explain historical receipts after their deadline
 * or cancellation, without changing the live publisher's clock or fence gates. */
export async function inspect(input: Input, observation?: Observation) {
  const inspected = await classify(input, observation)
  return {
    diagnostic: true as const,
    observation: observation ?? null,
    classification: {
      outcome: inspected.outcome,
      eligible: inspected.eligible,
      predicates: inspected.predicates,
      errors: inspected.errors,
    },
    cleanup: inspected.cleanup,
    artifacts: inspected.artifacts,
    score: inspected.score,
    verification: inspected.verification,
  }
}

async function classify(input: Input, observation?: Observation) {
  const artifacts: Artifact[] = []
  const predicates: Record<string, boolean> = {}
  const errors: string[] = []
  const cleanup = { native: { acknowledged: false }, official: { acknowledged: false, state: "unverified", admitted: 0 } }
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
    check("observation.valid", observation === undefined || observation.diagnostic === true
      && Number.isSafeInteger(observation.observedAt) && observation.observedAt >= input.admission.started
      && typeof observation.cancelled === "boolean")
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
    const verifications = await directories(path.join(input.directory, "campaign", "verifications")).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
      throw error
    })
    cleanup.official.admitted = verifications.length
    // Absence is distinct from a started grader whose fence is missing. Once
    // native execution is fenced, no verifier can subsequently be admitted.
    if (!verifications.length) cleanup.official = { acknowledged: true, state: "not-admitted", admitted: 0 }
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
      return { execution, fence, admitted }
    }))
    cleanup.native.acknowledged = true
    for (const native of natives)
      check(`native.${path.basename(native.execution)}.time`, time(native.fence.time, input.admission.started, input.admission.deadline))
    if (!verifications.length) {
      check("refusal.task-only", tests.length === 0 && natives.every((native) => native.admitted.evaluation === false))
      const rejected = await providerRefusal(input, natives, artifacts)
      check("refusal.host-failure", input.hostError === `Error: Native worker failed; inspect ${rejected.execution}`
        && input.summary.contract === "escalated" && input.summary.proposals === 0 && input.summary.comparisons === 0
        && input.summary.selectedMethod === input.summary.seedMethod)
      check("refusal.no-score", !await Bun.file(path.join(input.directory, "campaign", "FINAL_SCORE.json")).exists())
      check("terminal.not-cancelled", !input.aborted && (observation ? !observation.cancelled
        : !await Bun.file(path.join(input.admission.cohortRoot, "CANCEL")).exists()
          && !await Bun.file(path.join(input.directory, "campaign", "CANCEL")).exists()))
      check("terminal.before-deadline", (observation?.observedAt ?? Date.now()) <= input.admission.deadline)
      predicates["refusal.witnessed-nonretryable"] = true
      return {
        outcome: "provider-refusal", eligible: true, predicates, errors, cleanup, artifacts,
        score: { passed: null, total: null, valid: false }, verification: null,
      }
    }
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
    cleanup.official.state = "fenced"
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
    const operations = await fs.readdir(path.join(official, "operations"), { withFileTypes: true })
    check("official.operations-present", operations.some((entry) => entry.name.endsWith(".json")))
    check("official.operations-inventory", operations.every((entry) => entry.isFile()
      && /^[a-f0-9]{32}\.(json|stdout)$/.test(entry.name)))
    const receipts = operations.filter((entry) => entry.name.endsWith(".json")).map((entry) => entry.name).sort()
    const companions = new Set(operations.filter((entry) => entry.name.endsWith(".stdout")).map((entry) => entry.name))
    check("official.operations-companions", [...companions].every((name) => receipts.includes(name.replace(/\.stdout$/, ".json"))))
    for (const name of receipts) {
      const operation = await read(path.join(official, "operations", name), "official-operation")
      check(`official.operation.${name}`, operation.phase === "finished" && Number.isSafeInteger(operation.returncode) && Number(operation.returncode) >= 0
        && time(Number(operation.started) * 1000, Number(grade.link.started), input.admission.deadline)
        && time(Number(operation.finished) * 1000, Number(operation.started) * 1000, input.admission.deadline))
      check(`official.operation.${name}.argv`, Array.isArray(operation.argv) && operation.argv.length > 0
        && operation.argv.every((argument) => typeof argument === "string"))
      const argv = operation.argv as string[]
      const companion = name.replace(/\.json$/, ".stdout")
      // The frozen producer retains create output only for `run -d`. Its cp
      // archive is removed before a receipt can reach the finished phase.
      check(`official.operation.${name}.companion`, argv[0] === "run"
        ? argv[1] === "-d" && companions.has(companion)
        : !companions.has(companion))
      if (argv[0] === "run") {
        const stdout = await owned(input.directory, path.join(official, "operations", companion), "official-operation-stdout", Number(operation.started) * 1000)
        artifacts.push(stdout)
        check(`official.operation.${name}.container`, /^[a-f0-9]{12,64}$/.test((await Bun.file(stdout.path).text()).trim()))
      }
    }
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
    // Keep live gates after all receipt reads and immediately before returning
    // to the publisher. Only read-only inspection accepts a historical context.
    check("terminal.not-cancelled", !input.aborted && (observation ? !observation.cancelled
      : !await Bun.file(path.join(input.admission.cohortRoot, "CANCEL")).exists()
        && !await Bun.file(path.join(input.directory, "campaign", "CANCEL")).exists()))
    check("terminal.before-deadline", (observation?.observedAt ?? Date.now()) <= input.admission.deadline)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  const outcome = errors.length ? (input.aborted ? "cancelled" : "execution-fault")
    : state.score ? "scored" : state.invalid ? "invalid-official-score" : "execution-fault"
  return {
    outcome,
    eligible: outcome === "scored" || outcome === "invalid-official-score",
    predicates,
    errors,
    cleanup,
    artifacts,
    score: outcome === "scored" ? state.score : { passed: null, total: null, valid: false },
    verification: state.verification ?? null,
  }
}

/** Only authenticated host gateway journals can witness a refusal; Session text
 * and candidate-owned failure reports are never used for this classification. */
async function providerRefusal(
  input: Input,
  natives: { execution: string; fence: ObjectValue }[],
  artifacts: Artifact[],
) {
  const frozen = object(await Bun.file(path.join(input.admission.cohortRoot, "FROZEN.json")).json())
  if (typeof frozen.sdkDirectory !== "string" || !path.isAbsolute(frozen.sdkDirectory)
    || await fs.realpath(frozen.sdkDirectory) !== frozen.sdkDirectory) throw new Error("Missing canonical frozen provider classifier")
  const { classifyProviderFailure } = await import(path.join(frozen.sdkDirectory, "packages/ai/src/provider-error.ts"))
  const admissions: { execution: string; id: string; time: number }[] = []
  const refusals: { execution: string; id: string; time: number }[] = []
  for (const native of natives) {
    const journal = await owned(input.directory, path.join(native.execution, "requests.jsonl"), "provider-journal", input.admission.started)
    artifacts.push(journal)
    const pending = new Map<string, ObjectValue>()
    const completed = new Set<string>()
    for await (const line of createInterface({ input: createReadStream(journal.path), crlfDelay: Infinity })) {
      if (!line) continue
      const event = object(JSON.parse(line))
      if (!["admitted", "provider-error", "finished"].includes(String(event.type))) continue
      if (typeof event.id !== "string" || !time(Number(event.time) * 1000, input.admission.started, Number(native.fence.time)))
        throw new Error("Unbound or out-of-time provider record")
      if (event.type === "admitted") {
        if (pending.has(event.id)) throw new Error("Duplicate provider admission")
        pending.set(event.id, event)
        admissions.push({ execution: native.execution, id: event.id, time: Number(event.time) })
        continue
      }
      if (!pending.has(event.id) || completed.has(event.id)) throw new Error("Unmatched provider record")
      if (event.type === "finished") {
        completed.add(event.id)
        if (refusals.some((refusal) => refusal.execution === native.execution && refusal.id === event.id)
          && (event.complete !== false || event.usage !== null || event.usageIncomplete !== true || event.cost !== null))
          throw new Error("Refusal must preserve unknown usage and no successful completion")
        continue
      }
      if (typeof event.body !== "string" || !Number.isSafeInteger(event.status)
        || Number(event.status) < 100 || Number(event.status) > 599) throw new Error("Provider error lacks original body/status")
      const body = object(JSON.parse(event.body))
      if (JSON.stringify(body) !== JSON.stringify(event.event)) throw new Error("Provider event and original body disagree")
      const raw = body.error ?? object(body.response ?? {}).error
      const error = typeof raw === "string" ? { message: raw } : object(raw ?? {})
      const message = typeof body.message === "string" ? body.message : error.message
      if (typeof message !== "string") continue
      if (classifyProviderFailure({ message, status: Number(event.status), rawBody: event.body })._tag === "ContentPolicy")
        refusals.push({ execution: native.execution, id: event.id, time: Number(event.time) })
    }
    if (pending.size !== completed.size) throw new Error("Unfinished provider accounting")
  }
  if (refusals.length !== 1) throw new Error("Exactly one host-witnessed policy refusal required")
  const refusal = refusals[0]!
  const last = admissions.sort((a, b) => a.time - b.time).at(-1)
  if (!last || last.id !== refusal.id || last.execution !== refusal.execution
    || admissions.some((admission) => admission.time > refusal.time)) throw new Error("Provider work admitted after refusal")
  for (const native of natives) {
    const file = path.join(native.execution, "state", "result.json")
    if (native.execution === refusal.execution) {
      if (await Bun.file(file).exists()) throw new Error("Refused native execution also handed off")
      continue
    }
    const handoff = object(JSON.parse(await Bun.file(file).text()))
    if (handoff.action !== "checkpoint") throw new Error("Only fixed-method checkpoints may precede refusal")
    artifacts.push(await owned(input.directory, file, "native-handoff", input.admission.started))
  }
  return refusal
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
