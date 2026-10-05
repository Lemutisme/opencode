export * as ProContractVersion from "./version"

import { constants } from "node:fs"
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rm } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Hash } from "../util/hash"

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const File = Schema.Struct({ path: Schema.String, hash: Digest, bytes: Schema.Int })
const Entry = Schema.Struct({ ...File.fields, kind: Schema.Literals(["file", "directory"]) })
const Workspace = Schema.Struct({
  version: Schema.Literal(1),
  complete: Schema.Boolean,
  files: Schema.Array(Entry),
  requestHash: Schema.optional(Digest),
})
export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  entrypoint: Schema.String,
  config: Schema.Json,
  runtime: Schema.Struct({ kind: Schema.Literal("bun"), hash: Digest }),
  libraries: Schema.Array(File),
  files: Schema.Array(Entry),
})
export type Manifest = typeof Manifest.Type

// These are proposals and observations, not Contract commands or acceptance evidence.
export const Output = Schema.Struct({
  version: Schema.Literal(1),
  observations: Schema.Array(Schema.Json),
  requests: Schema.Array(Schema.Json),
  artifacts: Schema.Array(Schema.String),
})
export type Output = typeof Output.Type
export const Record = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  versionHash: Digest,
  targetVersion: Schema.optional(Digest),
  requestHash: Digest,
  workspaceHash: Schema.optional(Digest),
  supervisorHash: Schema.optional(Digest),
  startedAt: Schema.Int,
  completedAt: Schema.Int,
  status: Schema.Literals(["completed", "failed", "cancelled", "deadline"]),
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
  result: Schema.optional(Output),
  artifacts: Schema.Array(Entry),
  error: Schema.optional(Schema.String),
})
export type Record = typeof Record.Type

const MAX_PACKAGE_BYTES = 128 * 1024 * 1024
const MAX_FILES = 10_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_INPUT_BYTES = 4 * 1024 * 1024
const LIBRARIES = [
  "/lib64/ld-linux-x86-64.so.2",
  "/lib/x86_64-linux-gnu/libc.so.6",
  "/lib/x86_64-linux-gnu/libpthread.so.0",
  "/lib/x86_64-linux-gnu/libdl.so.2",
  "/lib/x86_64-linux-gnu/libm.so.6",
]

// Fixed host code, never candidate code. Outside the candidate PID namespace, this owner survives a
// host crash long enough to kill the entire sandbox group and enforces the original absolute deadline.
const SUPERVISOR = String.raw`
const config = JSON.parse(Bun.argv.at(-1));
const state = { child: undefined, code: 0 };
const stop = (code) => {
  if (state.code) return;
  state.code = code;
  if (!state.child) return;
  try { process.kill(-state.child.pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
};
process.on("SIGTERM", () => stop(143));
process.on("SIGINT", () => stop(130));
const check = () => {
  if (process.ppid !== config.parent) stop(125);
  if (Date.now() >= config.deadline) stop(124);
};
check();
if (state.code) process.exit(state.code);
try {
  state.child = Bun.spawn(config.argv, { detached: true, env: {}, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
} catch (error) {
  console.error(error.message);
  process.exit(127);
}
check();
const timer = setInterval(check, 25);
const exit = await state.child.exited;
clearInterval(timer);
process.exit(state.code || exit);
`

export function storePath(data: string) {
  return path.join(data, "pro-contract", "versions")
}

export function subjectHash(record: Record) {
  return Hash.sha256(
    JSON.stringify(Schema.decodeUnknownSync(Record)(record), (_key, value: unknown) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : value,
    ),
  )
}

