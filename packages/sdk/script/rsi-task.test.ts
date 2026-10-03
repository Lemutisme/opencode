import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { hash } from "../../core/script/ota-rsi"
import { Artifacts } from "../../core/script/ota-supervisor"
import type { Job } from "../../core/script/ota-supervisor"
import type { ContractDelivery } from "./contract-delivery"
import { RSIRuntime } from "./rsi-runtime"
import { RSITask } from "./rsi-task"

const roots: string[] = []
const obligation: typeof ContractDelivery.Obligation.Type = {
  probe: { title: "argument", args: ["x"], env: { B: "2", A: "1" } },
  expected: { exit: 0, stdout: "eAo=", stderr: "", files: { "b.out": null, "a.out": "eA==" } },
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-task-"))
  roots.push(root)
  const run = path.join(root, "native", "allocation")
  const directory = path.join(run, "candidate", "workspace")
  await fs.mkdir(directory, { recursive: true })
  await fs.mkdir(path.join(run, "state"))
  await Bun.write(path.join(directory, "source"), "public source before continuation")
  await Bun.write(path.join(directory, "reference"), "excluded reference")
  await Bun.write(path.join(run, "state", "session.sqlite"), "private Session bytes must not migrate")
  await Bun.write(path.join(run, "FENCED.json"), JSON.stringify({ name: "worker-allocation", time: Date.now() }))
  await RSIRuntime.run([
    "python3",
    path.join(import.meta.dir, "rsi-files.py"),
    "snapshot",
    directory,
    path.join(root, "seed.tar"),
  ])
  const file = await RSIRuntime.ref(path.join(root, "seed.tar"))
  const manifest: RSITask.Checkpoint = {
    kind: "native-rsi-task-v1",
    task: "same-original-task",
    goal: "Reimplement the original command; preserve every original requirement.",
    image: `sha256:${hash("pinned-task-image")}`,
    workspace: file,
    obligations: [obligation],
    summary: "The previous implementation still misses an edge case.",
  }
  const artifacts = new Artifacts(path.join(root, "objects"))
  const checkpoint = await artifacts.put(new TextEncoder().encode(JSON.stringify(manifest)))
  const deadline = Date.now() + 60_000
  const job: Job = {
    id: "same-task-new-incumbent",
    epoch: 2,
    slot: "h",
    mutable: "s",
    deadline,
    pair: { s: path.join(root, "s"), h: path.join(root, "h") },
    output: path.join(root, "staging"),
    memory: { id: "e2" },
    purpose: "continuation",
    task: { id: manifest.task, checkpoint },
  }
  const handoff = {
    kind: "programbench-handoff",
    result: { state: "ready", summary: "Candidate claims completion", snapshot: hash("untrusted snapshot"), probes: 1 },
    obligations: [obligation],
  }
  const input = {
    job,
    artifact: new TextEncoder().encode(JSON.stringify(handoff)),
    state: path.join(run, "state"),
    run,
    release: {
      kind: "native-v2-release-v1" as const,
      source: file,
      dependencies: file,
      bun: file,
      rg: file,
      image: manifest.image,
      entry: "packages/sdk/script/rsi-worker.ts",
    },
    deadline,
    signal: new AbortController().signal,
  }
  return { root, run, directory, artifacts, manifest, checkpoint, handoff, input }
}

test("task materialization preserves its original identity, goal, pinned image and public obligations", async () => {
  const f = await fixture()
  expect(await RSITask.load(f.root, f.checkpoint)).toEqual(f.manifest)
  const task = await RSITask.task(f.root, f.input.job.task!)
  expect(task.mode).toBe("programbench")
  expect(task.artifact).toBe("submission")
  expect(task.goal.startsWith(f.manifest.goal)).toBe(true)
  expect(task.goal).toContain("advisory")
  expect(task.image).toBe(f.manifest.image)
  expect(task.files!["workspace.tar"]).toEqual(f.manifest.workspace)
  expect(await Bun.file(task.files!["obligations.json"].path).json()).toEqual([obligation])
  await expect(RSITask.task(f.root, { id: "different-task", checkpoint: f.checkpoint })).rejects.toThrow("another task")
})

