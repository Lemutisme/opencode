// Actual historical or production worker, scripted provider, real public task
// handoff/fence/restore. Reference wrapping is allowed ONLY in this fixture.
import fs from "node:fs/promises"
import path from "node:path"
import { OTA, SIX_HOURS, subject } from "../../core/script/ota-rsi"
import { Artifacts, supervise } from "../../core/script/ota-supervisor"
import { nativeDriver } from "./rsi-driver"
import type { NativeObservation } from "./rsi-driver"
import { RSIRuntime } from "./rsi-runtime"
import { RSITask } from "./rsi-task"
import { scopedWire } from "./rsi-scoped-wire"

const [rootArg, releaseArg, gatewayArg, mode = "resume", extra] = process.argv.slice(2)
if (!rootArg || !releaseArg || !gatewayArg || !["off", "resume"].includes(mode) || extra)
  throw new Error("usage: bun rsi-resume-qualify.ts NEW_ROOT EXACT_RELEASE GATEWAY [off|resume]")
const root = path.resolve(rootArg)
await fs.mkdir(root, { mode: 0o700 })
const release = await RSIRuntime.release(path.resolve(releaseArg))
const artifacts = new Artifacts(path.join(root, "objects"))
const workspace = path.join(root, "initial")
await fs.mkdir(workspace)
await Bun.write(path.join(workspace, "README"), "Scripted containment and resume control, not performance.")
await RSIRuntime.run([
  "python3",
  path.join(import.meta.dir, "rsi-files.py"),
  "snapshot",
  workspace,
  path.join(root, "workspace.tar"),
])
const checkpoint = await artifacts.put(
  new TextEncoder().encode(
    JSON.stringify({
      kind: "native-rsi-task-v1",
      task: "resume-control-fixture",
      goal: "Scripted qualification: wrap the public reference, retain a probe, then checkpoint or deliver. Never claim benchmark performance.",
      image: release.image,
      workspace: await RSIRuntime.ref(path.join(root, "workspace.tar")),
      obligations: [],
      summary: "Initial task",
    }),
  ),
)
const wire = scopedWire(root, "closure", true)
const observations: { run: string; allowRevise?: boolean; checkpoint: string; outcome: string; deadline: number }[] = []
const inspect = async (input: NativeObservation) => {
  const execution = await Bun.file(path.join(input.run, "EXECUTION.json")).json()
  if (execution.release.source.sha256 !== release.source.sha256 || execution.deadline !== input.deadline)
    throw new Error("fixture worker source or original deadline changed")
  await Bun.file(path.join(input.run, "FENCED.json")).json()
  const journal = (await Bun.file(path.join(input.state, "delivery/delivery.jsonl")).text())
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row) as { type: string; matches?: boolean })
  if (
    !journal.some((row) => row.type === "check" && row.matches === true) ||
    journal.some((row) => row.type === "check" && !row.matches)
  )
    throw new Error("actual retained public probe did not replay")
}
const adapter = RSITask.continuation(
  root,
  async (input) => {
    await inspect(input)
    return { passed: 1, total: 1, valid: true }
  },
  { partial: "blocked", scoreBlocked: true },
)
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
    await RSIRuntime.ref(path.join(import.meta.dir, "rsi-scoped-wire.ts")),
  ],
  task: async () => {
    throw new Error("resume-only control must not schedule candidate evaluations")
  },
  grade: async () => {
    throw new Error("resume-only control must not evaluate modifications")
  },
  continuation: {
    task: adapter.task,
    settle: async (input) => {
      await inspect(input)
      const report = await adapter.settle(input)
      observations.push({
        run: input.run,
        allowRevise: input.job.allowRevise,
        checkpoint: report.checkpoint,
        outcome: report.outcome,
        deadline: input.deadline,
      })
      return report
    },
  },
})
const started = Date.now()
const seed = {
  s: await artifacts.put(new TextEncoder().encode("Scripted fixture. Use the admitted native task tools.")),
  h: await artifacts.put(new TextEncoder().encode(JSON.stringify(release))),
}
const ota = new OTA(
  path.join(root, "ota.sqlite"),
  {
    trusted: await driver.fingerprint(),
    evidence: "bound-v1",
    scope: "mechanics",
    performanceRule: "task-pareto",
    expansion: { width: 1 },
    deployment: {
      kind: "task",
      task: "resume-control-fixture",
      started,
      deadline: started + SIX_HOURS,
      checkpoint,
      revisions: mode === "off" ? 0 : 1,
      ...(mode === "resume" ? { control: "resume" as const } : {}),
    },
    tests: [{ id: "unused-safety", total: 1 }],
    startupMs: 120_000,
    heartbeatMs: 120_000,
    probationMs: 60_000,
  },
  seed,
)
const timeout = setTimeout(() => {
  void Bun.write(path.join(root, "CANCEL"), "qualification infrastructure timeout")
}, 600_000)
try {
  const state = await supervise(root, ota, artifacts, driver)
  const qualified =
    state.stopped === "task delivered" &&
    state.task?.status === "delivered" &&
    state.task.revisions === 0 &&
    subject(state.active.pair) === subject(seed) &&
    !state.lineage?.length &&
    observations.length === (mode === "off" ? 1 : 2) &&
    observations.at(-1)?.allowRevise === false &&
    observations.every((run) => run.deadline === started + SIX_HOURS) &&
    (mode === "off" || (observations[0].outcome === "revise" && state.task.resumeControlUsed === true))
  await Bun.write(
    path.join(root, "RESULT.json"),
    JSON.stringify(
      {
        qualified,
        mode,
        realModelCalls: 0,
        source: release.source.sha256,
        scope: "scripted-mechanics-only",
        state,
        observations,
        wire: wire.records,
        history: ota.history(),
      },
      null,
      2,
    ),
  )
  if (!qualified) throw new Error("native unchanged-incumbent control did not qualify")
  console.log(
    JSON.stringify({
      qualified,
      mode,
      realModelCalls: 0,
      source: release.source.sha256,
      requests: wire.records.length,
    }),
  )
} finally {
  clearTimeout(timeout)
  await driver.fence()
  wire.server.stop(true)
  ota.db.close()
}
