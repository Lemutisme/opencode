import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RSINative } from "./rsi-native"
import { RSIRuntime } from "./rsi-runtime"

test("host control cancellation drains its actual child before returning", async () => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60)
  try {
    await expect(
      RSIRuntime.run(["python3", "-I", "-c", "import time;time.sleep(30)"], { signal: controller.signal }),
    ).rejects.toThrow()
    expect(controller.signal.aborted).toBe(true)
  } finally {
    clearTimeout(timer)
  }
})

test("handoff import rejects symlinks, hardlinks, oversized records and self-attestation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-boundary-"))
  try {
    const valid = {
      digest: "a".repeat(64),
      summary: "proposal, not performance",
      deadline: 1000,
      authoritativeCompletion: false as const,
    }
    const file = path.join(root, "handoff.json")
    await Bun.write(file, JSON.stringify(valid))
    expect(await RSINative.readHandoff(file)).toEqual(valid)
    const link = path.join(root, "link")
    await fs.symlink(file, link)
    await expect(RSINative.readHandoff(link)).rejects.toThrow()
    const hard = path.join(root, "hard")
    await fs.link(file, hard)
    await expect(RSINative.readHandoff(file)).rejects.toThrow("invalid handoff")
    await fs.unlink(hard)
    await Bun.write(file, JSON.stringify({ ...valid, authoritativeCompletion: true }))
    await expect(RSINative.readHandoff(file)).rejects.toThrow()
    await Bun.write(file, "x".repeat(1024 * 1024 + 1))
    await expect(RSINative.readHandoff(file)).rejects.toThrow("invalid handoff")
    await Bun.write(file, JSON.stringify({ ...valid, digest: "not-a-hash" }))
    await expect(RSINative.readHandoff(file)).rejects.toThrow("coordinates")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("release references cannot redirect through a symlink or silently change bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-reference-"))
  try {
    const file = path.join(root, "file")
    await Bun.write(file, "original")
    const ref = await RSIRuntime.ref(file)
    expect(await RSIRuntime.checked(ref)).toBe(file)
    const link = path.join(root, "link")
    await fs.symlink(file, link)
    await expect(RSIRuntime.checked({ ...ref, path: link })).rejects.toThrow("changed")
    await Bun.write(file, "changed")
    await expect(RSIRuntime.checked(ref)).rejects.toThrow("changed")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
