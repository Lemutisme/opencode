import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { hash } from "../../core/script/ota-rsi"
import { RSIRuntime } from "./rsi-runtime"
import { revisionContext, revisionInstructions } from "./rsi-revision"

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-revision-"))
  const write = async (name: string, value: unknown) => {
    const file = path.join(root, name)
    await Bun.write(file, typeof value === "string" ? value : JSON.stringify(value))
    return RSIRuntime.ref(file)
  }
  const supply = await write("supply", "fixture supply")
  const release = {
    kind: "native-v2-release-v1" as const,
    source: supply,
    dependencies: supply,
    bun: supply,
    rg: supply,
    image: "sha256:" + "a".repeat(64),
    entry: "packages/sdk/script/rsi-worker.ts",
  }
  const harness = await write("harness", release)
  const strategy = await write("strategy", "fixed policy")
  const excerpt = await write("public", "Public compile.sh did not recreate the entrypoint.")
  const data = {
    test: { id: "old-d", total: 1, performance: { panel: "development", task: "D", replicate: "2" } },
    pair: { h: harness.path, s: strategy.path },
    deadline: 1000,
  }
  const source = await write("admission", { sha256: hash(JSON.stringify(data)), data })
  const execution = { release, strategy, deadline: 1000, mode: "programbench", scope: { phase: "evaluating" } }
  const input = {
    evidence: [
      {
        kind: "development-run" as const,
        source,
        execution: await write("execution", execution),
        publicFile: "failure",
      },
    ],
    files: { failure: excerpt },
    tests: [
      { id: "d", total: 1, performance: { panel: "development" as const, task: "D", replicate: "1" } },
      { id: "c", total: 1, performance: { panel: "confirmation" as const, task: "C", replicate: "1" } },
    ],
    audit: [{ id: "a", total: 1 }],
    task: (test: { id: string }) => ({
      identity: test.id.toUpperCase(),
      mode: "programbench" as const,
      goal: "task",
      artifact: "submission",
    }),
  }
  return { root, write, release, harness, strategy, data, execution, input }
}

