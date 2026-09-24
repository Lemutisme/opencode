import path from "node:path"
import { lstat, readlink, mkdir } from "node:fs/promises"
import { Schema } from "effect"
import { source } from "./freeze"
import { Deployment } from "./launch"
import { Infrastructure } from "./infrastructure"
import { digest, duration } from "./ledger"
import { put } from "./archive"
import { runtimeFiles, codeIdentity } from "./provenance"
import { routeURL } from "./provider"
import { advisoryDevelopment, advisoryRubric, observationRubric } from "./advisory-scenarios"
import { requiredCalculation, requiredObservationRubric } from "./required-scenarios"
import { subjectGeneralization, subjectObservationRubric } from "./subject-scenarios"
import type { Rubric } from "./advisory-measurement"

const Positive = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(duration))
const Rater = Schema.Struct({ id: Schema.NonEmptyString, model: Deployment.fields.worker })
export const AdvisorySetup = Schema.Struct({
  version: Schema.Literals(["advisory-batch:1", "advisory-observation:1"]),
  mode: Schema.Literals(["model", "local-fixture"]),
  evaluation: Schema.Literal("advisory-v3"),
  scenario: Schema.optional(
    Schema.Literals(["advisory-development:1", "required-calculation:1", "subject-generalization:1"]),
  ),
  worker: Deployment.fields.worker,
  reviewer: Deployment.fields.reviewer,
  raters: Schema.Struct({ first: Rater, second: Rater, adjudicator: Rater }),
  infrastructure: Infrastructure,
  timeouts: Schema.Struct({
    provider: Positive,
    verification: Positive,
    cleanup: Positive,
    scoring: Positive,
    extraction: Positive,
  }),
  bun: Schema.NonEmptyString,
  node: Schema.NonEmptyString,
  fixtureFaults: Schema.optional(Schema.Record(Schema.String, Schema.Literal("before_issue"))),
})
export type AdvisorySetup = typeof AdvisorySetup.Type
const Pointer = Schema.Struct({
  version: Schema.Literals(["advisory-batch:1", "advisory-observation:1"]),
  root: Schema.NonEmptyString,
  hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
type Manifest = Record<string, { hash: string; mode: number; link?: string }>

export async function object<T>(directory: string, hash: string): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid object identity")
  const raw = await Bun.file(path.join(directory, "objects", hash)).text()
  if (digest(raw) !== hash) throw new Error("Frozen object is missing or corrupt")
  return JSON.parse(raw)
}

function setup(value: unknown) {
  const config = Schema.decodeUnknownSync(AdvisorySetup, { onExcessProperty: "error" })(value)
  if (
    config.infrastructure.journal !== "cas:1" ||
    config.infrastructure.cleanup < 6000 ||
    config.timeouts.cleanup < 6000 ||
    config.timeouts.provider > 900000 ||
    config.timeouts.scoring > 900000 ||
    config.timeouts.extraction > 30000
  )
    throw new Error("Explicit CAS journal and bounded production-compatible operation/cleanup limits required")
  if (config.mode !== "local-fixture" && config.fixtureFaults !== undefined)
    throw new Error("Fault injection is forbidden in model batches")
  if (![config.bun, config.node].every(path.isAbsolute)) throw new Error("Frozen runtime paths must be absolute")
  if (
    ["required-calculation:1", "subject-generalization:1"].includes(config.scenario ?? "") &&
    config.version !== "advisory-observation:1"
  )
    throw new Error("New study tasks use the explicit observation entry, not historical formal scoring")
  const examples = scenarios(config)
  if (Object.keys(config.fixtureFaults ?? {}).some((id) => !examples.some((item) => item.packet.id === id)))
    throw new Error("Fixture fault refers to an unscheduled instance")
  const raters = Object.values(config.raters)
  if (new Set(raters.map((item) => item.id)).size !== 3)
    throw new Error("Freeze two distinct raters and an independent adjudicator")
  for (const model of [config.worker, config.reviewer, ...raters.map((item) => item.model)]) {
    routeURL(config.mode, model, model.credentialEnv !== null)
    if (config.mode === "local-fixture" && model.credentialEnv !== null)
      throw new Error("Fixtures must not use credentials")
    if (
      (model.seed === "unsupported" ? model.parameters.seed !== undefined : model.parameters.seed !== model.seed) ||
      (model.variant !== "default" && model.parameters.reasoning_effort !== model.variant)
    )
      throw new Error("Explicit model variant and seed must match transport parameters")
  }
  return config
}

export async function freezeAdvisory(value: unknown, directory: string) {
  const config = setup(value)
  await mkdir(directory, { recursive: false, mode: 0o700 })
  const captured = await source(path.resolve(import.meta.dir, "../../../.."), path.join(directory, "source"))
  const manifest = (await Bun.file(path.join(directory, "source/manifest.json")).json()) as Manifest
  const runner = digest(
    JSON.stringify(Object.fromEntries(runtimeFiles(Object.keys(manifest)).map((name) => [name, manifest[name]]))),
  )
  const runtimes = Object.fromEntries(
    await Promise.all((["bun", "node"] as const).map(async (name) => [name, await runtime(config[name])])),
  )
  const frozen = {
    version: config.version,
    setup: config,
    source: captured.hash,
    runner,
    runtimes,
    examples: scenarios(config),
    rubric: rubric(config),
    measurement: config.version === "advisory-observation:1" ? "candidate-opinion:1" : "advisory-measurement:1",
    reveal:
      config.version === "advisory-observation:1" ? "candidate-attempts-before-feedback:1" : "instance-isolated:1",
    context: "stateless-request:1",
    unavailable: "not_scored",
    budget: { milliseconds: duration },
    recovery: "one-scheduled-opportunity-original-deadline:1",
    accounting: "original-ledger-supplements-and-unknowns-separate:1",
  }
  const pointer = {
    version: config.version,
    root: path.resolve(directory),
    hash: await put(directory, frozen),
  }
  await Bun.write(path.join(directory, "deployment.json"), JSON.stringify(pointer, null, 2) + "\n")
  await checkAdvisory(pointer)
  return pointer
}

export async function checkAdvisory(value: unknown) {
  const pointer = Schema.decodeUnknownSync(Pointer, { onExcessProperty: "error" })(value)
  const frozen = await object<{
    version: string
    setup: AdvisorySetup
    source: string
    runner: string
    runtimes: Record<string, { hash: string; version: string }>
    examples: ReturnType<typeof scenarios>
    rubric: Rubric
    measurement: string
    reveal: string
    context: string
    unavailable: string
    budget: { milliseconds: number }
    recovery: string
    accounting: string
  }>(pointer.root, pointer.hash)
  const config = setup(frozen.setup)
  if (
    frozen.version !== pointer.version ||
    config.version !== pointer.version ||
    frozen.measurement !==
      (config.version === "advisory-observation:1" ? "candidate-opinion:1" : "advisory-measurement:1") ||
    frozen.reveal !==
      (config.version === "advisory-observation:1" ? "candidate-attempts-before-feedback:1" : "instance-isolated:1") ||
    frozen.context !== "stateless-request:1" ||
    frozen.unavailable !== "not_scored" ||
    frozen.budget.milliseconds !== duration ||
    frozen.recovery !== "one-scheduled-opportunity-original-deadline:1" ||
    frozen.accounting !== "original-ledger-supplements-and-unknowns-separate:1" ||
    JSON.stringify(frozen.examples) !== JSON.stringify(scenarios(config)) ||
    JSON.stringify(frozen.rubric) !== JSON.stringify(rubric(config))
  )
    throw new Error("Unsupported or changed frozen advisory policy, scenarios or rubric")
  const bytes = await Bun.file(path.join(pointer.root, "source/manifest.json")).text()
  if (digest(bytes) !== frozen.source) throw new Error("Source manifest changed")
  const manifest = JSON.parse(bytes) as Manifest
  const root = path.resolve(import.meta.dir, "../../../..")
  const inventory = Bun.spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const listed = [...new Set((await new Response(inventory.stdout).text()).split("\0").filter(Boolean))].sort()
  if ((await inventory.exited) || JSON.stringify(listed) !== JSON.stringify(Object.keys(manifest).sort()))
    throw new Error("Complete source inventory changed")
  for (const [name, expected] of Object.entries(manifest)) {
    for (const base of [path.join(pointer.root, "source/files"), root]) {
      const file = path.resolve(base, name)
      if (!file.startsWith(base + path.sep)) throw new Error("Source path escapes snapshot")
      const stat = await lstat(file)
      const link = stat.isSymbolicLink() ? await readlink(file) : undefined
      if (
        stat.mode !== expected.mode ||
        link !== expected.link ||
        digest(link ?? new Uint8Array(await Bun.file(file).arrayBuffer())) !== expected.hash
      )
        throw new Error("Installed or retained source changed: " + name)
    }
  }
  if ((await codeIdentity()) !== frozen.runner) throw new Error("Runtime source identity changed")
  for (const name of ["bun", "node"] as const)
    if (JSON.stringify(await runtime(config[name])) !== JSON.stringify(frozen.runtimes[name]))
      throw new Error("Runtime changed: " + name)
  return { pointer, frozen, config }
}

function scenarios(config: AdvisorySetup) {
  if (config.scenario === "subject-generalization:1") return subjectGeneralization()
  return config.scenario === "required-calculation:1" ? requiredCalculation() : advisoryDevelopment()
}

function rubric(config: AdvisorySetup) {
  if (config.scenario === "subject-generalization:1") return subjectObservationRubric
  if (config.scenario === "required-calculation:1") return requiredObservationRubric
  return config.version === "advisory-observation:1" ? observationRubric : advisoryRubric
}

async function runtime(executable: string) {
  const child = Bun.spawn([executable, "--version"], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
  try {
    const [exit, version] = await Promise.all([child.exited, new Response(child.stdout).text()])
    if (exit) throw new Error("Cannot identify runtime")
    return { hash: digest(new Uint8Array(await Bun.file(executable).arrayBuffer())), version: version.trim() }
  } finally {
    clearTimeout(timer)
  }
}

/** Read failures are integrity failures; callers can still preserve stop events and the full denominator. */
export async function runtimeMatches(expected: string, root?: string) {
  return codeIdentity(root).then(
    (hash) => hash === expected,
    () => false,
  )
}
