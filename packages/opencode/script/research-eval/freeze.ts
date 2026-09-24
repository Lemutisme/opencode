import { mkdir, copyFile, lstat, readlink, symlink, open } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { digest, duration } from "./ledger"
import { Infrastructure, infrastructure } from "./infrastructure"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Model = Schema.Struct({
  provider: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  variant: Schema.NonEmptyString,
  sampling: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])),
  seed: Schema.Union([Schema.Int, Schema.Literal("unsupported")]),
})
const Positive = Schema.Int.check(Schema.isGreaterThan(0))
export const Configuration = Schema.Struct({
  version: Schema.Literal(1),
  evaluation: Schema.optional(Schema.Literals(["feedback-v2", "repair-lifecycle-v1"])),
  infrastructure: Schema.optional(Infrastructure),
  feedbackGuidance: Schema.optional(Schema.Literal("closure:1")),
  scenarios: Schema.optional(Hash),
  mode: Schema.Literals(["deterministic-selfcheck", "development-calibration", "qualification"]),
  worker: Model,
  reviewer: Model,
  sourceSnapshot: Hash,
  lockfile: Hash,
  prompts: Hash,
  agents: Hash,
  tools: Hash,
  configuration: Hash,
  bun: Schema.Struct({ version: Schema.NonEmptyString, hash: Hash }),
  node: Schema.Struct({ version: Schema.NonEmptyString, hash: Hash }),
  runner: Hash,
  corpus: Hash,
  oracle: Hash,
  scorer: Hash,
  order: Schema.NonEmptyArray(Schema.NonEmptyString),
  seed: Schema.NonEmptyString,
  budget: Schema.Struct({ milliseconds: Schema.Literal(duration) }),
  timeouts: Schema.Struct({ provider: Positive, tool: Positive, verification: Positive, cleanup: Positive }),
  recovery: Schema.NonEmptyString,
  isolation: Schema.Struct({
    profile: Schema.NonEmptyString,
    configuration: Hash,
    filesystem: Hash,
    processes: Hash,
    network: Hash,
    candidateExecutor: Hash,
  }),
})

export function configuration(value: unknown) {
  const result = Schema.decodeUnknownSync(Configuration, { onExcessProperty: "error" })(value)
  infrastructure(result.infrastructure, result.evaluation)
  if (result.feedbackGuidance && result.evaluation !== "repair-lifecycle-v1")
    throw new Error("Closeout guidance requires lifecycle evaluation")
  if (
    !!result.evaluation !== !!result.scenarios ||
    (result.evaluation && (result.mode !== "development-calibration" || result.order.length !== 3))
  )
    throw new Error("V2 evaluation requires three development scenarios and their frozen measurement identity")
  if (new Set(result.order).size !== result.order.length) throw new Error("Instance order has duplicates")
  if (result.mode === "qualification" && result.order.length !== 66)
    throw new Error("Qualification requires the complete scheduled matrix")
  return result
}

/** Capture tracked AND untracked source; never use HEAD as a dirty worktree snapshot. */
export async function source(root: string, directory: string) {
  const child = Bun.spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const files = [...new Set((await new Response(child.stdout).text()).split("\0").filter(Boolean))].sort()
  if (await child.exited) throw new Error(await new Response(child.stderr).text())
  await mkdir(directory, { recursive: false, mode: 0o700 })
  const manifest: Record<string, { hash: string; mode: number; link?: string }> = {}
  for (const file of files) {
    const stat = await lstat(path.join(root, file))
    if (!stat.isFile() && !stat.isSymbolicLink()) continue
    const target = path.join(directory, "files", file)
    await mkdir(path.dirname(target), { recursive: true })
    if (stat.isSymbolicLink()) {
      const link = await readlink(path.join(root, file))
      await symlink(link, target)
      manifest[file] = { hash: digest(link), mode: stat.mode, link }
      continue
    }
    await copyFile(path.join(root, file), target)
    const hash = digest(new Uint8Array(await Bun.file(target).arrayBuffer()))
    if (hash !== digest(new Uint8Array(await Bun.file(path.join(root, file)).arrayBuffer())))
      throw new Error("Source changed during freeze")
    manifest[file] = { hash, mode: stat.mode }
  }
  const bytes = JSON.stringify(manifest, null, 2) + "\n"
  const handle = await open(path.join(directory, "manifest.json"), "wx", 0o600)
  await handle.writeFile(bytes)
  await handle.sync()
  await handle.close()
  return { hash: digest(bytes), files: Object.keys(manifest).length }
}

/** Verify retained bytes and installed runtimes before a caller may issue any instance. No model calls. */
export async function preflight(input: {
  configuration: unknown
  snapshot: string
  objects: string
  bun: string
  node: string
}) {
  const frozen = configuration(input.configuration)
  const bytes = await Bun.file(path.join(input.snapshot, "manifest.json")).text()
  if (digest(bytes) !== frozen.sourceSnapshot) throw new Error("Source manifest hash mismatch")
  const manifest = Schema.decodeUnknownSync(
    Schema.UnknownFromJsonString.pipe(
      Schema.decodeTo(
        Schema.Record(
          Schema.String,
          Schema.Struct({ hash: Hash, mode: Schema.Int, link: Schema.optional(Schema.String) }),
        ),
      ),
    ),
  )(bytes)
  for (const [file, expected] of Object.entries(manifest)) {
    const target = path.resolve(input.snapshot, "files", file)
    if (!target.startsWith(path.resolve(input.snapshot, "files") + path.sep))
      throw new Error("Snapshot path escapes source")
    const stat = await lstat(target)
    const actual = stat.isSymbolicLink() ? await readlink(target) : new Uint8Array(await Bun.file(target).arrayBuffer())
    if (
      digest(actual) !== expected.hash ||
      stat.mode !== expected.mode ||
      (expected.link !== undefined && actual !== expected.link)
    )
      throw new Error("Frozen source changed: " + file)
  }
  if (manifest["bun.lock"]?.hash !== frozen.lockfile) throw new Error("Lockfile differs from frozen source")
  for (const hash of [
    frozen.prompts,
    frozen.agents,
    frozen.tools,
    frozen.configuration,
    frozen.runner,
    frozen.corpus,
    frozen.oracle,
    frozen.scorer,
    ...(frozen.scenarios ? [frozen.scenarios] : []),
    ...Object.entries(frozen.isolation)
      .filter(([key]) => key !== "profile")
      .map(([, value]) => value),
  ]) {
    if (digest(new Uint8Array(await Bun.file(path.join(input.objects, hash)).arrayBuffer())) !== hash)
      throw new Error("Missing or changed frozen object: " + hash)
  }
  for (const name of ["bun", "node"] as const) {
    if (digest(new Uint8Array(await Bun.file(input[name]).arrayBuffer())) !== frozen[name].hash)
      throw new Error("Runtime hash mismatch: " + name)
    const child = Bun.spawn([input[name], "--version"], { stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
    const [exit, version] = await Promise.all([child.exited, new Response(child.stdout).text()])
    clearTimeout(timer)
    if (exit || version.trim() !== frozen[name].version) throw new Error("Runtime version mismatch: " + name)
  }
  return frozen
}
