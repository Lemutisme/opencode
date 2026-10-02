// Real native task-local RSI qualification using scripted model responses.
// This intentionally wraps the public reference executable. It is NOT a
// ProgramBench solution, a performance experiment, or hostile-H qualification.
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { hash, OTA, SIX_HOURS, subject } from "../../core/script/ota-rsi"
import type { Pair, Protocol } from "../../core/script/ota-rsi"
import { Artifacts, supervise } from "../../core/script/ota-supervisor"
import type { Continuation, Driver } from "../../core/script/ota-supervisor"
import { ContractDelivery } from "./contract-delivery"
import { nativeDriver } from "./rsi-driver"
import type { NativeConfiguration, NativeObservation } from "./rsi-driver"
import { RSIRuntime } from "./rsi-runtime"
import { RSITask } from "./rsi-task"
import { scopedProbe, scopedStrategy, scopedWire } from "./rsi-scoped-wire"

const Marker = Schema.Struct({
  kind: Schema.Literal("scripted-mechanics-only"),
  revision: Schema.Int,
  strategy: Schema.Boolean,
})
const Handoff = Schema.Struct({
  kind: Schema.Literal("programbench-handoff"),
  result: Schema.Struct({ state: Schema.Literals(["ready", "revise", "blocked"]) }),
  obligations: Schema.Array(ContractDelivery.Obligation),
})

