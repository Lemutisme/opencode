import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { programBench } from "./rsi-programbench"
import { RSIRuntime } from "./rsi-runtime"
import { Artifacts } from "../../core/script/ota-supervisor"

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
