import { appendFileSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import type { Infrastructure } from "./infrastructure"
import { processIdentity, type ProcessIdentity } from "./observe"
import path from "node:path"
import { journal } from "./host-journal"

type Message = { ready?: boolean; pid?: number; id?: string; result?: unknown; error?: string }

export async function observeHost(identity?: ProcessIdentity) {
  if (!identity) return { state: "unknown" as const, reason: "host_identity_missing" }
  return readFile(`/proc/${identity.pid}/stat`, "utf8").then(
    async (stat) => {
      const boot = await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => undefined)
      if (!boot) return { state: "unknown" as const, reason: "boot_identity_unreadable" }
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      return {
        state:
          fields[19] === identity.start && boot.trim() === identity.boot ? ("alive" as const) : ("replaced" as const),
        pid: identity.pid,
        start: fields[19],
        boot: boot.trim(),
        processState: fields[0],
      }
    },
    (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT"
        ? { state: "gone" as const, pid: identity.pid }
        : { state: "unknown" as const, reason: String(error) },
  )
}

/** A wait deadline revokes this connection; only the supervisor can establish tree cleanup. */
export function hostControl(input: {
  spawn: (receive: (message: Message) => void) => Bun.Subprocess
  policy: Infrastructure
  deadline: number
  signal: AbortSignal
  journal: string
  cleanupFile: string
}) {
  const ready = Promise.withResolvers<number>()
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const requests = new Map<string, { action: string; contractID: string; deadline: number }>()
  // Validate existing CAS metadata before spawning a host, including on same-instance recovery.
  const archive = input.policy.journal ? journal(input.journal) : undefined
  const connectionID = crypto.randomUUID()
  const cleanupFile = archive
    ? path.join(path.dirname(input.cleanupFile), `cleanup-${connectionID}.json`)
    : input.cleanupFile
  const state = {
    sequence: 0,
    closed: false,
    host: undefined as ProcessIdentity | undefined,
    recordingError: undefined as Error | undefined,
  }
  const write = (value: Record<string, unknown> & { event: string }) => {
    if (state.recordingError) return false
    try {
      if (archive) archive.append({ ...value, connectionID })
      else
        appendFileSync(input.journal, JSON.stringify({ sequence: ++state.sequence, at: Date.now(), ...value }) + "\n", {
          mode: 0o600,
          flush: true,
        })
      return true
    } catch (error) {
      state.recordingError = new Error("Host journal recording failed: " + String(error))
      state.closed = true
      ready.reject(state.recordingError)
      pending.forEach((value) => value.reject(state.recordingError!))
      pending.clear()
      // Cleanup must not depend on being able to write the failed journal again.
      queueMicrotask(() => void stop("journal_failure").catch(() => undefined))
      return false
    }
  }
  const child = input.spawn((message) => {
    if (message.ready) {
      if (!write({ event: "host_ready", pid: message.pid, late: state.closed })) return
      if (!state.closed) ready.resolve(message.pid!)
      return
    }
    const response = pending.get(message.id ?? "")
    const request = requests.get(message.id ?? "")
    const expired = request && Date.now() >= Math.min(request.deadline, input.deadline)
    if (
      !write({
        event: response && !expired ? "response" : "late_response",
        ...request,
        id: message.id,
        error: message.error,
        result: message.result,
      })
    )
      return
    requests.delete(message.id ?? "")
    if (!response) return
    pending.delete(message.id!)
    if (request && Date.now() >= Math.min(request.deadline, input.deadline)) {
      write({ event: "delivery_expired", ...request, id: message.id, execution: "unknown" })
      response.reject(new Error("Research IPC operation timed out before recorded delivery: " + request.action))
      void stop("operation_timeout").catch(() => undefined)
      return
    }
    if (message.error) response.reject(new Error(message.error))
    else response.resolve(message.result)
  })
  const stopState = { promise: undefined as Promise<void> | undefined }
  const stop = (reason = "requested") => {
    if (stopState.promise) return stopState.promise
    state.closed = true
    clearTimeout(startupTimer)
    clearTimeout(deadlineTimer)
    input.signal.removeEventListener("abort", abort)
    const error = new Error("Research host connection closed: " + reason)
    ready.reject(error)
    pending.forEach((value) => value.reject(error))
    pending.clear()
    const startedAt = Date.now()
    write({ event: "stop_requested", reason, execution: "unknown", cleanupDeadline: startedAt + input.policy.cleanup })
    stopState.promise = (async () => {
      const before = await observeHost(state.host)
      if (child.exitCode === null) child.kill("SIGTERM")
      const timer = { value: undefined as ReturnType<typeof setTimeout> | undefined }
      const exit = await Promise.race([
        child.exited,
        new Promise<null>((resolve) => {
          timer.value = setTimeout(() => resolve(null), Math.max(1, startedAt + input.policy.cleanup - Date.now()))
        }),
      ])
      clearTimeout(timer.value)
      const after = await observeHost(state.host)
      const complete =
        exit !== null && exit !== 126 && child.signalCode === null && ["gone", "replaced"].includes(after.state)
      const report = {
        version: 1,
        policy: input.policy,
        startedAt,
        endedAt: Date.now(),
        deadline: startedAt + input.policy.cleanup,
        reason,
        complete,
        status: complete ? "confirmed" : "unconfirmed",
        supervisor: { pid: child.pid, exit, signal: child.signalCode },
        host: state.host,
        before,
        after,
        ...(archive ? { journalID: archive.id, connectionID } : {}),
        ...(state.recordingError ? { recordingError: String(state.recordingError) } : {}),
      }
      writeFileSync(cleanupFile, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true })
      write({ event: "cleanup", ...report })
      if (!complete) throw new Error("Research supervisor cleanup unconfirmed")
      if (state.recordingError) throw state.recordingError
    })()
    return stopState.promise
  }
  const abort = () => {
    write({ event: "cancelled", execution: "unknown" })
    void stop("cancelled").catch(() => undefined)
  }
  const deadlineTimer = setTimeout(
    () => {
      write({ event: "deadline_expired", execution: "unknown" })
      void stop("original_deadline").catch(() => undefined)
    },
    Math.max(1, input.deadline - Date.now()),
  )
  const startupTimer = setTimeout(
    () => {
      write({ event: "startup_expired", execution: "unknown" })
      void stop("startup_timeout").catch(() => undefined)
    },
    Math.max(1, Math.min(input.policy.startup, input.deadline - Date.now())),
  )
  input.signal.addEventListener("abort", abort, { once: true })
  void child.exited.then((exit) => {
    write({ event: "supervisor_exit", exit, signal: child.signalCode })
    ready.reject(new Error("Research host exited"))
    pending.forEach((value) => value.reject(new Error("Research host exited")))
    pending.clear()
  })
  write({ event: "startup", supervisorPID: child.pid, policy: input.policy, deadline: input.deadline })
  const started = ready.promise
    .then(async (pid) => {
      state.host = await processIdentity(pid)
      if (!state.host || state.host.parent !== child.pid || state.closed || Date.now() >= input.deadline)
        throw new Error("Research host identity unavailable or connection stopped")
      clearTimeout(startupTimer)
    })
    .catch(async (error) => {
      await stop("startup_failure").catch(() => undefined)
      throw error
    })
  if (input.signal.aborted) abort()
  return {
    child,
    started,
    stop,
    cleanupFile,
    get identity() {
      return state.host
    },
    command(action: string, contractID: string, payload?: unknown) {
      if (state.closed || child.exitCode !== null || Date.now() >= input.deadline)
        return Promise.reject(new Error("Research host command admission closed"))
      const id = crypto.randomUUID()
      const deadline = Math.min(Date.now() + input.policy.operation, input.deadline)
      requests.set(id, { action, contractID, deadline })
      if (!write({ event: "command_start", id, action, contractID, deadline, ...(archive ? { payload } : {}) }))
        return Promise.reject(state.recordingError)
      if (Date.now() >= deadline) {
        write({ event: "dispatch_expired", id, action, contractID, deadline, execution: "not_dispatched" })
        void stop("operation_timeout").catch(() => undefined)
        return Promise.reject(new Error("Research IPC operation timed out before dispatch: " + action))
      }
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            pending.delete(id)
            write({ event: "wait_expired", id, action, contractID, deadline, execution: "unknown" })
            void stop("operation_timeout").then(
              () => reject(new Error("Research IPC operation timed out; cleanup confirmed: " + action)),
              () => reject(new Error("Research IPC operation timed out; cleanup unconfirmed: " + action)),
            )
          },
          Math.max(1, deadline - Date.now()),
        )
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        child.send({ id, action, contractID, input: payload, operationDeadline: deadline })
      })
    },
  }
}
