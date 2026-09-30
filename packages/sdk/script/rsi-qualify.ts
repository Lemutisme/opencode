// Real native V2/container qualification with a scripted provider. No model calls.
import fs from "node:fs/promises"
import path from "node:path"
import { OTA, hash } from "../../core/script/ota-rsi"
import type { Protocol } from "../../core/script/ota-rsi"
import { Artifacts, supervise } from "../../core/script/ota-supervisor"
import { nativeDriver } from "./rsi-driver"
import { RSIRuntime } from "./rsi-runtime"
import { wireFixture } from "./rsi-wire-fixture"

const [rootArg, releaseArg, gatewayArg, widthArg, mode, warmupArg] = process.argv.slice(2)
if (!rootArg || !releaseArg || !gatewayArg)
  throw new Error("usage: bun rsi-qualify.ts NEW_ROOT RELEASE GATEWAY [WIDTH]")
const root = path.resolve(rootArg)
await fs.mkdir(root, { mode: 0o700 })
const release = await RSIRuntime.release(path.resolve(releaseArg))
const fixture = wireFixture(root, Number(warmupArg ?? 0))
const driver = nativeDriver({
  root,
  provider: {
    gateway: await RSIRuntime.ref(path.resolve(gatewayArg)),
    model: "gpt-5.6-luna",
    effort: "max",
    upstream: fixture.url,
    key: "scripted-no-secret",
    fixture: true,
  },
  authority: [
    await RSIRuntime.ref(import.meta.path),
    await RSIRuntime.ref(path.join(import.meta.dir, "rsi-wire-fixture.ts")),
  ],
  task: () => ({ goal: "RSI_FIXTURE_EVAL: submit the observable revision answer.", artifact: "answer" }),
  grade: async (input) => {
    const actual = new TextDecoder().decode(input.artifact)
    const version = actual.match(/^revision:(\d+)$/)?.[1]
    return { passed: version !== undefined && Number(version) % 2 === 0 ? 1 : 0, total: 1, valid: true }
  },
})
const protocol: Protocol = {
  trusted: await driver.fingerprint(),
  scope: "mechanics",
  performanceRule: "task-pareto",
  expansion: { width: Number(widthArg ?? 1) },
  tests: [{ id: "fixture-behavior", total: 1 }],
  startupMs: 120000,
  heartbeatMs: 120000,
  probationMs: 60000,
}
const artifacts = new Artifacts(path.join(root, "objects"))
const seed = {
  s: await artifacts.put(new TextEncoder().encode("Use the native tools; hand off only the requested artifact.")),
  h: await artifacts.put(new TextEncoder().encode(JSON.stringify(release))),
}
const ota = new OTA(path.join(root, "ota.sqlite"), protocol, seed)
await Bun.write(
  path.join(root, "PROTOCOL.json"),
  JSON.stringify({ protocol, seed, release, scope: "mechanics-only", modelCalls: false }, null, 2),
)
const timer = setInterval(() => {
  if (
    ota.read().epoch >= 3 &&
    (mode === "rollback" ||
      fixture.records.some(
        (record) => record.mode === "h" && record.revision === 2 && record.successorStrategy && record.step >= 2,
      ))
  )
    void Bun.write(path.join(root, "CANCEL"), "qualified successor execution")
}, 25)
const timeout = setTimeout(() => {
  void Bun.write(path.join(root, "CANCEL"), "qualification infrastructure timeout")
}, 600000)
try {
  const state = await supervise(root, ota, artifacts, driver)
  const events = ota.history()
  const observed = {
    scope: "mechanics-only",
    modelCalls: false,
    width: protocol.expansion!.width,
    state,
    wire: fixture.records,
    events,
  }
  await Bun.write(path.join(root, "RESULT.json"), JSON.stringify(observed, null, 2))
  if (Number(warmupArg ?? 0) && !fixture.records.some((record) => record.step >= Number(warmupArg)))
    throw new Error("did not cross the requested fixture step boundary")
  if (state.epoch !== 3 || state.stopped !== "cancelled")
    throw new Error("qualification did not reach its frozen terminal condition")
  const rejected = state.lineage?.filter((node) => node.outcome === "rejected") ?? []
  if (rejected.length !== protocol.expansion!.width)
    throw new Error("expected rejected source children were not retained")
  if (protocol.expansion!.width > 1 && new Set(rejected.map((node) => node.parent)).size !== 1)
    throw new Error("tree did not explore siblings")
  if (mode === "rollback") {
    if (state.active.pair.h !== seed.h || state.active.pair.s !== seed.s || state.quarantine.length !== 1)
      throw new Error("failed H did not roll back to the admitted seed")
    const admissions = await fs.readdir(path.join(root, "receipts"))
    const boot = await Promise.all(
      admissions
        .filter((name) => name.endsWith("-admission.json"))
        .map(async (name) => (await Bun.file(path.join(root, "receipts", name)).json()).data),
    )
    const failed = boot.find((value) => value.epoch === 2 && value.mutable)
    if (!failed || state.job?.deadline !== failed.deadline) throw new Error("rollback renewed the original deadline")
    if (
      !events.some(
        (event) => typeof event === "object" && event !== null && "type" in event && event.type === "rollback",
      )
    )
      throw new Error("missing rollback record")
  } else {
    if (
      !fixture.records.some((record) => record.mode === "s" && record.revision === 2) ||
      !fixture.records.some(
        (record) => record.mode === "h" && record.revision === 2 && record.successorStrategy && record.step >= 2,
      ) ||
      state.active.slot !== "s" ||
      state.active.pair.h === seed.h ||
      state.active.pair.s === seed.s ||
      state.quarantine.length ||
      state.lineage?.filter((node) => node.outcome === "selected").length !== 2
    )
      throw new Error("expected two confirmed switches and actual successor execution, not rollback epochs")
  }
  console.log(
    JSON.stringify({
      qualified: true,
      scope: "mechanics-only",
      modelCalls: false,
      mode: mode ?? "healthy",
      width: protocol.expansion!.width,
      epochs: state.epoch,
      rejected: rejected.length,
      requests: fixture.records.length,
    }),
  )
} finally {
  clearInterval(timer)
  clearTimeout(timeout)
  await driver.fence()
  fixture.server.stop(true)
  ota.db.close()
}
