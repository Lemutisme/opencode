// Real native worker + gateway + checkpoint recovery, with a scripted provider.
// Scores and reference wrapping are fixtures, never benchmark performance.
import fs from "node:fs/promises"
import path from "node:path"
import { OTA, SIX_HOURS, subject } from "../../core/script/ota-rsi"
import { Artifacts, supervise } from "../../core/script/ota-supervisor"
import { nativeDriver } from "./rsi-driver"
import { RSIRuntime } from "./rsi-runtime"
import { RSITask } from "./rsi-task"
import { programBench } from "./rsi-programbench"
import { scopedStrategy, scopedWire } from "./rsi-scoped-wire"

const [rootArg, releaseArg, gatewayArg, mode = "provider", graderArg, extra] = process.argv.slice(2)
if (
  !rootArg ||
  !releaseArg ||
  !gatewayArg ||
  !["provider", "unknown", "guard-denied", "peer-grader"].includes(mode) ||
  (mode === "peer-grader") !== !!graderArg ||
  extra
)
  throw new Error("usage: bun rsi-recovery-qualify.ts NEW_ROOT EXACT_RELEASE GATEWAY MODE [PEER_GRADER_CONFIG]")
const root = path.resolve(rootArg)
await fs.mkdir(root, { mode: 0o700 })
const release = await RSIRuntime.release(path.resolve(releaseArg))
const artifacts = new Artifacts(path.join(root, "objects"))
await fs.mkdir(path.join(root, "initial"))
await Bun.write(path.join(root, "initial/README"), "Scripted recovery fixture, not a benchmark solution.")
await RSIRuntime.run([
  "python3",
  path.join(import.meta.dir, "rsi-files.py"),
  "snapshot",
  path.join(root, "initial"),
  path.join(root, "workspace.tar"),
])
const checkpoint = await artifacts.put(
  new TextEncoder().encode(
    JSON.stringify({
      kind: "native-rsi-task-v1",
      task: "recovery-fixture",
      goal: "Scripted fixture: retain the public reference help probe and finish the original task after an optional comparison fault.",
      image: release.image,
      workspace: await RSIRuntime.ref(path.join(root, "workspace.tar")),
      obligations: [],
      summary: "Initial public task",
    }),
  ),
)
const wire = scopedWire(root, "closure", true)
const injected: number[] = []
const peer = { run: "", container: false }
const grader = graderArg
  ? await (async () => {
      const reference = await RSIRuntime.ref(path.resolve(graderArg))
      const config = await Bun.file(reference.path).json()
      await Bun.write(
        path.join(root, "GRADER.json"),
        JSON.stringify({
          scoringTrust: "official-programbench-normal-use",
          tasks: [
            {
              id: config.instance,
              tests: ["interrupted-comparison"],
              goal: "Scripted grader cancellation fixture",
              image: config.image,
              grader: reference,
            },
          ],
        }),
      )
      return programBench(root, await RSIRuntime.ref(path.join(root, "GRADER.json")))
    })()
  : undefined
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = await request.text()
    if (body.includes("RSI_RECOVERY_FAILURE") && !(grader && body.includes(scopedStrategy))) {
      if (grader) {
        const until = Date.now() + 60_000
        while (!peer.container && Date.now() < until) {
          if (peer.run) {
            const grades = await fs.readdir(path.join(peer.run, "grades")).catch(() => [])
            for (const name of grades) {
              const control = Bun.file(path.join(peer.run, "grades", name, "control.json"))
              if (!(await control.exists())) continue
              const data = await control.json()
              peer.container = !!(
                await RSIRuntime.run(["docker", "ps", "-q", "--filter", `label=opencode.rsi-grade=${data.token}`])
              ).trim()
            }
          }
          if (!peer.container) await Bun.sleep(50)
        }
        if (!peer.container) return new Response("scripted peer grader did not start", { status: 400 })
      }
      injected.push(Date.now())
      return new Response(
        "data: " +
          JSON.stringify({
            error: {
              message:
                mode === "unknown"
                  ? "unclassified fault"
                  : "litellm.APIError: Our servers are currently overloaded. Please try again later.",
              type: null,
              code: "500",
            },
          }) +
          "\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      )
    }
    return fetch(wire.url + "/responses", { method: "POST", headers: { "Content-Type": "application/json" }, body })
  },
})
const adapter = RSITask.continuation(root, async () => ({ passed: 1, total: 1, valid: true }), {
  partial: "blocked",
  scoreBlocked: true,
})
const reports: { outcome: string; checkpoint: string; previous: string; deadline: number; allowRevise?: boolean }[] = []
const driver = nativeDriver({
  root,
  provider: {
    gateway: await RSIRuntime.ref(path.resolve(gatewayArg)),
    model: "gpt-5.6-luna",
    effort: "max",
    upstream: `http://127.0.0.1:${proxy.port}/v1`,
    key: "scripted-no-secret",
    fixture: true,
  },
  authority: [
    await RSIRuntime.ref(import.meta.path),
    await RSIRuntime.ref(path.join(import.meta.dir, "rsi-scoped-wire.ts")),
    ...(grader?.authority ?? []),
  ],
  task: async (_test, task) => {
    if (!task) throw new Error("fixture comparison lost its original checkpoint")
    const value = await RSITask.task(root, task)
    return { ...value, goal: value.goal + "\nRSI_RECOVERY_FAILURE" }
  },
  grade: async (input) => {
    if (!grader) throw new Error("unavailable solver must not produce an evaluation score")
    peer.run = input.run
    return grader.grade(input)
  },
  recovery: async (input) => {
    await Bun.write(
      path.join(root, "GUARD.json"),
      JSON.stringify({
        mode,
        job: input.job.id,
        interruptions: input.interruptions.map((error) => ({ kind: error.kind, receipt: error.receipt })),
      }),
    )
    if (mode === "guard-denied" || (await Bun.file(path.join(root, "CANCEL")).exists()))
      throw new Error("scripted shared outage guard denied recovery")
  },
  continuation: {
    task: adapter.task,
    settle: async (input) => {
      const report = await adapter.settle(input)
      reports.push({ ...report, deadline: input.deadline, allowRevise: input.job.allowRevise })
      return report
    },
  },
})
const started = Date.now()
const seed = {
  s: await artifacts.put(new TextEncoder().encode("Scripted qualification policy.")),
  h: await artifacts.put(new TextEncoder().encode(JSON.stringify(release))),
}
const ota = new OTA(
  path.join(root, "ota.sqlite"),
  {
    trusted: await driver.fingerprint(),
    evidence: "bound-v1",
    scope: "mechanics",
    performanceRule: "task-pareto",
    firstChange: "s",
    expansion: { width: 1 },
    deployment: {
      kind: "task",
      task: "recovery-fixture",
      started,
      deadline: started + SIX_HOURS,
      checkpoint,
      revisions: 1,
      recovery: "provider-unavailable",
    },
    tests: [{ id: "interrupted-comparison", total: 1 }],
    startupMs: 120_000,
    heartbeatMs: 120_000,
    probationMs: 60_000,
    evaluationConcurrency: grader ? 2 : 1,
  },
  seed,
)
const timer = setTimeout(() => {
  void Bun.write(path.join(root, "CANCEL"), "engineering qualification timeout")
}, 600_000)
try {
  const state = await supervise(root, ota, artifacts, driver)
  const workers = await fs.readdir(path.join(root, "native"))
  const fenced = await Promise.all(
    workers.map((worker) => Bun.file(path.join(root, "native", worker, "FENCED.json")).exists()),
  )
  const events = ota.history().map((event) => JSON.stringify(event))
  const recovered = mode === "provider" || mode === "peer-grader"
  const qualified =
    subject(state.active.pair) === subject(seed) &&
    state.task?.revisions === 0 &&
    !events.some((event) => event.includes('"type":"qualification"')) &&
    !events.some((event) => event.includes('"type":"preparation-rejected"')) &&
    injected.length === 1 &&
    fenced.every(Boolean) &&
    reports.length === (recovered ? 2 : 1) &&
    (!grader || peer.container) &&
    (recovered
      ? state.stopped === "task delivered" &&
        !!state.task.adaptationClosed &&
        reports[1].previous === reports[0].checkpoint &&
        reports[1].allowRevise === false &&
        reports.every((report) => report.deadline === started + SIX_HOURS)
      : state.stopped !== "task delivered" && !state.task?.adaptationClosed)
  await Bun.write(
    path.join(root, "RESULT.json"),
    JSON.stringify(
      {
        qualified,
        mode,
        source: release.source.sha256,
        state,
        reports,
        workers,
        fenced,
        injected,
        peer,
        scriptedRequests: wire.records.length,
        benchmarkPerformance: false,
      },
      null,
      2,
    ),
  )
  if (!qualified) throw new Error(`recovery qualification failed: ${state.stopped}; inspect ${root}`)
  process.stdout.write(
    JSON.stringify({ qualified, mode, stopped: state.stopped, workers: workers.length, root }) + "\n",
  )
} finally {
  clearTimeout(timer)
  proxy.stop(true)
  wire.server.stop(true)
  ota.db.close()
}
