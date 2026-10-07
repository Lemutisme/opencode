import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"

const release = process.env.PROCONTRACT_RELEASE

test.skipIf(!release)(
  "native policy succession reaches independent task discharge",
  async () => {
    await using directory = await tmpdir("contract-native-e2e-")
    const root = path.join(directory.path, "qualification")
    const child = Bun.spawn([process.execPath, "script/pro-contract-qualify.ts", root, release!, process.execPath], {
      cwd: path.join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const result = JSON.parse(stdout)
    expect(result.stages).toEqual([0, 1, 2])
    expect(result.result.contract.status).toBe("discharged")
    expect(result.comparisons).toBe(2)
    expect(result.physicalRequests).toBeGreaterThanOrEqual(46)
    expect(result.incompleteUsage).toBe(0)
  },
  300000,
)