test.each(["task", "goal", "image", "parent", "privateState"])(
  "checkpoint boundary rejects invalid %s",
  async (kind) => {
    const f = await fixture()
    const bad = {
      ...f.manifest,
      ...(kind === "privateState" ? { privateState: f.input.state } : { [kind]: kind === "parent" ? "unsealed" : " " }),
    }
    const digest = await f.artifacts.put(new TextEncoder().encode(JSON.stringify(bad)))
    await expect(RSITask.load(f.root, digest)).rejects.toThrow()
  },
)

test.each(["changed", "symlink", "hardlink"])("checkpoint workspace rejects %s bytes", async (kind) => {
  const f = await fixture()
  if (kind === "changed") {
    await fs.chmod(f.manifest.workspace.path, 0o600)
    await Bun.write(f.manifest.workspace.path, "changed archive")
  }
  if (kind === "symlink") {
    await fs.rename(f.manifest.workspace.path, path.join(f.root, "other.tar"))
    await fs.symlink(path.join(f.root, "other.tar"), f.manifest.workspace.path)
  }
  if (kind === "hardlink") await fs.link(f.manifest.workspace.path, path.join(f.root, "shared.tar"))
  await expect(RSITask.load(f.root, f.checkpoint)).rejects.toThrow()
})

test("ready is only a proposal: partial independent verification returns revise with a sealed public checkpoint", async () => {
  const f = await fixture()
  await Bun.write(path.join(f.directory, "source"), "candidate successor actually changed this task")
  const calls: string[] = []
  const adapter = RSITask.continuation(f.root, async (input) => {
    calls.push(input.job.id)
    expect(input.release).toEqual(f.input.release)
    expect(input.deadline).toBe(f.input.deadline)
    return { passed: 3, total: 4, valid: true }
  })
  const next = await adapter.settle(f.input)
  expect(calls).toEqual([f.input.job.id])
  expect(next.outcome).toBe("revise")
  expect(next.previous).toBe(f.checkpoint)
  const loaded = await RSITask.load(f.root, next.checkpoint)
  expect(loaded.task).toBe(f.manifest.task)
  expect(loaded.goal).toBe(f.manifest.goal)
  expect(loaded.image).toBe(f.manifest.image)
  expect(loaded.parent).toBe(f.checkpoint)
  expect(loaded.workspace.sha256).not.toBe(f.manifest.workspace.sha256)
  expect(loaded.workspace.path).toBe(path.join(f.root, "task-objects", loaded.workspace.sha256))
  expect((await fs.stat(loaded.workspace.path)).nlink).toBe(1)
  const receipt = await Bun.file(await f.artifacts.get(next.receipt)).json()
  expect(receipt).toMatchObject({
    previous: f.checkpoint,
    checkpoint: next.checkpoint,
    producer: f.input.job.pair,
    job: f.input.job.id,
    deadline: f.input.deadline,
    outcome: "revise",
    verification: { passed: 3, total: 4, valid: true },
  })
  expect(await RSITask.load(f.root, f.checkpoint)).toEqual(f.manifest)
  const entries = await RSIRuntime.run([
    "python3",
    "-c",
    "import sys,tarfile,json; print(json.dumps(tarfile.open(sys.argv[1]).getnames()))",
    loaded.workspace.path,
  ])
  expect(JSON.parse(entries)).toEqual(["source"])
  expect(await Bun.file(path.join(f.input.state, "session.sqlite")).text()).toBe(
    "private Session bytes must not migrate",
  )
})

