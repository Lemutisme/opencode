import { lstat, mkdir, open, readlink } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { development, measurement } from "./scenarios"
import { lifecycleDevelopment, lifecycleMeasurement, lifecycleScenarioVersion } from "./lifecycle-scenarios"
import { corpus } from "./corpus"
import { digest, duration } from "./ledger"
import { preflight, source } from "./freeze"
import { runInstance } from "./instance"
import { prepareScoring } from "./evaluate"
import { launcher } from "./isolation"
import { put } from "./archive"
import { runtimeFiles } from "./provenance"
import { routeURL } from "./provider"
import { Infrastructure, infrastructure } from "./infrastructure"

const Positive = Schema.Int.check(Schema.isGreaterThan(0))
const Model = Schema.Struct({
  endpoint: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  variant: Schema.NonEmptyString,
  parameters: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])),
  seed: Schema.Union([Schema.Int, Schema.Literal("unsupported")]),
  context: Positive,
  output: Positive,
  credentialEnv: Schema.Union([Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/)), Schema.Null]),
})
export const Deployment = Schema.Struct({
  version: Schema.Literal(1),
  evaluation: Schema.optional(Schema.Literals(["feedback-v2", "repair-lifecycle-v1"])),
  infrastructure: Schema.optional(Infrastructure),
  feedbackGuidance: Schema.optional(Schema.Literal("closure:1")),
  mode: Schema.Literals(["development-calibration", "qualification"]),
  worker: Model,
  reviewer: Model,
  snapshot: Schema.NonEmptyString,
  objects: Schema.NonEmptyString,
  frozen: Schema.NonEmptyString,
  bun: Schema.NonEmptyString,
  node: Schema.NonEmptyString,
})
const Setup = Schema.Struct({
  version: Deployment.fields.version,
  evaluation: Deployment.fields.evaluation,
  infrastructure: Deployment.fields.infrastructure,
  feedbackGuidance: Deployment.fields.feedbackGuidance,
  mode: Deployment.fields.mode,
  worker: Model,
  reviewer: Model,
  bun: Schema.NonEmptyString,
  node: Schema.NonEmptyString,
  timeouts: Schema.Struct({ provider: Positive, tool: Positive, verification: Positive, cleanup: Positive }),
})

