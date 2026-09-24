import { expect, test } from "bun:test"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { digest } from "./ledger"
import { shareFeedbackBundle, restoreFeedbackBundle } from "./advisory-bundle"

test("bundle copy restores exact evidence bytes while keeping every finding and event inline", () => {
  const bundle = {
    subjectHash: "candidate-a",
    operations: [{ status: "interrupted", usage: { state: "unknown" } }],
    feedback: [{ finding: "原始意见 ".repeat(200), response: null, availability: "unavailable" }],
    commands: [
      { id: 1, event: "retry" },
      { id: 2, event: "retry" },
    ],
  }
  const raw = ProContractRecognition.canonical(bundle)
  const input = { bundle, evidence: { [digest(raw)]: raw, unique: "Unique original output" }, metadata: "kept" }
  const before = JSON.stringify(input)
  const shared = shareFeedbackBundle(input)
  expect(JSON.stringify(shared).length).toBeLessThan(before.length)
  expect(shared.bundle).toBe(input.bundle)
  expect(JSON.stringify(restoreFeedbackBundle(JSON.parse(JSON.stringify(shared))))).toBe(before)
  expect(JSON.stringify(input)).toBe(before)
})

test("nonidentical serialization, missing source and small copies remain untouched", () => {
  const bundle = { b: "evidence ".repeat(200), a: 1 }
  for (const raw of [JSON.stringify(bundle), JSON.stringify(bundle, null, 2) + "\n", "another candidate"]) {
    const input = { bundle, evidence: { [digest(raw)]: raw } }
    expect(shareFeedbackBundle(input)).toBe(input)
  }
  const small = { bundle: {}, evidence: { [digest("{}")]: "{}" } }
  expect(shareFeedbackBundle(small)).toBe(small)
  const missing = { bundle, evidence: {} }
  expect(shareFeedbackBundle(missing)).toBe(missing)
})

test("restoration rejects altered, foreign, ambiguous and unknown references without external lookup", () => {
  const bundle = { subjectHash: "candidate-a", text: "retained evidence ".repeat(100) }
  const raw = ProContractRecognition.canonical(bundle)
  const hash = digest(raw)
  const shared = shareFeedbackBundle({ bundle, evidence: { [hash]: raw } })
  for (const change of [
    { encoding: "unknown" },
    { source: "another-request.bundle" },
    { hash: "another-hash" },
    { value: "ambiguous literal" },
    { instructions: "Changed instruction" },
  ]) {
    const altered = JSON.parse(JSON.stringify(shared))
    Object.assign(altered.evidence[hash], change)
    expect(() => restoreFeedbackBundle(altered)).toThrow("Shared bundle evidence")
  }
  expect(() => restoreFeedbackBundle({ ...shared, bundle: { ...bundle, subjectHash: "candidate-b" } })).toThrow()
  expect(() => restoreFeedbackBundle({ ...shared, bundle: null })).toThrow()
  const literal = '{"encoding":"shared-bundle-json:1","source":"bundle"}'
  expect(restoreFeedbackBundle({ bundle, evidence: { literal } }).evidence.literal).toBe(literal)
})
