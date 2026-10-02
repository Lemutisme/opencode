import { constants } from "node:fs"
import { mkdir, open, readdir, rename, statfs } from "node:fs/promises"
import path from "node:path"
import { hash, opposite, OTA, SIX_HOURS, subject } from "./ota-rsi.js"
import type { Evidence, Pair, Protocol, Slot, State } from "./ota-rsi.js"

export type Readmission = {
  manifest: string
  pair: Pair
  evidence: Evidence
  checkpoint: string
}

export type Accounting = { source: string; knownCost: string | null; incomplete: boolean; checkpoint?: string }
export type Job = {
  id: string
  epoch: number
  slot: Slot
  mutable: Slot
  deadline: number
  pair: { s: string; h: string }
  source?: { id: string; pair: { s: string; h: string } }
  output: string
  memory: State["active"]["memory"]
  purpose?: "continuation"
  task?: { id: string; checkpoint: string }
  feedback?: {
    eligible: boolean
    developmentPassed?: number
    developmentTotal?: number
    development?: { task: string; replicate: string; passed: number; total: number; baselinePassed: number }[]
    preparationFailure?: string
  }
}
export type Continuation = {
  previous: string
  checkpoint: string
  receipt: string
  outcome: "revise" | "delivered" | "blocked"
}
export type Worker = {
  result: Promise<void>
  // Host-observed provider/tool completion sequence, never candidate testimony.
  progress(): Promise<number>
  // Acknowledges termination of ALL owned descendants/containers, not just a PID.
  stop(): Promise<Accounting>
  // Trusted adapter seals public task state and adjudicates the completed work.
  // Called only after result and acknowledged stop, never candidate testimony.
  continuation?(signal: AbortSignal): Promise<Continuation>
}
export type Driver = {
  // Pin the external Kernel, evaluator, supervisor and containment adapter.
  // OpenCode's context/memory/tools/runner implementation is H, not this driver.
  fingerprint(): Promise<string>
  // Recover/fence all processes owned by THIS campaign, including after a crash.
  fence(): Promise<void>
  start(job: Job): Promise<Worker>
  // Materialize an inactive source proposal into a sealed runnable release.
  // Runs after the producer has stopped, before independent evaluation.
  prepare?(input: {
    job: Job
    proposal: string
    signal: AbortSignal
  }): Promise<Uint8Array | { rejected: true; reason: string; receipt: string }>
  // Runs OUTSIDE the proposer. Untrusted harness execution must be sandboxed away
  // from test authority, ledger, credentials, host filesystem and Docker socket.
  evaluate(input: {
    test: Protocol["tests"][number]
    pair: Job["pair"]
    deadline: number
    signal: AbortSignal
    task?: { id: string; checkpoint: string }
  }): Promise<{
    passed: number
    total: number
    valid: boolean
    accounting: Accounting
  }>
}

/** Content-addressed, host-only storage. Mutable files are imported only AFTER
 * stop acknowledgement. No directory walking, links or archives on the host.
 */
export class Artifacts {
  constructor(readonly directory: string) {}

  async put(bytes: Uint8Array) {
    if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw new Error("invalid artifact size")
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const digest = hash(bytes)
    const file = path.join(this.directory, digest)
    if (await Bun.file(file).exists()) {
      await this.get(digest)
      return digest
    }
    const temp = `${file}.${crypto.randomUUID()}`
    const handle = await open(temp, "wx", 0o400)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, file)
    const directory = await open(this.directory, "r")
    await directory.sync()
    await directory.close()
    return digest
  }

  async get(digest: string) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid artifact identity")
    const file = path.join(this.directory, digest)
    const bytes = await regular(file)
    if (hash(bytes) !== digest) throw new Error("artifact changed after qualification")
    return file
  }

  async pair(pair: Pair) {
    return { s: await this.get(pair.s), h: await this.get(pair.h) }
  }

  async candidate(directory: string, target: Slot) {
    if ((await readdir(directory)).join(",") !== target)
      throw new Error("candidate may export only its inactive partition")
    return this.put(await regular(path.join(directory, target)))
  }
}

/** Run under an OS-held exclusive lock (see CLI). No candidate process executes
 * in this address space. The driver is trusted, immutable application wiring.
 */
