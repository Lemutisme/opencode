import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  Audit,
  auditGrades,
  auditTasks,
  readAuditSource,
  requireAuditSource,
  requireAuditOwner,
  stopAuditForRecovery,
} from "./rsi-audit"
import type { AuditResult, AuditTest } from "./rsi-audit"
import { hash, OTA, SIX_HOURS, subject } from "../../core/script/ota-rsi"
import type { Evidence, Protocol, State } from "../../core/script/ota-rsi"

const directories: string[] = []
const databases: { db: { close(): void } }[] = []
afterEach(async () => {
  databases.splice(0).forEach((item) => item.db.close())
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})
const tests = [
  { id: "audit/rep-1", total: 10 },
  { id: "audit/rep-2", total: 10 },
]
const seed = { s: hash("seed strategy"), h: hash("seed harness") }
const protocol: Protocol = {
  trusted: hash("frozen test authority"),
  scope: "mechanics",
  minimumMeanGainBps: 1,
  tests: [{ id: "safety", total: 1 }],
  startupMs: 1000,
  heartbeatMs: 1000,
  probationMs: 1000,
}
const score = (passed = 5): AuditResult => ({
  passed,
  total: 10,
  valid: true,
  accounting: { source: "retained-accounting.json", knownCost: null, incomplete: true },
})

async function fixture(input: ReadonlyArray<AuditTest> = tests) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-audit-"))
  directories.push(root)
  const sourceFile = path.join(root, "source.sqlite")
  const ota = new OTA(sourceFile, protocol, seed)
  databases.push(ota)
  const begun = ota.begin(ota.read().revision, 1)
  ota.handedOff(begun.revision, begun.epoch, begun.job!.id, 2)
  const pair = { ...seed, h: hash("selected harness") }
  const evidence: Evidence = {
    protocol: ota.digest,
    subject: subject(pair),
    job: begun.job!.id,
    receipt: hash("test evidence"),
    rows: [{ id: "safety", total: 1, passed: 1, valid: true }],
    baseline: { subject: subject(seed), rows: [{ id: "safety", total: 1, passed: 1, valid: true }] },
  }
  ota.settle(ota.read().revision, pair, evidence, 3)
  const successor = ota.begin(ota.read().revision, 4)
  ota.handedOff(successor.revision, successor.epoch, successor.job!.id, 5)
  ota.stop(ota.read().revision, "recursive closure completed", 6)
  const file = path.join(root, "audit.sqlite")
  const source = readAuditSource(sourceFile)
  const audit = new Audit(file, source, input, hash("frozen audit authority"))
  databases.push(audit)
  return { root, file, sourceFile, source, ota, audit }
}

function mutate(ota: OTA, change: (state: State) => void) {
  const state = ota.read()
  change(state)
  ota.db.query("UPDATE ota_state SET value=? WHERE id=1").run(JSON.stringify(state))
}

function complete(audit: Audit, values: ReadonlyArray<number>) {
  values.forEach((value, index) => {
    const begun = audit.begin(100 + index * 2)
    const assignment = begun.assignments.find((item) => item.status === "active")!
    audit.settle(assignment.id, score(value), 101 + index * 2)
  })
}

test("audit freezes the exact stopped source without writing it", async () => {
  const { audit, source, ota } = await fixture()
  const before = ota.db.query<{ value: string }, []>("SELECT value FROM ota_state WHERE id=1").get()!.value
  const events = ota.history()
  expect(source.stateHash).toBe(hash(before))
  complete(audit, [4, 6, 5, 7])
  expect(ota.db.query<{ value: string }, []>("SELECT value FROM ota_state WHERE id=1").get()!.value).toBe(before)
  expect(ota.history()).toEqual(events)
  expect(audit.read().source.pair).toEqual(ota.read().active.pair)
  expect(audit.read().source.seed).toEqual(seed)
})

test.each(["stopped", "trial", "task", "support", "attestation"])(
  "source %s cannot substitute for completed recursive closure",
  async (kind) => {
    const { ota, sourceFile } = await fixture()
    mutate(ota, (state) => {
      if (kind === "stopped") state.stopped = "cancelled"
      if (kind === "trial") state.trial = true
      if (kind === "task")
        state.task = {
          id: "task",
          contractID: "pct_test_task",
          checkpoint: hash("checkpoint"),
          needsContinuation: false,
          status: "delivered",
        }
      if (kind === "support") state.active.support = undefined
      if (kind === "attestation") state.kernel = { ...state.kernel, attestations: {} }
    })
    expect(() => readAuditSource(sourceFile)).toThrow()
  },
)

