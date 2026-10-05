import { expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import { ProContractStrategy } from "../src/pro-contract/strategy"
import { SessionSchema } from "../src/session/schema"
import { tmpdir } from "./fixture/tmpdir"

const criteria = [
  {
    id: "square",
    sourceQuote: "print its square",
    requirement: "The result follows the requested function",
    strategy: "differential" as const,
    command: "python3 check.py",
    timeout: 1000,
  },
]

test("strategy plans quote the issued goal and do not invent acceptance terms", () => {
  expect(ProContractStrategy.plan("spec", "For an integer, print its square", criteria).ready).toBe(false)
  expect(() => ProContractStrategy.plan("spec", "Different goal", criteria)).toThrow("quote")
  expect(() =>
    ProContractStrategy.plan("spec", "For an integer, print its square", [...criteria, ...criteria]),
  ).toThrow("uniquely")
})

test("actual failed checks select another strategy without changing terms", () => {
  const state = ProContractStrategy.plan("spec", "print its square", criteria)
  const failed = ProContractStrategy.conclude(
    state,
    [{ criterion: "square", passed: false, observation: "expected 9, actual 6" }],
    "a",
    "a",
  )
  expect(failed.ready).toBe(false)
  expect(failed.strategy).toBe("counterexample-review")
  expect(failed.specHash).toBe(state.specHash)
  expect(failed.criteria).toEqual(state.criteria)
  const resource = ProContractStrategy.conclude(
    state,
    [{ criterion: "square", passed: false, observation: "Process killed by SIGKILL" }],
    "a",
    "a",
  )
  expect(resource.strategy).toBe("resource-safe")
})

test("passing a wrong, incomplete, or concurrently changed candidate is not readiness", () => {
  const state = ProContractStrategy.plan("spec", "print its square", criteria)
  expect(ProContractStrategy.conclude(state, [], "a", "a").ready).toBe(false)
  expect(
    ProContractStrategy.conclude(state, [{ criterion: "other", passed: true, observation: "ok" }], "a", "a").ready,
  ).toBe(false)
  expect(
    ProContractStrategy.conclude(state, [{ criterion: "square", passed: true, observation: "ok" }], "a", "b").ready,
  ).toBe(false)
  expect(
    ProContractStrategy.conclude(state, [{ criterion: "square", passed: true, observation: "ok" }], "a", "a").ready,
  ).toBe(true)
})

test("strategy/check revisions retain requirements and failure history, not stale readiness", () => {
  const original = ProContractStrategy.conclude(
    ProContractStrategy.plan("spec", "print its square", criteria),
    [{ criterion: "square", passed: false, observation: "old checker unavailable" }],
    "a",
    "a",
  )
  const changed = [{ ...criteria[0], command: "python3 independent_check.py", strategy: "roundtrip" as const }]
  const next = ProContractStrategy.revise(original, "print its square", changed, "Use an installed independent reader")
  expect(next.ready).toBe(false)
  expect(next.specHash).toBe(original.specHash)
  expect(next.revisions[0].previousChecks).toEqual(original.checks)
  expect(() => ProContractStrategy.revise(original, "print its square", [], "remove the failing requirement")).toThrow(
    "remove",
  )
  expect(() => ProContractStrategy.revise(original, "print its square", changed, "")).toThrow("rationale")
})

test("policy state is durable and separated by Session, independently of compacted history", async () => {
  await using directory = await tmpdir()
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const first = ProContractStrategy.make(directory.path, fs)
      const id = SessionSchema.ID.make("ses_policy")
      const state = ProContractStrategy.plan("spec", "print its square", criteria)
      yield* first.exclusive(id, first.write(id, state))
      const restored = ProContractStrategy.make(directory.path, fs)
      expect(yield* restored.read(id)).toEqual(state)
      expect(yield* restored.read(SessionSchema.ID.make("ses_other"))).toBeUndefined()
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  )
})
