// Public behavioral evidence for a single native allocation, not Kernel authority.
import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { Schema } from "effect"

export namespace ContractDelivery {
  const Data = Schema.Union([Schema.String, Schema.Struct({ base64: Schema.String })])
  export const Probe = Schema.Struct({
    title: Schema.String,
    args: Schema.Array(Schema.String),
    stdin: Schema.optional(Data),
    files: Schema.optional(Schema.Record(Schema.String, Data)),
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    outputs: Schema.optional(Schema.Array(Schema.String)),
  })
  export const Input = Schema.Union([
    Schema.Struct({ action: Schema.Literal("probe"), probe: Probe }),
    Schema.Struct({ action: Schema.Literal("status") }),
    Schema.Struct({ action: Schema.Literal("handoff"), summary: Schema.String }),
    Schema.Struct({ action: Schema.Literal("blocked"), reason: Schema.String }),
  ])
  export const instructions = `Delivery is not authorized by a final text response or a passing self-written validator.
Use contract_delivery(action="probe") for public black-box observations: it retains the reference result and compares the candidate. Each probe is a durable regression obligation; it cannot be deleted or silently redefined. Register documented behavior families and edge cases, not just one passing smoke test. Shell remains available for exploratory work, but discoveries made there must be turned into retained probes.
A probe runs reference and executable separately with the same args, stdin, fixture files, environment and working directory. Strings are UTF-8; use {base64: "..."} for binary stdin or fixture contents. Use {{case}} in textual fixtures, stdin, args or env to refer to that temporary fixture directory. outputs lists relative files whose bytes must also match. Do not put fixtures into the source tree. Use read/shell for exploratory cases not supported by this probe format; disclose these coverage limitations in your handoff summary.
Before stopping, call contract_delivery(action="handoff", summary=...) with what was implemented and remaining coverage uncertainty. It rebuilds, runs validate.sh and replays EVERY retained probe against the current candidate. Mismatches prevent handoff and must be repaired. A successful handoff is only permission to submit for independent host evaluation, never proof of full task correctness.
If an obligation cannot be resolved safely, use action="blocked" with a concrete reason instead of claiming completion. The original deadline never resets. Official hidden tests are unavailable and must not be requested.`

  type Observation = { exit: number; stdout: string; stderr: string; files: Record<string, string | null> }
  type Entry =
    | { type: "probe"; id: string; probe: typeof Probe.Type; expected: Observation }
    | { type: "check"; id: string; actual: Observation | null; matches: boolean }
    | { type: "handoff"; snapshot: string; summary: string }
    | { type: "blocked"; reason: string }
    | { type: "reopened"; reason: string }
  type Options = {
    directory: string
    state: string
    reference: string
    deadline: number
    signal: AbortSignal
    assertStanding: () => Promise<void>
  }

