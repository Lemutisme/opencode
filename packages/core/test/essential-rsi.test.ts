import { describe, expect, test } from "bun:test"
import { ProContract } from "@opencode/schema/pro-contract"
import { ContractLedger } from "../src/pro-contract/ledger"
import { ProContractKernel } from "../src/pro-contract/kernel"
import { RSI } from "../src/pro-contract/rsi"
import { tmpdir } from "./fixture/tmpdir"

const protocol = RSI.protocol({
  version: 1,
  environment: "a".repeat(64),
  performanceRule: "task-pareto",
  tests: [
    { id: "safety", panel: "safety", repeats: 1, total: 1 },
    { id: "dev", panel: "development", repeats: 2, total: 10 },
    { id: "confirm", panel: "confirmation", repeats: 2, total: 10 },
  ].map((test) => ({ ...test, checkpoint: "b".repeat(64), verifier: "e".repeat(64) })),
})
const seed = { instructions: "Investigate the task, retain public evidence, and submit independently verifiable work." }
const successor = {
  instructions: "Retain counterexamples across checkpoints, repair their cause and recheck before submitting.",
}
const id = ProContract.ID.make("pct_original")
const input = () => ({
  id,
  goal: "Deliver the original task",
  deadline: Date.now() + 21600000,
  checkpoint: "b".repeat(64),
  identity: "task-definition",
})
const rows = (baseline = 5, candidate = 6): RSI.Measurement[] =>
  protocol.tests.flatMap((item) =>
    (["baseline", "candidate"] as const).flatMap((side) =>
      Array.from({ length: item.repeats }, (_, repeat) => ({
        side,
        test: item.id,
        repeat,
        passed: item.panel === "safety" ? 1 : side === "baseline" ? baseline : candidate,
        total: item.total,
        valid: true,
        artifact: RSI.hash({ side, repeat }),
        execution: RSI.hash({ side, repeat, test: item.id }),
        verification: RSI.hash({ side, repeat, verifier: item.id }),
      })),
    ),
  )

function evidence(store: ContractLedger.Store, candidate: RSI.Method, rows: RSI.Measurement[]) {
  const state = store.read()
  const base = {
    id: "proposal",
    task: id,
    parent: state.active,
    method: state.active.hash,
    input: state.tasks[id].checkpoint,
    output: state.tasks[id].checkpoint,
    deadline: state.kernel.contracts[id].spec.budget.deadline,
    evaluation: false,
    fenced: true,
    handoff: { action: "propose", summary: "Test proposal", method: candidate },
  }
  store.propose(id, state.active, candidate, store.object(base))
  return rows.map((row) => ({
    ...row,
    execution: store.object({
      ...base,
      id: `${row.side}-${row.test}-${row.repeat}`,
      evaluation: true,
      method: row.side === "baseline" ? state.active.hash : RSI.hash(candidate),
      input: protocol.tests.find((test) => test.id === row.test)!.checkpoint,
      output: row.artifact,
      assignment: { side: row.side, test: row.test, repeat: row.repeat },
      handoff: { action: "submit", summary: "Test measurement" },
    }),
    verification: store.object({
      artifact: row.artifact,
      verifier: "e".repeat(64),
      passed: row.passed,
      total: row.total,
      valid: row.valid,
    }),
  }))
}

