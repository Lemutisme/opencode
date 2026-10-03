// Local proposal feedback inside mutable H. A receipt is not a release,
// performance evidence, or permission to skip the host's independent builder.
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { Schema } from "effect"

export const ProposalMetadata = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("h"), entry: Schema.String, parentSource: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("s") }),
])

export function proposalKind(input: { artifact: string; mode?: string; proposal?: typeof ProposalMetadata.Type }) {
  if (!input.proposal) return
  if (input.mode !== undefined || input.proposal.kind !== input.artifact)
    throw new Error("Proposal metadata conflicts with the admitted task mode/artifact")
  return input.proposal.kind
}

type Options = {
  kind: "h" | "s"
  artifact: string
  source: string
  state: string
  runtime: string
  bun: string
  parentArchive: string
  metadata?: typeof ProposalMetadata.Type
  deadline: number
  signal: AbortSignal
  standing: () => Promise<void>
}
type Result = {
  ok: boolean
  kind: "h" | "s"
  deadline: number
  localCheckOnly: true
  authoritativeCompletion: false
  performanceEvaluated: false
  artifactHash?: string
  sourceHash?: string
  parentSource?: string
  entry?: string
  bundleHash?: string
  phase: string
  diagnostics: string
}

export async function proposalCheck(options: Options) {
  await fs.mkdir(options.state, { recursive: true })
  const active = async () => {
    options.signal.throwIfAborted()
    if (Date.now() >= options.deadline) throw new Error("Original proposal deadline reached")
    await options.standing()
  }
  return async (signal = options.signal): Promise<Result> => {
    await active()
    signal.throwIfAborted()
    const controller = AbortSignal.any([
      options.signal,
      signal,
      AbortSignal.timeout(Math.max(1, Math.min(600000, options.deadline - Date.now()))),
    ])
    const directory = await fs.mkdtemp(path.join(options.state, "check-"))
    const result: Result = {
      ok: false,
      kind: options.kind,
      deadline: options.deadline,
      phase: "artifact",
      diagnostics: "",
      localCheckOnly: true,
      authoritativeCompletion: false,
      performanceEvaluated: false,
    }
    const commands: Array<{ argv: string[]; exit: number; stdout: string; stderr: string }> = []
    const run = async (argv: string[], cwd = directory) => {
      await active()
      const outcome = await proposalOperation(argv, {
        cwd,
        deadline: options.deadline,
        signal: controller,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          TMPDIR: directory,
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      })
      commands.push({ argv, ...outcome })
      if (outcome.exit !== 0) throw new Error(outcome.stderr || outcome.stdout || `Command exited ${outcome.exit}`)
      return outcome
    }
    try {
      const artifact = await regular(options.artifact, options.kind === "s" ? 65536 : 16 * 1024 * 1024)
      result.artifactHash = Bun.SHA256.hash(artifact, "hex")
      if (options.kind === "s") {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(artifact)
        if (!text.trim() || text.includes("\0"))
          throw new Error("S must be nonempty UTF-8 without NUL and at most 64 KiB")
        await active()
        if (Bun.SHA256.hash(await regular(options.artifact, 65536), "hex") !== result.artifactHash)
          throw new Error("Strategy changed while it was checked")
        result.ok = true
        result.diagnostics =
          "Exact strategy bytes are nonempty UTF-8 without NUL and within 64 KiB. Host qualification is still required."
        return result
      }
      result.phase = "parent"
      if (options.metadata?.kind !== "h")
        throw new Error("Host admission omitted the parent entry/source identity; do not guess a release entry")
      const entry = options.metadata.entry
      if (
        !entry ||
        path.isAbsolute(entry) ||
        entry.includes("\\") ||
        entry
          .split("/")
          .some((part) => !part || part === "." || part === ".." || part === "node_modules" || part === ".git")
      )
        throw new Error("Native entry must be a relative source file inside the proposed release")
      result.entry = entry
      result.parentSource = options.metadata.parentSource
      if (
        !/^[a-f0-9]{64}$/.test(result.parentSource) ||
        (await fileHash(options.parentArchive, controller)) !== result.parentSource
      )
        throw new Error("Mounted parent source does not match the admitted source identity")
      const working = await sourceTree(options.source, controller)
      result.sourceHash = working.hash
      const replay = path.join(directory, "replay")
      await fs.mkdir(replay)
      await fs.writeFile(path.join(directory, "proposal.patch"), artifact, { flag: "wx", mode: 0o400 })
      await run(["tar", "--no-same-owner", "--no-same-permissions", "-xf", options.parentArchive, "-C", replay])
      const parent = await sourceTree(replay, controller)
      if (parent.hash === working.hash)
        throw new Error("H must contain a source change, not an empty or no-op proposal")
      const git = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "-c", "core.filemode=true"]
      await run([...git, "init", "-q"], replay)
      await run([...git, "add", "--force", "--all"], replay)
      result.phase = "patch"
      await run([...git, "apply", "--index", "--whitespace=nowarn", path.join(directory, "proposal.patch")], replay)
      const names = (await run([...git, "ls-files", "-z"], replay)).stdout.split("\0").filter(Boolean)
      if (names.some((name) => name.split("/").some((part) => part === "node_modules" || part === ".git")))
        throw new Error("Proposal cannot mutate the fixed dependency closure or Git metadata")
      result.phase = "binding"
      const applied = await sourceTree(replay, controller)
      if (applied.hash !== working.hash) {
        const paths = [...new Set([...working.files.keys(), ...applied.files.keys()])].filter(
          (name) => working.files.get(name) !== applied.files.get(name),
        )
        throw new Error(
          `Patch does not reproduce the current source, including new files: ${paths.slice(0, 20).join(", ")}. Include new files with git add -N, then export git diff --binary HEAD again. Keep build outputs outside /candidate/source.`,
        )
      }
      if (!(await fs.lstat(path.join(replay, entry))).isFile())
        throw new Error("Native entry must be a regular source file")
      result.phase = "dependencies"
      await dependencies(options.runtime, replay)
      result.phase = "compile"
      await run(
        [
          options.bun,
          "build",
          entry,
          "--target=bun",
          "--packages=external",
          `--outfile=${path.join(directory, "entry.js")}`,
        ],
        replay,
      )
      result.bundleHash = await fileHash(path.join(directory, "entry.js"), controller)
      result.phase = "stability"
      await active()
      if (
        Bun.SHA256.hash(await regular(options.artifact, 16 * 1024 * 1024), "hex") !== result.artifactHash ||
        (await sourceTree(options.source, controller)).hash !== working.hash ||
        (await sourceTree(replay, controller)).hash !== applied.hash
      )
        throw new Error("Patch or source changed during checking; export and check the current bytes again")
      result.ok = true
      result.diagnostics =
        "The exact patch applies to the admitted parent, reproduces all current source files (including additions), and the actual native entry bundles with the pinned Bun/runtime dependency closure. This is local build feedback, not typecheck, task performance, release admission or promotion."
      return result
    } catch (error) {
      // The checked replay has identical source bytes. Show the editable path
      // in model-facing diagnostics; the receipt keeps unmodified command logs.
      result.diagnostics = String(error).replaceAll(path.join(directory, "replay"), options.source).slice(-32768)
      controller.throwIfAborted()
      return result
    } finally {
      // Keep bounded receipts/real command output, not another full source copy
      // per local edit cycle. Historical host experiments are never touched.
      try {
        await fs.appendFile(
          path.join(options.state, "checks.jsonl"),
          JSON.stringify({ at: Date.now(), ...result, commands }) + "\n",
        )
      } finally {
        await fs.rm(directory, { recursive: true, force: true })
      }
    }
  }
}

