// Actual native SDK/container + official tau business/user/grader transports.
// Both solver and user responses are scripted. No real models or RSI gains.
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { OTA, hash } from "../../core/script/ota-rsi"
import type { Protocol } from "../../core/script/ota-rsi"
import { Artifacts } from "../../core/script/ota-supervisor"
import { evaluateNative } from "./rsi-driver"
import { RSIRuntime } from "./rsi-runtime"
import { tauBench } from "./rsi-tau"

const [directory, releaseFile, gatewayFile, manifestFile, testID = "fixture"] = process.argv.slice(2)
if (!directory || !releaseFile || !gatewayFile || !manifestFile)
  throw new Error("usage: bun script/rsi-tau-qualify.ts NEW_ROOT RELEASE GATEWAY SCRIPTED_MANIFEST [TEST]")
const root = path.resolve(directory)
await fs.mkdir(root, { mode: 0o700 })
const manifest = Schema.decodeUnknownSync(Schema.Struct({ scriptedQualification: Schema.Literal(true) }))(
  await Bun.file(manifestFile).json(),
)
if (!manifest.scriptedQualification) throw new Error("only scripted qualification is allowed")
const wire = Bun.spawn(["python3", "-B", path.join(import.meta.dir, "rsi-tau-wire.py"), path.join(root, "wire")], {
  stdin: "ignore",
  stdout: Bun.file(path.join(root, "wire.stdout")),
  stderr: Bun.file(path.join(root, "wire.stderr")),
})
const ready = path.join(root, "wire/READY.json")
const until = Date.now() + 30000
while (!(await Bun.file(ready).exists())) {
  if (wire.exitCode !== null || Date.now() >= until) {
    wire.kill("SIGTERM")
    throw new Error("scripted wire unavailable")
  }
  await Bun.sleep(25)
}
const fixture = Schema.decodeUnknownSync(Schema.Struct({ upstream: Schema.String, fixture: Schema.Literal(true) }))(
  await Bun.file(ready).json(),
)
process.env.OPENAI_BASE_URL = fixture.upstream
process.env.OPENAI_API_KEY = "scripted-no-secret"
const release = await RSIRuntime.release(path.resolve(releaseFile))
const benchmark = await tauBench(root, await RSIRuntime.ref(path.resolve(manifestFile)))
const artifacts = new Artifacts(path.join(root, "objects"))
const seed = {
  s: await artifacts.put(new TextEncoder().encode("Use official benchmark tools and follow domain policy.")),
  h: await artifacts.put(new TextEncoder().encode(JSON.stringify(release))),
}
const test = { id: testID, total: 1 }
const protocol: Protocol = {
  trusted: hash("native-tau-scripted-qualification-not-performance"),
  scope: "mechanics",
  performanceRule: "task-pareto",
  tests: [test],
  startupMs: 120000,
  heartbeatMs: 120000,
  probationMs: 60000,
}
const ota = new OTA(path.join(root, "ota.sqlite"), protocol, seed)
ota.begin(0, Date.now())
const admission = ota.read()
if (!admission.job) throw new Error("missing fixture admission")
try {
  const score = await evaluateNative(
    {
      root,
      ...benchmark,
      provider: {
        gateway: await RSIRuntime.ref(path.resolve(gatewayFile)),
        model: "gpt-5.6-luna",
        effort: "max",
        upstream: fixture.upstream,
        key: "scripted-no-secret",
        fixture: true,
      },
    },
    {
      pair: { s: await artifacts.get(seed.s), h: await artifacts.get(seed.h) },
      test,
      deadline: admission.job.deadline,
      signal: AbortSignal.timeout(600000),
    },
    {
      database: path.join(root, "ota.sqlite"),
      protocol: admission.protocol,
      epoch: admission.epoch,
      job: admission.job.id,
      phase: "running",
      incumbent: admission.active.pair,
    },
  )
  const runs = await fs.readdir(path.join(root, "native"))
  const counts = Schema.decodeUnknownSync(Schema.Struct({ solver: Schema.Int, user: Schema.Int }))(
    await Bun.file(path.join(root, "wire/COUNTS.json")).json(),
  )
  if (
    runs.length !== 1 ||
    !score.valid ||
    score.passed !== 1 ||
    score.total !== 1 ||
    counts.solver !== 3 ||
    counts.user !== 3
  )
    throw new Error("native tau official business/termination qualification failed")
  const run = path.join(root, "native", runs[0])
  const execution = Schema.decodeUnknownSync(
    Schema.Struct({ mode: Schema.Literal("tau"), release: RSIRuntime.Release }),
  )(await Bun.file(path.join(run, "EXECUTION.json")).json())
  if (execution.release.source.sha256 !== release.source.sha256) throw new Error("supplied H did not execute")
  const terminal = Schema.decodeUnknownSync(
    Schema.Struct({ at: Schema.Number, source: Schema.Literal("official-tau-terminal") }),
  )(await Bun.file(path.join(run, "control/provider-ended")).json())
  const db = new Database(path.join(run, "control/requests.db"), { readonly: true })
  try {
    if (
      db.query<{ count: number }, [number]>("SELECT count(*) AS count FROM request WHERE started > ?").get(terminal.at)!
        .count !== 0
    )
      throw new Error("provider admitted after official USER_STOP")
  } finally {
    db.close()
  }
  const second = Schema.decodeUnknownSync(
    Schema.Struct({ input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
  )(await Bun.file(path.join(root, "wire/solver-1.json")).json())
  if (
    !second.input.some(
      (message) => message.role === "user" && JSON.stringify(message).includes("Yes, please create it."),
    )
  )
    throw new Error("official customer response was not admitted as a durable user prompt")
  await Bun.write(
    path.join(root, "RESULT.json"),
    JSON.stringify(
      {
        qualified: true,
        scope: "engineering-only",
        realModelCalls: 0,
        counts,
        score,
        release,
        terminal,
        noPostTerminalProviderAdmission: true,
        durableCustomerPrompt: true,
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ qualified: true, score, counts, realModelCalls: 0 }))
} finally {
  await benchmark.dispose()
  wire.kill("SIGTERM")
  await wire.exited
  ota.db.close()
}
