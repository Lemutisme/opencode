import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const binary = process.env.OPENCODE_TEST_BINARY

test.skipIf(!binary)("compiled Contract command exposes its isolated entrypoint", async () => {
  const child = Bun.spawn([binary!, "contract", "--help"], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code).toBe(0)
  expect(stderr).toBe("")
  expect(stdout).toContain("evidence-gated policy succession")
  expect(stdout).toContain("--profile")
})

test.skipIf(!binary)("compiled cancellation is explicit and scoped without loading model configuration", async () => {
  const root = await fs.mkdtemp("/tmp/contract-cli-")
  try {
    const child = Bun.spawn([binary!, "contract", "cancel", root], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(0)
    expect(stderr).toBe("")
    expect(JSON.parse(stdout)).toEqual({ cancelled: root })
    expect(await fs.readdir(root)).toEqual(["CANCEL"])
    expect(await Bun.file(path.join(root, "CANCEL")).text()).toContain("Explicit cancellation")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
