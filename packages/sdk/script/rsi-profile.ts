// Operator-owned JSON profile + grader, used with Core's existing ota-run CLI.
import { pathToFileURL } from "node:url"
import { Schema } from "effect"
import { RSIRuntime } from "./rsi-runtime"
import { nativeDriver } from "./rsi-driver"
import type { NativeConfiguration } from "./rsi-driver"
import type { Protocol } from "../../core/script/ota-rsi"
import { Artifacts } from "../../core/script/ota-supervisor"
import path from "node:path"

const Profile = Schema.Struct({
  harness: RSIRuntime.File,
  strategy: RSIRuntime.File,
  grader: Schema.optional(RSIRuntime.File),
  programbench: Schema.optional(RSIRuntime.File),
  terminal: Schema.optional(RSIRuntime.File),
  tau: Schema.optional(RSIRuntime.File),
  safety: Schema.optional(Schema.Array(Schema.String)),
  authority: Schema.Array(RSIRuntime.File),
  development: Schema.optional(
    Schema.Struct({ goal: Schema.String, files: Schema.Record(Schema.String, RSIRuntime.File) }),
  ),
  gateway: RSIRuntime.File,
  model: Schema.String,
  effort: Schema.String,
  upstream: Schema.String,
  expansionWidth: Schema.Int,
  tests: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      total: Schema.Int,
      performance: Schema.optional(
        Schema.Struct({
          panel: Schema.Literals(["development", "confirmation"]),
          task: Schema.String,
          replicate: Schema.String,
        }),
      ),
    }),
  ),
  startupMs: Schema.Int,
  heartbeatMs: Schema.Int,
  probationMs: Schema.Int,
  evaluationConcurrency: Schema.Int,
  requiredFull: Schema.optional(Schema.Array(Schema.String)),
  stopOnPrimaryImprovement: Schema.optional(Schema.Boolean),
  completion: Schema.optional(
    Schema.Struct({ selections: Schema.Int, successorHandoff: Schema.Literal(true), stopOnRejection: Schema.Boolean }),
  ),
  deployment: Schema.optional(
    Schema.Struct({
      kind: Schema.Literal("task"),
      task: Schema.String,
      started: Schema.Number,
      deadline: Schema.Number,
      checkpoint: RSIRuntime.File,
    }),
  ),
  audit: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, total: Schema.Int }))),
})
export async function configure(root: string) {
  const file = process.env.OPENCODE_RSI_PROFILE
  if (!file) throw new Error("OPENCODE_RSI_PROFILE must name an operator-owned frozen profile")
  const profile = await RSIRuntime.ref(file)
  const input = Schema.decodeUnknownSync(Schema.fromJsonString(Profile))(await Bun.file(profile.path).text(), {
    onExcessProperty: "error",
  })
  if ([input.grader, input.programbench, input.terminal, input.tau].filter(Boolean).length !== 1)
    throw new Error("freeze exactly one trusted grader or benchmark manifest")
  if (
    input.development &&
    (!input.development.goal.trim() ||
      Object.keys(input.development.files).some(
        (name) =>
          !/^[a-z][a-z0-9_.-]*$/.test(name) ||
          ["parent-strategy", "workspace.tar", "obligations.json", "bridge-tools.json"].includes(name),
      ))
  )
    throw new Error("development context requires a goal and non-reserved public file names")
  const safety = new Set(input.safety ?? [])
  if (
    safety.size !== (input.safety?.length ?? 0) ||
    [...safety].some((id) => {
      const test = input.tests.find((test) => test.id === id)
      return !test || test.performance !== undefined || test.total !== 1 || input.audit?.some((test) => test.id === id)
    }) ||
    ((input.terminal || input.tau) && !safety.size)
  )
    throw new Error("external benchmark safety IDs must name fixed non-performance selection tests, never audit")
  const safetyAdapter = await (async () => {
    if (!safety.size) return
    const { containmentTask, containmentScore } = await import("./rsi-safety")
    return { task: containmentTask, grade: containmentScore }
  })()
  const references = [
    input.harness,
    input.strategy,
    input.gateway,
    ...input.authority,
    ...Object.values(input.development?.files ?? {}),
    ...[input.grader, input.programbench, input.terminal, input.tau, input.deployment?.checkpoint].filter(
      (file): file is RSIRuntime.File => file !== undefined,
    ),
  ]
  await Promise.all(references.map(RSIRuntime.checked))
  await RSIRuntime.release(input.harness.path)
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error("missing host-only credential")
  // Only the operator-pinned grader is imported here; never a proposed H module.
  const adapter: Pick<NativeConfiguration, "task" | "grade" | "continuation" | "dispose"> & {
    authority: RSIRuntime.File[]
  } = await (async () => {
    if (input.programbench) {
      const { programBench } = await import("./rsi-programbench")
      return programBench(root, input.programbench)
    }
    if (input.terminal) {
      const { terminalBench } = await import("./rsi-terminal")
      return terminalBench(root, input.terminal)
    }
    if (input.tau) {
      const { tauBench } = await import("./rsi-tau")
      return tauBench(root, input.tau)
    }
    // Operator-pinned module, never an import from H.
    return {
      ...((await import(pathToFileURL(input.grader!.path).href)) as Pick<
        NativeConfiguration,
        "task" | "grade" | "continuation" | "dispose"
      >),
      authority: [input.grader!],
    }
  })()
  if (typeof adapter.task !== "function" || typeof adapter.grade !== "function")
    throw new Error("trusted grader must export task and grade")
  if (input.deployment && !adapter.continuation) throw new Error("task scope requires trusted checkpoint continuation")
  const native: NativeConfiguration = {
    root,
    provider: { gateway: input.gateway, model: input.model, effort: input.effort, upstream: input.upstream, key },
    authority: [profile, ...references, ...adapter.authority, await RSIRuntime.ref(import.meta.path)],
    task: (test, task) => (safety.has(test.id) ? safetyAdapter!.task(test) : adapter.task(test, task)),
    grade: (input) => (safety.has(input.test.id) ? safetyAdapter!.grade(input) : adapter.grade(input)),
    continuation: adapter.continuation,
    dispose: adapter.dispose,
    development: input.development
      ? { goal: input.development.goal, files: { ...input.development.files } }
      : undefined,
  }
  const driver = nativeDriver(native)
  const protocol: Protocol = {
    trusted: await driver.fingerprint(),
    scope: "performance",
    performanceRule: "task-pareto",
    expansion: { width: input.expansionWidth },
    tests: [...input.tests],
    startupMs: input.startupMs,
    heartbeatMs: input.heartbeatMs,
    probationMs: input.probationMs,
    evaluationConcurrency: input.evaluationConcurrency,
    requiredFull: input.requiredFull ? [...input.requiredFull] : undefined,
    stopOnPrimaryImprovement: input.stopOnPrimaryImprovement,
    completion: input.completion,
    deployment: input.deployment
      ? {
          ...input.deployment,
          checkpoint: await new Artifacts(path.join(root, "objects")).put(
            await Bun.file(input.deployment.checkpoint.path).bytes(),
          ),
        }
      : undefined,
  }
  return {
    driver,
    protocol,
    native,
    dispose: adapter.dispose,
    audit: input.audit,
    seed: { s: await Bun.file(input.strategy.path).bytes(), h: await Bun.file(input.harness.path).bytes() },
  }
}
