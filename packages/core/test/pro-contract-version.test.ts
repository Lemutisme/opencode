import { describe, expect, test } from "bun:test"
import { chmod, link, mkdir, readdir, rename, symlink, unlink } from "node:fs/promises"
import path from "node:path"
import { ProContractVersion } from "../src/pro-contract/version"
import { tmpdir } from "./fixture/tmpdir"

const emit = `console.log(JSON.stringify({version:1, observations:["executed"], requests:[], artifacts:[]}))`

describe("executable workflow versions", () => {
  test("freezes exact source, vendored dependencies, configuration and runtime; original edits do not change execution", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const workspace = path.join(root.path, "workspace")
    await mkdir(workspace)
    await Bun.write(path.join(source, "dep.ts"), `export const value = "frozen"`)
    await Bun.write(
      path.join(source, "workflow.ts"),
      `import { value } from "./dep.ts";
      const input = await Bun.stdin.json();
      console.log(JSON.stringify({version:1, observations:[value,input.config,input.task,input.view], requests:[{kind:"session",prompt:"ordinary host task"}],artifacts:[]}));`,
    )
    const store = ProContractVersion.make({ directory: path.join(root.path, "store") })
    const frozen = await store.freeze({ directory: source, entrypoint: "workflow.ts", config: { choice: "old" } })
    expect(await store.freeze({ directory: source, entrypoint: "workflow.ts", config: { choice: "old" } })).toEqual(
      frozen,
    )
    expect(frozen.manifest.files.map((file) => file.path)).toEqual(["dep.ts", "workflow.ts"])
    expect(frozen.manifest.runtime.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(frozen.manifest.libraries.length).toBe(5)
    await Bun.write(path.join(source, "dep.ts"), `export const value = "changed"`)
    const record = await store.run({
      versionHash: frozen.versionHash,
      task: { purpose: "solve" },
      view: ["approved-only"],
      workspace,
      deadline: Date.now() + 10_000,
    })
    expect(record.status).toBe("completed")
    expect(record.result?.observations).toEqual(["frozen", { choice: "old" }, { purpose: "solve" }, ["approved-only"]])
    expect(record.result?.requests).toEqual([{ kind: "session", prompt: "ordinary host task" }])
    expect(await store.read(record.id)).toEqual(record)
    expect(ProContractVersion.subjectHash(await store.read(record.id))).toBe(ProContractVersion.subjectHash(record))
    expect(await store.request(record.id)).toMatchObject({
      task: { purpose: "solve" },
      versionHash: frozen.versionHash,
    })
    expect(await store.inspect(frozen.versionHash)).toEqual(frozen.manifest)
    await expect(store.source(frozen.versionHash, source)).rejects.toThrow("Source does not match")
  })

  test("executes v0 → v1 → v2 changed research code and retains independent target provenance", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const workspace = path.join(root.path, "workspace")
    await mkdir(workspace)
    const code = (generation: number): string => `
      const input = await Bun.stdin.json();
      const generation = ${generation};
      const decision = generation === 0 ? "always-diagnose" : generation === 1 ? "diagnose-only-on-stall" : "serve";
      if (input.task.kind === "research") await Bun.write("candidate/workflow.ts", ${JSON.stringify(generation < 2 ? code(generation + 1) : emit)});
      await Bun.write("decision.txt", decision);
      console.log(JSON.stringify({version:1, observations:[{generation,decision,target:input.targetVersion}], requests:[], artifacts:input.task.kind === "research" ? ["candidate","decision.txt"] : ["decision.txt"]}));`
    await Bun.write(path.join(source, "workflow.ts"), code(0))
    const store = ProContractVersion.make({ directory: path.join(root.path, "store") })
    const v0 = await store.freeze({ directory: source, entrypoint: "workflow.ts" })
    const first = await store.run({
      versionHash: v0.versionHash,
      targetVersion: v0.versionHash,
      task: { kind: "research" },
      view: [],
      workspace,
      deadline: Date.now() + 10_000,
    })
    expect(first.status).toBe("completed")
    const v1 = await store.freeze({
      directory: path.join(await store.artifactDirectory(first.id), "candidate"),
      entrypoint: "workflow.ts",
    })
    expect(await store.candidate(first.id, v1.versionHash)).toBe(
      path.join(await store.artifactDirectory(first.id), "candidate"),
    )
    await expect(store.candidate(first.id, v0.versionHash)).rejects.toThrow("not the retained")
    const second = await store.run({
      versionHash: v1.versionHash,
      targetVersion: v0.versionHash,
      task: { kind: "research" },
      view: [],
      workspace,
      deadline: Date.now() + 10_000,
    })
    expect(second.result?.observations).toEqual([
      { generation: 1, decision: "diagnose-only-on-stall", target: v0.versionHash },
    ])
    const v2 = await store.freeze({
      directory: path.join(await store.artifactDirectory(second.id), "candidate"),
      entrypoint: "workflow.ts",
    })
    const third = await store.run({
      versionHash: v2.versionHash,
      task: { kind: "solve" },
      view: [],
      workspace,
      deadline: Date.now() + 10_000,
    })
    expect(third.result?.observations).toEqual([{ generation: 2, decision: "serve" }])
    expect(new Set([v0.versionHash, v1.versionHash, v2.versionHash]).size).toBe(3)
    expect(await store.read(first.id)).toEqual(first)
    expect(await Bun.file(path.join(await store.artifactDirectory(second.id), "decision.txt")).text()).toBe(
      "diagnose-only-on-stall",
    )
    expect(await readdir(workspace)).toEqual([])
  })

  test("archives syntax/startup failures and resumes with a separate successful run without rewriting history", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const workspace = path.join(root.path, "workspace")
    await mkdir(workspace)
    await Bun.write(path.join(source, "workflow.ts"), "this is invalid TypeScript ???")
    const store = ProContractVersion.make({ directory: path.join(root.path, "store") })
    const broken = await store.freeze({ directory: source, entrypoint: "workflow.ts" })
    const failed = await store.run({
      versionHash: broken.versionHash,
      task: "research",
      view: [],
      workspace,
      deadline: Date.now() + 10_000,
    })
    expect(failed.status).toBe("failed")
    expect(failed.exitCode).not.toBe(0)
    expect(failed.stderr.length).toBeGreaterThan(0)
    await Bun.write(path.join(source, "workflow.ts"), emit)
    const repaired = await store.freeze({ directory: source, entrypoint: "workflow.ts" })
    const reopened = ProContractVersion.make({ directory: path.join(root.path, "store") })
    expect(await reopened.read(failed.id)).toEqual(failed)
    expect(
      (
        await reopened.run({
          versionHash: repaired.versionHash,
          task: "research",
          view: [],
          workspace,
          deadline: Date.now() + 10_000,
        })
      ).status,
    ).toBe("completed")
    expect(await reopened.read(failed.id)).toEqual(failed)
  })

  test("records deadline and explicit cancellation without extending the original deadline", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const workspace = path.join(root.path, "workspace")
    await mkdir(workspace)
    await Bun.write(path.join(source, "workflow.ts"), `await Bun.sleep(30_000); ${emit}`)
    const store = ProContractVersion.make({ directory: path.join(root.path, "store") })
    const frozen = await store.freeze({ directory: source, entrypoint: "workflow.ts" })
    const deadline = Date.now() + 500
    const expired = await store.run({ versionHash: frozen.versionHash, task: "solve", view: [], workspace, deadline })
    expect(expired.status).toBe("deadline")
    expect(expired.completedAt - deadline).toBeLessThan(2000)
    const abort = new AbortController()
    const pending = store.run({
      versionHash: frozen.versionHash,
      task: "research",
      view: [],
      workspace,
      deadline: Date.now() + 10_000,
      signal: abort.signal,
    })
    setTimeout(() => abort.abort(), 300)
    expect((await pending).status).toBe("cancelled")
    const cancelled = await store.run({
      versionHash: frozen.versionHash,
      task: "solve",
      view: [],
      workspace,
      deadline: Date.now() + 10_000,
      signal: abort.signal,
    })
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.exitCode).toBeNull()
    const expiredBeforeStart = await store.run({
      versionHash: frozen.versionHash,
      task: "solve",
      view: [],
      workspace,
      deadline: Date.now() - 1,
    })
    expect(expiredBeforeStart.status).toBe("deadline")
    expect(expiredBeforeStart.exitCode).toBeNull()
  })

  test("rejects source links and unsafe entrypoints; detects changed frozen content", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const workspace = path.join(root.path, "workspace")
    await mkdir(workspace)
    await Bun.write(path.join(source, "workflow.ts"), emit)
    const store = ProContractVersion.make({ directory: path.join(root.path, "store") })
    await expect(store.freeze({ directory: source, entrypoint: "../workflow.ts" })).rejects.toThrow("relative")
    const frozen = await store.freeze({ directory: source, entrypoint: "workflow.ts" })
    await symlink(path.join(source, "workflow.ts"), path.join(source, "link.ts"))
    await expect(store.freeze({ directory: source, entrypoint: "workflow.ts" })).rejects.toThrow("symbolic links")
    const changed = path.join(root.path, "store", "versions", frozen.versionHash, "source", "workflow.ts")
    await chmod(changed, 0o600)
    await Bun.write(changed, `throw new Error("tampered")`)
    const failure = await store.run({
      versionHash: frozen.versionHash,
      task: "solve",
      view: [],
      workspace,
      deadline: Date.now() + 10_000,
    })
    expect(failure.status).toBe("failed")
    expect(failure.error).toContain("source changed")
    expect(failure.exitCode).toBeNull()
    const linked = path.join(root.path, "linked")
    await mkdir(linked)
    await link(path.join(source, "workflow.ts"), path.join(linked, "workflow.ts"))
    await expect(store.freeze({ directory: linked, entrypoint: "workflow.ts" })).rejects.toThrow("unlinked")
  })

  test("strict output cannot self-discharge; malformed output and output floods remain recorded failures", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const workspace = path.join(root.path, "workspace")
    await mkdir(workspace)
    const store = ProContractVersion.make({ directory: path.join(root.path, "store") })
    await Bun.write(
      path.join(source, "workflow.ts"),
      `console.log(JSON.stringify({version:1, observations:[], requests:[], artifacts:[], discharged:true}))`,
    )
    const forged = await store.freeze({ directory: source, entrypoint: "workflow.ts" })
    const failure = await store.run({
      versionHash: forged.versionHash,
      task: "research",
      view: [],
      workspace,
      deadline: Date.now() + 10_000,
    })
    expect(failure.status).toBe("failed")
    expect(failure.error).toContain("discharged")
    expect(failure.stdout).toContain("discharged")
    expect(failure.result).toBeUndefined()
    await Bun.write(path.join(source, "workflow.ts"), `while(true) console.log("x".repeat(65536))`)
    const flood = await store.freeze({ directory: source, entrypoint: "workflow.ts" })
    const bounded = await store.run({
      versionHash: flood.versionHash,
      task: "solve",
      view: [],
      workspace,
      deadline: Date.now() + 10_000,
    })
    expect(bounded.status).toBe("failed")
    expect(bounded.error).toContain("output exceeds")
    expect(Buffer.byteLength(bounded.stdout)).toBeLessThanOrEqual(1024 * 1024)
  })

  test("attempt identity is immutable and overlapping host storage fails closed", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const workspace = path.join(root.path, "workspace")
    await mkdir(workspace)
    await Bun.write(path.join(source, "workflow.ts"), emit)
    const store = ProContractVersion.make({ directory: path.join(root.path, "store") })
    const frozen = await store.freeze({ directory: source, entrypoint: "workflow.ts" })
    const input = {
      id: crypto.randomUUID(),
      versionHash: frozen.versionHash,
      task: "solve",
      view: [],
      workspace,
      deadline: Date.now() + 10_000,
    }
    const record = await store.run(input)
    expect(record.id).toBe(input.id)
    expect(record.status).toBe("completed")
    await expect(store.run(input)).rejects.toThrow("exist")
    expect(await store.read(input.id)).toEqual(record)
    const overlap = await store.run({ ...input, id: crypto.randomUUID(), workspace: root.path })
    expect(overlap.status).toBe("failed")
    expect(overlap.error).toContain("overlap")
    await expect(store.freeze({ directory: root.path, entrypoint: "source/workflow.ts" })).rejects.toThrow("overlap")
    await Bun.write(path.join(root.path, "store", "runs", input.id, "request.json"), "{}")
    await expect(store.request(input.id)).rejects.toThrow("identity changed")
  })

  test("retains the exact runtime bytes across host upgrades and detects retained runtime corruption", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const workspace = path.join(root.path, "workspace")
    const runtime = path.join(root.path, "bun")
    await mkdir(workspace)
    await Bun.write(path.join(source, "workflow.ts"), emit)
    await Bun.write(runtime, Bun.file(Bun.which("bun")!))
    await chmod(runtime, 0o700)
    const directory = path.join(root.path, "store")
    const store = ProContractVersion.make({ directory, runtime })
    const version = await store.freeze({ directory: source, entrypoint: "workflow.ts" })
    expect(await store.source(version.versionHash, source)).toBe(source)
    await Bun.write(runtime, "host installation replaced")
    // Opening the archive on a host with no Bun installation still uses retained executable/library bytes.
    const reopened = ProContractVersion.make({ directory, runtime: path.join(root.path, "missing-bun") })
    expect(await reopened.inspect(version.versionHash)).toEqual(version.manifest)
    expect(
      (
        await reopened.run({
          versionHash: version.versionHash,
          task: "solve",
          view: [],
          workspace,
          deadline: Date.now() + 10_000,
        })
      ).status,
    ).toBe("completed")
    const library = path.join(directory, "runtime", version.manifest.libraries[0].hash)
    await chmod(library, 0o600)
    await Bun.write(library, "corrupt retained library")
    const corrupted = await reopened.run({
      versionHash: version.versionHash,
      task: "solve",
      view: [],
      workspace,
      deadline: Date.now() + 10_000,
    })
    expect(corrupted.status).toBe("failed")
    expect(corrupted.error).toContain("Retained runtime content changed")
    expect(corrupted.exitCode).toBeNull()
  })

  test("retains exact input workspace separately from candidate writes and binds it into run provenance", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const workspace = path.join(root.path, "workspace")
    await Bun.write(path.join(workspace, "input.txt"), "approved initial input")
    await Bun.write(
      path.join(source, "workflow.ts"),
      `
      const before = await Bun.file("input.txt").text();
      await Bun.write("input.txt", "candidate changed workspace");
      console.log(JSON.stringify({version:1,observations:[before],requests:[],artifacts:["input.txt"]}));`,
    )
    const store = ProContractVersion.make({ directory: path.join(root.path, "store") })
    const version = await store.freeze({ directory: source, entrypoint: "workflow.ts" })
    const record = await store.run({
      versionHash: version.versionHash,
      task: "solve",
      view: [],
      workspace,
      deadline: Date.now() + 10_000,
    })
    expect(record.status).toBe("completed")
    expect(record.workspaceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(record.result?.observations).toEqual(["approved initial input"])
    await Bun.write(path.join(workspace, "input.txt"), "host changed original workspace")
    const retained = await store.inputDirectory(record.id)
    expect(await Bun.file(path.join(retained, "input.txt")).text()).toBe("approved initial input")
    expect(await Bun.file(path.join(await store.artifactDirectory(record.id), "input.txt")).text()).toBe(
      "candidate changed workspace",
    )
    expect(ProContractVersion.subjectHash({ ...record, workspaceHash: "0".repeat(64) })).not.toBe(
      ProContractVersion.subjectHash(record),
    )
    await chmod(path.join(retained, "input.txt"), 0o600)
    await Bun.write(path.join(retained, "input.txt"), "tampered retained input")
    await expect(store.inputDirectory(record.id)).rejects.toThrow("input workspace changed")
    const expired = await store.run({
      versionHash: version.versionHash,
      task: "solve",
      view: [],
      workspace,
      deadline: Date.now() - 1,
    })
    expect(expired.workspaceHash).toMatch(/^[a-f0-9]{64}$/)
    await expect(store.inputDirectory(expired.id)).rejects.toThrow("was not captured")
  })

  test("checksum-only publication stays pending without replay and historical missing checksums are preserved", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const workspace = path.join(root.path, "workspace")
    await mkdir(workspace)
    await Bun.write(path.join(source, "workflow.ts"), emit)
    const directory = path.join(root.path, "store")
    const store = ProContractVersion.make({ directory })
    const version = await store.freeze({ directory: source, entrypoint: "workflow.ts" })
    const input = {
      id: crypto.randomUUID(),
      versionHash: version.versionHash,
      task: "solve",
      view: [],
      workspace,
      deadline: Date.now() + 10_000,
    }
    const record = await store.run(input)
    const location = path.join(directory, "runs", record.id)
    const encoded = await Bun.file(path.join(location, "result.json")).text()
    // Reconstruct the exact crash window after checksum publication but before the completion rename.
    await rename(path.join(location, "result.json"), path.join(location, "result.pending"))
    expect(await Bun.file(path.join(location, "result.sha256")).exists()).toBe(true)
    const reopened = ProContractVersion.make({ directory })
    await expect(reopened.read(record.id)).rejects.toThrow("completion marker is absent")
    await expect(reopened.run(input)).rejects.toThrow("exist")
    expect(await Bun.file(path.join(location, "result.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(location, "result.pending")).text()).toBe(encoded)
    await rename(path.join(location, "result.pending"), path.join(location, "result.json"))
    expect(await reopened.read(record.id)).toEqual(record)
    await unlink(path.join(location, "result.sha256"))
    await expect(reopened.read(record.id)).rejects.toThrow("Historical run receipt is incomplete: checksum is absent")
    expect(await Bun.file(path.join(location, "result.json")).text()).toBe(encoded)
    expect(await Bun.file(path.join(location, "result.sha256")).exists()).toBe(false)
  })

  test("pending attempts retain independently verifiable input and request coordinates without a final receipt", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const workspace = path.join(root.path, "workspace")
    await Bun.write(path.join(workspace, "input.txt"), "original bytes")
    await Bun.write(path.join(source, "workflow.ts"), emit)
    const directory = path.join(root.path, "store")
    const store = ProContractVersion.make({ directory })
    const version = await store.freeze({ directory: source, entrypoint: "workflow.ts" })
    const record = await store.run({
      versionHash: version.versionHash,
      task: { contractID: "test-contract", revision: 1 },
      view: [],
      workspace,
      deadline: Date.now() + 10_000,
    })
    const location = path.join(directory, "runs", record.id)
    await rename(path.join(location, "result.json"), path.join(location, "retained-final-receipt.json"))
    await Bun.write(path.join(workspace, "input.txt"), "changed after crash")
    const reopened = ProContractVersion.make({ directory })
    expect(await reopened.input(record.id)).toMatchObject({ complete: true, requestHash: record.requestHash })
    expect(await reopened.request(record.id)).toMatchObject({ task: { contractID: "test-contract", revision: 1 } })
    expect(await Bun.file(path.join(await reopened.inputDirectory(record.id), "input.txt")).text()).toBe(
      "original bytes",
    )
    await expect(reopened.read(record.id)).rejects.toThrow("completion marker is absent")
    const checksum = await Bun.file(path.join(location, "input.sha256")).text()
    await unlink(path.join(location, "input.sha256"))
    await expect(reopened.inputDirectory(record.id)).rejects.toThrow("checksum is missing")
    await Bun.write(path.join(location, "input.sha256"), checksum)
    const request = await Bun.file(path.join(location, "request.json")).text()
    await Bun.write(path.join(location, "request.json"), "{}")
    await expect(reopened.input(record.id)).rejects.toThrow("request identity changed")
    await Bun.write(path.join(location, "request.json"), request)
    await rename(path.join(location, "input.json"), path.join(location, "retained-input.json"))
    await expect(reopened.inputDirectory(record.id)).rejects.toThrow("manifest marker is absent")
    expect(await Bun.file(path.join(location, "retained-final-receipt.json")).exists()).toBe(true)
  })

  test("deadline-triggered aborts cannot race into explicit-cancellation classification", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const workspace = path.join(root.path, "workspace")
    await mkdir(workspace)
    await Bun.write(path.join(source, "workflow.ts"), `await Bun.sleep(10_000); ${emit}`)
    const store = ProContractVersion.make({ directory: path.join(root.path, "store") })
    const version = await store.freeze({ directory: source, entrypoint: "workflow.ts" })
    for (const index of Array.from({ length: 6 }, (_, index) => index)) {
      const stop = new AbortController()
      const deadline = Date.now() + 400 + index
      const pending = store.run({
        versionHash: version.versionHash,
        task: "solve",
        view: [],
        workspace,
        deadline,
        signal: stop.signal,
      })
      while (Date.now() < deadline) await Bun.sleep(1)
      stop.abort()
      expect((await pending).status).toBe("deadline")
    }
    const aborted = new AbortController()
    aborted.abort()
    expect(
      (
        await store.run({
          versionHash: version.versionHash,
          task: "solve",
          view: [],
          workspace,
          deadline: Date.now() - 1,
          signal: aborted.signal,
        })
      ).status,
    ).toBe("deadline")
  })
})