export async function supervise(
  root: string,
  ota: OTA,
  artifacts: Artifacts,
  driver: Driver,
  readmission?: Readmission,
) {
  const receipts = path.join(root, "receipts")
  await mkdir(receipts, { recursive: true, mode: 0o700 })
  const record = async (name: string, data: unknown) => {
    const digest = await artifacts.put(new TextEncoder().encode(JSON.stringify(data)))
    await Bun.write(path.join(receipts, name + ".json"), JSON.stringify({ sha256: digest, data }, null, 2))
    return digest
  }
  const cancelled = () => Bun.file(path.join(root, "CANCEL")).exists()
  const verify = async () => {
    const disk = await statfs(root)
    if (disk.bavail * disk.bsize < 64 * 1024 ** 3) throw new Error("disk infrastructure reserve reached")
    if ((await bounded(driver.fingerprint(), 30_000)) !== ota.protocol.trusted)
      throw new Error("trusted control plane changed")
    await artifacts.pair(ota.read().active.pair)
  }
  const halt = async (reason: string, details?: unknown) => {
    const state = ota.read()
    if (state.stopped) return state
    if (ota.protocol.completion)
      await record("completion", {
        protocol: ota.digest,
        completed: reason === "recursive closure completed",
        reason,
        seed: state.seed,
        pair: state.active.pair,
        job: state.job,
        selections: recursiveSelections(ota),
        health: { trial: state.trial, support: state.active.support, quarantine: state.quarantine },
        details,
      })
    return ota.stop(state.revision, reason, Math.max(Date.now(), state.clock))
  }
  // Fencing is required even if the prior journal says idle: a crash can occur
  // between spawning a worker and persisting its transport handle.
  try {
    await verify()
    await bounded(driver.fence(), 30_000)
    const state = ota.read()
    if (state.stopped) return state
    if (state.job || state.trial) {
      if (
        (state.trial || (ota.protocol.completion && state.job?.phase === "running")) &&
        state.fallback &&
        (!state.job || Date.now() < state.job.deadline)
      ) {
        ota.rollback(state.revision, "supervisor restarted during unconfirmed boot", Date.now())
        if (ota.protocol.completion) return await halt("recursive closure interrupted: unconfirmed successor restarted")
      } else return await halt("interrupted work: fenced; no implicit provider retry")
    }
    if (ota.protocol.completion) {
      if (readmission) throw new Error("recursive closure requires live producers, not operator readmission")
      if (!driver.prepare) throw new Error("recursive closure requires an isolated preparation boundary")
      const progress = recursiveSelections(ota)
      if (!progress.valid) return await halt(`recursive closure failed: ${progress.reason}`)
      if (ota.protocol.completion.stopOnRejection && rejected(ota))
        return await halt("recursive closure rejected: retained negative result")
    }
    // An operator may re-adjudicate sealed observations under a NEW protocol.
    // This is not a model handoff or a retry, and it never rewrites old standing.
    if (readmission && state.revision === 0) {
      if (await cancelled()) return await halt("cancelled before readmission")
      await artifacts.pair(readmission.pair)
      const receipt = await record("operator-readmission", readmission)
      const admitted = ota.begin(state.revision, Date.now())
      const ready = ota.handedOff(
        admitted.revision,
        admitted.epoch,
        admitted.job!.id,
        Date.now(),
        readmission.checkpoint,
      )
      const selected = ota.settle(
        ready.revision,
        readmission.pair,
        {
          ...readmission.evidence,
          protocol: ota.digest,
          job: admitted.job!.id,
          receipt,
        },
        Date.now(),
      )
      if (!selected.trial) return await halt("operator readmission rejected")
    }
    while (!ota.read().stopped) {
      await verify()
      if (await cancelled()) return await halt("cancelled")
      const current = ota.read()
      const state = current.job ? current : ota.begin(current.revision, Date.now())
      if (Date.now() >= state.job!.deadline) return await halt("original job deadline reached")
      const name = `${state.job!.id}-e${state.epoch}`
      const output = path.join(root, "staging", name)
      await mkdir(output, { recursive: true, mode: 0o700 })
      if ((await readdir(output)).length) throw new Error("refusing to reuse mutable staging")
      const job: Job = {
        id: state.job!.id,
        epoch: state.epoch,
        slot: state.active.slot,
        mutable: opposite(state.active.slot),
        deadline: state.job!.deadline,
        pair: await artifacts.pair(state.active.pair),
        ...(state.job!.source
          ? { source: { id: state.job!.source.id, pair: await artifacts.pair(state.job!.source.pair) } }
          : {}),
        output,
        memory: state.active.memory,
        ...(state.job!.purpose ? { purpose: state.job!.purpose } : {}),
        ...(state.task ? { task: { id: state.task.id, checkpoint: state.task.checkpoint } } : {}),
      }
      const previous = ota
        .history()
        .findLast(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            ["qualification", "preparation-rejected"].includes(String(event.type)),
        )
      if (
        previous &&
        typeof previous === "object" &&
        "details" in previous &&
        "type" in previous &&
        previous.type === "qualification"
      ) {
        const value = previous.details as {
          passed: boolean
          evidence: {
            rows: { id: string; passed: number; total: number }[]
            baseline: { rows: { id: string; passed: number }[] }
          }
        }
        const development = value.evidence.rows.filter(
          (row) => ota.protocol.tests.find((test) => test.id === row.id)?.performance?.panel === "development",
        )
        job.feedback = {
          eligible: value.passed,
          developmentPassed: development.reduce((sum, row) => sum + row.passed, 0),
          developmentTotal: development.reduce((sum, row) => sum + row.total, 0),
          development: development.map((row) => {
            const assignment = ota.protocol.tests.find((test) => test.id === row.id)!.performance!
            return {
              task: assignment.task,
              replicate: assignment.replicate,
              passed: row.passed,
              total: row.total,
              baselinePassed: value.evidence.baseline.rows.find((item) => item.id === row.id)!.passed,
            }
          }),
        }
      }
      if (
        previous &&
        typeof previous === "object" &&
        "type" in previous &&
        previous.type === "preparation-rejected" &&
        "details" in previous
      )
        job.feedback = { eligible: false, preparationFailure: (previous.details as { reason: string }).reason }
      await record(name + "-admission", job)
      const worker = await bounded(driver.start(job), Math.min(300_000, Math.max(1, job.deadline - Date.now()))).catch(
        async (error) => {
          await record(name + "-startup-failure", { error: String(error), usageIncomplete: true })
          await bounded(driver.fence(), 30_000)
          const live = ota.read()
          if (!live.fallback || Date.now() >= job.deadline || (await cancelled())) throw error
          ota.rollback(live.revision, `startup failed: ${error}`, Date.now())
          return undefined
        },
      )
      if (!worker) {
        if (ota.protocol.completion) return await halt("recursive closure failed: successor startup", { producer: job })
        continue
      }
      const running = { done: false }
      const completed = worker.result.then(
        () => "handoff",
        () => "worker failure",
      )
      const monitor = async () => {
        while (!running.done) {
          if (await cancelled()) return "cancelled"
          const live = ota.read()
          if (ota.protocol.stopOnPrimaryImprovement && live.primaryImproved && !live.trial)
            return "full-pass improvement confirmed"
          if (Date.now() >= live.job!.deadline) return "original job deadline reached"
          if (ota.expired(live, Date.now())) return "progress heartbeat expired"
          const sequence = await bounded(worker.progress(), 5_000)
          if (running.done) break
          if (sequence > live.job!.sequence) ota.heartbeat(live.revision, state.epoch, job.id, sequence, Date.now())
          await Bun.sleep(100)
        }
        return "monitor stopped"
      }
      const observation = monitor().catch((error) => `progress observation failed: ${error}`)
      const outcome = await Promise.race([completed, observation]).finally(() => {
        running.done = true
      })
      // Never boot a replacement when termination is uncertain.
      const accounting = await bounded(worker.stop(), 30_000)
      await observation
      await record(name + "-execution", {
        outcome,
        accounting: requireAccounting(accounting),
        originalDeadline: job.deadline,
      })
      if (outcome === "full-pass improvement confirmed") return await halt(outcome)
      if (outcome !== "handoff") {
        const live = ota.read()
        if (outcome === "cancelled" || outcome === "original job deadline reached" || !live.fallback)
          return await halt(outcome)
        ota.rollback(live.revision, outcome, Date.now())
        if (ota.protocol.completion) return await halt(`recursive closure failed: ${outcome}`, { producer: job })
        continue
      }
      await verify()
      if (job.purpose === "continuation") {
        ota.continuationReady(ota.read().revision, job.epoch, job.id, Date.now())
        const report = await continuationReport(job, worker, cancelled)
        await artifacts.get(report.checkpoint)
        await artifacts.get(report.receipt)
        await record(name + "-continuation", { producer: job, pair: state.active.pair, report })
        if (await cancelled()) return await halt("cancelled before task continuation settlement")
        ota.continued(ota.read().revision, job.epoch, job.id, report, Date.now())
        if (report.outcome === "delivered") return await halt("task delivered", { producer: job, report })
        if (report.outcome === "blocked") return await halt("task blocked", { producer: job, report })
        continue
      }
      if (ota.protocol.stopOnPrimaryImprovement && ota.read().primaryImproved)
        return await halt("full-pass improvement confirmed")
      const proposal = await artifacts.candidate(output, job.mutable)
      const live = ota.read()
      ota.handedOff(live.revision, state.epoch, job.id, Date.now(), accounting.checkpoint)
      const file = await artifacts.get(proposal)
      if (await cancelled()) return await halt("cancelled before preparation")
      if (ota.protocol.deployment && Date.now() >= ota.protocol.deployment.deadline)
        throw new Error("original task deadline reached before preparation")
      const prepared = new AbortController()
      const preparing = { done: false }
      const work = Promise.resolve().then(() =>
        driver.prepare ? driver.prepare({ job, proposal: file, signal: prepared.signal }) : Bun.file(file).bytes(),
      )
      const watchPreparation = (async () => {
        while (!preparing.done) {
          if (await cancelled()) {
            prepared.abort()
            throw new Error("cancelled during preparation")
          }
          if (ota.protocol.deployment && Date.now() >= ota.protocol.deployment.deadline) {
            prepared.abort()
            throw new Error("original task deadline reached during preparation")
          }
          await Bun.sleep(100)
        }
      })()
      const materialization = await Promise.race([work, watchPreparation]).finally(async () => {
        preparing.done = true
        prepared.abort()
        await watchPreparation.catch(() => undefined)
        // Cancellation is not a build-container stop acknowledgement.
        await bounded(
          work.then(
            () => undefined,
            () => undefined,
          ),
          60_000,
        )
      })
      if (!materialization) throw new Error("preparation ended without an artifact")
      if (ota.protocol.deployment && Date.now() >= ota.protocol.deployment.deadline)
        throw new Error("original task deadline reached during preparation")
      if (!(materialization instanceof Uint8Array)) {
        await bounded(driver.fence(), 30_000)
        ota.rejectPreparation(
          ota.read().revision,
          { ...state.active.pair, [job.mutable]: proposal },
          materialization.reason,
          materialization.receipt,
          Date.now(),
        )
        if (ota.protocol.completion?.stopOnRejection)
          return await halt("recursive closure rejected: preparation", {
            producer: job,
            proposal,
            preparation: materialization,
          })
        continue
      }
      const replacement = await artifacts.put(materialization)
      await record(name + "-materialization", { proposed: proposal, materialized: replacement })
      const pair = { ...state.active.pair, [job.mutable]: replacement }
      if (
        (ota.protocol.completion && subject(pair) === subject(state.active.pair)) ||
        (ota.protocol.expansion &&
          ota
            .read()
            .lineage?.some(
              (node) => subject(node.root) === subject(state.active.pair) && subject(node.pair) === subject(pair),
            ))
      ) {
        ota.rejectPreparation(
          ota.read().revision,
          pair,
          "This exact pair is unchanged or was already evaluated under this incumbent",
          await record(name + "-duplicate", { pair }),
          Date.now(),
        )
        if (ota.protocol.completion?.stopOnRejection)
          return await halt("recursive closure rejected: duplicate proposal", {
            producer: job,
            proposal,
            prepared: replacement,
          })
        continue
      }
      if (ota.protocol.completion) {
        const progress = recursiveSelections(ota)
        if (!progress.valid) return await halt(`recursive closure failed: ${progress.reason}`)
        if (progress.selections.length > ota.protocol.completion.selections)
          throw new Error("recursive closure selection target was exceeded")
        if (progress.selections.length === ota.protocol.completion.selections) {
          const completion = await recursiveHandoff(ota, artifacts, job, proposal, replacement)
          await verify()
          await artifacts.pair(pair)
          await bounded(driver.fence(), 30_000)
          if (await cancelled()) return await halt("cancelled before recursive closure")
          if (Date.now() >= job.deadline) return await halt("original job deadline reached before recursive closure")
          return await halt("recursive closure completed", completion)
        }
      }
      const tables = {
        baseline: [] as { id: string; passed: number; total: number; valid: boolean }[],
        candidate: [] as { id: string; passed: number; total: number; valid: boolean }[],
      }
      // Interleave paired controls/candidates; each admission owns its own clock.
      const assignments = ota.protocol.tests.flatMap((test) =>
        (["baseline", "candidate"] as const).map((version) => ({ test, version })),
      )
      await evaluationWorkers(
        assignments,
        ota.protocol.evaluationConcurrency ?? 1,
        async ({ test, version }, batch) => {
          if (await cancelled()) throw new Error("cancelled before evaluation")
          await verify()
          const request = {
            test,
            pair: await artifacts.pair(version === "baseline" ? state.active.pair : pair),
            deadline: Math.min(Date.now() + SIX_HOURS, ota.protocol.deployment?.deadline ?? Infinity),
            ...(state.task ? { task: { id: state.task.id, checkpoint: state.task.checkpoint } } : {}),
          }
          if (Date.now() >= request.deadline) throw new Error("original task deadline reached before evaluation")
          await record(`${name}-${version}-test-${hash(test.id)}-admission`, request)
          const abort = new AbortController()
          const stop = () => abort.abort()
          batch.addEventListener("abort", stop, { once: true })
          const waiting = { done: false }
          const watchdog = async () => {
            while (!waiting.done) {
              if (batch.aborted || (await cancelled()) || Date.now() >= request.deadline) {
                abort.abort()
                throw new Error("evaluation cancelled or original deadline reached")
              }
              await Bun.sleep(100)
            }
          }
          const work = driver.evaluate({ ...request, signal: abort.signal })
          const watch = watchdog()
          try {
            const result = await Promise.race([work, watch])
            if (!result || Date.now() >= request.deadline) throw new Error("incomplete or late evaluation")
            await record(`${name}-${version}-test-${hash(test.id)}-result`, {
              ...result,
              accounting: requireAccounting(result.accounting),
            })
            if (!result.valid) throw new Error("invalid evaluator evidence; do not drop a failed assignment")
            tables[version].push({ id: test.id, passed: result.passed, total: result.total, valid: result.valid })
          } finally {
            waiting.done = true
            abort.abort()
            batch.removeEventListener("abort", stop)
            await watch.catch(() => undefined)
            // Abort is not an acknowledgement. Drain before any promotion/rollback.
            await bounded(
              work.then(
                () => undefined,
                () => undefined,
              ),
              60_000,
            )
          }
        },
      )
      await verify()
      await artifacts.pair(pair)
      if (await cancelled()) return await halt("cancelled before switch")
      const evidence = {
        protocol: ota.digest,
        subject: subject(pair),
        job: job.id,
        ...(state.task ? { checkpoint: state.task.checkpoint } : {}),
        rows: tables.candidate,
        baseline: { subject: subject(state.active.pair), rows: tables.baseline },
        receipt: await record(name + "-evaluation", {
          pair,
          tables,
          producer: {
            pair: state.active.pair,
            job: job.id,
            epoch: job.epoch,
            mutable: job.mutable,
            outcome: "handoff",
            ...(state.task ? { task: { id: state.task.id, checkpoint: state.task.checkpoint } } : {}),
          },
          proposal,
          materialized: replacement,
        }),
      }
      // All worker processes, including evaluator-owned ones, must be gone.
      await bounded(driver.fence(), 30_000)
      const selected = ota.settle(ota.read().revision, pair, evidence, Date.now())
      if (ota.protocol.completion?.stopOnRejection && subject(selected.active.pair) !== subject(pair))
        return await halt("recursive closure rejected: qualification", {
          producer: job,
          proposal,
          prepared: replacement,
          evidence,
        })
    }
    return ota.read()
  } catch (error) {
    // An unacknowledged fence is a hard infrastructure failure, never success.
    const fenceFailure = await bounded(driver.fence(), 30_000).then(
      () => undefined,
      (failure) => String(failure),
    )
    const state = await halt((await cancelled()) && !fenceFailure ? "cancelled" : String(error))
    await record(`fault-${Date.now()}`, { error: String(error), fenceFailure, state, usageIncomplete: true })
    return state
  }
}