test("exactly two distinct frozen repeat IDs and denominators are required", async () => {
  const { root, source } = await fixture()
  for (const assignments of [
    tests.slice(0, 1),
    [...tests, { id: "extra", total: 10 }],
    [tests[0], tests[0]],
    [
      { id: "one", total: 10 },
      { id: "two", total: 11 },
    ],
  ]) {
    expect(() => new Audit(path.join(root, "invalid.sqlite"), source, assignments, hash("authority"))).toThrow(
      "exactly two",
    )
  }
})

test("evaluation-only Kernel admission preserves original allowance and cannot overlap or change pairs", async () => {
  const { audit, source } = await fixture()
  const begun = audit.begin(100)
  const assignment = begun.assignments.find((item) => item.status === "active")!
  expect(begun.assignments.map((item) => item.arm)).toEqual(["seed", "final", "seed", "final"])
  expect(assignment.pair).toEqual(source.seed)
  const contract = begun.kernel.contracts[assignment.contractID!]
  expect(contract.status).toBe("active")
  expect(contract.spec.budget).toEqual({ deadline: 100 + SIX_HOURS })
  expect(contract.spec.goal).toContain("no search feedback or deployment")
  expect(contract.spec.evidence.claim).toContain("not a claim of improvement")
  expect(contract.spec.authority).toEqual([])
  expect(() => audit.begin(101)).toThrow("already active")
  assignment.pair.h = hash("not deployed")
  expect(audit.read().assignments[0].pair).toEqual(source.seed)
})

test("a valid zero or partial score discharges evaluation, not task success", async () => {
  const { audit } = await fixture()
  const begun = audit.begin(100)
  const assignment = begun.assignments[0]
  const settled = audit.settle(assignment.id, score(0), 101)
  expect(settled.kernel.contracts[assignment.contractID!].status).toBe("discharged")
  expect(settled.assignments[0].result!.passed).toBe(0)
  expect(audit.report().valid).toBe(false)
  expect(audit.report().means).toEqual({ seed: null, final: null })
  expect(audit.report().accounting[0].accounting).toEqual(score().accounting)
  expect(() => audit.settle(assignment.id, score(10), 102)).toThrow("not active")
})

test("complete paired audit reports task-Pareto gain once, with no deployment or search feedback", async () => {
  const { audit } = await fixture()
  complete(audit, [4, 6, 5, 7])
  const report = audit.report()
  expect(report.valid).toBe(true)
  expect(report.means.seed).toBeCloseTo(0.45)
  expect(report.means.final).toBeCloseTo(0.65)
  expect(report.delta).toBeCloseTo(0.2)
  expect(report.netImprovement).toBe(true)
  expect(report.promoted).toBe(false)
  expect(report.searchFeedback).toBe(false)
  expect(Object.values(audit.read().kernel.contracts).map((contract) => contract.status)).toEqual(
    Array(4).fill("discharged"),
  )
  expect(() => audit.begin(1000)).toThrow("no replay")
})

test.each([{ values: [5, 5, 5, 5] }, { values: [9, 8, 9, 8] }, { values: [0, 1, 3, 2] }])(
  "ties and regression are not improvements: %j",
  async (input) => {
    const { audit } = await fixture()
    complete(audit, input.values)
    expect(audit.report().valid).toBe(true)
    expect(audit.report().netImprovement).toBe(false)
  },
)

test.each(["missing", "denominator", "fractional", "accounting"])(
  "invalid %s evidence escalates without inventing a score",
  async (kind) => {
    const { audit } = await fixture()
    const begun = audit.begin(100)
    const result = score()
    if (kind === "missing") result.valid = false
    if (kind === "denominator") result.total = 9
    if (kind === "fractional") result.passed = 5.1
    if (kind === "accounting") result.accounting = { source: "", knownCost: null, incomplete: true }
    const settled = audit.settle(begun.assignments[0].id, result, 101)
    expect(settled.kernel.contracts[begun.assignments[0].contractID!].status).toBe("escalated")
    expect(audit.report().valid).toBe(false)
    expect(audit.report().netImprovement).toBeNull()
    expect(audit.report().means).toEqual({ seed: null, final: null })
    expect(settled.assignments[1].status).toBe("pending")
    expect(() => audit.begin(102)).toThrow("no replay")
  },
)

