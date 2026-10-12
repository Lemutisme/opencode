import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"

const release = process.env.PROCONTRACT_RELEASE

test.skipIf(!release)(
  "task-only native execution retains a public counterexample across a fresh Session and independent discharge",
  async () => {
    await using directory = await tmpdir("contract-task-e2e-")
    const child = Bun.spawn(
      [
        process.execPath,
        "script/pro-contract-observation-qualify.ts",
        path.join(directory.path, "qualification"),
        release!,
        process.execPath,
        "--task-only",
      ],
      { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const result = JSON.parse(stdout)
    expect(result.taskOnly).toBe(true)
    expect(result.realModel).toBe(false)
    expect(result.performanceClaim).toBe(false)
    expect(result.result.contract.status).toBe("discharged")
    expect(result.comparisons).toBe(0)
    expect(new Set(result.sessions).size).toBe(3)
    expect(result.physicalRequests).toBe(36)
    expect(result.publicRepairFeedbackRetained).toBe(true)
    expect(result.originalShellFileEvicted).toBe(true)
    expect(result.summaryContainsCounterexample).toBe(false)
    expect(result.readOnlyArchive).toBe(true)
  },
  300000,
)