describe("minimal RSI evidence gate", () => {
  test("accepts any strict task-level gain without a regression, rejects all ties", () => {
    expect(RSI.compare(protocol, rows()).eligible).toBe(true)
    expect(RSI.compare(protocol, rows(5, 5)).reasons).toContain("no-strict-improvement")
  })
  test("an aggregate gain cannot hide a task regression", () => {
    const evidence = rows(5, 10).map((row) =>
      row.side === "candidate" && row.test === "confirm" ? { ...row, passed: 4 } : row,
    )
    expect(RSI.compare(protocol, evidence).reasons).toContain("regression:confirm")
  })
  test("safety and established full passes remain mandatory", () => {
    const unsafe = rows().map((row) =>
      row.test === "safety" && row.side === "candidate" ? { ...row, passed: 0 } : row,
    )
    expect(RSI.compare(protocol, unsafe).reasons).toContain("safety:safety")
    expect(RSI.compare(protocol, rows(), ["dev"]).reasons).toContain("full-pass-lost:dev")
    expect(() => RSI.compare(protocol, rows(), ["lost-task"])).toThrow("missing an established")
  })
  test("rejects missing, duplicate, recycled, invalid and foreign measurements", () => {
    const evidence = rows()
    expect(() => RSI.compare(protocol, evidence.slice(1))).toThrow("Incomplete")
    expect(() => RSI.compare(protocol, [...evidence.slice(1), evidence[1]])).toThrow("Duplicate")
    expect(() =>
      RSI.compare(
        protocol,
        evidence.map((row) => ({ ...row, execution: "a".repeat(64) })),
      ),
    ).toThrow("distinct execution")
    expect(() =>
      RSI.compare(
        protocol,
        evidence.map((row, index) => (index ? row : { ...row, valid: false })),
      ),
    ).toThrow("invalid")
    expect(() =>
      RSI.compare(
        protocol,
        evidence.map((row, index) => (index ? row : { ...row, total: 2 })),
      ),
    ).toThrow("mismatched")
  })
  test("requires independent panels and repeats; policy is bounded but has no action allowance", () => {
    expect(() =>
      RSI.protocol({ ...protocol, tests: protocol.tests.filter((row) => row.panel !== "confirmation") }),
    ).toThrow("confirmation")
    expect(() => RSI.protocol({ ...protocol, tests: protocol.tests.map((row) => ({ ...row, repeats: 1 })) })).toThrow(
      "two fixed",
    )
    expect(() => RSI.method({ instructions: " " })).toThrow("nonempty")
    expect(() => RSI.method({ instructions: "\0" })).toThrow("NUL")
    expect(() => RSI.method({ instructions: "a".repeat(65537) })).toThrow("65536")
    expect(() => RSI.method({ instructions: "ok", turns: 1000 })).toThrow()
  })
})