/** Freeze explicit deployment choices; missing models/parameters are errors, never defaults. */
export async function freezeDeployment(value: unknown, output: string) {
  const setup = Schema.decodeUnknownSync(Setup, { onExcessProperty: "error" })(value)
  infrastructure(setup.infrastructure, setup.evaluation)
  if (setup.feedbackGuidance && setup.evaluation !== "repair-lifecycle-v1")
    throw new Error("Closeout guidance requires lifecycle evaluation")
  if (setup.evaluation && setup.mode !== "development-calibration")
    throw new Error("V2 qualification is not authorized or supported")
  for (const role of ["worker", "reviewer"] as const) routeURL("model", setup[role], setup[role].credentialEnv !== null)
  await mkdir(output, { recursive: false, mode: 0o700 })
  const snapshot = path.join(output, "source")
  const captured = await source(path.resolve(import.meta.dir, "../../../.."), snapshot)
  const manifest = (await Bun.file(path.join(snapshot, "manifest.json")).json()) as Parameters<typeof identities>[0]
  const packets = corpus(setup.mode === "qualification" ? "qualification" : "development")
  const examples = setup.evaluation
    ? setup.evaluation === "repair-lifecycle-v1"
      ? lifecycleDevelopment()
      : development()
    : setup.mode === "qualification"
      ? packets
      : packets.filter(
          (item) => item.oracle.instance.repeat === 1 && ["P1", "R3"].includes(item.oracle.instance.family),
        )
  const canonical = {
    version: setup.version,
    mode: setup.mode,
    worker: setup.worker,
    reviewer: setup.reviewer,
    ...(setup.evaluation ? { evaluation: setup.evaluation } : {}),
    ...(setup.infrastructure ? { infrastructure: setup.infrastructure } : {}),
    ...(setup.feedbackGuidance ? { feedbackGuidance: setup.feedbackGuidance } : {}),
  }
  const values = identities(manifest, examples, canonical, setup.timeouts)
  const hashes = Object.fromEntries(
    await Promise.all(
      Object.entries(values)
        .filter(([key]) => key !== "isolation")
        .map(async ([key, value]) => [key, await put(output, JSON.stringify(value))]),
    ),
  )
  const isolation = Object.fromEntries(
    await Promise.all(
      Object.entries(values.isolation).map(async ([key, value]) => [key, await put(output, JSON.stringify(value))]),
    ),
  )
  const runtimes = Object.fromEntries(
    await Promise.all(
      (["bun", "node"] as const).map(async (name) => {
        const child = Bun.spawn([setup[name], "--version"], { stdout: "pipe", stderr: "pipe" })
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
        const [exit, version] = await Promise.all([child.exited, new Response(child.stdout).text()])
        clearTimeout(timer)
        if (exit) throw new Error("Cannot identify configured runtime")
        return [
          name,
          { version: version.trim(), hash: digest(new Uint8Array(await Bun.file(setup[name]).arrayBuffer())) },
        ]
      }),
    ),
  )
  const models = Object.fromEntries(
    (["worker", "reviewer"] as const).map((role) => [
      role,
      {
        provider: new URL(setup[role].endpoint).origin,
        model: setup[role].model,
        variant: setup[role].variant,
        sampling: setup[role].parameters,
        seed: setup[role].seed,
      },
    ]),
  )
  const frozen = {
    version: 1,
    mode: setup.mode,
    ...(setup.evaluation ? { evaluation: setup.evaluation } : {}),
    ...(setup.infrastructure ? { infrastructure: setup.infrastructure } : {}),
    ...(setup.feedbackGuidance ? { feedbackGuidance: setup.feedbackGuidance } : {}),
    ...models,
    sourceSnapshot: captured.hash,
    lockfile: manifest["bun.lock"].hash,
    ...hashes,
    ...runtimes,
    order: examples.map((item) => item.packet.id),
    seed: "s6b-frozen-20260919",
    budget: { milliseconds: duration },
    timeouts: setup.timeouts,
    recovery: "one-scheduled-opportunity-original-deadline:1",
    isolation: { profile: "linux-landlock6-seccomp-subreaper:1", ...isolation },
  }
  const file = path.join(output, "frozen.json")
  await Bun.write(file, JSON.stringify(frozen, null, 2) + "\n")
  const deployment = {
    ...canonical,
    bun: setup.bun,
    node: setup.node,
    snapshot,
    objects: path.join(output, "objects"),
    frozen: file,
  }
  await Bun.write(path.join(output, "deployment.json"), JSON.stringify(deployment, null, 2) + "\n")
  await check(deployment)
  return deployment
}

/** Values whose exact JSON bytes must be retained in the freeze object store. */
export function identities(
  manifest: Record<string, { hash: string; mode: number; link?: string }>,
  examples: ReturnType<typeof corpus>,
  configuration: unknown,
  timeouts: unknown,
) {
  const select = (predicate: (file: string) => boolean) =>
    Object.fromEntries(Object.entries(manifest).filter(([file]) => predicate(file)))
  const evaluator = (names: string[]) =>
    select((file) => names.includes(file.replace("packages/opencode/script/research-eval/", "")))
  return {
    configuration,
    ...(examples[0]?.packet.version === lifecycleScenarioVersion
      ? {
          scenarios: {
            ...lifecycleMeasurement,
            ...((configuration as { feedbackGuidance?: "closure:1" }).feedbackGuidance
              ? { feedbackGuidance: (configuration as { feedbackGuidance: "closure:1" }).feedbackGuidance }
              : {}),
            ...((configuration as { infrastructure?: Infrastructure }).infrastructure
              ? {
                  infrastructure: (configuration as { infrastructure: Infrastructure }).infrastructure,
                  finalQuality: "candidate-or-terminal:1",
                }
              : {}),
          },
        }
      : examples[0]?.packet.version === "feedback-development:1"
        ? { scenarios: measurement }
        : {}),
    runner: Object.fromEntries(runtimeFiles(Object.keys(manifest)).map((file) => [file, manifest[file]])),
    prompts: select(
      (file) =>
        file.startsWith("packages/sdk-next/src/research/") || file.startsWith("packages/core/src/system-context/"),
    ),
    agents: select(
      (file) => file.startsWith("packages/core/src/agent") || file.startsWith("packages/core/src/config/agent"),
    ),
    tools: select(
      (file) => file.startsWith("packages/core/src/tool/") || file.startsWith("packages/opencode/src/tool/"),
    ),
    corpus: examples.map((item) => item.packet),
    oracle: examples.map((item) => item.oracle),
    scorer: evaluator([
      "evaluate.ts",
      "score.ts",
      "oracle.ts",
      "blind.ts",
      "recognize.ts",
      "qualification.ts",
      "ledger.ts",
      "accounting.ts",
      "rating.ts",
      "infrastructure.ts",
      "terminal.ts",
      ...(["feedback-development:1", lifecycleScenarioVersion].includes(examples[0]?.packet.version)
        ? ["scenarios.ts", "feedback-score.ts", "feedback-evaluate.ts", "feedback-report.ts", "diagnostic.ts"]
        : []),
      ...(examples[0]?.packet.version === lifecycleScenarioVersion
        ? ["lifecycle-scenarios.ts", "lifecycle-evaluate.ts", "lifecycle-blind.ts"]
        : []),
    ]),
    isolation: {
      configuration: {
        timeouts,
        supervisor: "subreaper",
        protocol: "frozen-chat-completions-or-responses:1",
        network: "fixed-loopback-broker",
      },
      filesystem: evaluator(["isolate.c", "isolation.ts"]),
      processes: evaluator(["isolate.c", "host.ts", "host-process.ts"]),
      network: evaluator(["provider.ts", "isolate.c"]),
      candidateExecutor: evaluator(["isolation.ts", "isolate.c", "evaluate.ts"]),
    },
  }
}