/** Grading owns the task's original deadline too. Abort must be acknowledged
 * before any checkpoint can be committed or another generation can start.
 */
export async function continuationReport(
  job: Pick<Job, "deadline">,
  worker: Pick<Worker, "continuation">,
  cancelled: () => Promise<boolean>,
) {
  if (!worker.continuation) throw new Error("task continuation requires a trusted checkpoint adapter")
  if ((await cancelled()) || Date.now() >= job.deadline)
    throw new Error("continuation grading cancelled or original deadline reached")
  const abort = new AbortController()
  const reading = { done: false }
  const work = Promise.resolve().then(() => worker.continuation!(abort.signal))
  const watch = (async () => {
    while (!reading.done) {
      if ((await cancelled()) || Date.now() >= job.deadline) {
        abort.abort()
        throw new Error("continuation grading cancelled or original deadline reached")
      }
      await Bun.sleep(100)
    }
  })()
  try {
    const report = await Promise.race([work, watch])
    if (!report || abort.signal.aborted || Date.now() >= job.deadline || (await cancelled()))
      throw new Error("incomplete or late continuation report")
    return report
  } finally {
    reading.done = true
    abort.abort()
    await watch.catch(() => undefined)
    await bounded(
      work.then(
        () => undefined,
        () => undefined,
      ),
      60_000,
    )
  }
}

