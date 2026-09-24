import path from "node:path"
import { open } from "node:fs/promises"
import { digest, duration } from "./ledger"
import { put } from "./archive"
import { codeIdentity } from "./provenance"
import { infrastructure, type Infrastructure } from "./infrastructure"
import { lifecycleDevelopment } from "./lifecycle-scenarios"
import { readJournal } from "./host-journal"
import type { runInstance } from "./instance"

type Result = Awaited<ReturnType<typeof runInstance>>
type Failure = Partial<Result> & {
  instance?: string
  attempted?: boolean
  admitted?: boolean
  agreement?: Result["monitored"]["run"]["input"]
  failure?: string
  reason?: string
  contractID?: string
  cleanup?: { result?: Result }
  retained?: { hash?: string; evidence?: { runs?: Result["monitored"]["run"][] } }
  partial?: { status: string; value?: { data: Result["monitored"]["run"] }[] }[]
}

async function object(directory: string, hash: string): Promise<unknown> {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid terminal object reference")
  const bytes = await Bun.file(path.join(directory, "objects", hash)).text()
  if (digest(bytes) !== hash) throw new Error("Terminal evidence identity changed")
  return JSON.parse(bytes)
}

export async function cohortState(directory: string, codeHash: string) {
  const root = path.dirname(directory)
  const bytes = await Bun.file(path.join(root, "cohort.json")).text()
  const cohort = JSON.parse(bytes) as {
    mode: string
    configuration: {
      evaluation: string
      runner: string
      order: string[]
      infrastructure?: Infrastructure
      feedbackGuidance?: "closure:1"
    }
    instances: { id: string }[]
  }
  const policy = infrastructure(cohort.configuration.infrastructure, cohort.configuration.evaluation)
  const ids = lifecycleDevelopment().map((row) => row.packet.id)
  if (
    !policy ||
    cohort.mode !== "development-calibration" ||
    cohort.configuration.runner !== codeHash ||
    JSON.stringify(cohort.configuration.order) !== JSON.stringify(ids) ||
    JSON.stringify(cohort.instances.map((row) => row.id)) !== JSON.stringify(ids) ||
    !ids.includes(path.basename(directory))
  )
    throw new Error("Terminal sealing requires the explicitly versioned fixed cohort")
  const eventBytes = await Bun.file(path.join(root, "events.jsonl")).text()
  const rows = eventBytes
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          hash: string
          previous: string
          at: number
          id: string
          status: string
          evidence: string
        },
    )
  const chain = { hash: digest(bytes) }
  if (rows.length !== ids.length) throw new Error("Terminal cohort execution is incomplete")
  for (const [index, entry] of rows.entries()) {
    const { hash, ...row } = entry
    if (
      row.id !== ids[index] ||
      row.previous !== chain.hash ||
      digest(JSON.stringify(row)) !== hash ||
      !Number.isFinite(row.at)
    )
      throw new Error("Terminal cohort event chain changed")
    chain.hash = hash
    await object(root, row.evidence)
  }
  return {
    root,
    feedbackGuidance: cohort.configuration.feedbackGuidance,
    cohortHash: digest(bytes),
    eventsHash: digest(eventBytes),
    policy,
    rows,
  }
}

