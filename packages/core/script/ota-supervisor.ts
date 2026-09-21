import { constants } from "node:fs"
import { mkdir, open, readdir, rename, statfs } from "node:fs/promises"
import path from "node:path"
import { hash, opposite, OTA, SIX_HOURS, subject } from "./ota-rsi"
import type { Pair, Protocol, Slot, State } from "./ota-rsi"

export type Accounting = { source: string; knownCost: string | null; incomplete: boolean }
export type Job = {
  id: string
  epoch: number
  slot: Slot
  mutable: Slot
  deadline: number
  pair: { s: string; h: string }
  output: string
  feedback?: { eligible: boolean; developmentPassed: number; developmentTotal: number }
}
export type Worker = {
  result: Promise<void>
  // Host-observed provider/tool completion sequence, never candidate testimony.
  progress(): Promise<number>
  // Acknowledges termination of ALL owned descendants/containers, not just a PID.
  stop(): Promise<Accounting>
}
export type Driver = {
  // Pin runtime, Kernel, evaluator, supervisor and transitive adapter source.
  fingerprint(): Promise<string>
  // Recover/fence all processes owned by THIS campaign, including after a crash.
  fence(): Promise<void>
  start(job: Job): Promise<Worker>
  // Runs OUTSIDE the proposer. Untrusted harness execution must be sandboxed away
  // from test authority, ledger, credentials, host filesystem and Docker socket.
  evaluate(input: {
    test: Protocol["tests"][number]
    pair: Job["pair"]
    deadline: number
    signal: AbortSignal
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
export async function supervise(root: string, ota: OTA, artifacts: Artifacts, driver: Driver) {
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
  const halt = (reason: string) => {
    const state = ota.read()
    return state.stopped ? state : ota.stop(state.revision, reason, Math.max(Date.now(), state.clock))
  }
  // Fencing is required even if the prior journal says idle: a crash can occur
  // between spawning a worker and persisting its transport handle.
  try {
    await verify()
    await bounded(driver.fence(), 30_000)
    const state = ota.read()
    if (state.stopped) return state
    if (state.job || state.trial) {
      if (state.trial && state.fallback && (!state.job || Date.now() < state.job.deadline))
        ota.rollback(state.revision, "supervisor restarted during unconfirmed boot", Date.now())
      else return halt("interrupted work: fenced; no implicit provider retry")
    }
    while (!ota.read().stopped) {
      await verify()
      if (await cancelled()) return halt("cancelled")
      const current = ota.read()
      const state = current.job ? current : ota.begin(current.revision, Date.now())
      if (Date.now() >= state.job!.deadline) return halt("original job deadline reached")
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
        output,
      }
      const previous = ota
        .history()
        .findLast(
          (event) => typeof event === "object" && event !== null && "type" in event && event.type === "qualification",
        )
      if (previous && typeof previous === "object" && "details" in previous) {
        const value = previous.details as {
          passed: boolean
          evidence: { rows: { id: string; passed: number; total: number }[] }
        }
        const development = value.evidence.rows.filter(
          (row) => ota.protocol.tests.find((test) => test.id === row.id)?.performance?.panel === "development",
        )
        job.feedback = {
          eligible: value.passed,
          developmentPassed: development.reduce((sum, row) => sum + row.passed, 0),
          developmentTotal: development.reduce((sum, row) => sum + row.total, 0),
        }
      }
      await record(name + "-admission", job)
      const worker = await bounded(driver.start(job), 30_000)
      const running = { done: false }
      const completed = worker.result.then(
        () => "handoff",
        () => "worker failure",
      )
      const monitor = async () => {
        while (!running.done) {
          if (await cancelled()) return "cancelled"
          const live = ota.read()
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
      if (outcome !== "handoff") {
        const live = ota.read()
        if (outcome === "cancelled" || outcome === "original job deadline reached" || !live.fallback)
          return halt(outcome)
        ota.rollback(live.revision, outcome, Date.now())
        continue
      }
      await verify()
      const pair = { ...state.active.pair, [job.mutable]: await artifacts.candidate(output, job.mutable) }
      const live = ota.read()
      ota.handedOff(live.revision, state.epoch, job.id, Date.now())
      const tables = {
        baseline: [] as { id: string; passed: number; total: number; valid: boolean }[],
        candidate: [] as { id: string; passed: number; total: number; valid: boolean }[],
      }
      for (const version of ["baseline", "candidate"] as const) {
        for (const test of ota.protocol.tests) {
          if (await cancelled()) return halt("cancelled before evaluation")
          await verify()
          const request = {
            test,
            pair: await artifacts.pair(version === "baseline" ? state.active.pair : pair),
            deadline: Date.now() + SIX_HOURS,
          }
          // Each evaluator instance has its own durable ORIGINAL six-hour deadline.
          await record(`${name}-${version}-test-${hash(test.id)}-admission`, request)
          const abort = new AbortController()
          const waiting = { done: false }
          const watchdog = async () => {
            while (!waiting.done) {
              if ((await cancelled()) || Date.now() >= request.deadline) {
                abort.abort()
                throw new Error("evaluation cancelled or original deadline reached")
              }
              await Bun.sleep(100)
            }
          }
          const watch = watchdog()
          const result = await Promise.race([driver.evaluate({ ...request, signal: abort.signal }), watch]).finally(
            () => {
              waiting.done = true
              abort.abort()
            },
          )
          await watch
          if (!result || Date.now() >= request.deadline) throw new Error("incomplete or late evaluation")
          await record(`${name}-${version}-test-${hash(test.id)}-result`, {
            ...result,
            accounting: requireAccounting(result.accounting),
          })
          tables[version].push({ id: test.id, passed: result.passed, total: result.total, valid: result.valid })
        }
      }
      await verify()
      await artifacts.pair(pair)
      if (await cancelled()) return halt("cancelled before switch")
      const evidence = {
        protocol: ota.digest,
        subject: subject(pair),
        job: job.id,
        rows: tables.candidate,
        baseline: { subject: subject(state.active.pair), rows: tables.baseline },
        receipt: await record(name + "-evaluation", { pair, tables }),
      }
      // All worker processes, including evaluator-owned ones, must be gone.
      await bounded(driver.fence(), 30_000)
      ota.settle(ota.read().revision, pair, evidence, Date.now())
    }
    return ota.read()
  } catch (error) {
    // An unacknowledged fence is a hard infrastructure failure, never success.
    const fenceFailure = await bounded(driver.fence(), 30_000).then(
      () => undefined,
      (failure) => String(failure),
    )
    const state = halt((await cancelled()) && !fenceFailure ? "cancelled" : String(error))
    await record(`fault-${Date.now()}`, { error: String(error), fenceFailure, state, usageIncomplete: true })
    return state
  }
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
