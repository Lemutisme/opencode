import { expect, test } from "bun:test"
import path from "node:path"

test("gateway shutdown cannot wait on journal locks or deadlock under reentrant signals", async () => {
  const child = Bun.spawn(["/usr/bin/python3", "test/pro-contract/gateway-shutdown.py", "src/pro-contract/gateway.py"], {
    cwd: path.join(import.meta.dir, ".."),
    env: { PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stderr).toBe(0)
  expect(stdout).toBe("")
  expect(stderr).toContain("Ran 4 tests")
  expect(stderr.trimEnd().endsWith("OK")).toBe(true)
}, 15000)
