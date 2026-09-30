import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OTA, hash, subject } from "./ota-rsi"
import type { Protocol } from "./ota-rsi"
const roots: string[] = []
const databases: OTA[] = []
afterEach(async () => {
  databases.splice(0).forEach((db) => db.db.close())
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})
async function fixture(width: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-lineage-"))
  roots.push(root)
  const protocol: Protocol = {
    trusted: hash("authority"),
    scope: "mechanics",
    performanceRule: "task-pareto",
    expansion: { width },
    tests: [{ id: "safety", total: 1 }],
    startupMs: 1000,
    heartbeatMs: 1000,
    probationMs: 1000,
  }
  const seed = { s: hash("s0"), h: hash("h0") }
  const file = path.join(root, "ota.sqlite")
  const ota = new OTA(file, protocol, seed)
  databases.push(ota)
  return { ota, file, protocol, seed }
}
function candidate(ota: OTA, name: string, passed = false) {
  const now = ota.read().clock + 10
  const job = ota.begin(ota.read().revision, now)
  const pair = { ...job.active.pair, [job.active.slot === "s" ? "h" : "s"]: hash(name) }
  ota.handedOff(job.revision, job.epoch, job.job!.id, now + 1)
  const state = ota.settle(
    ota.read().revision,
    pair,
    {
      protocol: ota.digest,
      subject: subject(pair),
      job: job.job!.id,
      receipt: hash(name + "receipt"),
      rows: [{ id: "safety", total: 1, passed: passed ? 1 : 0, valid: true }],
      baseline: { subject: subject(job.active.pair), rows: [{ id: "safety", total: 1, passed: 1, valid: true }] },
    },
    now + 2,
  )
  return { job, pair, state }
}

test("linear search extends rejected materialized children without deploying them", async () => {
  const { ota, seed } = await fixture(1)
  const a = candidate(ota, "a")
  const b = candidate(ota, "b")
  const c = candidate(ota, "c")
  expect(a.job.job!.source!.pair).toEqual(seed)
  expect(b.job.job!.source!.pair).toEqual(a.pair)
  expect(c.job.job!.source!.pair).toEqual(b.pair)
  expect(c.state.active.pair).toEqual(seed)
  expect(c.state.lineage?.map((node) => node.outcome)).toEqual(["rejected", "rejected", "rejected"])
  expect(Object.values(c.state.kernel.contracts).every((contract) => contract.status === "escalated")).toBe(true)
})

test("width two explores siblings then descendants with the same authority gate", async () => {
  const { ota, seed } = await fixture(2)
  const a = candidate(ota, "a")
  const b = candidate(ota, "b")
  const c = candidate(ota, "c")
  const d = candidate(ota, "d")
  const e = candidate(ota, "e")
  expect([a, b].map((value) => value.job.job!.source!.pair)).toEqual([seed, seed])
  expect([c, d].map((value) => value.job.job!.source!.pair)).toEqual([a.pair, a.pair])
  expect(e.job.job!.source!.pair).toEqual(b.pair)
  expect(ota.read().active.pair).toEqual(seed)
})

test("a selected descendant becomes the executor and starts the opposite source tree", async () => {
  const { ota } = await fixture(1)
  candidate(ota, "rejected")
  const selected = candidate(ota, "good", true)
  expect(selected.state.active.pair).toEqual(selected.pair)
  expect(selected.state.active.slot).toBe("h")
  expect(selected.state.kernel.contracts[selected.state.active.support!].status).toBe("discharged")
  const next = candidate(ota, "next-strategy")
  expect(next.job.job!.source).toEqual({ id: subject(selected.pair), pair: selected.pair })
  expect(next.pair.h).toBe(selected.pair.h)
})

test("lineage survives reopening and stale evidence cannot enter the graph", async () => {
  const f = await fixture(2)
  const a = candidate(f.ota, "a")
  const other = new OTA(f.file, f.protocol, f.seed)
  databases.push(other)
  expect(other.read().lineage).toEqual(f.ota.read().lineage)
  const job = other.begin(other.read().revision, 100)
  expect(job.job!.source!.pair).toEqual(f.seed)
  other.handedOff(job.revision, job.epoch, job.job!.id, 101)
  const before = other.read()
  expect(() =>
    other.settle(
      before.revision,
      { ...f.seed, h: hash("new") },
      {
        protocol: other.digest,
        subject: subject({ ...f.seed, h: hash("new") }),
        job: job.job!.id,
        receipt: hash("receipt"),
        rows: [{ id: "safety", passed: 1, total: 1, valid: true }],
        baseline: { subject: subject(a.pair), rows: [{ id: "safety", passed: 1, total: 1, valid: true }] },
      },
      102,
    ),
  ).toThrow("baseline")
  expect(other.read()).toEqual(before)
})

test("rollback preserves the job deadline and reselects source in the restored context", async () => {
  const { ota, seed } = await fixture(2)
  const selected = candidate(ota, "good", true)
  const job = ota.begin(selected.state.revision, 100)
  const reverted = ota.rollback(job.revision, "failed cold boot", 101)
  expect(reverted.job!.deadline).toBe(job.job!.deadline)
  expect(reverted.active.pair).toEqual(seed)
  expect(reverted.job!.source!.pair).toEqual(seed)
  expect(reverted.kernel.contracts[selected.state.active.support!].status).toBe("escalated")
})

test("identical rejected candidates cannot be re-sampled into promotion", async () => {
  const { ota, seed } = await fixture(2)
  const old = candidate(ota, "same")
  const job = ota.begin(ota.read().revision, 100)
  ota.handedOff(job.revision, job.epoch, job.job!.id, 101)
  const before = ota.read()
  expect(() =>
    ota.settle(
      before.revision,
      old.pair,
      {
        protocol: ota.digest,
        subject: subject(old.pair),
        job: job.job!.id,
        receipt: hash("new sample"),
        rows: [{ id: "safety", total: 1, passed: 1, valid: true }],
        baseline: { subject: subject(seed), rows: [{ id: "safety", total: 1, passed: 1, valid: true }] },
      },
      102,
    ),
  ).toThrow("already evaluated")
  expect(ota.read()).toEqual(before)
})