test("revision exposes public excerpts but keeps raw provenance host-only", async () => {
  const f = await fixture()
  try {
    const result = await revisionContext(f.input)
    expect(result.context.observations[0]).toEqual({
      kind: "development-run",
      task: "D",
      publicFile: "/task/failure",
      source: f.input.evidence[0].source.sha256,
    })
    expect(JSON.stringify(result.context)).not.toContain(f.root)
    expect(result.authority.some((ref) => ref.path === f.input.evidence[0].execution.path)).toBe(true)
    const text = revisionInstructions(result.context, f.release.entry)
    expect(text).toContain(f.release.entry)
    expect(text).toContain("not an edit whitelist or proof of effect")
    expect(text).toContain("ties still reject")
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
})

test("revision rejects confirmation/audit aliases and conflicting admission coordinates", async () => {
  const f = await fixture()
  try {
    await expect(revisionContext({ ...f.input, files: {} })).rejects.toThrow("excerpt")
    await expect(
      revisionContext({ ...f.input, task: () => ({ identity: "D", goal: "alias", artifact: "out" }) }),
    ).rejects.toThrow("overlaps")
    for (const data of [
      { ...f.data, test: { ...f.data.test, performance: { ...f.data.test.performance, panel: "confirmation" } } },
      { ...f.data, test: { ...f.data.test, performance: { ...f.data.test.performance, task: "C" } } },
      { ...f.data, deadline: 2000 },
    ]) {
      const source = await f.write("admission", { sha256: hash(JSON.stringify(data)), data })
      await expect(revisionContext({ ...f.input, evidence: [{ ...f.input.evidence[0], source }] })).rejects.toThrow()
    }
    const source = await f.write("admission", { sha256: hash(JSON.stringify(f.data)), data: f.data })
    const execution = await f.write("execution", { ...f.execution, scope: { kind: "audit", phase: "evaluating" } })
    await expect(
      revisionContext({ ...f.input, evidence: [{ ...f.input.evidence[0], source, execution }] }),
    ).rejects.toThrow()
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
})

test("revision rejects tampered receipts and a strategy changed after observation", async () => {
  const f = await fixture()
  try {
    const source = await f.write("admission", { sha256: "a".repeat(64), data: f.data })
    await expect(revisionContext({ ...f.input, evidence: [{ ...f.input.evidence[0], source }] })).rejects.toThrow(
      "receipt changed",
    )
    const restored = await f.write("admission", { sha256: hash(JSON.stringify(f.data)), data: f.data })
    await f.write("strategy", "different policy")
    await expect(
      revisionContext({ ...f.input, evidence: [{ ...f.input.evidence[0], source: restored }] }),
    ).rejects.toThrow("admitted runtime")
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
})

test("proposal-build feedback cannot alone qualify as task experience", async () => {
  const f = await fixture()
  try {
    const log = await f.write("compile.stderr", "variable was already declared")
    const proposal = await f.write("patch", "fixture patch")
    const source = await f.write("rejected", {
      phase: "compile",
      code: 1,
      parent: f.release.source,
      proposal,
      log,
      performanceEvaluated: false,
    })
    const evidence = { kind: "proposal-build" as const, source, publicFile: "failure" }
    await expect(revisionContext({ ...f.input, evidence: [evidence] })).rejects.toThrow("task observation")
    expect(
      (await revisionContext({ ...f.input, evidence: [...f.input.evidence, evidence] })).context.observations[1].kind,
    ).toBe("proposal-build")
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
})

test("completed measurement feedback binds its assignment and new development identity", async () => {
  const f = await fixture()
  try {
    const pair = { h: f.harness.sha256, s: f.strategy.sha256 }
    const profile = await f.write("profile", { harness: f.harness, strategy: f.strategy })
    const report = {
      purpose: "measurement-only",
      complete: true,
      promoted: false,
      recursiveImprovement: false,
      protocol: "protocol",
      pair,
      source: { profile },
      assignments: [
        { id: "assignment", status: "closed", deadline: 1000, test: { task: "D" }, result: { valid: true } },
      ],
    }
    const source = await f.write("report", report)
    const execution = await f.write("execution", {
      ...f.execution,
      scope: { kind: "evaluation", protocol: "protocol", assignment: "assignment", pair, deadline: 1000 },
    })
    const evidence = { kind: "development-measurement" as const, source, execution, publicFile: "failure" }
    expect((await revisionContext({ ...f.input, evidence: [evidence] })).context.observations[0].task).toBe("D")
    const other = await f.write("report", {
      ...report,
      assignments: [{ ...report.assignments[0], test: { task: "C" } }],
    })
    await expect(revisionContext({ ...f.input, evidence: [{ ...evidence, source: other }] })).rejects.toThrow(
      "canonical development",
    )
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
})

test("task-local experience keeps its continuation identity and cannot export task-local authority", async () => {
  const f = await fixture()
  try {
    const task = { id: "D", checkpoint: hash("before task continuation") }
    const data = {
      producer: { id: "original-job", epoch: 2, purpose: "continuation", task, pair: f.data.pair, deadline: 1000 },
      pair: { s: f.strategy.sha256, h: f.harness.sha256 },
      report: {
        previous: task.checkpoint,
        checkpoint: hash("after continuation"),
        receipt: hash("host receipt"),
        outcome: "blocked",
      },
    }
    const execution = await f.write("task-execution", {
      ...f.execution,
      scope: { kind: "ota", phase: "running", purpose: "continuation", job: "original-job", epoch: 2, task },
    })
    const source = await f.write("task-report", { sha256: hash(JSON.stringify(data)), data })
    const evidence = { kind: "development-task" as const, source, execution, publicFile: "failure" }
    const result = await revisionContext({ ...f.input, evidence: [evidence] })
    expect(result.context.observations[0]).toMatchObject({
      kind: "development-task",
      task: "D",
      publicFile: "/task/failure",
    })
    expect(JSON.stringify(result.context)).not.toContain(f.root)
    expect(JSON.stringify(result.context)).not.toContain("original-job")
    for (const changed of [
      { ...data, producer: { ...data.producer, id: "other-job" } },
      { ...data, producer: { ...data.producer, epoch: 3 } },
      { ...data, producer: { ...data.producer, deadline: 2000 } },
      { ...data, producer: { ...data.producer, task: { ...task, id: "C" } } },
      { ...data, pair: { ...data.pair, h: hash("inactive local proposal") } },
      { ...data, report: { ...data.report, previous: hash("other checkpoint") } },
    ]) {
      const source = await f.write("changed-report", { sha256: hash(JSON.stringify(changed)), data: changed })
      await expect(revisionContext({ ...f.input, evidence: [{ ...evidence, source }] })).rejects.toThrow()
    }
    const stale = await f.write("wrong-scope", { ...f.execution, scope: { phase: "evaluating" } })
    await expect(revisionContext({ ...f.input, evidence: [{ ...evidence, execution: stale }] })).rejects.toThrow()
    await expect(
      revisionContext({
        ...f.input,
        evidence: [evidence],
        task: () => ({ identity: "D", goal: "alias", artifact: "out" }),
      }),
    ).rejects.toThrow("overlaps")
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
})
