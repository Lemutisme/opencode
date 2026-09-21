// Production entrypoint for ota-run.ts. The JSON profile and grader module are
// operator-owned; they must never come from a candidate's source/output tree.
import { pathToFileURL } from "node:url"
import { driver } from "./ota-opencode"
import type { Configuration, Supplies } from "./ota-opencode"
import { checked, reference, release } from "./ota-native"
import type { FileRef } from "./ota-native"
import type { Protocol } from "./ota-rsi"
import type { Driver } from "./ota-supervisor"

export async function configure(root: string) {
  const file = process.env.OPENCODE_OTA_PROFILE
  if (!file) throw new Error("OPENCODE_OTA_PROFILE must name a frozen, operator-owned JSON profile")
  const ref = await reference(file)
  const config = (await Bun.file(await checked(ref)).json()) as {
    supplies: FileRef
    harness: FileRef
    strategy: FileRef
    grader: FileRef
    authority: FileRef[]
    provider: { gateway: FileRef; model: string; effort: string; upstream: string; keyEnvironment?: string }
    tests: Protocol["tests"]
    minimumMeanGainBps?: number
    startupMs?: number
    heartbeatMs?: number
    probationMs?: number
    evaluationConcurrency?: number
    stopOnPrimaryImprovement?: boolean
    requiredFull?: string[]
  }
  const supplies = (await Bun.file(await checked(config.supplies)).json()) as Supplies
  const harness = await checked(config.harness)
  await release(harness)
  const strategy = await Bun.file(await checked(config.strategy)).bytes()
  const text = new TextDecoder("utf-8", { fatal: true }).decode(strategy)
  if (!text.trim() || text.includes("\0") || strategy.length > 65_536) throw new Error("invalid initial strategy")
  const key = process.env[config.provider.keyEnvironment ?? "OPENAI_API_KEY"]
  if (!key) throw new Error("host-only provider credential is missing")
  const { task, grade, evaluate, fence } = (await import(pathToFileURL(await checked(config.grader)).href)) as Partial<
    Pick<Configuration, "task" | "grade">
  > & {
    evaluate?: (input: Parameters<Driver["evaluate"]>[0] & { root: string }) => ReturnType<Driver["evaluate"]>
    fence?: (root: string) => Promise<void>
  }
  if (typeof evaluate !== "function" && (typeof task !== "function" || typeof grade !== "function"))
    throw new Error("trusted grader must export evaluate or task and grade")
  const value = driver({
    root,
    supplies,
    provider: { ...config.provider, key },
    authority: [await reference(import.meta.path), ref, config.supplies, config.grader, ...(config.authority ?? [])],
    task:
      task ??
      (() => {
        throw new Error("external evaluator owns task execution")
      }),
    grade:
      grade ??
      (async () => {
        throw new Error("external evaluator owns scoring")
      }),
  })
  if (evaluate) value.evaluate = (input) => evaluate({ ...input, root })
  if (fence) {
    const close = value.fence
    value.fence = async () => {
      try {
        await fence(root)
      } finally {
        await close()
      }
    }
  }
  return {
    driver: value,
    seed: { s: strategy, h: await Bun.file(harness).bytes() },
    protocol: {
      trusted: await value.fingerprint(),
      scope: "performance" as const,
      tests: config.tests,
      minimumMeanGainBps: config.minimumMeanGainBps ?? 200,
      startupMs: config.startupMs ?? 1_200_000,
      heartbeatMs: config.heartbeatMs ?? 1_200_000,
      probationMs: config.probationMs ?? 60_000,
      evaluationConcurrency: config.evaluationConcurrency ?? 1,
      stopOnPrimaryImprovement: config.stopOnPrimaryImprovement ?? false,
      requiredFull: config.requiredFull ?? [],
    },
  }
}
