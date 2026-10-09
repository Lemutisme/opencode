import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Replay } from "./replay"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-replay-"))
  roots.push(root)
  return root
}

test("recorded cancellation 330 ms after the original endpoint does not retroactively cancel its diagnosis", () => {
  expect(Replay.boundary(1791530475564, 1791530475.8942568)).toEqual({
    diagnostic: true, observedAt: 1791530475564, cancelled: false,
  })
  expect(Replay.boundary(1791530475989, 1791530475.8942568).cancelled).toBe(true)
  expect(() => Replay.boundary(Number.NaN, 1)).toThrow("Invalid recorded diagnostic boundary")
})

test("inventory streams private sidecar bytes without displaying them or following links", async () => {
  const root = await setup()
  await fs.mkdir(path.join(root, "operations"))
  const data = new Uint8Array(1024 * 1024).fill(237)
  await Bun.write(path.join(root, "operations", "capture.stdout"), data)
  await fs.symlink("/not-an-existing-artifact", path.join(root, "unfollowed"))
  const before = await Replay.inventory(root)
  const sidecar = before.find((entry) => entry.path === "operations/capture.stdout")
  expect(sidecar?.sha256).toBe(Bun.SHA256.hash(data, "hex"))
  expect(before.find((entry) => entry.path === "unfollowed")?.target).toBe("/not-an-existing-artifact")
  expect(Replay.differences(before, await Replay.inventory(root))).toEqual([])
  await fs.utimes(path.join(root, "operations", "capture.stdout"), 1, 1)
  expect(Replay.differences(before, await Replay.inventory(root))).toEqual(["operations/capture.stdout"])
})

test("replay refuses outputs within historical custody before writing anything", async () => {
  const root = await setup()
  await expect(Replay.replay(root, path.join(root, "new-audit"))).rejects.toThrow("Audit output must be separate")
  expect(await fs.readdir(root)).toEqual([])
})

test("replay never overwrites an existing audit directory", async () => {
  const root = await setup()
  const output = await setup()
  await expect(Replay.replay(root, output)).rejects.toThrow()
  expect(await fs.readdir(output)).toEqual([])
})

const historical = process.env.PROCONTRACT_RECEIPT_REPLAY_ROOT
const output = process.env.PROCONTRACT_RECEIPT_REPLAY_OUTPUT
test.skipIf(!historical || !output)("actual stopped cohort replays read-only with complete artifact custody", async () => {
  const audit = await Replay.replay(historical!, output!)
  expect(audit.custody.unchanged).toBe(true)
  const hexyl = audit.diagnosis?.cases.find((entry) => entry.id === "2-rsi-r1")
  expect(hexyl?.recorded.errors).toEqual(["official.operations-present"])
  expect(hexyl?.historical.classification.outcome).toBe("scored")
  expect(hexyl?.historical.score).toEqual({ passed: 817, total: 906, valid: true })
  expect(hexyl?.historical.classification.errors).toEqual([])
  expect(hexyl?.present.classification.outcome).toBe("execution-fault")
  expect(hexyl?.present.classification.errors).toContain("terminal.not-cancelled")
  expect(hexyl?.expiryProbe.inspection.classification.errors).toContain("terminal.before-deadline")
  expect(hexyl?.provenance.hostErrorPresent).toBe(false)
  expect(hexyl?.provenance.boundary.cancelled).toBe(false)
  expect(hexyl?.provenance.presentTimeBeyondOriginalDeadline).toBe(true)
  expect(hexyl?.historical.artifacts.filter((entry) => entry.kind === "official-operation")).toHaveLength(167)
  expect(hexyl?.historical.artifacts.filter((entry) => entry.kind === "official-operation-stdout")).toHaveLength(12)
  for (const id of ["0-rsi-r1", "1-rsi-r1"]) {
    const entry = audit.diagnosis?.cases.find((item) => item.id === id)
    expect(entry?.historical.classification.outcome).toBe("cancelled")
    expect(entry?.historical.score).toEqual({ passed: null, total: null, valid: false })
    expect(entry?.historical.verification).toBe(null)
  }
}, 120000)