/** A Linux x64, offline execution boundary. The caller, never the candidate, grants the input View. */
export function make(options: { directory: string; runtime?: string; sandbox?: string }) {
  const directory = path.resolve(options.directory)
  const runtime = options.runtime ?? Bun.which("bun") ?? ""
  const sandbox = options.sandbox ?? "/usr/bin/bwrap"
  const runtimeFile = (hash: string) => path.join(directory, "runtime", Schema.decodeUnknownSync(Digest)(hash))
  const versionDirectory = (hash: string) => path.join(directory, "versions", Schema.decodeUnknownSync(Digest)(hash))
  const runDirectory = (id: string) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid version run identity")
    return path.join(directory, "runs", id)
  }

  const inspect = async (versionHash: string) => {
    const location = versionDirectory(versionHash)
    const manifest = decode(Manifest, await Bun.file(path.join(location, "manifest.json")).text())
    if (Hash.sha256(JSON.stringify(manifest)) !== versionHash) throw new Error("Frozen version manifest changed")
    if (JSON.stringify(manifest.libraries.map((library) => library.path)) !== JSON.stringify(LIBRARIES))
      throw new Error("Unsupported frozen runtime library layout")
    await Promise.all(
      [manifest.runtime.hash, ...manifest.libraries.map((library) => library.hash)].map(async (hash) => {
        if ((await digest(runtimeFile(hash))) !== hash) throw new Error("Retained runtime content changed")
      }),
    )
    const files = await snapshot(path.join(location, "source"))
    if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error("Frozen version source changed")
    return manifest
  }

  const source = async (versionHash: string, location: string) => {
    const manifest = await inspect(versionHash)
    if (JSON.stringify(await snapshot(location)) !== JSON.stringify(manifest.files))
      throw new Error("Source does not match the frozen executable version")
    return location
  }

  const read = async (id: string) => {
    const location = runDirectory(id)
    if (!(await Bun.file(path.join(location, "result.json")).exists()))
      throw new Error("Run is incomplete: completion marker is absent; execution is not replayed")
    if (!(await Bun.file(path.join(location, "result.sha256")).exists()))
      throw new Error("Historical run receipt is incomplete: checksum is absent; receipt is preserved")
    const record = decode(Record, await Bun.file(path.join(location, "result.json")).text())
    if (record.id !== id || (await digest(path.join(location, "request.json"))) !== record.requestHash)
      throw new Error("Run record identity changed")
    if (
      record.workspaceHash !== undefined &&
      (await digest(path.join(location, "input.json"))) !== record.workspaceHash
    )
      throw new Error("Run input manifest changed")
    if (
      (await digest(path.join(location, "result.json"))) !==
      (await Bun.file(path.join(location, "result.sha256")).text())
    )
      throw new Error("Run record changed")
    return record
  }

  const readInput = async (id: string) => {
    const location = runDirectory(id)
    if (!(await Bun.file(path.join(location, "input.json")).exists())) {
      if (
        (await Bun.file(path.join(location, "input.sha256")).exists()) ||
        (await lstat(path.join(location, "input")).then(
          () => true,
          (error: unknown) => {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false
            throw error
          },
        ))
      )
        throw new Error("Run input capture is incomplete: manifest marker is absent")
      if (await Bun.file(path.join(location, "result.json")).exists()) {
        const record = await read(id)
        if (record.workspaceHash) throw new Error("Run input manifest is missing")
      }
      return undefined
    }
    const encoded = await Bun.file(path.join(location, "input.json")).text()
    const workspace = decode(Workspace, encoded)
    if (workspace.requestHash) {
      if (!(await Bun.file(path.join(location, "input.sha256")).exists()))
        throw new Error("Run input checksum is missing")
      if (Hash.sha256(encoded) !== (await Bun.file(path.join(location, "input.sha256")).text()))
        throw new Error("Run input manifest changed")
      if ((await digest(path.join(location, "request.json"))) !== workspace.requestHash)
        throw new Error("Run input request identity changed")
      if (
        (await Bun.file(path.join(location, "result.json")).exists()) &&
        (await Bun.file(path.join(location, "result.sha256")).exists())
      )
        await read(id)
      return workspace
    }
    // Legacy inputs without an independent capture marker remain readable only through a completed receipt.
    const record = await read(id)
    if (record.workspaceHash !== Hash.sha256(encoded))
      throw new Error("Historical input has no verified receipt binding")
    return workspace
  }

  return {
    inspect,
    read,
    source,
    async request(id: string) {
      if (await Bun.file(path.join(runDirectory(id), "result.json")).exists()) await read(id)
      else if (!(await readInput(id))?.requestHash) throw new Error("Pending run has no verified request binding")
      return decode(Schema.Json, await Bun.file(path.join(runDirectory(id), "request.json")).text())
    },
    input: readInput,
    async inputDirectory(id: string) {
      const workspace = await readInput(id)
      if (!workspace?.complete) throw new Error("Run input workspace was not captured")
      const location = path.join(runDirectory(id), "input")
      if (JSON.stringify(await snapshot(location)) !== JSON.stringify(workspace.files))
        throw new Error("Run input workspace changed")
      return location
    },
    async candidate(id: string, versionHash: string, prefix = "candidate") {
      relative(prefix)
      const record = await read(id)
      const manifest = await inspect(versionHash)
      const files = record.artifacts
        .filter((file) => file.path.startsWith(prefix + "/"))
        .map((file) => ({ ...file, path: file.path.slice(prefix.length + 1) }))
      if (JSON.stringify(files) !== JSON.stringify(manifest.files))
        throw new Error("Candidate source is not the retained run artifact")
      const location = path.join(runDirectory(id), "artifacts", prefix)
      return source(versionHash, location)
    },
    async artifactDirectory(id: string) {
      const record = await read(id)
      const location = path.join(runDirectory(id), "artifacts")
      if (JSON.stringify(await snapshot(location)) !== JSON.stringify(record.artifacts))
        throw new Error("Run artifacts changed")
      return location
    },
    async freeze(input: { directory: string; entrypoint: string; config?: Schema.Json }) {
      relative(input.entrypoint)
      if (process.platform !== "linux" || process.arch !== "x64")
        throw new Error("Executable versions require Linux x64")
      if (!path.isAbsolute(runtime)) throw new Error("An absolute Bun runtime is required")
      await mkdir(path.join(directory, "versions"), { recursive: true, mode: 0o700 })
      const temporary = await mkdtemp(path.join(directory, "versions", ".freeze-"))
      try {
        const files = await snapshot(input.directory, path.join(temporary, "source"))
        if (!files.some((file) => file.path === input.entrypoint && file.kind === "file"))
          throw new Error("Entrypoint is not a frozen regular file")
        const manifest = Schema.decodeUnknownSync(Manifest)({
          version: 1,
          entrypoint: input.entrypoint,
          config: input.config ?? null,
          runtime: { kind: "bun", hash: (await retainRuntime(directory, runtime)).hash },
          libraries: await Promise.all(
            LIBRARIES.map(async (filename) => ({ path: filename, ...(await retainRuntime(directory, filename)) })),
          ),
          files,
        })
        const encoded = JSON.stringify(manifest)
        const versionHash = Hash.sha256(encoded)
        await Bun.write(path.join(temporary, "manifest.json"), encoded)
        await chmod(path.join(temporary, "manifest.json"), 0o400)
        // A concurrent identical freeze may win publication. Never replace an existing version.
        await rename(temporary, versionDirectory(versionHash)).catch(async (error: unknown) => {
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            !["EEXIST", "ENOTEMPTY"].includes(String(error.code))
          )
            throw error
          await inspect(versionHash)
        })
        return { versionHash, manifest }
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    },
    async run(input: {
      id?: string
      versionHash: string
      targetVersion?: string
      task: Schema.Json
      view: Schema.Json
      workspace: string
      deadline: number
      signal?: AbortSignal
    }): Promise<Record> {
      Schema.decodeUnknownSync(Digest)(input.versionHash)
      if (input.targetVersion !== undefined) Schema.decodeUnknownSync(Digest)(input.targetVersion)
      if (!Number.isSafeInteger(input.deadline)) throw new Error("An absolute millisecond deadline is required")
      const id = input.id ?? crypto.randomUUID()
      const location = runDirectory(id)
      await mkdir(path.dirname(location), { recursive: true, mode: 0o700 })
      await mkdir(location, { mode: 0o700 })
      const request = JSON.stringify({
        version: 1,
        versionHash: input.versionHash,
        ...(input.targetVersion === undefined ? {} : { targetVersion: input.targetVersion }),
        task: Schema.decodeUnknownSync(Schema.Json)(input.task),
        view: Schema.decodeUnknownSync(Schema.Json)(input.view),
        deadline: input.deadline,
      })
      await Bun.write(path.join(location, "request.json"), request)
      const workspace: { hash?: string } = {}
      const record: Record = {
        version: 1,
        id,
        versionHash: input.versionHash,
        ...(input.targetVersion === undefined ? {} : { targetVersion: input.targetVersion }),
        requestHash: Hash.sha256(request),
        supervisorHash: Hash.sha256(SUPERVISOR),
        startedAt: Date.now(),
        completedAt: Date.now(),
        status: "failed",
        exitCode: null,
        stdout: "",
        stderr: "",
        artifacts: [],
      }
      const scratch = path.join(location, "workspace")
      const execution: { value?: Awaited<ReturnType<typeof execute>> } = {}
      const capture = async (files?: ReadonlyArray<typeof Entry.Type>) => {
        const encoded = JSON.stringify({
          version: 1,
          complete: files !== undefined,
          files: files ?? [],
          requestHash: record.requestHash,
        })
        const hash = Hash.sha256(encoded)
        await Bun.write(path.join(location, "input.json.pending"), encoded)
        await Bun.write(path.join(location, "input.sha256.pending"), hash)
        await rename(path.join(location, "input.sha256.pending"), path.join(location, "input.sha256"))
        // Publish once before execution. Even a process without a final receipt has a verifiable original W.
        await rename(path.join(location, "input.json.pending"), path.join(location, "input.json"))
        workspace.hash = hash
      }
      const complete = async (result: Partial<Record>) => {
        // An unavailable input is explicit, never disguised as an empty captured workspace.
        if (workspace.hash === undefined) await capture()
        return finish({ ...record, workspaceHash: workspace.hash, ...result }, location)
      }
      await mkdir(path.join(location, "artifacts"), { mode: 0o700 })
      try {
        if (Buffer.byteLength(request) > MAX_INPUT_BYTES)
          throw new Error("Workflow input exceeds the operation-size guard")
        if (input.signal?.aborted)
          return await complete({ status: Date.now() >= input.deadline ? "deadline" : "cancelled" })
        if (Date.now() >= input.deadline) return await complete({ status: "deadline" })
        const manifest = await inspect(input.versionHash)
        if (input.targetVersion !== undefined) await inspect(input.targetVersion)
        if (input.signal?.aborted)
          return await complete({ status: Date.now() >= input.deadline ? "deadline" : "cancelled" })
        if (Date.now() >= input.deadline) return await complete({ status: "deadline" })
        disjoint(await realpath(input.workspace), await realpath(directory))
        // Never bind an arbitrary host tree writable: hardlinks and Unix sockets cross pathname isolation.
        const files = await snapshot(input.workspace, path.join(location, "input.pending"))
        await rename(path.join(location, "input.pending"), path.join(location, "input"))
        await capture(files)
        await snapshot(path.join(location, "input"), scratch, true)
        const envelope = JSON.stringify({ ...(decode(Schema.Json, request) as object), config: manifest.config })
        if (Buffer.byteLength(envelope) > MAX_INPUT_BYTES)
          throw new Error("Workflow input exceeds the operation-size guard")
        const result = await execute({
          sandbox,
          runtime: runtimeFile(manifest.runtime.hash),
          libraries: manifest.libraries.map((library) => ({
            source: runtimeFile(library.hash),
            destination: library.path,
          })),
          source: path.join(versionDirectory(input.versionHash), "source"),
          target:
            input.targetVersion === undefined ? undefined : path.join(versionDirectory(input.targetVersion), "source"),
          scratch,
          manifest,
          request: envelope,
          deadline: input.deadline,
          signal: input.signal,
        })
        execution.value = result
        if (result.status !== "completed") return await complete(result)
        const output = decode(Output, result.stdout)
        const artifacts = await snapshot(scratch, path.join(location, "artifacts.pending"), false, output.artifacts)
        await rename(path.join(location, "artifacts.pending"), path.join(location, "artifacts"))
        return await complete({ ...result, result: output, artifacts })
      } catch (error) {
        return await complete({
          ...execution.value,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        await rm(scratch, { recursive: true, force: true })
        await rm(path.join(location, "artifacts.pending"), { recursive: true, force: true })
        await rm(path.join(location, "input.pending"), { recursive: true, force: true })
      }
    },
  }
}

function relative(value: string) {
  if (
    !value ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => ["", ".", ".."].includes(part))
  )
    throw new Error("Expected a normalized package-relative path")
  return value
}

