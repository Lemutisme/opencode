import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"

const release = process.env.PROCONTRACT_RELEASE

test.skipIf(!release)(
  "public raw shell evidence survives upstream eviction and a fresh read-only native Session",
  async () => {
    await using directory = await tmpdir("contract-observation-e2e-")
    const root = path.join(directory.path, "qualification")
    const child = Bun.spawn(
      [process.execPath, "script/pro-contract-observation-qualify.ts", root, release!, process.execPath],
      { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const result = JSON.parse(stdout)
    expect(result.result.contract.status).toBe("discharged")
    expect(new Set(result.sessions).size).toBe(2)
    expect(result.physicalRequests).toBe(34)
    expect(result.rawBytes).toBeGreaterThan(50 * 1024)
    expect(result.originalShellFileEvicted).toBe(true)
    expect(result.readOnlyArchive).toBe(true)
    expect(result.nativeTimeoutAndErrorRetained).toBe(true)
    expect(result.signalKillIsIncomplete).toBe(true)
    expect(result.summaryContainsCounterexample).toBe(false)
    expect(result.workspaceContainsObservationLogs).toBe(false)
  },
  300000,
)

test.skipIf(!release)(
  "fixed evaluations retain their own checkpoints without sharing original, side, test or repeat observations",
  async () => {
    await using directory = await tmpdir("contract-observation-isolation-")
    const root = path.join(directory.path, "qualification")
    const child = Bun.spawn(
      [process.execPath, "script/pro-contract-observation-isolation.ts", root, release!, process.execPath],
      { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const result = JSON.parse(stdout)
    expect(result.physicalRequests).toBe(20)
    expect(result.lineages).toHaveLength(5)
    expect(result.privateVerifierLeaked).toBe(false)
    expect(result.originalProtectedFromEvaluation).toBe(true)
    expect(result.sideTestAndRepeatIsolated).toBe(true)
    expect(result.acceptanceClaim).toBe(false)
  },
  300000,
)
