import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { programBench } from "./rsi-programbench"
import { RSIRuntime } from "./rsi-runtime"
import { Artifacts, evaluationWorkers } from "../../core/script/ota-supervisor"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture(change: Record<string, unknown> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-programbench-"))
  roots.push(root)
  const image = "sha256:" + "a".repeat(64)
  await Bun.write(path.join(root, "grader.json"), JSON.stringify({ instance: "public-task", image }))
  const grader = await RSIRuntime.ref(path.join(root, "grader.json"))
  await Bun.write(
    path.join(root, "manifest.json"),
    JSON.stringify({
      scoringTrust: "official-programbench-normal-use",
      safety: ["containment"],
      tasks: [
        {
          id: "public-task",
          tests: ["development-1", "development-2"],
          goal: "Implement the public program",
          image,
          grader,
        },
      ],
      ...change,
    }),
  )
  return { root, grader, image, reference: await RSIRuntime.ref(path.join(root, "manifest.json")) }
}

test("ProgramBench exposes exact dataset identity and does not enable private task feedback by default", async () => {
  const f = await fixture()
  const adapter = await programBench(f.root, f.reference)
  expect(await adapter.task({ id: "development-1", total: 10 })).toMatchObject({
    identity: "public-task",
    mode: "programbench",
    image: f.image,
  })
  expect(await adapter.task({ id: "containment", total: 1 })).toMatchObject({
    identity: "@native/containment",
    artifact: "safety",
  })
  expect(adapter.continuation).toBeUndefined()
  await expect(adapter.task({ id: "unassigned", total: 10 })).rejects.toThrow("unassigned")
  await expect(adapter.task({ id: "containment", total: 2 })).rejects.toThrow("one fixed obligation")
})

test("task-local qualification feedback requires explicit frozen opt-in", async () => {
  const f = await fixture({ taskFeedback: "qualification-outcomes" })
  const adapter = await programBench(f.root, f.reference)
  expect(adapter.continuation).toBeDefined()
})

test("continuation and evaluation reject a checkpoint that changes the frozen task goal", async () => {
  const f = await fixture({ taskFeedback: "qualification-outcomes" })
  const adapter = await programBench(f.root, f.reference)
  const checkpoint = await new Artifacts(path.join(f.root, "objects")).put(
    new TextEncoder().encode(
      JSON.stringify({
        kind: "native-rsi-task-v1",
        task: "public-task",
        goal: "Substituted problem",
        image: f.image,
        workspace: f.grader,
        obligations: [],
        summary: "public context",
      }),
    ),
  )
  const task = { id: "public-task", checkpoint }
  await expect(adapter.task({ id: "development-1", total: 10 }, task)).rejects.toThrow("frozen problem")
  await expect(
    adapter.continuation!.task({
      id: "job",
      epoch: 1,
      slot: "s",
      mutable: "h",
      deadline: Date.now() + 10000,
      pair: { s: "seed-s", h: "seed-h" },
      output: f.root,
      memory: { id: "e1" },
      purpose: "continuation",
      task,
    }),
  ).rejects.toThrow("frozen problem")
})

test("operator must acknowledge official normal-use grading and cannot alias a safety assignment", async () => {
  const missing = await fixture({ scoringTrust: undefined })
  await expect(programBench(missing.root, missing.reference)).rejects.toThrow()
  const aliased = await fixture({ safety: ["development-1"] })
  await expect(programBench(aliased.root, aliased.reference)).rejects.toThrow("unique")
})

test("mismatched task and official grader identities fail before any model execution", async () => {
  const f = await fixture()
  await Bun.write(f.grader.path, JSON.stringify({ instance: "another-task", image: f.image }))
  await expect(programBench(f.root, f.reference)).rejects.toThrow("changed")
})

test("safety is independently bound to host containment and fencing, not the worker assertion alone", async () => {
  const f = await fixture()
  const adapter = await programBench(f.root, f.reference)
  const input = {
    test: { id: "containment", total: 1 },
    artifact: new TextEncoder().encode("native-rsi-safety-v1"),
    run: f.root,
    state: path.join(f.root, "state"),
    deadline: Date.now() + 10000,
    signal: new AbortController().signal,
    release: {
      kind: "native-v2-release-v1" as const,
      source: f.grader,
      dependencies: f.grader,
      bun: f.grader,
      rg: f.grader,
      image: f.image,
      entry: "worker.ts",
    },
  }
  await expect(adapter.grade(input)).rejects.toThrow()
  await Bun.write(
    path.join(f.root, "CONTAINMENT.json"),
    JSON.stringify({ NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"] }),
  )
  await expect(adapter.grade(input)).rejects.toThrow("acknowledgement")
  await Bun.write(path.join(f.root, "FENCED.json"), "{}")
  expect(await adapter.grade(input)).toMatchObject({ passed: 1, total: 1, valid: true })
  expect(await adapter.grade({ ...input, artifact: new TextEncoder().encode("self-certified") })).toMatchObject({
    passed: 0,
    valid: true,
  })
  await expect(adapter.grade({ ...input, deadline: Date.now() - 1 })).rejects.toThrow("late")
})

test.skipIf(!process.env.OPENCODE_RSI_PB_GRADER)(
  "official terminal build zeros retain failure annotations and do not cancel another fixed repeat",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-pb-official-zero-"))
    roots.push(root)
    const grader = await RSIRuntime.ref(process.env.OPENCODE_RSI_PB_GRADER!)
    const config = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ instance: Schema.String, image: Schema.String })),
    )(await Bun.file(grader.path).text())
    expect(config.instance).toBe("altdesktop__i3-style.f93821b")
    await Bun.write(
      path.join(root, "manifest.json"),
      JSON.stringify({
        scoringTrust: "official-programbench-normal-use",
        tasks: [
          {
            id: config.instance,
            tests: ["one", "two"],
            goal: "Engineering build-failure fixtures",
            image: config.image,
            grader,
          },
        ],
      }),
    )
    const adapter = await programBench(root, await RSIRuntime.ref(path.join(root, "manifest.json")))
    const completed: { passed: number; total: number; valid: boolean }[] = []
    await evaluationWorkers(["one", "two"], 1, async (id, signal) => {
      const run = path.join(root, id)
      await fs.mkdir(path.join(run, "candidate/workspace"), { recursive: true })
      await Bun.write(path.join(run, "candidate/workspace/compile.sh"), `#!/bin/sh\nexit ${id === "one" ? 7 : 0}\n`)
      await Bun.write(path.join(run, "candidate/workspace/validate.sh"), "#!/bin/sh\nexit 0\n")
      await Bun.write(
        path.join(run, "FENCED.json"),
        JSON.stringify({ fixture: "operator-authored; no solver was launched" }),
      )
      const result = await adapter.grade({
        test: { id, total: 539 },
        artifact: new TextEncoder().encode("explicit engineering fixture"),
        run,
        state: path.join(run, "state"),
        deadline: Date.now() + 300_000,
        signal,
        release: {
          kind: "native-v2-release-v1",
          source: grader,
          dependencies: grader,
          bun: grader,
          rg: grader,
          image: config.image,
          entry: "worker.ts",
        },
      })
      expect(result).toMatchObject({
        passed: 0,
        total: 539,
        valid: true,
        failure: "candidate_build",
        executedTests: 0,
        terminalFailure: {
          kind: "candidate_build",
          officialError: id === "one" ? "compile_failed" : "copy_executable_failed",
          executedTests: 0,
        },
      })
      completed.push(result)
    })
    expect(completed).toHaveLength(2)
  },
  180_000,
)
