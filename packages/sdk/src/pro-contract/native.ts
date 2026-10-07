export * as ContractNative from "./native"

import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { RSI } from "@opencode/core/pro-contract/rsi"
import { ProContract } from "@opencode/schema/pro-contract"
import { ContractLedger } from "@opencode/core/pro-contract/ledger"

export type Runtime = { directory: string; bun: string; python: string; bwrap: string }
export type Model = { id: string; effort: string; upstream: string; credential?: string }
export const Handoff = RSI.Handoff
export const Grade = Schema.Struct({
  passed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThan(0)),
  valid: Schema.Boolean,
  feedback: Schema.optional(Schema.String),
})
export type Grade = typeof Grade.Type
export type Verifier = { directory: string; command: readonly string[] }
type Entry = { path: string; directory: true } | { path: string; hash: string; executable: boolean; directory?: false }

export async function snapshot(source: string, objects: string) {
  const temporary = path.join(objects, `pending-${crypto.randomUUID()}`)
  await fs.mkdir(temporary, { recursive: true, mode: 0o700 })
  const files: Entry[] = []
  const copy = async (relative: string) => {
    const names = (await fs.readdir(path.join(source, relative))).sort()
    for (const name of names) {
      const file = path.join(relative, name)
      const stat = await fs.lstat(path.join(source, file))
      if (stat.isDirectory()) {
        if (files.length >= 10000) throw new Error("Snapshot entry-count infrastructure guard")
        files.push({ path: file, directory: true })
        await fs.mkdir(path.join(temporary, file))
        await copy(file)
        continue
      }
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
        throw new Error(`Snapshot requires bounded regular files: ${file}`)
      if (files.length >= 10000) throw new Error("Snapshot file-count infrastructure guard")
      const bytes = await Bun.file(path.join(source, file)).bytes()
      await Bun.write(path.join(temporary, file), bytes)
      await fs.chmod(path.join(temporary, file), stat.mode & 0o111 ? 0o700 : 0o600)
      files.push({ path: file, hash: Bun.SHA256.hash(bytes, "hex"), executable: !!(stat.mode & 0o111) })
    }
  }
  await copy("")
  const hash = RSI.hash(files)
  const directory = path.join(objects, hash)
  await fs.rename(temporary, directory).catch(async (error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || !["EEXIST", "ENOTEMPTY"].includes(String(error.code)))
      throw error
    // Simultaneous imports of the same immutable input have the same destination.
    await fs.rm(temporary, { recursive: true })
  })
  await Bun.write(path.join(objects, hash + ".json"), JSON.stringify(files))
  return { hash, directory }
}

export async function restore(objects: string, hash: string, destination: string) {
  const entries: Entry[] = await Bun.file(path.join(objects, hash + ".json")).json()
  if (RSI.hash(entries) !== hash) throw new Error("Checkpoint manifest integrity failure")
  await fs.mkdir(destination, { recursive: true, mode: 0o700 })
  for (const file of entries) {
    if (path.isAbsolute(file.path) || file.path.split(path.sep).includes(".."))
      throw new Error("Invalid checkpoint path")
    if (file.directory) {
      await fs.mkdir(path.join(destination, file.path), { recursive: true })
      continue
    }
    const bytes = await Bun.file(path.join(objects, hash, file.path)).bytes()
    if (Bun.SHA256.hash(bytes, "hex") !== file.hash) throw new Error("Checkpoint bytes changed")
    await fs.mkdir(path.dirname(path.join(destination, file.path)), { recursive: true })
    await Bun.write(path.join(destination, file.path), bytes)
    await fs.chmod(path.join(destination, file.path), file.executable ? 0o700 : 0o600)
  }
}

export function sandbox(runtime: Runtime, workspace: string, state: string) {
  return [
    runtime.bwrap,
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--as-pid-1",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/etc",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--symlink",
    "/usr/bin",
    "/bin",
    "--symlink",
    "/usr/sbin",
    "/sbin",
    "--ro-bind",
    runtime.directory,
    "/runtime",
    "--ro-bind",
    runtime.bun,
    "/tools/bun",
    "--bind",
    workspace,
    "/workspace",
    "--bind",
    state,
    "/state",
    "--chdir",
    "/workspace",
    "--clearenv",
    "--setenv",
    "PATH",
    "/tools:/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/state/home",
    "--setenv",
    "XDG_DATA_HOME",
    "/state/data",
    "--setenv",
    "XDG_CONFIG_HOME",
    "/state/config",
    "--setenv",
    "XDG_CACHE_HOME",
    "/state/cache",
    "--setenv",
    "XDG_STATE_HOME",
    "/state/local",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "LANG",
    "C.UTF-8",
  ]
}