test("only valid full independent verification authorizes task delivery", async () => {
  const f = await fixture()
  const next = await RSITask.continuation(f.root, async () => ({ passed: 4, total: 4, valid: true })).settle(f.input)
  expect(next.outcome).toBe("delivered")
  expect((await RSITask.load(f.root, next.checkpoint)).goal).toBe(f.manifest.goal)
})

test("a hidden final verifier can stop on partial results without leaking scores back into the task", async () => {
  const f = await fixture()
  const next = await RSITask.continuation(f.root, async () => ({ passed: 17, total: 29, valid: true }), {
    partial: "blocked",
  }).settle(f.input)
  expect(next.outcome).toBe("blocked")
  const manifest = await RSITask.load(f.root, next.checkpoint)
  expect(manifest.summary).toBe(f.handoff.result.summary)
  expect(manifest).not.toHaveProperty("verification")
  expect(await Bun.file(await f.artifacts.get(next.receipt)).json()).toMatchObject({
    outcome: "blocked",
    verification: { passed: 17, total: 29, valid: true },
  })
})

test.each([
  { passed: 4, total: 4, valid: false },
  { passed: 1.5, total: 4, valid: true },
  { passed: 4, total: 0, valid: true },
  { passed: 5, total: 4, valid: true },
])("invalid independent verification never produces a checkpoint: %j", async (verification) => {
  const f = await fixture()
  await expect(RSITask.continuation(f.root, async () => verification).settle(f.input)).rejects.toThrow("verification")
  expect(await Bun.file(path.join(f.root, "task-objects")).exists()).toBe(false)
})

test.each(["revise", "blocked"] as const)(
  "%s skips final grading and retains a public task checkpoint",
  async (state) => {
    const f = await fixture()
    const adapter = RSITask.continuation(f.root, async () => {
      throw new Error("non-ready handoffs cannot request completion grading")
    })
    const next = await adapter.settle({
      ...f.input,
      artifact: new TextEncoder().encode(
        JSON.stringify({ ...f.handoff, result: { state, reason: "Need a different execution strategy" } }),
      ),
    })
    expect(next.outcome).toBe(state)
    expect((await RSITask.load(f.root, next.checkpoint)).summary).toBe("Need a different execution strategy")
  },
)

test("an opted-in blocked artifact is scored without being called completed or permitting another solve", async () => {
  const f = await fixture()
  const scores: string[] = []
  const next = await RSITask.continuation(
    f.root,
    async (input) => {
      scores.push(input.run)
      return { passed: 2, total: 4, valid: true }
    },
    { partial: "blocked", scoreBlocked: true },
  ).settle({
    ...f.input,
    artifact: new TextEncoder().encode(
      JSON.stringify({ ...f.handoff, result: { state: "blocked", reason: "Partial implementation" } }),
    ),
  })
  expect(scores).toEqual([f.run])
  expect(next.outcome).toBe("blocked")
  const receipt = await Bun.file(await f.artifacts.get(next.receipt)).json()
  expect(receipt.verification).toEqual({ passed: 2, total: 4, valid: true })
  expect(receipt.deadline).toBe(f.input.deadline)
})

test.each(["removed", "expected", "probe", "duplicate"])("public obligations cannot be %s", async (kind) => {
  const f = await fixture()
  const calls: string[] = []
  const obligations =
    kind === "removed"
      ? []
      : kind === "duplicate"
        ? [obligation, obligation]
        : [
            {
              ...obligation,
              ...(kind === "probe"
                ? { probe: { ...obligation.probe, args: ["different"] } }
                : { expected: { ...obligation.expected, stdout: "changed" } }),
            },
          ]
  await expect(
    RSITask.continuation(f.root, async () => {
      calls.push("verify")
      return { passed: 1, total: 1, valid: true }
    }).settle({ ...f.input, artifact: new TextEncoder().encode(JSON.stringify({ ...f.handoff, obligations })) }),
  ).rejects.toThrow("obligation")
  expect(calls).toEqual([])
})