async function main() {
  const [rootArg, releaseArg, gatewayArg, image, mode = "delivery", extra] = process.argv.slice(2)
  if (
    !rootArg ||
    !releaseArg ||
    !gatewayArg ||
    !/^sha256:[a-f0-9]{64}$/.test(image ?? "") ||
    !["closure", "delivery"].includes(mode) ||
    extra
  )
    throw new Error(
      "usage: bun script/rsi-scoped-qualify.ts NEW_ROOT FIXTURE_RELEASE GATEWAY PINNED_TASK_IMAGE [delivery|closure]",
    )
  const root = path.resolve(rootArg)
  const taskID = `scripted-same-original-task-${mode}`
  const disk = await fs.statfs(path.dirname(root))
  if (disk.bavail * disk.bsize < 64 * 1024 ** 3) throw new Error("disk infrastructure reserve reached")
  // Requires CURRENT native source with an explicit fixture-only import of
  // rsi-fixture-logic.ts and RSI_FIXTURE_REVISION=${revision} in the user prompt.
  // Never patch an old frozen release in place to satisfy this requirement.
  const release = await RSIRuntime.release(path.resolve(releaseArg))
  const gateway = await RSIRuntime.ref(path.resolve(gatewayArg))
  await fs.mkdir(root, { mode: 0o700 })
  const artifacts = new Artifacts(path.join(root, "objects"))
  const put = (value: unknown) => artifacts.put(new TextEncoder().encode(JSON.stringify(value)))
  const directory = path.join(root, "initial-public-workspace")
  await fs.mkdir(directory)
  await Bun.write(
    path.join(directory, "README"),
    "Scripted mechanics fixture: public reference wrapping is allowed, not a benchmark solution.\n",
  )
  await RSIRuntime.run([
    "python3",
    path.join(import.meta.dir, "rsi-files.py"),
    "snapshot",
    directory,
    path.join(root, "initial-workspace.tar"),
  ])
  const checkpoint = await put({
    kind: "native-rsi-task-v1",
    task: taskID,
    goal: "RSI_SCOPED_TASK: qualify public checkpoint continuity and actual S/H succession. This fixture may wrap the public reference; no task-solving claim is permitted.",
    image,
    workspace: await RSIRuntime.ref(path.join(root, "initial-workspace.tar")),
    obligations: [],
    summary: "Initial public task checkpoint, before any runtime revision.",
  } satisfies RSITask.Checkpoint)
  const fixture = scopedWire(root, mode === "closure" ? "closure" : "delivery")
  // This is a fixture expectation table, not deployment authority. A real run
  // must separately emit matching version/strategy bytes and public probe logs.
  const versions = new Map([[release.source.sha256, 0]])
  const observations: {
    continuations: { pair: Pair; marker: typeof Marker.Type; deadline: number; report: Continuation }[]
    evaluations: { run: string; marker: typeof Marker.Type; test: string; passed: number }[]
  } = { continuations: [], evaluations: [] }
  const inspect = async (input: NativeObservation, expected: "ready" | "revise") => {
    input.signal.throwIfAborted()
    if (Date.now() >= input.deadline) throw new Error("late fixture observation")
    await boundedText(path.join(input.run, "FENCED.json"))
    const execution: { release: RSIRuntime.Release; strategy: RSIRuntime.File; deadline: number; mode: string } =
      JSON.parse(await boundedText(path.join(input.run, "EXECUTION.json")))
    if (
      JSON.stringify(execution.release) !== JSON.stringify(input.release) ||
      execution.deadline !== input.deadline ||
      execution.mode !== "programbench"
    )
      throw new Error("fixture grade is not bound to the actual native execution")
    const marker = Schema.decodeUnknownSync(Schema.fromJsonString(Marker))(
      await boundedText(path.join(input.run, "candidate/workspace/rsi-fixture-public.json")),
    )
    if (
      marker.revision !== versions.get(input.release.source.sha256) ||
      marker.strategy !== (await Bun.file(await RSIRuntime.checked(execution.strategy)).text()).includes(scopedStrategy)
    )
      throw new Error("actual worker behavior does not match the selected H/S")
    const handoff = Schema.decodeUnknownSync(Schema.fromJsonString(Handoff))(new TextDecoder().decode(input.artifact))
    if (
      handoff.result.state !== expected ||
      handoff.obligations.length !== 1 ||
      JSON.stringify(handoff.obligations[0].probe) !== JSON.stringify(scopedProbe)
    )
      throw new Error("missing actual public delivery/revision handoff")
    const journal = (await boundedText(path.join(input.state, "delivery/delivery.jsonl")))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; matches?: boolean; id?: string })
    if (
      !journal.some(
        (entry) => entry.type === "check" && entry.matches === true && entry.id === hash(JSON.stringify(scopedProbe)),
      ) ||
      journal.some((entry) => entry.type === "check" && entry.matches !== true) ||
      (expected === "ready" && !journal.some((entry) => entry.type === "handoff"))
    )
      throw new Error("public reference observation or retained replay did not actually succeed")
    return marker
  }
  const continuation = RSITask.continuation(root, async (input) => {
    const marker = await inspect(input, "ready")
    if (mode !== "delivery" || marker.revision !== 1 || !marker.strategy)
      throw new Error("only the final scripted successor may request task delivery")
    return { passed: 1, total: 1, valid: true }
  })
  const config: NativeConfiguration = {
    root,
    provider: {
      gateway,
      model: "gpt-5.6-luna",
      effort: "max",
      upstream: fixture.url,
      key: "scripted-no-secret",
      fixture: true,
    },
    authority: [
      await RSIRuntime.ref(import.meta.path),
      await RSIRuntime.ref(path.join(import.meta.dir, "rsi-scoped-wire.ts")),
    ],
    task: async (_test, task) => {
      if (!task) throw new Error("scoped qualification must evaluate from the live task checkpoint")
      return RSITask.task(root, task)
    },
    grade: async (input) => {
      const marker = await inspect(input, "ready")
      const passed = input.test.id === "safety" ? 1 : marker.revision + Number(marker.strategy)
      if (passed > input.test.total) throw new Error("unexpected fixture generation was evaluated")
      observations.evaluations.push({ run: input.run, marker, test: input.test.id, passed })
      return { passed, total: input.test.total, valid: true }
    },
    continuation: {
      task: continuation.task,
      settle: async (input) => {
        const deliver =
          mode === "delivery" &&
          versions.get(input.release.source.sha256) === 1 &&
          (await Bun.file(input.job.pair.s).text()).includes(scopedStrategy)
        const marker = await inspect(input, deliver ? "ready" : "revise")
        const report = await continuation.settle(input)
        const sealed = await RSITask.load(root, report.checkpoint)
        if (sealed.parent !== report.previous || sealed.task !== input.job.task?.id || sealed.obligations.length !== 1)
          throw new Error("sealed task checkpoint lost its identity or inherited public obligation")
        observations.continuations.push({
          pair: {
            s: (await RSIRuntime.ref(input.job.pair.s)).sha256,
            h: (await RSIRuntime.ref(input.job.pair.h)).sha256,
          },
          marker,
          deadline: input.deadline,
          report,
        })
        return report
      },
    },
  }
  const native = nativeDriver(config)
  const driver: Driver = {
    ...native,
    prepare: async (input) => {
      const result = await native.prepare!(input)
      if (input.job.mutable === "h" && result instanceof Uint8Array) {
        const parent = await RSIRuntime.release((input.job.source?.pair ?? input.job.pair).h)
        const current = versions.get(parent.source.sha256)
        if (current === undefined) throw new Error("unrecognized fixture source parent")
        const next = Schema.decodeUnknownSync(Schema.fromJsonString(RSIRuntime.Release))(
          new TextDecoder().decode(result),
        )
        versions.set(next.source.sha256, current + 1)
      }
      return result
    },
  }
  const started = Date.now()
  const protocol: Protocol = {
    trusted: await driver.fingerprint(),
    scope: "mechanics",
    performanceRule: "task-pareto",
    expansion: { width: 1 },
    completion: { selections: 2, successorHandoff: true, stopOnRejection: true },
    deployment: {
      kind: "task",
      task: taskID,
      started,
      deadline: started + SIX_HOURS,
      checkpoint,
    },
    tests: [
      { id: "safety", total: 1 },
      ...(["development", "confirmation"] as const).flatMap((panel) =>
        ["1", "2"].map((replicate) => ({
          id: `${panel}-${replicate}`,
          total: 2,
          performance: { panel, task: taskID, replicate },
        })),
      ),
    ],
    startupMs: 120000,
    heartbeatMs: 120000,
    probationMs: 60000,
    evaluationConcurrency: 1,
  }
  const seed = {
    s: await artifacts.put(
      new TextEncoder().encode("Use native tools and preserve public task obligations. Scripted mechanics only."),
    ),
    h: await put(release),
  }
  const ota = new OTA(path.join(root, "ota.sqlite"), protocol, seed)
  await Bun.write(
    path.join(root, "PROTOCOL.json"),
    JSON.stringify(
      {
        scope: "scripted-mechanics-only",
        mode,
        realModelCalls: 0,
        benchmarkPerformanceClaim: false,
        protocol,
        seed,
        release,
      },
      null,
      2,
    ),
  )
  const cancel = () => {
    void Bun.write(path.join(root, "CANCEL"), "explicit host signal; qualification interrupted")
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, cancel)
  const outcome = { qualified: false, error: undefined as string | undefined, fence: false }
  try {
    const state = await supervise(root, ota, artifacts, driver)
    const selections = state.lineage?.filter((node) => node.outcome === "selected") ?? []
    const runs = observations.continuations
    const completion: { data: { completed: boolean; details: { prepared: string } } } = await Bun.file(
      path.join(root, "receipts/completion.json"),
    ).json()
    if (
      state.stopped !== (mode === "closure" ? "recursive closure completed" : "task delivered") ||
      state.trial ||
      state.quarantine.length ||
      selections.length !== 2 ||
      state.lineage?.length !== 2 ||
      completion.data.completed !== (mode === "closure")
    )
      throw new Error("two selections and the frozen delivery/closure terminal condition were not reached")
    if (
      runs.length !== 3 ||
      JSON.stringify(runs.map((run) => [run.marker.revision, run.marker.strategy])) !==
        JSON.stringify([
          [0, false],
          [1, false],
          [1, true],
        ]) ||
      runs.some(
        (run, index) =>
          subject(run.pair) !== subject(index ? selections[index - 1].pair : seed) ||
          run.deadline !== protocol.deployment!.deadline ||
          run.report.previous !== (index ? runs[index - 1].report.checkpoint : checkpoint),
      )
    )
      throw new Error("selected H and S did not really continue the same original checkpoint lineage")
    const continued = ota.history().filter((entry) => (entry as { type: string }).type === "task-continuation")
    if (
      continued.length !== 3 ||
      state.task?.checkpoint !== runs[2].report.checkpoint ||
      state.task.status !== (mode === "closure" ? "blocked" : "delivered") ||
      state.kernel.contracts[state.task.contractID].status !== (mode === "closure" ? "escalated" : "discharged") ||
      !!state.kernel.contracts[state.task.contractID].attestationID !== (mode === "delivery")
    )
      throw new Error("recursive mechanics closure was confused with original task delivery")
    if (observations.evaluations.length !== 20 || observations.evaluations.some((entry) => entry.marker.revision > 1))
      throw new Error("unexpected third candidate performance comparison")
    const h2 = fixture.records.filter((entry) => entry.mode === "h" && entry.revision === 1 && entry.strategy)
    if (mode === "closure") {
      const finalProposal = await RSIRuntime.release(await artifacts.get(completion.data.details.prepared))
      if (versions.get(finalProposal.source.sha256) !== 2 || !h2.some((entry) => entry.step === 2))
        throw new Error("H2 was not really proposed and prepared before stopping")
    }
    if (mode === "delivery") {
      const task = state.kernel.contracts[state.task!.contractID]
      const attestation = state.kernel.attestations[task.attestationID!]
      if (
        h2.length ||
        attestation.subjectHash !== runs[2].report.checkpoint ||
        attestation.evidenceHash !== runs[2].report.receipt
      )
        throw new Error("task delivery lacks the exact final checkpoint attestation or ran an unrequested H2")
    }
    outcome.qualified = true
  } catch (error) {
    outcome.error = String(error)
  } finally {
    await driver.fence().then(
      () => {
        outcome.fence = true
      },
      (error) => {
        outcome.error = String(error)
      },
    )
    outcome.qualified &&= outcome.fence
    await Bun.write(
      path.join(root, "RESULT.json"),
      JSON.stringify(
        {
          ...outcome,
          mode,
          scope: "scripted-mechanics-only",
          realModelCalls: 0,
          benchmarkPerformanceClaim: false,
          taskReferenceWrapper: true,
          state: ota.read(),
          history: ota.history(),
          observations,
          wire: fixture.records,
        },
        null,
        2,
      ),
    )
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, cancel)
    fixture.server.stop(true)
    ota.db.close()
  }
  console.log(JSON.stringify({ ...outcome, mode, scope: "scripted-mechanics-only", realModelCalls: 0, root }))
  process.exitCode = outcome.qualified ? 0 : 1
}

async function boundedText(file: string) {
  const info = await fs.lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0 || info.size > 4 * 1024 * 1024)
    throw new Error("fixture observation must be a bounded regular file")
  return Bun.file(file).text()
}

if (import.meta.main) await main()