type RecursiveSelection = {
  root: Pair
  pair: Pair
  job: string
  receipt: string
  support: string
  checkpoint?: string
}

/** This is a view of the existing ledger, never another promotion authority.
 * Neither a large epoch nor a cleared probation bit proves recursive execution.
 */
export function recursiveSelections(ota: OTA) {
  const state = ota.read()
  const history = ota.history() as {
    type: string
    commands?: { type: string; contractID?: string }[]
    details?: { passed?: boolean; evidence?: Evidence }
  }[]
  const selections: RecursiveSelection[] = []
  const invalid = (reason: string) => ({ valid: false, reason, selections })
  if (history.some((event) => event.type === "rollback")) return invalid("successor health was withdrawn")
  for (const node of state.lineage ?? []) {
    if (node.outcome !== "selected") continue
    const root = selections.at(-1)?.pair ?? state.seed
    if (subject(root) !== subject(node.root)) return invalid("selected producer lineage is discontinuous")
    const events = history.filter(
      (event) =>
        event.type === "qualification" &&
        event.details?.passed === true &&
        event.details.evidence &&
        node.id === hash(JSON.stringify([ota.digest, event.details.evidence.job, subject(node.pair)])),
    )
    if (events.length !== 1) return invalid("selection lacks one exact qualification")
    const evidence = events[0].details!.evidence!
    if (
      evidence.protocol !== ota.digest ||
      evidence.subject !== subject(node.pair) ||
      evidence.baseline.subject !== subject(root)
    )
      return invalid("selection evidence names another producer or candidate")
    const support = events[0].commands?.find((command) => command.type === "discharge")?.contractID
    if (
      !support ||
      state.kernel.contracts[support]?.status !== "discharged" ||
      state.kernel.contracts[support].handoff?.subjectHash !== subject(node.pair)
    )
      return invalid("selection lacks live Kernel standing")
    selections.push({
      root,
      pair: node.pair,
      job: evidence.job,
      receipt: evidence.receipt,
      support,
      ...(evidence.checkpoint ? { checkpoint: evidence.checkpoint } : {}),
    })
  }
  if (subject(selections.at(-1)?.pair ?? state.seed) !== subject(state.active.pair))
    return invalid("active pair is not the recursive successor")
  if (selections.length && selections.at(-1)!.support !== state.active.support)
    return invalid("active support is not the selected successor")
  return { valid: true, reason: "exact qualified producer chain", selections }
}