export async function run(input: {
  root: string
  id: string
  runtime: Runtime
  model: Model
  store: ContractLedger.Store
  task: ProContract.ID
  parent: ContractLedger.Method
  method: RSI.Method
  checkpoint: string
  goal: string
  feedback: readonly string[]
  evaluation: boolean
  signal: AbortSignal
  assignment?: { test: string; repeat: number; side: "baseline" | "candidate" }
}) {
  const root = path.join(input.root, "executions", input.id)
  const workspace = path.join(root, "workspace")
  const state = path.join(root, "state")
  const channel = await fs.mkdtemp("/tmp/pc-channel-")
  const admission = path.join(root, "admission")
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  for (const directory of [state, admission]) await fs.mkdir(directory, { mode: 0o700 })
  await restore(path.join(input.root, "checkpoints"), input.checkpoint, workspace)
  const initial = input.store.read()
  const credential = input.model.credential ? process.env[input.model.credential] : undefined
  if (input.model.credential && !credential) throw new Error("Configured host provider credential is unavailable")
  input.store.assertTask(initial, input.task)
  input.store.assertMethod(initial, input.parent)
  const deadline = initial.kernel.contracts[input.task].spec.budget.deadline
  const method = RSI.method(input.method)
  await Bun.write(
    path.join(admission, "input.json"),
    JSON.stringify({
      goal: input.goal,
      deadline,
      model: input.model.id,
      effort: input.model.effort,
      instructions: method.instructions,
      feedback: input.feedback,
      evaluation: input.evaluation,
    }),
  )
  const worker = Bun.spawn(
    [
      ...sandbox(input.runtime, workspace, state),
      "--info-fd",
      "3",
      "--ro-bind",
      admission,
      "/admission",
      "--ro-bind",
      channel,
      "/channel",
      "/tools/bun",
      "/runtime/packages/sdk/src/pro-contract/worker.ts",
    ],
    {
      env: {},
      stdio: ["ignore", Bun.file(path.join(root, "stdout.log")), Bun.file(path.join(root, "stderr.log")), "pipe"],
    },
  )
  const gateway: { process?: ReturnType<typeof Bun.spawn> } = {}
  const stop = () => {
    worker.kill("SIGKILL")
    gateway.process?.kill("SIGTERM")
  }
  const timer = setTimeout(stop, Math.max(1, deadline - Date.now()))
  const startupTimer = setTimeout(stop, Math.max(1, Math.min(30000, deadline - Date.now())))
  input.signal.addEventListener("abort", stop, { once: true })
  const monitor = setInterval(() => {
    const state = input.store.read()
    if (
      state.kernel.contracts[input.task]?.status !== "active" ||
      state.kernel.contracts[input.parent.grant]?.status !== "discharged"
    )
      stop()
    if (input.signal.aborted || existsSync(path.join(input.root, "CANCEL"))) stop()
  }, 100)
  try {
    input.signal.throwIfAborted()
    const descriptor = worker.stdio[3]
    if (descriptor === undefined || descriptor === null) throw new Error("Missing sandbox identity pipe")
    const identity: { "child-pid": number } = JSON.parse(
      typeof descriptor === "number" ? await Bun.file(descriptor).text() : await new Response(descriptor).text(),
    )
    const pid = identity["child-pid"]
    const birth = (await Bun.file(`/proc/${pid}/stat`).text()).split(")").at(-1)!.trim().split(/\s+/)[19]
    const config = {
      upstream: input.model.upstream,
      model: input.model.id,
      effort: input.model.effort,
      pid,
      birth,
      deadline,
      ledger: path.join(input.root, "ledger.sqlite"),
      task: input.task,
      grant: input.parent.grant,
      parent: input.parent.hash,
      method: RSI.hash(method),
      cancel: path.join(input.root, "CANCEL"),
      journal: path.join(root, "requests.jsonl"),
      socket: path.join(channel, "provider.sock"),
    }
    await Bun.write(path.join(root, "gateway.json"), JSON.stringify(config))
    gateway.process = Bun.spawn(
      [
        input.runtime.python,
        path.join(input.runtime.directory, "packages/sdk/src/pro-contract/gateway.py"),
        path.join(root, "gateway.json"),
      ],
      {
        env: { PATH: "/usr/bin:/bin", ...(credential ? { OPENAI_API_KEY: credential } : {}) },
        stdout: Bun.file(path.join(root, "gateway.log")),
        stderr: Bun.file(path.join(root, "gateway-error.log")),
      },
    )
    const startup = Math.min(deadline, Date.now() + 30000)
    while (!(await fs.stat(config.socket).catch(() => undefined))) {
      input.signal.throwIfAborted()
      if (Date.now() >= startup || gateway.process.exitCode !== null || worker.exitCode !== null)
        throw new Error(`Model channel startup failed; inspect ${root}`)
      await Bun.sleep(20)
    }
    await Bun.write(path.join(admission, "ready"), "ready")
    clearTimeout(startupTimer)
    if ((await worker.exited) !== 0) throw new Error(`Native worker failed; inspect ${root}`)
    input.signal.throwIfAborted()
    const handoff = Schema.decodeUnknownSync(Schema.fromJsonString(Handoff))(
      await Bun.file(path.join(state, "result.json")).text(),
    )
    if ((handoff.action === "propose") !== (handoff.method !== undefined)) throw new Error("Malformed native handoff")
    if (input.evaluation && handoff.action === "propose") throw new Error("Nested evaluation proposal")
    const sealed = await snapshot(workspace, path.join(input.root, "checkpoints"))
    const receipt = {
      id: input.id,
      task: input.task,
      parent: input.parent,
      method: RSI.hash(method),
      input: input.checkpoint,
      output: sealed.hash,
      deadline,
      evaluation: input.evaluation,
      ...(input.assignment ? { assignment: input.assignment } : {}),
      session: await Bun.file(path.join(state, "identity.json")).json(),
      handoff,
      fenced: true,
    }
    return { handoff, checkpoint: sealed.hash, receipt: input.store.object(receipt), root }
  } finally {
    clearTimeout(timer)
    clearTimeout(startupTimer)
    clearInterval(monitor)
    input.signal.removeEventListener("abort", stop)
    stop()
    await worker.exited
    await gateway.process?.exited
    await fs.rm(channel, { recursive: true, force: true })
    await Bun.write(
      path.join(root, "FENCED.json"),
      JSON.stringify({
        pid: worker.pid,
        exitCode: worker.exitCode,
        gatewayExitCode: gateway.process?.exitCode,
        deadline,
        time: Date.now(),
      }),
    )
  }
}