export async function check(value: unknown) {
  const deployment = Schema.decodeUnknownSync(Deployment, { onExcessProperty: "error" })(value)
  const frozen = await preflight({ configuration: await Bun.file(deployment.frozen).json(), ...deployment })
  infrastructure(deployment.infrastructure, deployment.evaluation)
  if (JSON.stringify(frozen.infrastructure) !== JSON.stringify(deployment.infrastructure))
    throw new Error("Infrastructure policy differs from freeze")
  if (frozen.feedbackGuidance !== deployment.feedbackGuidance) throw new Error("Feedback guidance differs from freeze")
  if (frozen.evaluation !== deployment.evaluation) throw new Error("Evaluation policy differs from freeze")
  if (frozen.mode !== deployment.mode) throw new Error("Deployment mode differs from frozen configuration")
  const packet = corpus(deployment.mode === "qualification" ? "qualification" : "development", frozen.seed)
  const examples = deployment.evaluation
    ? deployment.evaluation === "repair-lifecycle-v1"
      ? lifecycleDevelopment(frozen.seed)
      : development(frozen.seed)
    : deployment.mode === "qualification"
      ? packet
      : packet.filter((item) => item.oracle.instance.repeat === 1 && ["P1", "R3"].includes(item.oracle.instance.family))
  if (JSON.stringify(frozen.order) !== JSON.stringify(examples.map((item) => item.packet.id)))
    throw new Error("Deployment must retain the exact frozen corpus order")
  const canonical = {
    version: deployment.version,
    mode: deployment.mode,
    worker: deployment.worker,
    reviewer: deployment.reviewer,
    ...(deployment.evaluation ? { evaluation: deployment.evaluation } : {}),
    ...(deployment.infrastructure ? { infrastructure: deployment.infrastructure } : {}),
    ...(deployment.feedbackGuidance ? { feedbackGuidance: deployment.feedbackGuidance } : {}),
  }
  if (digest(JSON.stringify(canonical)) !== frozen.configuration)
    throw new Error("Deployment parameters differ from frozen bytes")
  for (const role of ["worker", "reviewer"] as const) {
    const model = deployment[role]
    const endpoint = routeURL("model", model, model.credentialEnv !== null)
    if (
      model.model !== frozen[role].model ||
      model.variant !== frozen[role].variant ||
      endpoint.origin !== frozen[role].provider ||
      JSON.stringify(model.parameters) !== JSON.stringify(frozen[role].sampling) ||
      model.seed !== frozen[role].seed ||
      (model.seed !== "unsupported" && model.parameters.seed !== model.seed) ||
      (model.seed === "unsupported" && model.parameters.seed !== undefined) ||
      (model.variant !== "default" && model.parameters.reasoning_effort !== model.variant)
    )
      throw new Error("Model selection or supported sampling parameters differ from freeze")
  }
  if (frozen.timeouts.provider > 900_000 || frozen.timeouts.tool !== 600_000 || frozen.timeouts.cleanup < 6000)
    throw new Error("Timeouts conflict with production provider, tool or supervisor limits")
  const manifest = (await Bun.file(path.join(deployment.snapshot, "manifest.json")).json()) as Record<
    string,
    { hash: string; mode: number; link?: string }
  >
  const root = path.resolve(import.meta.dir, "../../../..")
  const inventory = Bun.spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const listed = [...new Set((await new Response(inventory.stdout).text()).split("\0").filter(Boolean))].sort()
  if (await inventory.exited) throw new Error("Cannot verify complete source inventory")
  const files = (
    await Promise.all(
      listed.map(async (file) => {
        const stat = await lstat(path.join(root, file))
        return stat.isFile() || stat.isSymbolicLink() ? file : undefined
      }),
    )
  ).filter((file): file is string => !!file)
  if (JSON.stringify(files) !== JSON.stringify(Object.keys(manifest).sort()))
    throw new Error("Freeze must contain the complete tracked and untracked source inventory")
  // A verified retained snapshot alone does not prove the code being executed is the same.
  for (const [file, expected] of Object.entries(manifest)) {
    const current = path.resolve(root, file)
    if (!current.startsWith(root + path.sep)) throw new Error("Source path escapes repository")
    const stat = await lstat(current)
    const bytes = stat.isSymbolicLink()
      ? await readlink(current)
      : new Uint8Array(await Bun.file(current).arrayBuffer())
    if (digest(bytes) !== expected.hash || stat.mode !== expected.mode)
      throw new Error("Installed source differs from freeze: " + file)
  }
  const expected = identities(manifest, examples, canonical, frozen.timeouts)
  for (const name of ["runner", "configuration", "prompts", "agents", "tools", "corpus", "oracle", "scorer"] as const)
    if (digest(JSON.stringify(expected[name])) !== frozen[name])
      throw new Error("Frozen object does not bind actual " + name)
  if (deployment.evaluation && digest(JSON.stringify(expected.scenarios)) !== frozen.scenarios)
    throw new Error("Frozen scenario measurement differs")
  for (const name of ["configuration", "filesystem", "processes", "network", "candidateExecutor"] as const)
    if (digest(JSON.stringify(expected.isolation[name])) !== frozen.isolation[name])
      throw new Error("Frozen isolation object differs: " + name)
  if (
    frozen.isolation.profile !== "linux-landlock6-seccomp-subreaper:1" ||
    frozen.recovery !== "one-scheduled-opportunity-original-deadline:1"
  )
    throw new Error("Unsupported isolation or recovery profile")
  return {
    deployment,
    frozen,
    examples,
    credentialSources: (["worker", "reviewer"] as const).map((role) => ({
      role,
      kind: deployment[role].credentialEnv === null ? "local-no-auth" : "environment",
      configured: deployment[role].credentialEnv === null || !!process.env[deployment[role].credentialEnv],
    })),
  }
}