/** Each selected candidate must have been produced by the preceding admitted
 * pair, not by operator readmission or a disconnected, externally authored patch.
 */
export async function recursiveEvidence(ota: OTA, artifacts: Artifacts) {
  const progress = recursiveSelections(ota)
  if (!progress.valid) throw new Error(progress.reason)
  return Promise.all(
    progress.selections.map(async (selection) => {
      const receipt: {
        pair?: Pair
        producer?: { pair: Pair; job: string; mutable: Slot; outcome: string; task?: Job["task"] }
        proposal?: string
        materialized?: string
      } = await Bun.file(await artifacts.get(selection.receipt)).json()
      if (
        !receipt?.pair ||
        !receipt.producer ||
        !receipt.proposal ||
        !receipt.materialized ||
        receipt.producer.outcome !== "handoff" ||
        receipt.producer.job !== selection.job ||
        subject(receipt.producer.pair) !== subject(selection.root) ||
        subject(receipt.pair) !== subject(selection.pair) ||
        !["s", "h"].includes(receipt.producer.mutable) ||
        receipt.materialized !== selection.pair[receipt.producer.mutable] ||
        selection.pair[receipt.producer.mutable] === selection.root[receipt.producer.mutable] ||
        selection.pair[opposite(receipt.producer.mutable)] !== selection.root[opposite(receipt.producer.mutable)] ||
        (ota.protocol.deployment &&
          (receipt.producer.task?.id !== ota.protocol.deployment.task ||
            receipt.producer.task?.checkpoint !== selection.checkpoint))
      )
        throw new Error("qualification lacks the exact sealed producer handoff")
      await artifacts.get(receipt.proposal)
      await artifacts.get(receipt.materialized)
      return { ...selection, proposal: receipt.proposal, prepared: receipt.materialized }
    }),
  )
}

