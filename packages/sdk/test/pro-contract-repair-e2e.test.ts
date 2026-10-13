import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"

const release = process.env.PROCONTRACT_RELEASE

test.skipIf(!release)(
  "native startup repair and provider refusals settle without replay or unknown cleanup",
  async () => {
    await using directory = await tmpdir("contract-repair-e2e-")
    const child = Bun.spawn(
      [
        process.execPath,
        "script/pro-contract-repair-qualify.ts",
        path.join(directory.path, "qualification"),
        release!,
        process.execPath,
      ],
      {
        cwd: path.join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const result = JSON.parse(stdout)
    expect(result.realModel).toBe(false)
    expect(result.performanceClaim).toBe(false)
    expect(result.results.map((entry: { physicalRequests: number }) => entry.physicalRequests)).toEqual([3, 1, 1, 1, 1])
    expect(result.results[0].contract).toBe("discharged")
    for (const entry of result.results.slice(1)) {
      expect(entry.contract).toBe("escalated")
      expect(entry.executions).toBe(1)
      expect(entry.fence.acknowledged).toBe(true)
    }
    expect(result.results[1].endpoint.outcome).toBe("provider-refusal")
    expect(result.results[2].endpoint.outcome).toBe("provider-refusal")
  },
  300000,
)
