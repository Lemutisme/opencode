import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { configuration, preflight, source } from "./freeze"
import { put } from "./archive"
import { digest, duration } from "./ledger"

test("freeze includes dirty and untracked files, requires retained hashes, and rejects cumulative caps", async () => {
  const root = await mkdtemp("/tmp/research-freeze-")
  try {
    const repo = path.join(root, "repo")
    await Bun.write(path.join(repo, "tracked.ts"), "old")
    await Bun.write(path.join(repo, "bun.lock"), "lock")
    for (const argv of [
      ["git", "init", "-q"],
      ["git", "add", "."],
    ])
      expect(await Bun.spawn(argv, { cwd: repo, stdout: "ignore", stderr: "pipe" }).exited).toBe(0)
    await Bun.write(path.join(repo, "tracked.ts"), "dirty")
    await Bun.write(path.join(repo, "new.ts"), "untracked")
    const snapshot = path.join(root, "snapshot")
    const captured = await source(repo, snapshot)
    expect(captured.files).toBe(3)
    expect(await Bun.file(path.join(snapshot, "files/tracked.ts")).text()).toBe("dirty")
    expect(await Bun.file(path.join(snapshot, "files/new.ts")).text()).toBe("untracked")
    const hash = await put(root, "evidence")
    const model = { provider: "local", model: "fixture", variant: "script", sampling: {}, seed: "unsupported" }
    const frozen = {
      version: 1,
      mode: "deterministic-selfcheck",
      worker: model,
      reviewer: model,
      sourceSnapshot: captured.hash,
      lockfile: digest("lock"),
      prompts: hash,
      agents: hash,
      tools: hash,
      configuration: hash,
      runner: hash,
      corpus: hash,
      oracle: hash,
      scorer: hash,
      bun: { version: Bun.version, hash: digest(new Uint8Array(await Bun.file(process.execPath).arrayBuffer())) },
      node: {
        version: (
          await new Response(Bun.spawn(["/usr/bin/node", "--version"], { stdout: "pipe" }).stdout).text()
        ).trim(),
        hash: digest(new Uint8Array(await Bun.file("/usr/bin/node").arrayBuffer())),
      },
      order: ["one"],
      seed: "fixture",
      budget: { milliseconds: duration },
      timeouts: { provider: 1000, tool: 1000, verification: 1000, cleanup: 1000 },
      recovery: "explicit, retain deadline",
      isolation: {
        profile: "selfcheck",
        configuration: hash,
        filesystem: hash,
        processes: hash,
        network: hash,
        candidateExecutor: hash,
      },
    }
    expect(configuration(frozen).budget).toEqual({ milliseconds: duration })
    expect(() => configuration({ ...frozen, budget: { ...frozen.budget, turns: 1000 } })).toThrow()
    expect(() => configuration({ ...frozen, mode: "qualification" })).toThrow()
    expect(() => configuration({ ...frozen, order: ["one", "one"] })).toThrow()
    await preflight({
      configuration: frozen,
      snapshot,
      objects: path.join(root, "objects"),
      bun: process.execPath,
      node: "/usr/bin/node",
    })
    await Bun.write(path.join(snapshot, "files/new.ts"), "changed")
    expect(
      preflight({
        configuration: frozen,
        snapshot,
        objects: path.join(root, "objects"),
        bun: process.execPath,
        node: "/usr/bin/node",
      }),
    ).rejects.toThrow("Frozen source changed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
