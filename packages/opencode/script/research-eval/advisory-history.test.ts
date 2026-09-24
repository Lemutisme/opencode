import { expect, test } from "bun:test"
import { shareRunHistory, restoreRunHistory } from "./advisory-history"

test("shared run fields preserve every state, field value, key order and plan version", () => {
  const input = { contractID: "one", brief: "An unchanged original agreement. ".repeat(50) }
  const plan = { version: 1, method: "Use the fixed primary population. ".repeat(30) }
  const runs = [
    { version: 1, input, plan, stage: "execution", literal: { ref: "f1" }, empty: "", missing: null },
    { version: 2, input, plan, stage: "execution", literal: { ref: "f1" }, empty: "", missing: null },
    { version: 3, input, plan: { ...plan, version: 2 }, stage: "review", reason: "意见未回应" },
  ]
  const original = JSON.stringify(runs)
  const history = shareRunHistory(runs)
  expect(JSON.stringify(history).length).toBeLessThan(original.length)
  expect(history.rows).toHaveLength(3)
  expect(Object.values(history.contents).map((entry) => entry.value)).toEqual([input, plan])
  expect(JSON.stringify(restoreRunHistory(history))).toBe(original)
  expect(JSON.stringify(runs)).toBe(original)
})

test("references resolve only from the supplied history; missing, altered and ambiguous values reject", () => {
  const input = { id: "one", text: "required evidence ".repeat(50) }
  const history = shareRunHistory([{ input }, { input }])
  const missing = structuredClone(history)
  delete missing.contents.f1
  expect(() => restoreRunHistory(missing)).toThrow("Missing shared run field")
  const altered = structuredClone(history)
  altered.contents.f1.value = { ...input, id: "another job" }
  expect(() => restoreRunHistory(altered)).toThrow("corrupt")
  const ambiguous = structuredClone(history)
  ambiguous.rows[0].input = { value: input, ref: "f1" }
  expect(() => restoreRunHistory(ambiguous)).toThrow("Ambiguous")
  // The same local selector in another request must not populate a missing value here.
  const other = shareRunHistory([{ input: { ...input, id: "two" } }, { input: { ...input, id: "two" } }])
  expect(restoreRunHistory(other)[0].input).toEqual({ ...input, id: "two" })
  expect(() => restoreRunHistory(missing)).toThrow("Missing shared run field")
})

test("unique evidence is retained in full and repeated events are never collapsed", () => {
  const event = { version: 4, output: { raw: "唯一实验输出".repeat(80), status: "unavailable" } }
  const history = shareRunHistory([event, event, { version: 5, output: { raw: "different", status: "available" } }])
  expect(restoreRunHistory(history)).toEqual([
    event,
    event,
    { version: 5, output: { raw: "different", status: "available" } },
  ])
  expect(history.rows).toHaveLength(3)
  expect(history.rows[2].output).toEqual({ value: { raw: "different", status: "available" } })
})
