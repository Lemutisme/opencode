// Exact production seed, real SDK/containers/builds/gateway, scripted provider.
// The generated marker patch and scores are fixtures, NOT performance evidence.
import fs from "node:fs/promises"
import path from "node:path"
import { OTA, subject } from "../../core/script/ota-rsi"
import type { Protocol } from "../../core/script/ota-rsi"
import { Artifacts, supervise } from "../../core/script/ota-supervisor"
import { nativeDriver } from "./rsi-driver"
import { RSIRuntime } from "./rsi-runtime"
import { wireFixture } from "./rsi-wire-fixture"

const [rootArg, releaseArg, gatewayArg, extra] = process.argv.slice(2)
if (!rootArg || !releaseArg || !gatewayArg || extra)
  throw new Error("usage: bun rsi-learning-qualify.ts NEW_ROOT PRODUCTION_RELEASE GATEWAY")
const root = path.resolve(rootArg)
await fs.mkdir(root, { mode: 0o700 })
const release = await RSIRuntime.release(path.resolve(releaseArg))
const wire = wireFixture(root, 0, true)
const observations: { source: string; passed: number; test: string; run: string }[] = []
const driver = nativeDriver({
  root,
  provider: {
    gateway: await RSIRuntime.ref(path.resolve(gatewayArg)),
    model: "gpt-5.6-luna",
    effort: "max",
    upstream: wire.url,
    key: "scripted-no-secret",
    fixture: true,
  },
  authority: [
    await RSIRuntime.ref(import.meta.path),
    await RSIRuntime.ref(path.join(import.meta.dir, "rsi-wire-fixture.ts")),
  ],
  task: () => ({
    goal: "Scripted mechanics: report the observable worker revision marker, never a benchmark score.",
    artifact: "answer",
  }),
  grade: async (input) => {
    const marker = new TextDecoder().decode(input.artifact)
    const changed = input.release.source.sha256 !== release.source.sha256
    if (marker !== `revision:${changed ? 1 : 0}`)
      throw new Error("the actual loaded worker did not execute its expected marker")
    const passed = !input.test.performance
      ? 1
      : changed
        ? input.test.performance.panel === "development"
          ? 60
          : 49
        : 50
    observations.push({ source: input.release.source.sha256, passed, test: input.test.id, run: input.run })
    return { passed, total: input.test.total, valid: true }
  },
})
const protocol: Protocol = {
  trusted: await driver.fingerprint(),
  evidence: "bound-v1",
  scope: "performance",
  performanceRule: "task-pareto",
  expansion: { width: 1 },
  research: { proposals: 2 },
  tests: [
    { id: "containment", total: 1 },
    ...(["development", "confirmation"] as const).flatMap((panel) =>
      ["1", "2"].map((replicate) => ({
        id: `${panel}-${replicate}`,
        total: 100,
        performance: { panel, task: panel, replicate },
      })),
    ),
  ],
  startupMs: 120_000,
  heartbeatMs: 120_000,
  probationMs: 1000,
  evaluationConcurrency: 4,
}
const artifacts = new Artifacts(path.join(root, "objects"))
const seed = {
  s: await artifacts.put(new TextEncoder().encode("Use native tools and submit the requested artifact.")),
  h: await artifacts.put(new TextEncoder().encode(JSON.stringify(release))),
}
const ota = new OTA(path.join(root, "ota.sqlite"), protocol, seed)
await Bun.write(
  path.join(root, "PROTOCOL.json"),
  JSON.stringify({ protocol, seed, release, scope: "scripted-mechanics-only", modelCalls: false }, null, 2),
)
const timeout = setTimeout(() => {
  void Bun.write(path.join(root, "CANCEL"), "qualification infrastructure timeout")
}, 900_000)
try {
  const state = await supervise(root, ota, artifacts, driver)
  const qualified =
    state.stopped === "research proposal schedule completed" &&
    subject(state.active.pair) === subject(seed) &&
    state.lineage?.length === 2 &&
    state.lineage.every((node) => node.outcome === "rejected" && node.researchSupport) &&
    wire.records.some((record) => record.mode === "s" && record.revision === 1 && record.step >= 2) &&
    observations.length === 20
  await Bun.write(
    path.join(root, "RESULT.json"),
    JSON.stringify(
      {
        qualified,
        scope: "scripted-mechanics-only",
        modelCalls: false,
        seedSource: release.source.sha256,
        state,
        observations,
        wire: wire.records,
        events: ota.history(),
      },
      null,
      2,
    ),
  )
  if (!qualified) throw new Error("actual research producer succession did not qualify")
  console.log(
    JSON.stringify({
      qualified,
      modelCalls: false,
      actualResearchSuccessions: 1,
      adoptions: 0,
      seedSource: release.source.sha256,
      requests: wire.records.length,
    }),
  )
} finally {
  clearTimeout(timeout)
  await driver.fence()
  wire.server.stop(true)
  ota.db.close()
}