/** A final proposal is useful execution evidence only after acknowledged stop,
 * Kernel handoff and successful preparation. It receives no evaluation standing.
 */
export async function recursiveHandoff(ota: OTA, artifacts: Artifacts, job: Job, proposal: string, prepared: string) {
  const state = ota.read()
  const selections = await recursiveEvidence(ota, artifacts)
  const producer = await artifacts.pair(state.active.pair)
  if (!ota.protocol.completion || selections.length !== ota.protocol.completion.selections)
    throw new Error("recursive selection target not met")
  if (
    job.purpose === "continuation" ||
    state.job?.phase !== "evaluating" ||
    state.job.id !== job.id ||
    state.epoch !== job.epoch ||
    state.job.deadline !== job.deadline ||
    Date.now() >= job.deadline ||
    job.slot !== state.active.slot ||
    job.mutable !== opposite(state.active.slot) ||
    job.pair.s !== producer.s ||
    job.pair.h !== producer.h ||
    (state.task && (job.task?.id !== state.task.id || job.task.checkpoint !== state.task.checkpoint))
  )
    throw new Error("completion requires the exact active successor handoff")
  await artifacts.get(proposal)
  await artifacts.get(prepared)
  const pair = { ...state.active.pair, [job.mutable]: prepared }
  if (
    subject(pair) === subject(state.active.pair) ||
    state.lineage?.some(
      (node) => subject(node.root) === subject(state.active.pair) && subject(node.pair) === subject(pair),
    )
  )
    throw new Error("completion requires a new prepared proposal")
  return {
    producer: job,
    pair: state.active.pair,
    proposal,
    prepared,
    inactive: pair,
    selections,
    health: "exact admitted successor completed a useful handoff and preparation; no long-duration stability claim",
    evaluated: false,
    promoted: false,
  }
}

