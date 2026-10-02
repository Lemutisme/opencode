// Qualifies the real standalone measurement CLI and official tau environment
// with scripted solver/user responses. No OTA or fake completed audit ledger.
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { RSIRuntime } from "./rsi-runtime"
import { hash } from "../../core/script/ota-rsi"

const [directory, donorFile, tauFile] = process.argv.slice(2)
if (!directory || !donorFile || !tauFile)
  throw new Error("usage: bun rsi-evaluation-qualify.ts NEW_ROOT FIXED_SEED_PROFILE SCRIPTED_TAU_MANIFEST")
const root = path.resolve(directory)
await fs.mkdir(root, { mode: 0o700 })
const donor = Schema.decodeUnknownSync(
  Schema.Struct({ harness: RSIRuntime.File, strategy: RSIRuntime.File, gateway: RSIRuntime.File }),
)(await Bun.file(donorFile).json())
const fixture = Schema.decodeUnknownSync(Schema.Struct({ scriptedQualification: Schema.Literal(true) }))(
  await Bun.file(tauFile).json(),
)
if (!fixture.scriptedQualification) throw new Error("only scripted mock qualification is allowed")
const wire = Bun.spawn(["python3", "-B", path.join(import.meta.dir, "rsi-tau-wire.py"), path.join(root, "wire")], {
  stdin: "ignore",
  stdout: Bun.file(path.join(root, "wire.stdout")),
  stderr: Bun.file(path.join(root, "wire.stderr")),
})
try {
  const until = Date.now() + 30000
  while (!(await Bun.file(path.join(root, "wire/READY.json")).exists())) {
    if (wire.exitCode !== null || Date.now() >= until) throw new Error("scripted transport unavailable")
    await Bun.sleep(25)
  }
  const endpoint = Schema.decodeUnknownSync(Schema.Struct({ upstream: Schema.String }))(
    await Bun.file(path.join(root, "wire/READY.json")).json(),
  )
  const profile = path.join(root, "PROFILE.json")
  await Bun.write(
    profile,
    JSON.stringify(
      {
        ...donor,
        tau: await RSIRuntime.ref(path.resolve(tauFile)),
        safety: ["containment"],
        authority: [await RSIRuntime.ref(import.meta.path)],
        model: "gpt-5.6-luna",
        effort: "max",
        upstream: endpoint.upstream,
        expansionWidth: 1,
        startupMs: 120000,
        heartbeatMs: 120000,
        probationMs: 60000,
        evaluationConcurrency: 1,
        tests: [
          { id: "containment", total: 1 },
          { id: "fixture", total: 1 },
        ],
      },
      null,
      2,
    ),
  )
  const plan = path.join(root, "PLAN.json")
  await Bun.write(
    plan,
    JSON.stringify(
      {
        kind: "fixed-pair-evaluation-v1",
        purpose: "measurement-only",
        profile: await RSIRuntime.ref(profile),
        pair: {
          s: hash(await Bun.file(donor.strategy.path).bytes()),
          h: hash(await Bun.file(donor.harness.path).bytes()),
        },
        assignments: [{ id: "fixture", total: 1, task: "tau-mock-qualification", replicate: "1" }],
      },
      null,
      2,
    ),
  )
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "rsi-evaluation.ts"), path.join(root, "measurement"), plan],
    {
      stdin: "ignore",
      stdout: Bun.file(path.join(root, "measurement.stdout")),
      stderr: Bun.file(path.join(root, "measurement.stderr")),
      env: { ...process.env, OPENAI_API_KEY: "scripted-no-secret", OPENAI_BASE_URL: endpoint.upstream },
    },
  )
  const timer = setTimeout(() => child.kill("SIGTERM"), 600000)
  const code = await child.exited.finally(() => clearTimeout(timer))
  if (code !== 0) throw new Error(`standalone measurement qualification failed: ${root}/measurement.stderr`)
  const result = Schema.decodeUnknownSync(
    Schema.Struct({
      complete: Schema.Literal(true),
      promoted: Schema.Literal(false),
      assignments: Schema.Array(
        Schema.Struct({
          status: Schema.Literal("closed"),
          result: Schema.Struct({ passed: Schema.Literal(1), total: Schema.Literal(1), valid: Schema.Literal(true) }),
        }),
      ),
      userAccounting: Schema.Array(Schema.Struct({ rows: Schema.Array(Schema.Unknown) })),
    }),
  )(await Bun.file(path.join(root, "measurement/RESULT.json")).json())
  const counts = Schema.decodeUnknownSync(Schema.Struct({ solver: Schema.Literal(3), user: Schema.Literal(3) }))(
    await Bun.file(path.join(root, "wire/COUNTS.json")).json(),
  )
  if (
    result.assignments.length !== 1 ||
    result.userAccounting.length !== 1 ||
    result.userAccounting[0].rows.length !== 3
  )
    throw new Error("measurement role accounting or assignment count differs")
  if (
    (await Bun.file(path.join(root, "measurement/ota.sqlite")).exists()) ||
    (await Bun.file(path.join(root, "measurement/audit.sqlite")).exists())
  )
    throw new Error("measurement borrowed the wrong authority ledger")
  const [run] = await fs.readdir(path.join(root, "measurement/native"))
  const execution = Schema.decodeUnknownSync(
    Schema.Struct({ scope: Schema.Struct({ kind: Schema.Literal("evaluation") }) }),
  )(await Bun.file(path.join(root, "measurement/native", run, "EXECUTION.json")).json())
  await Bun.write(
    path.join(root, "RESULT.json"),
    JSON.stringify(
      {
        qualified: true,
        scope: "engineering-only",
        realModelCalls: 0,
        counts,
        execution,
        officialGrade: result.assignments[0].result,
        completeAccountingRoles: ["solver", "user"],
        isolatedMeasurementAuthority: true,
      },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify({ qualified: true, realModelCalls: 0, counts, officialGrade: result.assignments[0].result }),
  )
} finally {
  wire.kill("SIGTERM")
  await wire.exited
}