test("original deadline and explicit cancellation close admission without renewing allowance", async () => {
  const { audit } = await fixture()
  const begun = audit.begin(100)
  const assignment = begun.assignments[0]
  const settled = audit.settle(assignment.id, score(10), assignment.deadline!)
  expect(settled.stopped).toContain("deadline")
  expect(settled.assignments[0].deadline).toBe(100 + SIX_HOURS)
  expect(settled.kernel.contracts[assignment.contractID!].status).toBe("escalated")
  const next = await fixture()
  const active = next.audit.begin(200)
  const cancelled = next.audit.stop("cancelled", 201)
  expect(cancelled.assignments[0].deadline).toBe(active.assignments[0].deadline)
  expect(cancelled.kernel.contracts[active.assignments[0].contractID!].status).toBe("escalated")
})

test("source mutation forbids new admission and settlement even when pair bytes did not change", async () => {
  const { audit, ota, source } = await fixture()
  mutate(ota, (state) => {
    state.revision += 1
  })
  expect(() => requireAuditSource(source)).toThrow("snapshot changed")
  expect(() => audit.begin(100)).toThrow("snapshot changed")
  expect(audit.read().revision).toBe(0)
  const active = await fixture()
  const begun = active.audit.begin(100)
  mutate(active.ota, (state) => {
    state.clock += 1
  })
  expect(() => active.audit.settle(begun.assignments[0].id, score(10), 101)).toThrow("snapshot changed")
  const stopped = active.audit.stop("source changed", 102)
  expect(stopped.kernel.contracts[begun.assignments[0].contractID!].status).toBe("escalated")
})

test("an existing ledger is never reopened for retries, added tasks or a changed pair", async () => {
  const { audit, source, file } = await fixture()
  const before = audit.read()
  expect(() => new Audit(file, source, tests, hash("other authority"))).toThrow("already exists")
  expect(audit.read()).toEqual(before)
})

test("audit uses trusted dataset identity, not test labels, for isolation", async () => {
  const selection: Protocol["tests"] = [
    { id: "dev", total: 10, performance: { panel: "development", task: "dev", replicate: "one" } },
    { id: "confirm", total: 10, performance: { panel: "confirmation", task: "confirm", replicate: "one" } },
  ]
  const task = (test: { id: string }) => ({
    identity: test.id.startsWith("audit/") ? "audit-instance" : test.id + "-instance",
    goal: "public task",
    artifact: "submission",
  })
  const frozen = await auditTasks(tests, selection, task)
  expect(frozen.identity).toBe("audit-instance")
  expect(frozen.audit).toHaveLength(2)
  expect(frozen.selection).toHaveLength(2)
  await expect(auditTasks(tests, selection, () => ({ goal: "no identity", artifact: "submission" }))).rejects.toThrow(
    "explicit dataset identity",
  )
  await expect(auditTasks(tests, selection, (test) => ({ ...task(test), identity: test.id }))).rejects.toThrow(
    "one instance identity",
  )
  await expect(
    auditTasks(tests, selection, (test) => ({
      ...task(test),
      identity: test.id === "confirm" ? "audit-instance" : task(test).identity,
    })),
  ).rejects.toThrow("renamed IDs are not isolation")
})

test("selection safety instances are also excluded from final audit", async () => {
  const selection: Protocol["tests"] = [{ id: "safety-row", total: 1 }]
  const task = (test: { id: string }) => ({
    identity: test.id === "safety-row" ? "@native/containment" : "audit-instance",
    goal: "public",
    artifact: "submission",
  })
  expect((await auditTasks(tests, selection, task)).selection).toEqual([
    { id: "safety-row", identity: "@native/containment" },
  ])
  await expect(
    auditTasks(tests, selection, () => ({ identity: "audit-instance", goal: "public", artifact: "submission" })),
  ).rejects.toThrow("renamed IDs are not isolation")
  await expect(
    auditTasks(tests, selection, (test) => ({
      ...task(test),
      identity: test.id === "safety-row" ? undefined : "audit-instance",
    })),
  ).rejects.toThrow("explicit dataset identity")
})