function rejected(ota: OTA) {
  return ota.history().some((entry) => {
    const event = entry as { type: string; details?: { passed?: boolean } }
    return event.type === "preparation-rejected" || (event.type === "qualification" && event.details?.passed === false)
  })
}

async function regular(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > 16 * 1024 * 1024)
      throw new Error("artifact must be one bounded regular file")
    const bytes = new Uint8Array(await handle.readFile())
    if (bytes.length !== info.size) throw new Error("artifact changed while importing")
    return bytes
  } finally {
    await handle.close()
  }
}

function requireAccounting(value: Accounting) {
  if (
    !value.source ||
    typeof value.incomplete !== "boolean" ||
    (value.knownCost === null ? !value.incomplete : !/^(0|[1-9]\d*)(\.\d+)?$/.test(value.knownCost))
  )
    throw new Error("invalid accounting; unknown usage is not zero")
  return value
}

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = { timer: undefined as ReturnType<typeof setTimeout> | undefined }
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout.timer = setTimeout(() => reject(new Error("control operation timed out")), ms)
    }),
  ]).finally(() => clearTimeout(timeout.timer))
}

export async function evaluationWorkers<T>(
  items: readonly T[],
  concurrency: number,
  execute: (item: T, signal: AbortSignal) => Promise<void>,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("invalid concurrency")
  const queue = { next: 0 }
  const abort = new AbortController()
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!abort.signal.aborted) {
        const index = queue.next++
        if (index >= items.length) return
        await execute(items[index], abort.signal).catch((error) => {
          abort.abort()
          throw error
        })
      }
    }),
  )
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failed) throw failed.reason
}
