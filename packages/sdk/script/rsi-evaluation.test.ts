import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { closeEvaluation, Evaluation, stopEvaluationForRecovery } from "./rsi-evaluation"
import type { EvaluationPlan } from "./rsi-evaluation"
import { hash, SIX_HOURS } from "../../core/script/ota-rsi"

const directories: string[] = []
const databases: Evaluation[] = []
afterEach(async () => {
  databases.splice(0).forEach((evaluation) => evaluation.db.close())
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})
const plan: EvaluationPlan = {
  kind: "fixed-pair-evaluation-v1",
  purpose: "measurement-only",
  profile: { path: "/frozen/profile.json", sha256: hash("profile") },
  pair: { s: hash("admitted s"), h: hash("admitted h") },
  assignments: [
    { id: "t1", total: 1, task: "airline-34", replicate: "1" },
    { id: "t2", total: 1, task: "airline-34", replicate: "2" },
  ],
}
const source = { plan: { path: "/frozen/plan.json", sha256: hash("plan") }, profile: plan.profile }
const score = (passed = 0) => ({
  passed,
  total: 1,
  valid: true,
  accounting: { source: "actual-ledger.json", knownCost: null, incomplete: true },
})
async function fixture(input = plan) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-evaluation-"))
  directories.push(root)
  const file = path.join(root, "evaluation.sqlite")
  const evaluation = new Evaluation(file, input, source, hash("trusted"))
  databases.push(evaluation)
  return { root, file, evaluation }
}

test("fixed-pair measurement issues a real task-specific Contract, never a proposal or audit", async () => {
  const { evaluation } = await fixture()
  const state = evaluation.begin(100)
  const assignment = state.assignments[0]
  expect(assignment.deadline).toBe(100 + SIX_HOURS)
  expect(assignment.pair).toEqual(plan.pair)
  const contract = state.kernel.contracts[assignment.contractID!]
  expect(contract.status).toBe("active")
  expect(contract.spec.goal).toContain("official measurement")
  expect(contract.spec.budget).toEqual({ deadline: 100 + SIX_HOURS })
  expect(contract.spec.resolution.maxAttempts).toBe(1)
  expect(() => evaluation.begin(101)).toThrow("already active")
  expect(evaluation.read().revision).toBe(1)
})

test("valid zero is a complete measurement, not success/promotion and not permission to resample", async () => {
  const { evaluation } = await fixture()
  const first = evaluation.begin(100).assignments[0]
  evaluation.settle(first.id, score(0), 101)
  const zero = evaluation.read()
  expect(zero.kernel.contracts[first.contractID!].status).toBe("discharged")
  expect(zero.assignments[0].result?.passed).toBe(0)
  expect(zero.pair).toEqual(plan.pair)
  const second = evaluation.begin(102).assignments[1]
  evaluation.settle(second.id, score(1), 103)
  expect(evaluation.report()).toMatchObject({
    complete: true,
    promoted: false,
    recursiveImprovement: false,
    searchFeedback: false,
    tasks: [{ task: "airline-34", mean: 0.5, complete: true }],
  })
  expect(() => evaluation.begin(104)).toThrow("no replay")
  expect(() => evaluation.settle(first.id, score(1), 104)).toThrow("no replay")
})

test("late and invalid scores are escalated without inventing missing instance scores", async () => {
  const { evaluation } = await fixture()
  const first = evaluation.begin(100).assignments[0]
  evaluation.settle(first.id, score(1), first.deadline!)
  const state = evaluation.read()
  expect(state.stopped).toContain("deadline")
  expect(state.kernel.contracts[first.contractID!].status).toBe("escalated")
  expect(state.assignments[1].status).toBe("pending")
  expect(state.assignments[1].result).toBeUndefined()
  expect(evaluation.report().tasks[0].mean).toBeNull()
  expect(evaluation.report().complete).toBe(false)
})

test("wrong denominator or incomplete accounting cannot certify measurement", async () => {
  const { evaluation } = await fixture()
  const first = evaluation.begin(100).assignments[0]
  evaluation.settle(first.id, { ...score(), total: 2 }, 101)
  expect(evaluation.read().stopped).toContain("invalid")
  const other = await fixture()
  const second = other.evaluation.begin(100).assignments[0]
  other.evaluation.settle(
    second.id,
    { ...score(), accounting: { source: "ledger", knownCost: null, incomplete: false } },
    101,
  )
  expect(other.evaluation.read().stopped).toContain("invalid")
})

test("an active interrupted ledger cannot be reconstructed or silently restarted", async () => {
  const { file, evaluation } = await fixture()
  const first = evaluation.begin(100).assignments[0]
  expect(() => new Evaluation(file, plan, source, hash("trusted"))).toThrow("no implicit restart")
  const state = stopEvaluationForRecovery(file, 200)
  expect(state.assignments[0].deadline).toBe(first.deadline)
  expect(state.kernel.contracts[first.contractID!].status).toBe("escalated")
  expect(state.assignments[1].status).toBe("pending")
  expect(() => evaluation.begin(201)).toThrow("no replay")
  expect(stopEvaluationForRecovery(file, 201)).toEqual(state)
})

test("aliases cannot add duplicate repeats and cancelling creates no grade", async () => {
  await expect(
    fixture({ ...plan, assignments: [plan.assignments[0], { ...plan.assignments[0], id: "renamed" }] }),
  ).rejects.toThrow("distinct")
  const { evaluation } = await fixture()
  const first = evaluation.begin(100).assignments[0]
  evaluation.stop("operator cancelled", 101)
  expect(evaluation.read().assignments[0].result).toBeUndefined()
  expect(evaluation.read().kernel.contracts[first.contractID!].status).toBe("escalated")
  expect(evaluation.report().tasks[0].mean).toBeNull()
})

test("a failed fence still disposes environments and records unacknowledged cleanup", async () => {
  const { root, evaluation } = await fixture()
  const called: string[] = []
  evaluation.begin(100)
  const result = await closeEvaluation({
    root,
    evaluation,
    fence: async () => {
      called.push("fence")
      throw new Error("docker unavailable")
    },
    dispose: async () => {
      called.push("dispose")
    },
  })
  databases.splice(databases.indexOf(evaluation), 1)
  expect(called).toEqual(["fence", "dispose"])
  expect(result.complete).toBe(false)
  expect(result.cleanup).toMatchObject({
    native: false,
    environment: true,
    errors: ["native fence: Error: docker unavailable"],
  })
  expect(result.assignments[0].failure).toBe("measurement cleanup or accounting failed")
  expect(await Bun.file(path.join(root, "RESULT.json")).json()).toMatchObject({ complete: false })
})