export async function grade(input: {
  root: string
  runtime: Runtime
  verifier: Verifier
  checkpoint: string
  deadline: number
  signal: AbortSignal
}) {
  const root = path.join(input.root, "verifications", crypto.randomUUID())
  const workspace = path.join(root, "workspace")
  const state = path.join(root, "state")
  await fs.mkdir(state, { recursive: true, mode: 0o700 })
  await restore(path.join(input.root, "checkpoints"), input.checkpoint, workspace)
  const process = Bun.spawn(
    [
      ...sandbox(input.runtime, workspace, state),
      "--ro-bind",
      input.verifier.directory,
      "/verifier",
      ...input.verifier.command,
    ],
    {
      env: {},
      stdout: Bun.file(path.join(root, "stdout.json")),
      stderr: Bun.file(path.join(root, "stderr.log")),
    },
  )
  const stop = () => process.kill("SIGKILL")
  input.signal.addEventListener("abort", stop, { once: true })
  const timer = setTimeout(stop, Math.max(1, Math.min(600000, input.deadline - Date.now())))
  try {
    input.signal.throwIfAborted()
    if (Date.now() >= input.deadline || (await process.exited) !== 0) throw new Error(`Verifier unavailable: ${root}`)
    input.signal.throwIfAborted()
    const file = Bun.file(path.join(root, "stdout.json"))
    if (file.size > 1024 * 1024) throw new Error("Verifier report exceeds individual operation bound")
    const result = Schema.decodeUnknownSync(Schema.fromJsonString(Grade))(await file.text(), {
      onExcessProperty: "error",
    })
    if (!result.valid || result.passed > result.total) throw new Error("Invalid verifier evidence")
    return { result, root }
  } finally {
    clearTimeout(timer)
    input.signal.removeEventListener("abort", stop)
    stop()
    await process.exited
    await Bun.write(
      path.join(root, "FENCED.json"),
      JSON.stringify({ exitCode: process.exitCode, deadline: input.deadline }),
    )
  }
}
