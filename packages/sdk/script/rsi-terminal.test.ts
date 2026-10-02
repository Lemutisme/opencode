import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { terminalBench } from "./rsi-terminal"
import { RSIRuntime } from "./rsi-runtime"

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-terminal-test-"))
  await Bun.write(path.join(root, "binding.json"), "{}")
  await Bun.write(
    path.join(root, "config.json"),
    JSON.stringify({
      id: "official-instance",
      binding: await RSIRuntime.ref(path.join(root, "binding.json")),
      authority: [],
    }),
  )
  const manifest = {
    scoringTrust: "official-harbor-normal-use",
    python: process.execPath,
    pythonRuntime: await RSIRuntime.ref(process.execPath),
    authority: [],
    tasks: [
      {
        id: "official-instance",
        tests: ["development-r1", "development-r2"],
        goal: "Frozen official instruction",
        config: await RSIRuntime.ref(path.join(root, "config.json")),
      },
    ],
  }
  const file = path.join(root, "manifest.json")
  await Bun.write(file, JSON.stringify(manifest))
  return { root, file, manifest }
}

test("metadata identity resolution never boots a Harbor environment", async () => {
  const input = await fixture()
  try {
    const adapter = await terminalBench(input.root, await RSIRuntime.ref(input.file))
    const task = await adapter.task({ id: "development-r1", total: 1 })
    expect(task.identity).toBe("official-instance")
    expect(task.mode).toBe("bridge")
    expect((await fs.readdir(input.root)).sort()).toEqual(["binding.json", "config.json", "manifest.json"])
    await adapter.dispose()
  } finally {
    await fs.rm(input.root, { recursive: true, force: true })
  }
})

test("task-local forks and changed official denominator fail closed", async () => {
  const input = await fixture()
  try {
    const adapter = await terminalBench(input.root, await RSIRuntime.ref(input.file))
    expect(() => adapter.task({ id: "development-r1", total: 2 })).toThrow("denominator")
    expect(() =>
      adapter.task({ id: "development-r1", total: 1 }, { id: "official-instance", checkpoint: "a".repeat(64) }),
    ).toThrow("qualified environment forks")
    expect(() => adapter.task({ id: "unfrozen", total: 1 })).toThrow("unassigned")
  } finally {
    await fs.rm(input.root, { recursive: true, force: true })
  }
})

test("frozen duplicate assignments are rejected before any allocation", async () => {
  const input = await fixture()
  try {
    input.manifest.tasks[0]!.tests.push("development-r1")
    await Bun.write(input.file, JSON.stringify(input.manifest))
    await expect(terminalBench(input.root, await RSIRuntime.ref(input.file))).rejects.toThrow("unique frozen")
  } finally {
    await fs.rm(input.root, { recursive: true, force: true })
  }
})

test("operator profile rejects ambiguous benchmark authority before loading a grader", async () => {
  const input = await fixture()
  try {
    const reference = await RSIRuntime.ref(path.join(input.root, "binding.json"))
    const file = path.join(input.root, "profile.json")
    await Bun.write(
      file,
      JSON.stringify({
        harness: reference,
        strategy: reference,
        gateway: reference,
        programbench: reference,
        terminal: reference,
        authority: [],
        model: "qualification-only",
        effort: "max",
        upstream: "http://unused.invalid",
        expansionWidth: 1,
        tests: [{ id: "development-r1", total: 1 }],
        startupMs: 100,
        heartbeatMs: 100,
        probationMs: 0,
        evaluationConcurrency: 1,
      }),
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {configure} from ${JSON.stringify(path.join(import.meta.dir, "rsi-profile.ts"))}; await configure(${JSON.stringify(input.root)})`,
      ],
      { env: { PATH: process.env.PATH, OPENCODE_RSI_PROFILE: file }, stdout: "pipe", stderr: "pipe" },
    )
    expect(await child.exited).not.toBe(0)
    expect(await new Response(child.stderr).text()).toContain("freeze exactly one trusted grader or benchmark manifest")
  } finally {
    await fs.rm(input.root, { recursive: true, force: true })
  }
})
