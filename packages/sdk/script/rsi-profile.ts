// Operator-owned JSON profile + grader, used with Core's existing ota-run CLI.
import { pathToFileURL } from "node:url"
import { Schema } from "effect"
import { RSIRuntime } from "./rsi-runtime"
import { nativeDriver } from "./rsi-driver"
import type { NativeConfiguration } from "./rsi-driver"
import type { Protocol } from "../../core/script/ota-rsi"

const Profile = Schema.Struct({
  harness: RSIRuntime.File,
  strategy: RSIRuntime.File,
  grader: RSIRuntime.File,
  authority: Schema.Array(RSIRuntime.File),
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
})
export async function configure(root: string) {
  const file = process.env.OPENCODE_RSI_PROFILE
  if (!file) throw new Error("OPENCODE_RSI_PROFILE must name an operator-owned frozen profile")
  const profile = await RSIRuntime.ref(file)
  const input = Schema.decodeUnknownSync(Schema.fromJsonString(Profile))(await Bun.file(profile.path).text(), {
    onExcessProperty: "error",
  })
  await Promise.all(
    [input.harness, input.strategy, input.grader, input.gateway, ...input.authority].map(RSIRuntime.checked),
  )
  await RSIRuntime.release(input.harness.path)
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error("missing host-only credential")
  // Only the operator-pinned grader is imported here; never a proposed H module.
  const { task, grade } = (await import(pathToFileURL(input.grader.path).href)) as Pick<
    NativeConfiguration,
    "task" | "grade"
  >
  if (typeof task !== "function" || typeof grade !== "function")
    throw new Error("trusted grader must export task and grade")
  const driver = nativeDriver({
    root,
    provider: { gateway: input.gateway, model: input.model, effort: input.effort, upstream: input.upstream, key },
    authority: [profile, input.grader, ...input.authority, await RSIRuntime.ref(import.meta.path)],
    task,
    grade,
  })
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
  }
  return {
    driver,
    protocol,
    seed: { s: await Bun.file(input.strategy.path).bytes(), h: await Bun.file(input.harness.path).bytes() },
  }
}