test("explicit audit recovery escalates outstanding evaluations without replay or source writes", async () => {
  const { audit, file, ota } = await fixture()
  const begun = audit.begin(100)
  const source = ota.read()
  const state = stopAuditForRecovery(file, 101)
  expect(state.stopped).toBe("explicit audit recovery; no allocation replay")
  expect(state.assignments).toHaveLength(4)
  expect(state.assignments[0].deadline).toBe(begun.assignments[0].deadline)
  expect(state.assignments[0].pair).toEqual(begun.assignments[0].pair)
  expect(state.kernel.contracts[state.assignments[0].contractID!].status).toBe("escalated")
  expect(Object.keys(state.kernel.contracts)).toHaveLength(1)
  expect(ota.read()).toEqual(source)
  expect(() => audit.begin(102)).toThrow("no replay")
  const event = JSON.parse(
    audit.db.query<{ value: string }, []>("SELECT value FROM rsi_audit_event ORDER BY sequence DESC LIMIT 1").get()!
      .value,
  )
  expect(event.type).toBe("explicit-fence")
  expect(event.commands.map((command: { type: string }) => command.type)).toEqual(["escalate"])
  expect(stopAuditForRecovery(file, 103)).toEqual(state)
})

test("audit recovery preserves completed ledger and refuses to initialize a missing one", async () => {
  const { audit, file, root } = await fixture()
  complete(audit, [4, 6, 5, 7])
  const before = audit.read()
  expect(stopAuditForRecovery(file, 1000)).toEqual(before)
  expect(audit.read()).toEqual(before)
  const missing = path.join(root, "never-initialize.sqlite")
  expect(() => stopAuditForRecovery(missing, 1000)).toThrow()
  expect(await Bun.file(missing).exists()).toBe(false)
})

test("audit recovery discovers only host metadata and rejects symlink redirection", async () => {
  const { root } = await fixture()
  const grade = path.join(root, "native", "worker", "grades", "grade")
  await fs.mkdir(grade, { recursive: true, mode: 0o700 })
  await Bun.write(path.join(grade, "control.json"), JSON.stringify({ root: grade, token: "a".repeat(32) }))
  const candidate = path.join(root, "native", "worker", "candidate", "workspace", "grades", "fake")
  await fs.mkdir(candidate, { recursive: true, mode: 0o700 })
  await Bun.write(path.join(candidate, "control.json"), "candidate is never recovery authority")
  expect(await auditGrades(root)).toEqual([grade])
  await fs.symlink(grade, path.join(root, "native", "redirect"))
  await expect(auditGrades(root)).rejects.toThrow("symlink")
})

test("audit rejects adoption by a replacement owner before new allocation", () => {
  expect(() => requireAuditOwner(process.ppid)).not.toThrow()
  expect(() => requireAuditOwner(1)).toThrow("original audit owner")
  expect(() => requireAuditOwner(process.pid)).toThrow("original audit owner")
})

test("fence-only CLI needs no profile or model credential and creates no allocation", async () => {
  const { audit, root, ota } = await fixture()
  const begun = audit.begin(100)
  const source = ota.read()
  const bin = path.join(root, "test-tools")
  await fs.mkdir(bin)
  // A recorded no-op transport, explicitly not a Docker daemon.
  const calls = path.join(root, "docker-calls.txt")
  await fs.writeFile(
    path.join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
`,
    { mode: 0o500 },
  )
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "rsi-audit.ts"), root, "--fence"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, OPENCODE_RSI_PROFILE: "/must-not-load-profile" },
  })
  const output = await new Response(child.stdout).text()
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
  expect(JSON.parse(output)).toMatchObject({ acknowledged: true, action: "fence-only", allocations: 0 })
  const commands = (await Bun.file(calls).text()).trim().split("\n")
  expect(commands).toHaveLength(2)
  expect(commands.every((line) => line.startsWith("ps -aq --filter label=opencode.rsi="))).toBe(true)
  expect(audit.read().assignments[0].deadline).toBe(begun.assignments[0].deadline)
  expect(Object.keys(audit.read().kernel.contracts)).toHaveLength(1)
  expect(ota.read()).toEqual(source)
}, 20_000)
