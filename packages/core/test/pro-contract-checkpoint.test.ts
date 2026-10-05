import { expect, test } from "bun:test"
import { chmod, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { ProContractVersion } from "../src/pro-contract/version"
import { tmpdir } from "./fixture/tmpdir"

async function fixture(code: string) {
  const root = await tmpdir()
  const directory = path.join(root.path, "store")
  const workspace = path.join(root.path, "workspace")
  await mkdir(workspace)
  await Bun.write(path.join(workspace, "untouched.txt"), "original")
  await Bun.write(path.join(workspace, "state", "stale.txt"), "remove me")
  await Bun.write(path.join(root.path, "source", "workflow.ts"), code)
  const versions = ProContractVersion.make({ directory })
  const frozen = await versions.freeze({ directory: path.join(root.path, "source"), entrypoint: "workflow.ts" })
  return {
    directory,
    versions,
    source: path.join(root.path, "source"),
    request: {
      versionHash: frozen.versionHash,
      targetVersion: frozen.versionHash,
      task: { contractID: "task", revision: 1, specHash: "spec", input: "study" },
      view: {},
      workspace,
      deadline: Date.now() + 30_000,
    },
    [Symbol.asyncDispose]: () => root[Symbol.asyncDispose](),
  }
}

const output = `console.log(JSON.stringify({version:1,observations:[],requests:[],artifacts:["state"],checkpoint:"state"}));`

test("checkpoint restoration replaces its entire prefix, preserves deletions, and records exact lineage", async () => {
  await using setup = await fixture(`
    import { rm } from "node:fs/promises";
    const input = await Bun.stdin.json();
    if (!input.checkpoint) {
      await rm("state", {recursive:true});
      await Bun.write("state/retained.txt", "verified bytes");
      await Bun.write("untouched.txt", "scratch only");
    }
    console.log(JSON.stringify({version:1, observations:[
      await Bun.file("state/retained.txt").text(),
      await Bun.file("state/stale.txt").exists(),
      await Bun.file("untouched.txt").text()
    ],requests:[],artifacts:["state"],checkpoint:"state"}));`)
  const first = await setup.versions.run(setup.request)
  expect(first.status).toBe("completed")
  expect(first.result?.observations).toEqual(["verified bytes", false, "scratch only"])
  const second = await setup.versions.run({ ...setup.request, checkpoint: first.id })
  expect(second.status).toBe("completed")
  expect(second.result?.observations).toEqual(["verified bytes", false, "original"])
  expect(second.checkpoint).toEqual({
    runID: first.id,
    subjectHash: ProContractVersion.subjectHash(first),
    path: "state",
  })
  expect(await setup.versions.request(second.id)).toMatchObject({ checkpoint: first.id })
  expect((await setup.versions.input(second.id))?.files.map((file) => file.path)).toEqual([
    "state",
    "state/retained.txt",
    "untouched.txt",
  ])
  expect((await setup.versions.input(second.id))?.baselineHash).toBe(
    (await setup.versions.input(first.id))?.baselineHash,
  )
  const third = await setup.versions.run({ ...setup.request, checkpoint: second.id })
  expect(third.result?.observations).toEqual(["verified bytes", false, "original"])
  expect(third.checkpoint?.runID).toBe(second.id)
  expect(await Bun.file(path.join(setup.request.workspace, "state/stale.txt")).text()).toBe("remove me")
})

test("an explicit checkpoint may be a file, change type, become empty, or deliberately select a different prefix", async () => {
  await using setup = await fixture(`
    import { mkdir, rm } from "node:fs/promises";
    const input = await Bun.stdin.json();
    const prior = await Bun.file("state").text().catch(() => "directory");
    await rm("state", {recursive:true});
    if (input.view.kind === "file") await Bun.write("state", "file state");
    if (input.view.kind === "empty") await mkdir("state");
    if (input.view.kind === "switch") await Bun.write("other/next.txt", "new namespace");
    const checkpoint = input.view.kind === "switch" ? "other" : "state";
    console.log(JSON.stringify({version:1,observations:[prior],requests:[],artifacts:[checkpoint],checkpoint}));`)
  const file = await setup.versions.run({ ...setup.request, view: { kind: "file" } })
  expect(file.status).toBe("completed")
  const empty = await setup.versions.run({ ...setup.request, checkpoint: file.id, view: { kind: "empty" } })
  expect(empty.status).toBe("completed")
  expect(empty.result?.observations).toEqual(["file state"])
  expect(empty.artifacts).toHaveLength(1)
  const next = await setup.versions.run({ ...setup.request, checkpoint: empty.id, view: { kind: "switch" } })
  expect(next.status).toBe("completed")
  expect((await setup.versions.input(next.id))?.files.some((file) => file.path === "state/stale.txt")).toBe(false)
  const switched = await setup.versions.run({ ...setup.request, checkpoint: next.id, view: { kind: "empty" } })
  expect(switched.status).toBe("completed")
  expect(switched.checkpoint?.path).toBe("other")
  expect((await setup.versions.input(switched.id))?.files.map((file) => file.path)).toEqual([
    "other",
    "other/next.txt",
    "state",
    "state/stale.txt",
    "untouched.txt",
  ])
})

test("checkpoint declarations must name a normalized fully retained subtree, never synthesized ancestors", async () => {
  await using setup = await fixture(`
    const input = await Bun.stdin.json();
    await Bun.write("state/retained.txt", "bytes");
    console.log(JSON.stringify({version:1,observations:[],requests:[],artifacts:input.view.artifacts,checkpoint:input.view.checkpoint}));`)
  for (const checkpoint of [
    ".",
    "../escape",
    "/absolute",
    "state//retained.txt",
    "state/../retained.txt",
    "state\\retained.txt",
  ])
    expect((await setup.versions.run({ ...setup.request, view: { checkpoint, artifacts: ["state"] } })).status).toBe(
      "failed",
    )
  const ancestor = await setup.versions.run({
    ...setup.request,
    view: { checkpoint: "state", artifacts: ["state/retained.txt"] },
  })
  expect(ancestor.error).toContain("fully retained")
  const missing = await setup.versions.run({
    ...setup.request,
    view: { checkpoint: "state/missing", artifacts: ["state"] },
  })
  expect(missing.error).toContain("absent")
  const nested = await setup.versions.run({
    ...setup.request,
    view: { checkpoint: "state/retained.txt", artifacts: ["state"] },
  })
  expect(nested.status).toBe("completed")
  expect(
    (
      await setup.versions.run({
        ...setup.request,
        checkpoint: nested.id,
        view: { checkpoint: "state/retained.txt", artifacts: ["state"] },
      })
    ).status,
  ).toBe("completed")
})

test("a checkpoint cannot cross task, revision, spec, method, target, deadline, or original input boundaries", async () => {
  await using setup = await fixture(output)
  const first = await setup.versions.run(setup.request)
  expect(first.status).toBe("completed")
  const other = await setup.versions.freeze({ directory: setup.source, entrypoint: "workflow.ts", config: "different" })
  const conflicts = [
    { task: { ...setup.request.task, contractID: "other" } },
    { task: { ...setup.request.task, revision: 2 } },
    { task: { ...setup.request.task, specHash: "changed" } },
    { task: { ...setup.request.task, input: "different task" } },
    { versionHash: other.versionHash },
    { targetVersion: other.versionHash },
    { targetVersion: undefined },
    { deadline: setup.request.deadline + 1 },
  ]
  for (const conflict of conflicts) {
    const result = await setup.versions.run({ ...setup.request, ...conflict, checkpoint: first.id })
    expect(result.status).toBe("failed")
    expect(result.error).toContain("another frozen execution")
  }
  await Bun.write(path.join(setup.request.workspace, "untouched.txt"), "different original")
  const changed = await setup.versions.run({ ...setup.request, checkpoint: first.id })
  expect(changed.status).toBe("failed")
  expect(changed.error).toContain("another original workspace")
})

test("failed, cancelled, unknown and undeclared outputs cannot publish continuation state", async () => {
  await using setup = await fixture(`
    const input = await Bun.stdin.json();
    await Bun.write("state/uncommitted.txt", "must not continue");
    if (input.view.fail) process.exit(1);
    console.log(JSON.stringify({version:1,observations:[],requests:[],artifacts:["state"]}));`)
  const failed = await setup.versions.run({ ...setup.request, view: { fail: true } })
  const cancelled = await setup.versions.run({ ...setup.request, signal: AbortSignal.abort() })
  const undeclared = await setup.versions.run(setup.request)
  expect(failed.status).toBe("failed")
  expect(cancelled.status).toBe("cancelled")
  expect(undeclared.status).toBe("completed")
  for (const prior of [failed, cancelled, undeclared]) {
    const next = await setup.versions.run({ ...setup.request, checkpoint: prior.id })
    expect(next.status).toBe("failed")
    expect(next.error).toContain("Only a completed run with an explicit checkpoint")
  }
  await rm(path.join(setup.directory, "runs", undeclared.id, "result.json"))
  const unknown = await setup.versions.run({ ...setup.request, checkpoint: undeclared.id })
  expect(unknown.status).toBe("failed")
  expect(unknown.error).toContain("completion marker is absent")
})

test("retained checkpoint content and receipts are verified before any continuation code starts", async () => {
  await using setup = await fixture(output)
  const first = await setup.versions.run(setup.request)
  const artifact = path.join(await setup.versions.artifactDirectory(first.id), "state/stale.txt")
  await chmod(artifact, 0o600)
  await Bun.write(artifact, "tampered")
  const tampered = await setup.versions.run({ ...setup.request, checkpoint: first.id })
  expect(tampered.status).toBe("failed")
  expect(tampered.error).toContain("Checkpoint artifacts changed")
  expect(tampered.stdout).toBe("")
  const other = await setup.versions.run(setup.request)
  await Bun.write(
    path.join(setup.directory, "runs", other.id, "result.json"),
    JSON.stringify({ ...other, stdout: "changed" }),
  )
  const receipt = await setup.versions.run({ ...setup.request, checkpoint: other.id })
  expect(receipt.status).toBe("failed")
  expect(receipt.error).toContain("Run record changed")
  expect(receipt.stdout).toBe("")
})

test("a nested checkpoint cannot overwrite original ancestors outside its declared prefix", async () => {
  await using setup = await fixture(`
    import { rm } from "node:fs/promises";
    await rm("state", {recursive:true});
    await Bun.write("state/nested/value.txt", "retained");
    console.log(JSON.stringify({version:1,observations:[],requests:[],artifacts:["state"],checkpoint:"state/nested"}));`)
  await rm(path.join(setup.request.workspace, "state"), { recursive: true })
  await Bun.write(path.join(setup.request.workspace, "state"), "original ancestor file")
  const first = await setup.versions.run(setup.request)
  expect(first.status).toBe("completed")
  const next = await setup.versions.run({ ...setup.request, checkpoint: first.id })
  expect(next.status).toBe("failed")
  expect(next.error).toContain("ancestor outside its declared prefix")
  expect(await Bun.file(path.join(setup.request.workspace, "state")).text()).toBe("original ancestor file")
})
