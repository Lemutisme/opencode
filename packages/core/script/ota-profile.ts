// Production entrypoint for ota-run.ts. The JSON profile and grader module are
// operator-owned; they must never come from a candidate's source/output tree.
import { pathToFileURL } from "node:url"
import path from "node:path"
import { driver } from "./ota-opencode"
import type { Configuration, Supplies } from "./ota-opencode"
import { checked, reference, release } from "./ota-native"
import type { FileRef } from "./ota-native"
import type { Protocol } from "./ota-rsi"
import { Artifacts } from "./ota-supervisor"
import type { Driver, Readmission } from "./ota-supervisor"

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
    performanceRule?: Protocol["performanceRule"]
    startupMs?: number
    heartbeatMs?: number
    probationMs?: number
    evaluationConcurrency?: number
    stopOnPrimaryImprovement?: boolean
    requiredFull?: string[]
    readmission?: FileRef
    evaluationReadiness?: { plan: FileRef; receipt: string }
  }
  const supplies = (await Bun.file(await checked(config.supplies)).json()) as Supplies
  const harness = await checked(config.harness)
  await release(harness)
  const strategy = await Bun.file(await checked(config.strategy)).bytes()
  const text = new TextDecoder("utf-8", { fatal: true }).decode(strategy)
  if (!text.trim() || text.includes("\0") || strategy.length > 65_536) throw new Error("invalid initial strategy")
  const key = process.env[config.provider.keyEnvironment ?? "OPENAI_API_KEY"]
  if (!key) throw new Error("host-only provider credential is missing")
  const readmission = config.readmission ? await loadReadmission(root, config.readmission, config) : undefined
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
    authority: [
      await reference(import.meta.path),
      ref,
      config.supplies,
      config.grader,
      ...(config.authority ?? []),
      ...(config.readmission ? [config.readmission] : []),
      ...(config.evaluationReadiness ? [config.evaluationReadiness.plan] : []),
    ],
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
  if (config.evaluationReadiness) {
    const readiness = config.evaluationReadiness
    if (path.resolve(readiness.receipt) !== path.join(root, "qualification", "EVALUATOR-ADMISSION.json"))
      throw new Error("evaluator readiness must be an external campaign-owned receipt")
    await checked(readiness.plan)
    const prepare = value.prepare
    value.prepare = async (input) => {
      const candidate = prepare ? await prepare(input) : await Bun.file(input.proposal).bytes()
      if (!(candidate instanceof Uint8Array)) return candidate
      // A proposal may be researched before grader qualification, but no paid
      // task trial or OTA settlement may pass this external readiness boundary.
      // The proposer has already handed off and stopped; this admits no work.
      await Bun.write(
        path.join(root, "qualification", "EVALUATOR-WAIT.json"),
        JSON.stringify({
          job: input.job.id,
          plan: readiness.plan,
          candidatePrepared: true,
          modelWorkStopped: true,
        }),
      )
      await evaluationReady(readiness, input.signal)
      return candidate
    }
  }
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
    readmission,
    seed: { s: strategy, h: await Bun.file(harness).bytes() },
    protocol: {
      trusted: await value.fingerprint(),
      scope: "performance" as const,
      tests: config.tests,
      performanceRule:
        config.performanceRule ?? (config.minimumMeanGainBps === undefined ? "task-pareto" : "panel-margin"),
      minimumMeanGainBps: config.minimumMeanGainBps,
      startupMs: config.startupMs ?? 1_200_000,
      heartbeatMs: config.heartbeatMs ?? 1_200_000,
      probationMs: config.probationMs ?? 60_000,
      evaluationConcurrency: config.evaluationConcurrency ?? 1,
      stopOnPrimaryImprovement: config.stopOnPrimaryImprovement ?? false,
      requiredFull: config.requiredFull ?? [],
    },
  }
}

export async function evaluationReady(readiness: { plan: FileRef; receipt: string }, signal: AbortSignal) {
  await checked(readiness.plan)
  while (!(await Bun.file(readiness.receipt).exists())) {
    if (signal.aborted) throw new Error("cancelled while awaiting evaluator qualification")
    await Bun.sleep(100)
  }
  if (signal.aborted) throw new Error("cancelled before evaluator readiness admission")
  await checked(readiness.plan)
  const receipt = (await Bun.file(await checked(await reference(readiness.receipt))).json()) as {
    passed: boolean
    plan_sha256: string
  }
  if (receipt.passed !== true || receipt.plan_sha256 !== readiness.plan.sha256)
    throw new Error("evaluator qualification failed or names a different frozen plan; no task trials admitted")
}

async function loadReadmission(
  root: string,
  ref: FileRef,
  config: {
    tests: Protocol["tests"]
    strategy: FileRef
    harness: FileRef
    performanceRule?: Protocol["performanceRule"]
  },
) {
  const input = (await Bun.file(await checked(ref)).json()) as {
    kind: "operator-readmission-v1"
    evidence: Readmission["evidence"]
    pair: { s: FileRef; h: FileRef }
    baseline: { s: FileRef; h: FileRef }
    tests: Protocol["tests"]
    sources: FileRef[]
    memory: FileRef
  }
  if (input.kind !== "operator-readmission-v1" || config.performanceRule !== "task-pareto")
    throw new Error("explicit task-pareto operator readmission required")
  if (JSON.stringify(input.tests) !== JSON.stringify(config.tests)) throw new Error("readmission test manifest changed")
  if (input.baseline.s.sha256 !== config.strategy.sha256 || input.baseline.h.sha256 !== config.harness.sha256)
    throw new Error("readmission baseline differs from authorized seed")
  if (path.resolve(input.memory.path) !== path.join(root, "memory", "e1.json"))
    throw new Error("readmission must bind this cohort's private seed memory")
  if (!input.sources.length) throw new Error("readmission provenance required")
  await Promise.all(
    [...input.sources, ...Object.values(input.baseline), ...Object.values(input.pair), input.memory].map(checked),
  )
  await release(input.pair.h.path)
  const store = new Artifacts(path.join(root, "objects"))
  const checkpoint = (await Bun.file(input.memory.path).json()).tree_sha256
  if (typeof checkpoint !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint))
    throw new Error("sealed memory checkpoint required")
  return {
    manifest: ref.sha256,
    pair: {
      s: await store.put(await Bun.file(input.pair.s.path).bytes()),
      h: await store.put(await Bun.file(input.pair.h.path).bytes()),
    },
    evidence: input.evidence,
    checkpoint,
  } satisfies Readmission
}
