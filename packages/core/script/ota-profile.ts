// Production entrypoint for ota-run.ts. The JSON profile and grader module are
// operator-owned; they must never come from a candidate's source/output tree.
import { pathToFileURL } from "node:url"
import { driver } from "./ota-opencode"
import type { Configuration, Supplies } from "./ota-opencode"
import { checked, reference, release } from "./ota-native"
import type { FileRef } from "./ota-native"
import type { Protocol } from "./ota-rsi"

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
  }
  const supplies = (await Bun.file(await checked(config.supplies)).json()) as Supplies
  const harness = await checked(config.harness)
  await release(harness)
  const strategy = await Bun.file(await checked(config.strategy)).bytes()
  const text = new TextDecoder("utf-8", { fatal: true }).decode(strategy)
  if (!text.trim() || text.includes("\0") || strategy.length > 65_536) throw new Error("invalid initial strategy")
  const key = process.env[config.provider.keyEnvironment ?? "OPENAI_API_KEY"]
  if (!key) throw new Error("host-only provider credential is missing")
  const { task, grade } = (await import(pathToFileURL(await checked(config.grader)).href)) as Pick<
    Configuration,
    "task" | "grade"
  >
  if (typeof task !== "function" || typeof grade !== "function")
    throw new Error("trusted grader must export task and grade")
  const value = driver({
    root,
    supplies,
    provider: { ...config.provider, key },
    authority: [await reference(import.meta.path), ref, config.supplies, config.grader, ...(config.authority ?? [])],
    task,
    grade,
  })
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
    },
  }
}