  export async function create(options: Options) {
    await fs.mkdir(options.state, { recursive: true })
    const journal = path.join(options.state, "delivery.jsonl")
    // This is unprivileged execution evidence, not an issuer ledger or a restart grant.
    let latest: Entry | undefined
    const probes = new Map<string, Extract<Entry, { type: "probe" }>>()
    const append = async (record: Entry) => {
      await fs.appendFile(journal, JSON.stringify(record) + "\n")
      if (record.type !== "check") latest = record
      if (record.type === "probe") probes.set(record.id, record)
    }
    if (await Bun.file(journal).exists())
      throw new Error("Delivery evidence already exists; explicit recovery required")
    const assertActive = async () => {
      options.signal.throwIfAborted()
      if (Date.now() >= options.deadline) throw new Error("Original Contract deadline reached")
      await options.assertStanding()
    }
    const snapshot = async () => {
      await assertActive()
      const hash = new Bun.CryptoHasher("sha256")
      const files = await Array.fromAsync(
        new Bun.Glob("**/*").scan({
          cwd: options.directory,
          dot: true,
          onlyFiles: false,
          followSymlinks: false,
        }),
      )
      for (const file of files.sort()) {
        if (file === "reference" || file === ".git" || file.startsWith(".git/")) continue
        await assertActive()
        const full = path.join(options.directory, file)
        const stat = await fs.lstat(full)
        hash.update(JSON.stringify([file, stat.mode, stat.isFile() ? stat.size : null]))
        if (stat.isSymbolicLink()) {
          const target = await fs.readlink(full)
          const relative = path.relative(options.directory, path.resolve(path.dirname(full), target))
          if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))
            throw new Error("Candidate symlink escapes snapshot scope")
          hash.update(target)
        }
        if (stat.isFile()) {
          const reader = Bun.file(full).stream().getReader()
          try {
            while (true) {
              await assertActive()
              const chunk = await reader.read()
              if (chunk.done) break
              hash.update(chunk.value)
            }
          } finally {
            await reader.cancel()
          }
        }
        if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink())
          throw new Error("Unsupported candidate file type")
      }
      return hash.digest("hex")
    }
    const run = async (
      argv: string[],
      cwd: string,
      env = process.env,
      stdin: string | Uint8Array = "",
      signal = options.signal,
    ) => {
      await assertActive()
      return execute(argv, {
        cwd,
        env,
        stdin,
        signal: AbortSignal.any([
          options.signal,
          signal,
          AbortSignal.timeout(Math.max(1, Math.min(600_000, options.deadline - Date.now()))),
        ]),
      })
    }
    const observe = async (
      executable: string,
      probe: typeof Probe.Type,
      directory: string,
      signal: AbortSignal,
    ): Promise<Observation> => {
      await fs.rm(directory, { recursive: true, force: true })
      await fs.mkdir(directory, { recursive: true })
      for (const [file, content] of Object.entries(probe.files ?? {})) {
        const target = fixturePath(directory, file)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await Bun.write(target, data(content, directory))
      }
      const expand = (text: string) => text.replaceAll("{{case}}", directory)
      const result = await run(
        [executable, ...probe.args.map(expand)],
        directory,
        {
          ...process.env,
          HOME: directory,
          TMPDIR: directory,
          XDG_CONFIG_HOME: path.join(directory, ".config"),
          XDG_DATA_HOME: path.join(directory, ".data"),
          XDG_CACHE_HOME: path.join(directory, ".cache"),
          XDG_STATE_HOME: path.join(directory, ".state"),
          ...Object.fromEntries(Object.entries(probe.env ?? {}).map(([key, value]) => [key, expand(value)])),
        },
        data(probe.stdin ?? "", directory),
        signal,
      )
      const files: Record<string, string | null> = {}
      for (const file of probe.outputs ?? []) {
        const target = fixturePath(directory, file)
        files[file] = (await Bun.file(target).exists())
          ? Buffer.from(await Bun.file(target).arrayBuffer()).toString("base64")
          : null
      }
      return { ...result, files }
    }
    const check = async (item: Extract<Entry, { type: "probe" }>, directory: string, signal: AbortSignal) => {
      const executable = path.join(options.directory, "executable")
      const actual = (await Bun.file(executable).exists())
        ? await observe(executable, item.probe, directory, signal)
        : null
      const matches = JSON.stringify(actual) === JSON.stringify(item.expected)
      await append({ type: "check", id: item.id, actual, matches })
      return { id: item.id, title: item.probe.title, matches, expected: item.expected, actual }
    }
    const status = async () => {
      const last = latest
      if (last?.type === "blocked") return { state: "blocked" as const, reason: last.reason, probes: probes.size }
      if (last?.type === "handoff" && last.snapshot === (await snapshot()))
        return { state: "ready" as const, snapshot: last.snapshot, summary: last.summary, probes: probes.size }
      if (last?.type === "handoff") await append({ type: "reopened", reason: "Candidate changed after handoff" })
      return { state: "open" as const, probes: probes.size }
    }
    const act = async (input: typeof Input.Type, signal = options.signal) => {
      signal.throwIfAborted()
      await assertActive()
      if (input.action === "status") return status()
      if (input.action === "blocked") {
        if (!input.reason.trim()) throw new Error("A concrete blocking reason is required")
        await append({ type: "blocked", reason: input.reason })
        return status()
      }
      if ((await status()).state === "blocked") throw new Error("This allocation has been explicitly blocked")
      if (input.action === "probe") {
        await append({ type: "reopened", reason: "A public probe needs fresh handoff validation" })
        const id = Bun.SHA256.hash(JSON.stringify(input.probe), "hex")
        const directory = path.join(options.state, "cases", id)
        try {
          const existing = probes.get(id)
          const item = existing ?? {
            type: "probe" as const,
            id,
            probe: input.probe,
            expected: await observe(options.reference, input.probe, directory, signal),
          }
          if (!existing) await append(item)
          return await check(item, directory, signal)
        } finally {
          await fs.rm(directory, { recursive: true, force: true })
        }
      }
      if (!input.summary.trim()) throw new Error("A handoff summary is required")
      if (!probes.size)
        return { state: "open", reason: "No retained public behavioral evidence; register probes before handoff" }
      await append({ type: "reopened", reason: "Revalidating the current candidate" })
      const compiled = await run(["/bin/bash", "compile.sh"], options.directory, process.env, "", signal)
      if (compiled.exit !== 0) return { state: "open", reason: "compile.sh failed", result: compiled }
      const before = await snapshot()
      const validated = await run(["/bin/bash", "validate.sh"], options.directory, process.env, "", signal)
      if (validated.exit !== 0) return { state: "open", reason: "validate.sh failed", result: validated }
      const failures = []
      for (const item of probes.values()) {
        const directory = path.join(options.state, "cases", item.id)
        try {
          const result = await check(item, directory, signal)
          if (!result.matches) failures.push(result)
        } finally {
          await fs.rm(directory, { recursive: true, force: true })
        }
      }
      if (failures.length) return { state: "open", reason: "Retained public counterexamples remain", failures }
      if (before !== (await snapshot()))
        return { state: "open", reason: "Candidate changed during replay; evidence is stale" }
      signal.throwIfAborted()
      await append({ type: "handoff", snapshot: before, summary: input.summary })
      return { ...(await status()), authoritativeCompletion: false }
    }
    // Serialize candidate tools and closure operations so validation cannot race a patch.
    let pending = Promise.resolve()
    const exclusive = <T>(action: () => Promise<T>): Promise<T> => {
      const next = pending.then(async () => {
        await assertActive()
        return action()
      })
      pending = next.then(
        () => undefined,
        () => undefined,
      )
      return next
    }
    return { act, status, exclusive }
  }

  function data(value: typeof Data.Type, directory: string) {
    if (typeof value === "string") return value.replaceAll("{{case}}", directory)
    const bytes = Buffer.from(value.base64, "base64")
    if (bytes.toString("base64") !== value.base64) throw new Error("Binary fixture data must be canonical base64")
    return bytes
  }

  function fixturePath(directory: string, file: string) {
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
      throw new Error("Fixture paths must be relative and stay inside the probe")
    return path.join(directory, file)
  }

  async function execute(
    argv: string[],
    input: { cwd: string; env: NodeJS.ProcessEnv; stdin: string | Uint8Array; signal: AbortSignal },
  ) {
    input.signal.throwIfAborted()
    const child = spawn(argv[0], argv.slice(1), { cwd: input.cwd, env: input.env, detached: true, stdio: "pipe" })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const outcome = await new Promise<{ exit: number; stdout: string; stderr: string }>((resolve, reject) => {
      let size = 0
      let error: Error | undefined
      const stop = () => {
        error ??= new Error("Operation cancelled or original deadline reached")
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL")
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ESRCH") reject(cause)
          }
        }
      }
      const collect = (target: Buffer[]) => (data: Buffer) => {
        size += data.length
        if (size > 8 * 1024 * 1024) {
          error = new Error("Individual probe output exceeded 8 MiB; no evidence admitted")
          stop()
          return
        }
        target.push(data)
      }
      input.signal.addEventListener("abort", stop, { once: true })
      child.stdout.on("data", collect(stdout))
      child.stderr.on("data", collect(stderr))
      child.stdin.on("error", () => undefined) // A CLI may intentionally exit without consuming stdin.
      child.on("error", (cause) => {
        error = cause
      })
      child.on("close", (code, signal) => {
        input.signal.removeEventListener("abort", stop)
        // Reap background descendants even when their parent exited successfully.
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL")
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ESRCH") return reject(cause)
          }
        }
        if (error) return reject(error)
        if (signal || code === null) return reject(new Error(`Probe terminated by ${signal}`))
        resolve({
          exit: code,
          stdout: Buffer.concat(stdout).toString("base64"),
          stderr: Buffer.concat(stderr).toString("base64"),
        })
      })
      child.stdin.end(input.stdin)
      if (input.signal.aborted) stop()
    })
    return outcome
  }
}