async function material(directory: string, codeHash: string) {
  const cohort = await cohortState(directory, codeHash)
  const row = cohort.rows.find((row) => row.id === path.basename(directory))!
  const original = (await object(cohort.root, row.evidence)) as Failure
  const archive = path.join(directory, "archive")
  const failure = original.retained?.hash ? ((await object(archive, original.retained.hash)) as Failure) : original
  if (original.retained?.hash && original.instance !== row.id)
    throw new Error("Failure wrapper belongs to another instance")
  if (
    failure.codeHash !== codeHash ||
    failure.evaluation !== "repair-lifecycle-v1" ||
    failure.feedbackGuidance !== cohort.feedbackGuidance ||
    (failure.agreement && failure.agreement.manifest?.feedbackGuidance !== cohort.feedbackGuidance) ||
    JSON.stringify(failure.infrastructure) !== JSON.stringify(cohort.policy)
  )
    throw new Error("Terminal runtime or policy differs")
  const read = async (name: string): Promise<unknown> =>
    (await Bun.file(path.join(directory, name)).exists())
      ? await Bun.file(path.join(directory, name)).json()
      : undefined
  const result = (await read("result.json")) as { result: Result } | undefined
  const cleanupFailure = (await read("cleanup-failure.json")) as { result?: Result } | undefined
  const scoring = (await read("scoring.json")) as { candidateAvailable?: boolean; resultHash: string } | undefined
  const admission = (await read("admission.json")) as
    | { issuedAt: number; deadline: number; agreement: Failure["agreement"] }
    | undefined
  const attempt = (await read("attempt.json")) as
    | {
        contractID: string
        issuedAt: number
        deadline: number
        codeHash: string
        infrastructure: Infrastructure
        feedbackGuidance?: "closure:1"
      }
    | undefined
  const audit = failure.auditHash
    ? ((await object(archive, failure.auditHash)) as {
        state: string
        capturedAt: number
        contractID: string
        cleanup?: { complete: boolean }
        runs?: Result["monitored"]["run"][]
        history?: { data: Result["monitored"]["run"] }[]
        contracts?: unknown[]
        sources?: { path: string; hash: string }[]
        files: { path: string; hash: string }[]
      })
    : undefined
  const runs = [
    failure.monitored?.run,
    result?.result.monitored.run,
    cleanupFailure?.result?.monitored.run,
    original.cleanup?.result?.monitored.run,
    ...(audit?.runs ?? []),
    ...(audit?.history ?? []).map((row) => row.data),
    ...(failure.retained?.evidence?.runs ?? []),
    ...(failure.partial?.[1]?.value ?? []).map((row) => row.data),
  ].filter((run) => run !== undefined)
  if (scoring?.candidateAvailable || runs.some((run) => run.subjectHash || run.bundleHash || run.stage === "ready"))
    throw new Error("An existing candidate cannot be downgraded to a terminal absence")
  if (await Bun.file(path.join(directory, "blind/sealed.json")).exists())
    throw new Error("Candidate judgments and terminal absence are mutually exclusive")
  if (scoring && (scoring.candidateAvailable !== false || scoring.resultHash !== row.evidence))
    throw new Error("Scoring failure is not proof of candidate absence")
  const contractID = "pct_eval_" + row.id
  if (
    (failure.contractID !== undefined && failure.contractID !== contractID) ||
    runs.some((run) => run.id !== contractID) ||
    (audit && audit.contractID !== contractID)
  )
    throw new Error("Terminal evidence belongs to another research instance")
  const coordinates = admission ?? attempt ?? (failure.issuedAt !== undefined ? failure : undefined)
  if (
    coordinates &&
    (coordinates.issuedAt! + duration !== coordinates.deadline ||
      (failure.deadline !== undefined && failure.deadline !== coordinates.deadline) ||
      (failure.issuedAt !== undefined && failure.issuedAt !== coordinates.issuedAt))
  )
    throw new Error("Terminal original deadline changed")
  if (
    admission &&
    (admission.agreement?.id !== contractID ||
      admission.agreement.spec.budget.deadline !== admission.deadline ||
      JSON.stringify(admission.agreement) !== JSON.stringify(failure.agreement))
  )
    throw new Error("Terminal admission coordinates differ")
  if (
    attempt &&
    (attempt.contractID !== contractID ||
      attempt.codeHash !== codeHash ||
      attempt.feedbackGuidance !== cohort.feedbackGuidance ||
      JSON.stringify(attempt.infrastructure) !== JSON.stringify(cohort.policy) ||
      attempt.issuedAt !== coordinates?.issuedAt ||
      attempt.deadline !== coordinates?.deadline)
  )
    throw new Error("Terminal attempt identity changed")
  if (
    row.status === "not_started" &&
    (original.instance !== row.id ||
      failure.attempted !== false ||
      admission ||
      attempt ||
      !["cancelled_before_start", "prior_infrastructure_failure"].includes(failure.reason ?? ""))
  )
    throw new Error("Invalid unstarted terminal evidence")
  if (row.status !== "not_started" && !failure.monitored && !original.retained?.hash)
    throw new Error("Missing retained failure evidence")
  if (failure.transportHash) {
    const bytes = await Bun.file(path.join(archive, "objects", failure.transportHash)).text()
    if (digest(bytes) !== failure.transportHash) throw new Error("Terminal transport changed")
  }
  for (const source of [...(audit?.files ?? []), ...(audit?.sources ?? [])]) {
    if (
      digest(new Uint8Array(await Bun.file(path.join(archive, "objects", source.hash)).arrayBuffer())) !== source.hash
    )
      throw new Error("Terminal audit evidence changed")
    if (digest(new Uint8Array(await Bun.file(path.join(directory, source.path)).arrayBuffer())) !== source.hash)
      throw new Error("Terminal live evidence differs from retained cutoff")
  }
  const reference = (await read("terminal-ref.json")) as { hash: string } | undefined
  const scoreReference = (await read("score-ref.json")) as { hash: string } | undefined
  if (scoreReference) {
    const score = (await object(archive, scoreReference.hash)) as { resultHash: string }
    if (
      score.resultHash !== row.evidence ||
      digest(await Bun.file(path.join(directory, "score.json")).text()) !== scoreReference.hash
    )
      throw new Error("Terminal derivative score changed")
  }
  const names = [
    "attempt.json",
    "admission.json",
    "result.json",
    "failure.json",
    "cleanup-failure.json",
    "scoring.json",
    "scoring-ref.json",
    "host/issuance.jsonl",
    "host/operations.jsonl",
    "host/cleanup.json",
    ...(
      await Promise.all(
        ["host/operations.objects/*", "host/cleanup-*.json"].map((pattern) =>
          Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: directory, onlyFiles: true })).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return []
              throw error
            },
          ),
        ),
      )
    ).flat(),
    "host/opencode.db",
    "host/opencode.db-wal",
    "host/opencode.db-shm",
  ]
  const objects = await Array.fromAsync(
    new Bun.Glob("archive/objects/*").scan({ cwd: directory, onlyFiles: true }),
  ).catch(() => [])
  const inventory: Record<string, string | null> = {}
  for (const name of [
    ...names,
    ...objects.filter((name) => ![reference?.hash, scoreReference?.hash].includes(path.basename(name))),
  ].sort()) {
    const file = Bun.file(path.join(directory, name))
    inventory[name] = (await file.exists()) ? digest(new Uint8Array(await file.arrayBuffer())) : null
    if (
      (name.startsWith("archive/objects/") || name.startsWith("host/operations.objects/")) &&
      inventory[name] !== path.basename(name)
    )
      throw new Error("Terminal archive changed")
  }
  // Only responses on the private host channel establish observed run state. Raw reports can contain arbitrary JSON.
  const journal = path.join(directory, "host/operations.jsonl")
  const requests = new Map<string, { action?: string; contractID?: string; connectionID?: string }>()
  if (await Bun.file(journal).exists())
    for await (const event of readJournal(journal, cohort.policy.journal)) {
      if ((event.format === "cas:1") !== (cohort.policy.journal === "cas:1"))
        throw new Error("Journal policy differs from frozen infrastructure")
      if (event.event === "command_start") {
        if (!event.id || requests.has(event.id)) throw new Error("Duplicate host command identity")
        requests.set(event.id, event)
        continue
      }
      if (!["response", "late_response"].includes(event.event)) continue
      const request = requests.get(event.id ?? "")
      if (
        !request ||
        request.action !== event.action ||
        request.contractID !== event.contractID ||
        request.connectionID !== event.connectionID
      )
        throw new Error("Host response lost its command identity")
      requests.delete(event.id!)
      if (
        !["research-get", "research-history", "research-issue", "research-cancel", "research-recover"].includes(
          request.action!,
        )
      )
        continue
      if (request.contractID !== contractID) throw new Error("Host response belongs to another instance")
      const observed =
        request.action === "research-history"
          ? ((event.result as { data: Result["monitored"]["run"] }[] | undefined)?.map((item) => item.data) ?? [])
          : event.result
            ? [event.result as Result["monitored"]["run"]]
            : []
      if (observed.some((run) => run.id !== contractID)) throw new Error("Host run belongs to another instance")
      if (observed.some((run) => run.subjectHash || run.bundleHash || run.stage === "ready"))
        throw new Error("An observed candidate cannot be downgraded to a terminal absence")
    }
  return {
    version: "research-terminal:1" as const,
    rule: "candidate-or-terminal:1" as const,
    cohortHash: cohort.cohortHash,
    eventsHash: cohort.eventsHash,
    eventHash: row.hash,
    evidenceCutoff: row.at,
    instanceID: row.id,
    codeHash,
    infrastructure: cohort.policy,
    ...(cohort.feedbackGuidance ? { feedbackGuidance: cohort.feedbackGuidance } : {}),
    resultHash: row.evidence,
    status: row.status,
    reason: failure.failure ?? failure.reason ?? failure.monitored?.run.reason ?? "not_submitted",
    candidateStatus:
      row.status === "not_started" ||
      failure.monitored ||
      (audit?.state === "stable_copy" && audit.runs?.length === 0 && audit.contracts?.length === 0)
        ? ("absent_in_retained_state" as const)
        : ("unknown" as const),
    candidateQuality: "not_scored" as const,
    admission: failure.monitored
      ? "admitted"
      : failure.admitted
        ? "admitted"
        : failure.attempted
          ? "unknown"
          : "not_attempted",
    coordinates: coordinates
      ? { issuedAt: coordinates.issuedAt, deadline: coordinates.deadline }
      : row.status === "not_started"
        ? "not_created"
        : "unknown",
    cleanup: audit?.cleanup ?? "unknown",
    observationAt: audit?.capturedAt ?? null,
    inventory,
  }
}

export async function sealTerminal(directory: string) {
  const value = { ...(await material(directory, await codeIdentity())), sealedAt: Date.now() }
  const hash = await put(path.join(directory, "archive"), value)
  const file = await open(path.join(directory, "terminal-ref.json"), "wx", 0o600)
  await file.writeFile(JSON.stringify({ hash }) + "\n")
  await file.sync()
  await file.close()
  return { hash, ...value }
}

export async function checkedTerminal(directory: string, codeHash: string) {
  const reference = (await Bun.file(path.join(directory, "terminal-ref.json")).json()) as { hash: string }
  const sealed = (await object(path.join(directory, "archive"), reference.hash)) as Awaited<
    ReturnType<typeof material>
  > & { sealedAt: number }
  const { sealedAt, ...original } = sealed
  if (
    !Number.isFinite(sealedAt) ||
    sealedAt < original.evidenceCutoff ||
    JSON.stringify(original) !== JSON.stringify(await material(directory, codeHash))
  )
    throw new Error("Terminal evidence or candidate availability changed after sealing")
  return { hash: reference.hash, ...sealed }
}