/** Serial, append-only cohort. Every scheduled row survives failed or unstarted instances. */
export async function launch(value: unknown, output: string, signal: AbortSignal) {
  const checked = await check(value)
  if (checked.credentialSources.some((item) => !item.configured))
    throw new Error("Explicit provider credential sources are unavailable")
  await mkdir(output, { recursive: false, mode: 0o700 })
  const file = await open(path.join(output, "cohort.json"), "wx", 0o600)
  await file.writeFile(
    JSON.stringify(
      {
        mode: checked.deployment.mode,
        configuration: checked.frozen,
        instances: checked.examples.map((item) => item.oracle.instance),
        at: Date.now(),
      },
      null,
      2,
    ) + "\n",
  )
  await file.sync()
  await file.close()
  const events = await open(path.join(output, "events.jsonl"), "wx", 0o600)
  const state = { previous: digest(await Bun.file(path.join(output, "cohort.json")).text()), failed: false }
  const rows: { id: string; status: string; evidence?: string }[] = []
  try {
    for (const example of checked.examples) {
      const row = { id: example.packet.id, status: "not_started", evidence: undefined as string | undefined }
      rows.push(row)
      if (!signal.aborted && !state.failed) {
        const directory = path.join(output, example.packet.id)
        await runInstance({
          mode: "model",
          directory,
          packet: example.packet,
          evaluation: checked.deployment.evaluation,
          infrastructure: checked.deployment.infrastructure,
          ...(checked.deployment.feedbackGuidance ? { feedbackGuidance: checked.deployment.feedbackGuidance } : {}),
          entry: checked.deployment.evaluation && example.oracle.entry === "plan" ? "followup" : example.oracle.entry,
          fault: example.oracle.fault,
          routes: {
            worker: {
              ...checked.deployment.worker,
              credential:
                checked.deployment.worker.credentialEnv === null
                  ? null
                  : process.env[checked.deployment.worker.credentialEnv]!,
            },
            reviewer: {
              ...checked.deployment.reviewer,
              credential:
                checked.deployment.reviewer.credentialEnv === null
                  ? null
                  : process.env[checked.deployment.reviewer.credentialEnv]!,
            },
          },
          limits: { worker: checked.deployment.worker, reviewer: checked.deployment.reviewer },
          timeouts: checked.frozen.timeouts,
          bun: checked.deployment.bun,
          node: checked.deployment.node,
          signal,
          frozenCode: checked.frozen.runner,
        }).then(
          async (result) => {
            row.evidence = await put(output, result)
            row.status = result.monitored.cancelled
              ? "cancelled"
              : result.monitored.timedOut
                ? "timeout"
                : "pending_scoring"
            if (
              !checked.deployment.evaluation &&
              (result.monitored.cancelled || result.monitored.timedOut || result.monitored.prerequisiteBlocked)
            )
              return
            await prepareScoring({
              directory,
              result,
              packet: example.packet,
              oracle: example.oracle,
              launcher: await launcher(path.join(output, "scoring-isolation")),
              timeout: checked.frozen.timeouts.verification,
            }).catch(async (error) => {
              row.status = "scoring_unavailable"
              await put(output, { instance: row.id, scoringFailure: String(error) })
            })
          },
          async (error) => {
            row.status = signal.aborted ? "cancelled" : "infrastructure_failure"
            const retained = (await Bun.file(path.join(directory, "failure.json"))
              .json()
              .catch(() => undefined)) as unknown
            const cleanup = (await Bun.file(path.join(directory, "cleanup-failure.json"))
              .json()
              .catch(() => undefined)) as unknown
            row.evidence = await put(output, {
              instance: row.id,
              failure: String(error),
              retained,
              cleanup,
              ...(checked.deployment.feedbackGuidance ? { feedbackGuidance: checked.deployment.feedbackGuidance } : {}),
            })
            // An infrastructure fault stops the cohort; it never buys a fresh attempt/deadline.
            state.failed = true
          },
        )
      }
      if (checked.deployment.infrastructure && row.status === "not_started")
        row.evidence = await put(output, {
          instance: row.id,
          codeHash: checked.frozen.runner,
          infrastructure: checked.deployment.infrastructure,
          ...(checked.deployment.feedbackGuidance ? { feedbackGuidance: checked.deployment.feedbackGuidance } : {}),
          evaluation: checked.deployment.evaluation,
          attempted: false,
          reason: signal.aborted ? "cancelled_before_start" : "prior_infrastructure_failure",
          prior: state.previous,
        })
      const event = { previous: state.previous, at: Date.now(), ...row }
      state.previous = digest(JSON.stringify(event))
      await events.writeFile(JSON.stringify({ ...event, hash: state.previous }) + "\n")
      await events.sync()
    }
    const summary = {
      mode: checked.deployment.mode,
      denominator: checked.examples.length,
      rows,
      qualification: checked.deployment.evaluation ? "not_run" : "pending",
      finalEvent: state.previous,
    }
    await Bun.write(path.join(output, "report.json"), JSON.stringify(summary, null, 2) + "\n")
    return summary
  } finally {
    await events.close()
  }
}

if (import.meta.main) {
  const [command, configuration, output] = process.argv.slice(2)
  if (!["freeze", "check", "run"].includes(command) || !configuration || (command !== "check" && !output))
    throw new Error(
      "Usage: bun launch.ts freeze SETUP.json NEW_FREEZE_DIRECTORY | check DEPLOYMENT.json | run DEPLOYMENT.json NEW_OUTPUT_DIRECTORY",
    )
  const controller = new AbortController()
  process.once("SIGINT", () => controller.abort())
  process.once("SIGTERM", () => controller.abort())
  const result =
    command === "freeze"
      ? await freezeDeployment(await Bun.file(configuration).json(), output)
      : command === "check"
        ? await check(await Bun.file(configuration).json())
        : await launch(await Bun.file(configuration).json(), output, controller.signal)
  console.log(
    JSON.stringify(
      command === "check"
        ? { checked: true, credentialSources: "credentialSources" in result ? result.credentialSources : [] }
        : result,
      null,
      2,
    ),
  )
}
