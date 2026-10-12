import { describe, expect, test } from "bun:test"
import { ProContract } from "@opencode/schema/pro-contract"
import { ContractLedger } from "../src/pro-contract/ledger"
import { ProContractKernel } from "../src/pro-contract/kernel"
import { tmpdir } from "./fixture/tmpdir"

const protocol = { kind: "task" as const, version: 1 as const, environment: "a".repeat(64) }
const method = { instructions: "Retain observations, repair the task and request independent acceptance." }
const id = ProContract.ID.make("pct_fixed_task")
const admission = () => ({
  id,
  goal: "Complete the original responsibility",
  deadline: Date.now() + 21600000,
  checkpoint: "b".repeat(64),
  identity: "fixed-task-definition",
})

describe("task responsibility without method research", () => {
  test("admits and reopens a fixed task without invented performance panels", async () => {
    await using directory = await tmpdir("task-only-ledger-")
    const file = directory.path + "/ledger.sqlite"
    const store = new ContractLedger.Store(file, protocol, method)
    const input = admission()
    store.issue(input)
    store.issue(input)
    const first = store.begin(id, "first")
    store.checkpoint(id, "first", "c".repeat(64), "Public mismatch remains unresolved")
    expect(store.read().protocol).toEqual(protocol)
    expect(store.read().protocol).not.toHaveProperty("performanceRule")
    expect(store.read().protocol).not.toHaveProperty("tests")
    expect(ProContractKernel.quiet(store.read().kernel, store.read().kernel.contracts[id].scope)).toBe(false)
    store.close()
    const reopened = new ContractLedger.Store(file, protocol, method)
    expect(reopened.read().tasks[id].feedback).toEqual(["Public mismatch remains unresolved"])
    expect(reopened.read().kernel.contracts[id].spec.budget).toEqual({ deadline: input.deadline })
    expect(reopened.begin(id, "second").method).toEqual(first.method)
    reopened.checkpoint(id, "second", "d".repeat(64), "Repaired public mismatch")
    reopened.settleTask(id, { passed: 1, total: 1, valid: true })
    expect(reopened.read().kernel.contracts[id].status).toBe("discharged")
    expect(reopened.read().kernel.contracts[id].handoff?.subjectHash).toBe("d".repeat(64))
    reopened.verify()
    reopened.close()
  })

  test("research and selection are rejected transactionally, not merely hidden in the UI", async () => {
    await using directory = await tmpdir("task-only-research-")
    const store = new ContractLedger.Store(directory.path + "/ledger.sqlite", protocol, method)
    store.issue(admission())
    const before = store.read()
    const candidate = { instructions: "A different method is not authorized by fixed-task admission." }
    expect(() => store.propose(id, before.active, candidate, "source")).toThrow("does not authorize method research")
    expect(() => store.select(before.active, candidate, [])).toThrow("does not authorize method selection")
    expect(store.read()).toEqual(before)
    store.verify()
    store.close()
  })

  test("self-handoff and unavailable evidence cannot discharge; public negative evidence keeps the deadline", async () => {
    await using directory = await tmpdir("task-only-evidence-")
    const store = new ContractLedger.Store(directory.path + "/ledger.sqlite", protocol, method)
    const input = admission()
    store.issue(input)
    store.begin(id, "native")
    expect(() => store.settleTask(id, { passed: 1, total: 1, valid: true })).toThrow("fenced work")
    store.checkpoint(id, "native", "c".repeat(64), "My own validate says ok")
    expect(store.read().kernel.contracts[id].status).toBe("active")
    expect(() => store.settleTask(id, { passed: 0, total: 1, valid: false })).toThrow("not a score")
    store.settleTask(id, { passed: 0, total: 1, valid: true, feedback: "Actual independent mismatch" })
    expect(store.read().kernel.contracts[id].status).toBe("active")
    expect(store.read().tasks[id].feedback).toContain("Actual independent mismatch")
    expect(store.read().kernel.contracts[id].spec.budget.deadline).toBe(input.deadline)
    store.close()
  })

  test("sealed negative evidence does not leak feedback or authorize another execution", async () => {
    await using directory = await tmpdir("task-only-sealed-")
    const store = new ContractLedger.Store(directory.path + "/ledger.sqlite", protocol, method)
    store.issue(admission())
    store.settleTask(id, { passed: 0, total: 1, valid: true, feedback: "PRIVATE_VERIFIER_DETAIL" }, "terminal")
    expect(store.read().kernel.contracts[id].status).toBe("escalated")
    expect(store.read().tasks[id].feedback).not.toContain("PRIVATE_VERIFIER_DETAIL")
    expect(() => store.begin(id, "hidden-test-retry")).toThrow("not active")
    store.close()
  })

  test("explicit resume requires acknowledged fencing and cannot renew admission", async () => {
    await using directory = await tmpdir("task-only-resume-")
    const store = new ContractLedger.Store(directory.path + "/ledger.sqlite", protocol, method)
    const input = admission()
    store.issue(input)
    store.begin(id, "unknown")
    store.interrupted(id, "Unknown ownership", false)
    expect(() => store.resume(id)).toThrow("fencing")
    store.interrupted(id, "Fencing acknowledged", true)
    store.resume(id)
    expect(store.read().kernel.contracts[id].spec.budget.deadline).toBe(input.deadline)
    expect(() => store.issue({ ...input, deadline: input.deadline + 1 })).toThrow("Conflicting task")
    store.close()
  })
})