describe("responsibility survives method evolution", () => {
  test("terminal benchmark verification retains a partial score without another solve admission", async () => {
    await using directory = await tmpdir("essential-terminal-")
    const store = new ContractLedger.Store(directory.path + "/ledger.sqlite", protocol, seed)
    const admission = input()
    store.issue(admission)
    store.settleTask(id, { passed: 4, total: 10, valid: true, feedback: "PRIVATE_DIAGNOSTIC" }, "terminal")
    expect(store.read().kernel.contracts[id].status).toBe("escalated")
    expect(store.read().kernel.contracts[id].challenge?.disclosure).toBe("sealed")
    expect(store.read().tasks[id].feedback).not.toContain("PRIVATE_DIAGNOSTIC")
    expect(store.read().kernel.contracts[id].spec.budget.deadline).toBe(admission.deadline)
    expect(() => store.begin(id, "extra-solve")).toThrow("not active")
    store.close()
  })
  test("selection requires admitted, producer-bound execution and verifier receipts", async () => {
    await using directory = await tmpdir("essential-binding-")
    const store = new ContractLedger.Store(directory.path + "/ledger.sqlite", protocol, seed)
    store.issue(input())
    const parent = store.read().active
    expect(() => store.select(parent, successor, rows())).toThrow("not admitted")
    const bound = evidence(store, successor, rows())
    const forged = bound.map((row, index) => (index === 1 ? { ...row, passed: row.passed + 1 } : row))
    expect(() => store.select(parent, successor, forged)).toThrow("not bound")
    expect(store.read().active).toEqual(parent)
    expect(store.read().compared).toHaveLength(0)
    const source = Object.values(store.read().proposals)[0].source
    expect(() => store.propose(id, parent, successor, source)).toThrow("already has a comparison")
    expect(store.select(parent, successor, bound).eligible).toBe(true)
    store.verify()
    store.close()
  })

  test("event-chain corruption is not silently adopted on reopen", async () => {
    await using directory = await tmpdir("essential-integrity-")
    const file = directory.path + "/ledger.sqlite"
    const store = new ContractLedger.Store(file, protocol, seed)
    store.issue(input())
    store.db.query("UPDATE event SET previous = 'changed' WHERE seq = 2").run()
    expect(() => store.verify()).toThrow("event-chain")
    store.close()
    expect(() => new ContractLedger.Store(file, protocol, seed)).toThrow("event-chain")
  })

  test("persists exact admission, checkpoints, successor use and independent completion", async () => {
    await using directory = await tmpdir("essential-ledger-")
    const file = directory.path + "/ledger.sqlite"
    const store = new ContractLedger.Store(file, protocol, seed)
    const admission = input()
    store.issue(admission)
    store.issue(admission)
    expect(Object.keys(store.read().tasks)).toHaveLength(1)
    expect(() => store.issue({ ...admission, goal: "Changed task" })).toThrow("Conflicting")
    const first = store.begin(id, "run-1")
    expect(() => store.begin(id, "run-2")).toThrow("Unclosed")
    expect(() => store.checkpoint(id, "run-2", "bad", "wrong identity")).toThrow("Stale")
    store.checkpoint(id, "run-1", "c".repeat(64), "Public counterexample retained")
    const decision = store.select(first.method, successor, evidence(store, successor, rows()))
    expect(decision.eligible).toBe(true)
    expect(store.read().kernel.contracts[id].status).toBe("active")
    expect(store.read().kernel.contracts[id].spec.budget).toEqual({ deadline: admission.deadline })
    const next = store.begin(id, "run-2")
    expect(next.method.hash).toBe(RSI.hash(successor))
    expect(store.read().methods[next.method.hash]).toEqual(successor)
    store.checkpoint(id, "run-2", "d".repeat(64), "Repaired and checked")
    store.settleTask(id, { passed: 10, total: 10, valid: true })
    expect(store.read().kernel.contracts[id].status).toBe("discharged")
    store.withdraw(decision.evaluation, "Evaluation was invalidated")
    expect(() => store.assertMethod(store.read(), next.method)).toThrow("withdrawn")
    expect(store.read().kernel.contracts[id].status).toBe("discharged")
    store.close()
    const reopened = new ContractLedger.Store(file, protocol, seed)
    expect(reopened.read().tasks[id].feedback).toContain("Public counterexample retained")
    expect(reopened.read().kernel.contracts[id].spec.budget.deadline).toBe(admission.deadline)
    reopened.close()
  })
  test("negative comparisons are measurements, not adoptions or successful task completion", async () => {
    await using directory = await tmpdir("essential-negative-")
    const store = new ContractLedger.Store(directory.path + "/ledger.sqlite", protocol, seed)
    store.issue(input())
    const original = store.read().active
    const decision = store.select(original, successor, evidence(store, successor, rows(7, 6)))
    expect(decision.eligible).toBe(false)
    expect(store.read().active).toEqual(original)
    expect(store.read().kernel.contracts[decision.evaluation].status).toBe("discharged")
    expect(store.read().kernel.contracts[id].status).toBe("active")
    expect(() => store.select(original, successor, rows(1, 10))).toThrow("already compared")
    expect(ProContractKernel.quiet(store.read().kernel, RSI.hash(protocol))).toBe(false)
    store.close()
  })
  test("failed task verification feeds back without resetting responsibility or deadline", async () => {
    await using directory = await tmpdir("essential-feedback-")
    const store = new ContractLedger.Store(directory.path + "/ledger.sqlite", protocol, seed)
    const admission = input()
    store.issue(admission)
    store.settleTask(id, { passed: 1, total: 2, valid: true, feedback: "Unicode case still fails" })
    expect(store.read().kernel.contracts[id].status).toBe("active")
    expect(store.read().tasks[id].feedback).toContain("Unicode case still fails")
    expect(store.read().kernel.contracts[id].spec.budget.deadline).toBe(admission.deadline)
    expect(() => store.settleTask(id, { passed: 0, total: 2, valid: false })).toThrow("not a score")
    store.close()
  })
  test("unknown cleanup cannot resume, fenced interruption can; expiry cannot be renewed", async () => {
    await using directory = await tmpdir("essential-interruption-")
    const store = new ContractLedger.Store(directory.path + "/ledger.sqlite", protocol, seed)
    store.issue(input())
    store.begin(id, "unacknowledged")
    store.interrupted(id, "Process state unknown", false)
    expect(() => store.resume(id)).toThrow("fencing")
    store.interrupted(id, "Owner explicitly fenced", true)
    store.resume(id)
    expect(store.read().kernel.contracts[id].status).toBe("active")
    expect(() => store.issue({ ...input(), id: ProContract.ID.make("pct_expired"), deadline: Date.now() - 1 })).toThrow(
      "deadline",
    )
    expect(store.read().tasks.pct_expired).toBeUndefined()
    store.close()
  })
})