async function regular(file: string, limit: number) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > limit)
      throw new Error(`One nonempty regular unshared artifact of at most ${limit} bytes is required`)
    const bytes = await handle.readFile()
    if (bytes.length !== stat.size) throw new Error("Artifact changed while reading")
    return bytes
  } finally {
    await handle.close()
  }
}

async function fileHash(file: string, signal: AbortSignal) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 ** 3)
    throw new Error("Source/build file must be bounded, regular and unshared")
  const hash = new Bun.CryptoHasher("sha256")
  const reader = Bun.file(file).stream().getReader()
  const size = { bytes: 0 }
  try {
    while (true) {
      signal.throwIfAborted()
      const item = await reader.read()
      if (item.done) break
      size.bytes += item.value.length
      if (size.bytes > 1024 ** 3) throw new Error("Individual source file exceeded 1 GiB")
      hash.update(item.value)
    }
    if (size.bytes !== stat.size) throw new Error("File changed while hashing")
    return hash.digest("hex")
  } finally {
    await reader.cancel()
  }
}

async function sourceTree(root: string, signal: AbortSignal) {
  if (!path.isAbsolute(root) || (await fs.realpath(root)) !== root || !(await fs.lstat(root)).isDirectory())
    throw new Error("Source must be a canonical directory")
  const files = new Map<string, string>()
  const limits = { bytes: 0 }
  const walk = async (directory: string): Promise<void> => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted()
      if (item.name === ".git" || item.name === "node_modules") continue
      const full = path.join(directory, item.name)
      if (item.isDirectory()) {
        await walk(full)
        continue
      }
      if (files.size >= 100000) throw new Error("Individual source snapshot exceeded 100000 files")
      const name = path.relative(root, full)
      const stat = await fs.lstat(full)
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(full)
        const resolved = await fs.realpath(full).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return path.resolve(directory, target)
          throw error
        })
        const relative = path.relative(root, resolved)
        if (path.isAbsolute(target) || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))
          throw new Error(`Source symlink escapes its release: ${name}`)
        files.set(name, JSON.stringify(["link", target]))
        continue
      }
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Unsupported or hardlinked source entry: ${name}`)
      limits.bytes += stat.size
      if (limits.bytes > 1024 ** 3) throw new Error("Individual source snapshot exceeded 1 GiB")
      files.set(name, JSON.stringify([stat.mode & 0o111 ? 0o755 : 0o644, await fileHash(full, signal)]))
    }
  }
  await walk(root)
  return {
    files,
    hash: Bun.SHA256.hash(
      JSON.stringify([...files].sort(([left], [right]) => (left < right ? -1 : left === right ? 0 : 1))),
      "hex",
    ),
  }
}

async function dependencies(runtime: string, replay: string) {
  const link = async (source: string, target: string, scoped = false): Promise<void> => {
    await fs.mkdir(target)
    for (const item of await fs.readdir(source, { withFileTypes: true })) {
      const from = path.join(source, item.name)
      const to = path.join(target, item.name)
      // Preserve workspace-relative links so they select the proposed source;
      // installed package bytes remain in the read-only runtime supply.
      if (item.isSymbolicLink()) {
        await fs.symlink(await fs.readlink(from), to)
        continue
      }
      if (!scoped && item.isDirectory() && item.name.startsWith("@")) {
        await link(from, to, true)
        continue
      }
      await fs.symlink(from, to)
    }
  }
  if (
    (await Bun.file(path.join(runtime, "node_modules/package.json")).exists()) ||
    (await fs.stat(path.join(runtime, "node_modules")).then(
      (stat) => stat.isDirectory(),
      () => false,
    ))
  )
    await link(path.join(runtime, "node_modules"), path.join(replay, "node_modules"))
  for (const item of await fs
    .readdir(path.join(runtime, "packages"), { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })) {
    if (!item.isDirectory()) continue
    const from = path.join(runtime, "packages", item.name, "node_modules")
    if (
      !(await fs.stat(from).then(
        (stat) => stat.isDirectory(),
        () => false,
      ))
    )
      continue
    await link(from, path.join(replay, "packages", item.name, "node_modules"))
  }
}

/** A bounded local subprocess, fenced as a process group before acknowledging
 * completion/cancellation. Mutable H still remains inside the outer container. */
export async function proposalOperation(
  argv: string[],
  input: {
    cwd: string
    env: NodeJS.ProcessEnv
    deadline: number
    signal: AbortSignal
  },
) {
  input.signal.throwIfAborted()
  if (Date.now() >= input.deadline) throw new Error("Original proposal deadline reached")
  const child = spawn(argv[0], argv.slice(1), {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const output = { stdout: [] as Buffer[], stderr: [] as Buffer[], bytes: 0, error: undefined as Error | undefined }
  const kill = () => {
    if (!child.pid) return
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") output.error ??= error as Error
    }
  }
  const abort = () => {
    output.error ??= new Error("Local check cancelled or original deadline reached")
    kill()
  }
  const timer = setTimeout(abort, Math.max(1, Math.min(600000, input.deadline - Date.now())))
  const collect = (target: Buffer[]) => (bytes: Buffer) => {
    output.bytes += bytes.length
    if (output.bytes > 8 * 1024 * 1024) {
      output.error = new Error("Individual check output exceeded 8 MiB")
      kill()
      return
    }
    target.push(bytes)
  }
  input.signal.addEventListener("abort", abort, { once: true })
  child.stdout.on("data", collect(output.stdout))
  child.stderr.on("data", collect(output.stderr))
  child.on("error", (error) => {
    output.error = error
  })
  child.on("exit", kill)
  if (input.signal.aborted) abort()
  try {
    const exit = await new Promise<number | null>((resolve) => child.on("close", resolve))
    kill()
    const until = Date.now() + 5000
    while (child.pid && (await liveGroup(child.pid))) {
      if (Date.now() >= until) throw new Error("Local check process-group fence unacknowledged")
      kill()
      await Bun.sleep(10)
    }
    if (output.error) throw output.error
    input.signal.throwIfAborted()
    if (exit === null) throw new Error("Local check process terminated without an exit status")
    return {
      exit,
      stdout: Buffer.concat(output.stdout).toString("utf8"),
      stderr: Buffer.concat(output.stderr).toString("utf8"),
    }
  } finally {
    clearTimeout(timer)
    input.signal.removeEventListener("abort", abort)
  }
}

async function liveGroup(group: number) {
  for (const name of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue
    const fields = await fs.readFile(`/proc/${name}/stat`, "utf8").then(
      (value) =>
        value
          .slice(value.lastIndexOf(")") + 1)
          .trim()
          .split(/\s+/),
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ESRCH") return undefined
        throw error
      },
    )
    if (fields && Number(fields[2]) === group && !["Z", "X"].includes(fields[0])) return true
  }
  return false
}