test("obligation identity is canonical across record ordering, and new public probes may be retained", async () => {
  const f = await fixture()
  const obligations = [
    {
      expected: { files: { "a.out": "eA==", "b.out": null }, stderr: "", stdout: "eAo=", exit: 0 },
      probe: { env: { A: "1", B: "2" }, args: ["x"], title: "argument" },
    },
    { ...obligation, probe: { ...obligation.probe, title: "new edge case", args: [] } },
  ]
  const next = await RSITask.continuation(f.root, async () => ({ passed: 1, total: 1, valid: true })).settle({
    ...f.input,
    artifact: new TextEncoder().encode(JSON.stringify({ ...f.handoff, obligations })),
  })
  expect((await RSITask.load(f.root, next.checkpoint)).obligations).toEqual(obligations)
})

test.each(["missing", "symlink", "future"])("a %s host fence receipt cannot admit a task checkpoint", async (kind) => {
  const f = await fixture()
  await fs.unlink(path.join(f.run, "FENCED.json"))
  if (kind === "symlink") {
    await Bun.write(path.join(f.run, "candidate", "fake"), JSON.stringify({ name: "forged", time: Date.now() }))
    await fs.symlink(path.join(f.run, "candidate", "fake"), path.join(f.run, "FENCED.json"))
  }
  if (kind === "future")
    await Bun.write(
      path.join(f.run, "FENCED.json"),
      JSON.stringify({ name: "not stopped yet", time: Date.now() + 60_000 }),
    )
  await expect(
    RSITask.continuation(f.root, async () => ({ passed: 1, total: 1, valid: true })).settle(f.input),
  ).rejects.toThrow()
})

test.each(["task", "purpose", "deadline", "privateState"])("handoff cannot change %s authority", async (kind) => {
  const f = await fixture()
  const input = {
    ...f.input,
    ...(kind === "deadline" ? { deadline: f.input.deadline + 1 } : {}),
    job: {
      ...f.input.job,
      ...(kind === "purpose" ? { purpose: undefined } : {}),
      ...(kind === "task" ? { task: { ...f.input.job.task!, id: "different-task" } } : {}),
    },
    ...(kind === "privateState"
      ? { artifact: new TextEncoder().encode(JSON.stringify({ ...f.handoff, privateState: f.input.state })) }
      : {}),
  }
  await expect(
    RSITask.continuation(f.root, async () => ({ passed: 1, total: 1, valid: true })).settle(input),
  ).rejects.toThrow()
})

test("original deadline and cancellation prevent late checkpoint admission", async () => {
  const f = await fixture()
  const controller = new AbortController()
  controller.abort(new Error("explicit cancellation"))
  const adapter = RSITask.continuation(f.root, async () => ({ passed: 1, total: 1, valid: true }))
  await expect(adapter.settle({ ...f.input, signal: controller.signal })).rejects.toThrow("cancellation")
  const deadline = Date.now() - 1
  await expect(adapter.settle({ ...f.input, deadline, job: { ...f.input.job, deadline } })).rejects.toThrow("deadline")
  const during = new AbortController()
  await expect(
    RSITask.continuation(f.root, async () => {
      during.abort(new Error("cancelled during grading"))
      return { passed: 1, total: 1, valid: true }
    }).settle({ ...f.input, signal: during.signal }),
  ).rejects.toThrow("grading")
})

test("duplicate immutable snapshots are checked, not overwritten", async () => {
  const f = await fixture()
  const adapter = RSITask.continuation(f.root, async () => ({ passed: 1, total: 1, valid: true }))
  const first = await adapter.settle(f.input)
  const manifest = await RSITask.load(f.root, first.checkpoint)
  const stat = await fs.stat(manifest.workspace.path)
  const second = await adapter.settle(f.input)
  expect(second).toEqual(first)
  expect((await fs.stat(manifest.workspace.path)).ino).toBe(stat.ino)
  expect((await fs.stat(manifest.workspace.path)).nlink).toBe(1)
})
