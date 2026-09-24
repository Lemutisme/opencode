import { mkdir } from "node:fs/promises"
import path from "node:path"
import { hostBoundary } from "./isolation"
import { processIdentity } from "./observe"
import { hostControl } from "./host-control"
import type { Infrastructure } from "./infrastructure"

export async function start(input: {
  storage: string
  directory: string
  launcher: string
  port: number
  bun: string
  timeout: number
  infrastructure?: Infrastructure
  deadline?: number
  signal?: AbortSignal
}) {
  await mkdir(path.join(input.storage, "tmp"), { recursive: true })
  const ready = Promise.withResolvers<number>()
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const log = path.join(input.storage, crypto.randomUUID() + ".host.log")
  const boundary = await hostBoundary({ ...input, entry: "evaluation" })
  const spawn = (
    ipc: (message: { ready?: boolean; pid?: number; id?: string; result?: unknown; error?: string }) => void,
  ) =>
    Bun.spawn([...boundary, input.bun, path.join(import.meta.dir, "host-process.ts")], {
      cwd: input.directory,
      detached: true,
      env: {
        ...(input.infrastructure ? { RESEARCH_ISSUE_TRACE: path.join(input.storage, "issuance.jsonl") } : {}),
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        HOME: path.join(input.storage, "home"),
        TMPDIR: path.join(input.storage, "tmp"),
        XDG_DATA_HOME: path.join(input.storage, "data"),
        XDG_CONFIG_HOME: path.join(input.storage, "config"),
        XDG_CACHE_HOME: path.join(input.storage, "cache"),
        XDG_STATE_HOME: path.join(input.storage, "state"),
        OPENCODE_TEST_HOME: path.join(input.storage, "home"),
        OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(input.storage, "managed"),
        OPENCODE_DB: path.join(input.storage, "opencode.db"),
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_ACTION_FUSION: "0",
        OPENCODE_MODELS_PATH: path.join(input.storage, "models.json"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdin: "ignore",
      stdout: Bun.file(log),
      stderr: Bun.file(log),
      ipc,
    })
  if (input.infrastructure) {
    if (!input.deadline || !input.signal) throw new Error("Audited host requires original deadline and cancellation")
    const client = hostControl({
      spawn,
      policy: input.infrastructure,
      deadline: input.deadline,
      signal: input.signal,
      journal: path.join(input.storage, "operations.jsonl"),
      cleanupFile: path.join(input.storage, "cleanup.json"),
    })
    await client.started
    return { ...client, log, identity: client.identity! }
  }
  const child = spawn((message) => {
    if (message.ready) return ready.resolve(message.pid!)
    const response = pending.get(message.id ?? "")
    if (!response) return
    pending.delete(message.id!)
    if (message.error) response.reject(new Error(message.error))
    else response.resolve(message.result)
  })
  const stop = async () => {
    // SIGTERM asks the trusted subreaper to kill/reap its entire tree, including orphans.
    if (child.exitCode === null) child.kill("SIGTERM")
    const result = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Research supervisor cleanup timed out")), input.timeout)
        void child.exited.then(() => clearTimeout(timer))
      }),
    ])
    if (result === 126 || child.signalCode !== null)
      throw new Error("Research supervisor could not prove complete cleanup")
  }
  void child.exited.then(() => {
    const error = new Error("Research host exited; see retained host log")
    ready.reject(error)
    pending.forEach((item) => item.reject(error))
    pending.clear()
  })
  const timer = setTimeout(() => ready.reject(new Error("Research host startup timed out")), input.timeout)
  const pid = await ready.promise
    .catch(async (error) => {
      await stop()
      throw error
    })
    .finally(() => clearTimeout(timer))
  const identity = await processIdentity(pid)
  if (!identity || identity.parent !== child.pid) {
    await stop()
    throw new Error("Host identity does not belong to the supervisor")
  }
  return {
    child,
    log,
    identity,
    stop,
    command(action: string, contractID: string, payload?: unknown) {
      if (child.exitCode !== null) return Promise.reject(new Error("Research host is stopped"))
      const id = crypto.randomUUID()
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error("Research IPC operation timed out: " + action))
        }, input.timeout)
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
        child.send({ id, action, contractID, input: payload })
      })
    },
  }
}
