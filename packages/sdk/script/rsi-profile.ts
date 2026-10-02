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
  if (!!input.grader === !!input.programbench)
    throw new Error("freeze exactly one trusted grader or ProgramBench manifest")
  if (
    input.development &&
    (!input.development.goal.trim() ||
      Object.keys(input.development.files).some(
        (name) =>
          !/^[a-z][a-z0-9_.-]*$/.test(name) || ["parent-strategy", "workspace.tar", "obligations.json"].includes(name),
      ))
  )
    throw new Error("development context requires a goal and non-reserved public file names")
  const references = [
    input.harness,
    input.strategy,
    input.gateway,
    ...input.authority,
    ...Object.values(input.development?.files ?? {}),
    ...[input.grader, input.programbench, input.deployment?.checkpoint].filter(
      (file): file is RSIRuntime.File => file !== undefined,
    ),
  ]
  await Promise.all(references.map(RSIRuntime.checked))
  await RSIRuntime.release(input.harness.path)
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error("missing host-only credential")
  // Only the operator-pinned grader is imported here; never a proposed H module.
  const adapter = await (async () => {
    if (input.programbench) {
      const { programBench } = await import("./rsi-programbench")
      return programBench(root, input.programbench)
    }
    // Operator-pinned module, never an import from H.
    return {
      ...((await import(pathToFileURL(input.grader!.path).href)) as Pick<
        NativeConfiguration,
        "task" | "grade" | "continuation"
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
    task: adapter.task,
    grade: adapter.grade,
    continuation: adapter.continuation,
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
    audit: input.audit,
    seed: { s: await Bun.file(input.strategy.path).bytes(), h: await Bun.file(input.harness.path).bytes() },
  }
}
