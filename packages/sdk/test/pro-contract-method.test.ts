import { expect, test } from "bun:test"
import { Schema } from "effect"
import { RSI } from "@opencode/core/pro-contract/rsi"
import { ProContractRSI } from "@opencode/sdk/pro-contract"

const Inputs = Schema.Struct({
  parentHash: Schema.String,
  parent: RSI.Method,
  experience: Schema.Array(Schema.String),
  deliverable: Schema.String,
})

test("the optional method is admitted and serialized through the actual method boundary", () => {
  const method = RSI.method(ProContractRSI.investigationMethod)
  const restored = RSI.method(Schema.decodeUnknownSync(Schema.fromJsonString(RSI.Method))(JSON.stringify(method)))
  expect(restored).toEqual(ProContractRSI.investigationMethod)
  expect(RSI.hash(restored)).toBe(RSI.hash(method))
  expect(Object.keys(method)).toEqual(["instructions"])
})

test("research goals bind the exact parent bytes and public experience without mutating them", () => {
  const parent = Object.freeze({ instructions: "Investigate\nwith exact evidence.\nQuoted ``` markers remain data.\n" })
  const experience = Object.freeze(["/workspace/experience/trace.jsonl", "/workspace/observations/未解决.txt"])
  const goal = ProContractRSI.researchGoal({ parent, experience })
  const inputs = Schema.decodeUnknownSync(Schema.fromJsonString(Inputs))(goal.match(/```json\n([\s\S]*?)\n```/)![1])
  expect(inputs).toEqual({
    parentHash: RSI.hash(RSI.method(parent)),
    parent,
    experience,
    deliverable: "/workspace/method-research.json",
  })
  expect(ProContractRSI.researchGoal({ parent, experience })).toBe(goal)
  expect(RSI.hash({ instructions: parent.instructions.trim() })).not.toBe(inputs.parentHash)
})

test("a research goal permits an empty experience allocation and does not run or promote a method", () => {
  const goal = ProContractRSI.researchGoal({ parent: ProContractRSI.investigationMethod, experience: [] })
  const inputs = Schema.decodeUnknownSync(Schema.fromJsonString(Inputs))(goal.match(/```json\n([\s\S]*?)\n```/)![1])
  expect(inputs.experience).toEqual([])
  expect(goal).toContain("No-change is a valid research outcome")
  expect(goal).toContain("proposals: 0")
  expect(goal).toContain("action submit")
  expect(goal).toContain("not performance acceptance, research-parent selection or deployment permission")
})

test("the public helper composes an ordinary terminal research Task with caller-owned acceptance", () => {
  const goal = ProContractRSI.researchGoal({
    parent: ProContractRSI.investigationMethod,
    experience: ["/workspace/experience/observations.jsonl"],
  })
  const task = Schema.decodeUnknownSync(ProContractRSI.Task)({
    id: "pct_method_research",
    goal,
    directory: "/operator/public-input",
    total: 1,
    verifier: { directory: "/operator/private-verifier", command: ["/usr/bin/python3", "/verifier/judge.py"] },
    verification: "terminal",
    deadline: 123456789,
  })
  expect(task.goal).toBe(goal)
  expect(task.deadline).toBe(123456789)
  expect(task.verification).toBe("terminal")
  expect(task.verifier).toEqual({
    directory: "/operator/private-verifier",
    command: ["/usr/bin/python3", "/verifier/judge.py"],
  })
  expect(ProContractRSI.investigationMethod).not.toBe(ProContractRSI.initialMethod)
})

test.each([
  ["host path", "/home/operator/private.json"],
  ["relative path", "relative.json"],
  ["traversal", "/workspace/../private.json"],
  ["repeated separator", "/workspace//public.json"],
  ["NUL", "/workspace/evidence\0.json"],
  ["line break", "/workspace/evidence\n.json"],
  ["deliverable alias", "/workspace/method-research.json"],
])("research goals reject nonpublic or ambiguous experience locators: %s", (_name, experience) => {
  expect(() =>
    ProContractRSI.researchGoal({ parent: ProContractRSI.investigationMethod, experience: [experience] }),
  ).toThrow("public /workspace")
})

test("research input cannot silently carry an authority override", () => {
  const input = { parent: ProContractRSI.investigationMethod, experience: [], deadline: Date.now() + 3600000 }
  expect(() => ProContractRSI.researchGoal(input)).toThrow()
})

test.each(["", " ", "invalid\0method", "x".repeat(65537)])(
  "research goals use actual method validation rather than accepting invalid parent bytes",
  (instructions) => {
    expect(() => ProContractRSI.researchGoal({ parent: { instructions }, experience: [] })).toThrow()
  },
)