function disjoint(source: string, destination: string) {
  if (source === destination || source.startsWith(destination + path.sep) || destination.startsWith(source + path.sep))
    throw new Error("Source/workspace and host storage must not overlap")
}

function decode<S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, text: string): S["Type"] {
  return Schema.decodeUnknownSync(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(schema)))(text, {
    onExcessProperty: "error",
  })
}

async function digest(filename: string) {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of readChunks(Bun.file(filename).stream())) hasher.update(chunk)
  return hasher.digest("hex")
}

async function retainRuntime(directory: string, filename: string) {
  const stat = await lstat(await realpath(filename))
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error("Runtime exceeds the operation-size guard")
  await mkdir(path.join(directory, "runtime"), { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(path.join(directory, "runtime", ".retain-"))
  try {
    const copy = path.join(temporary, "data")
    await Bun.write(copy, Bun.file(filename))
    const bytes = (await lstat(copy)).size
    if (bytes > 256 * 1024 * 1024) throw new Error("Runtime exceeds the operation-size guard")
    const hash = await digest(copy)
    await chmod(copy, 0o500)
    const destination = path.join(directory, "runtime", hash)
    await link(copy, destination).catch(async (error: unknown) => {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error
      if ((await digest(destination)) !== hash) throw new Error("Retained runtime content changed")
    })
    return { hash, bytes }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function* readChunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    reader.releaseLock()
  }
}

async function snapshot(source: string, destination?: string, writable = false, selected?: ReadonlyArray<string>) {
  if (!(await lstat(source)).isDirectory() || (await lstat(source)).isSymbolicLink())
    throw new Error("Source must be a real directory")
  const root = await realpath(source)
  if (destination) disjoint(root, path.resolve(destination))
  const files = new Map<string, typeof Entry.Type>()
  const seen = new Set<string>()
  if (destination) await mkdir(destination, { recursive: true, mode: 0o700 })
  const visit = async (name: string): Promise<void> => {
    relative(name)
    if (seen.has(name)) return
    if (seen.size >= MAX_FILES) throw new Error("Package exceeds operation-size guard")
    seen.add(name)
    for (const count of name
      .split("/")
      .slice(1)
      .map((_, index) => index + 1)) {
      const ancestor = name.split("/").slice(0, count).join("/")
      const parent = await lstat(path.join(root, ancestor))
      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new Error("Artifact ancestors must be real directories, not symbolic links")
      files.set(ancestor, { path: ancestor, hash: Hash.sha256("directory"), bytes: 0, kind: "directory" })
    }
    const filename = path.join(root, name)
    const stat = await lstat(filename)
    if (stat.isSymbolicLink()) throw new Error("Source and artifacts cannot contain symbolic links")
    if (stat.isDirectory()) {
      files.set(name, { path: name, hash: Hash.sha256("directory"), bytes: 0, kind: "directory" })
      if (destination) await mkdir(path.join(destination, name), { recursive: true, mode: 0o700 })
      for (const child of (await readdir(filename)).sort()) await visit(`${name}/${child}`)
      return
    }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Source and artifacts must be regular, unlinked files")
    const descriptor = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await descriptor.stat()
      // Validate the opened descriptor, not just a pathname which another writer could replace.
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        !(await readlink(`/proc/self/fd/${descriptor.fd}`)).startsWith(root + path.sep)
      )
        throw new Error("Source changed during snapshot")
      if (opened.size > MAX_PACKAGE_BYTES || files.size >= MAX_FILES)
        throw new Error("Package exceeds operation-size guard")
      const chunks: Buffer[] = []
      for await (const chunk of descriptor.createReadStream({ autoClose: false, start: 0, end: MAX_PACKAGE_BYTES }))
        chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error("File exceeds operation-size guard")
      files.set(name, { path: name, hash: Hash.sha256(bytes), bytes: bytes.byteLength, kind: "file" })
      if ([...files.values()].reduce((sum, file) => sum + file.bytes, 0) > MAX_PACKAGE_BYTES)
        throw new Error("Package exceeds operation-size guard")
      if (!destination) return
      await mkdir(path.dirname(path.join(destination, name)), { recursive: true, mode: 0o700 })
      await Bun.write(path.join(destination, name), bytes)
      await chmod(path.join(destination, name), writable ? 0o600 : 0o400)
    } finally {
      await descriptor.close()
    }
  }
  // Sequential reads keep memory bounded by one file, even for hostile packages with many files.
  for (const name of selected ?? (await readdir(root)).sort()) await visit(name)
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

async function finish(record: Record, directory: string) {
  const result = { ...record, completedAt: Date.now() }
  const encoded = JSON.stringify(result)
  await Bun.write(path.join(directory, "result.pending"), encoded)
  await Bun.write(path.join(directory, "result.sha256.pending"), Hash.sha256(encoded))
  await rename(path.join(directory, "result.sha256.pending"), path.join(directory, "result.sha256"))
  // The result is the completion marker. A crash before this rename leaves a pending, never replayed run.
  await rename(path.join(directory, "result.pending"), path.join(directory, "result.json"))
  return result
}

async function execute(input: {
  sandbox: string
  runtime: string
  libraries: { source: string; destination: string }[]
  source: string
  target?: string
  scratch: string
  manifest: Manifest
  request: string
  deadline: number
  signal?: AbortSignal
}) {
  if (input.signal?.aborted)
    return {
      status: Date.now() >= input.deadline ? ("deadline" as const) : ("cancelled" as const),
      exitCode: null,
      stdout: "",
      stderr: "",
    }
  if (Date.now() >= input.deadline) return { status: "deadline" as const, exitCode: null, stdout: "", stderr: "" }
  const argv = [
    input.sandbox,
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    "--assert-userns-disabled",
    "--die-with-parent",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--ro-bind",
    input.runtime,
    "/runtime/bun",
    ...input.libraries.flatMap((library) => ["--ro-bind", library.source, library.destination]),
    "--ro-bind",
    input.source,
    "/version",
    ...(input.target ? ["--ro-bind", input.target, "/target"] : []),
    "--bind",
    input.scratch,
    "/workspace",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "PATH",
    "/runtime",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--chdir",
    "/workspace",
    "/runtime/bun",
    "run",
    "--no-install",
    `/version/${input.manifest.entrypoint}`,
  ]
  const child = Bun.spawn(
    [
      input.runtime,
      "--no-install",
      "--no-env-file",
      "--config=/dev/null",
      "-e",
      SUPERVISOR,
      "--",
      JSON.stringify({ parent: process.pid, deadline: input.deadline, argv }),
    ],
    {
      detached: true,
      cwd: path.dirname(input.runtime),
      env: { HOME: path.dirname(input.runtime) },
      stdin: new TextEncoder().encode(input.request),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const state: { stopped?: "deadline" | "cancelled" | "failed" } = {}
  const stop = (reason: NonNullable<typeof state.stopped>) => {
    if (state.stopped) return
    state.stopped = reason
    // The supervisor installs this handler before spawning bwrap and joins its owned process group.
    child.kill("SIGTERM")
  }
  const timer = setInterval(() => {
    if (Date.now() >= input.deadline) stop("deadline")
  }, 25)
  const cancel = () => stop(Date.now() >= input.deadline ? "deadline" : "cancelled")
  input.signal?.addEventListener("abort", cancel, { once: true })
  if (input.signal?.aborted) cancel()
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = []
    const size = { bytes: 0 }
    for await (const chunk of readChunks(stream)) {
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - size.bytes)
      if (remaining) chunks.push(chunk.subarray(0, remaining))
      size.bytes += chunk.byteLength
      if (size.bytes > MAX_OUTPUT_BYTES) stop("failed")
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, collect(child.stdout), collect(child.stderr)])
    return {
      status:
        state.stopped ??
        (exitCode === 124 && Date.now() >= input.deadline
          ? ("deadline" as const)
          : exitCode === 0
            ? ("completed" as const)
            : ("failed" as const)),
      exitCode,
      stdout,
      stderr,
      ...(state.stopped === "failed"
        ? { error: "Workflow output exceeds operation-size guard" }
        : exitCode !== 0
          ? { error: `Workflow process exited with code ${exitCode}` }
          : {}),
    }
  } finally {
    clearInterval(timer)
    input.signal?.removeEventListener("abort", cancel)
    if (child.exitCode === null) {
      child.kill("SIGTERM")
      await child.exited
    }
  }
}
