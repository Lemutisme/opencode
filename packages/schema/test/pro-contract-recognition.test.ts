import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ProContract } from "../src/pro-contract"

const target = {
  revision: 1,
  specHash: "spec",
  subjectHash: "candidate",
  handoffID: "pch_event",
  contextHash: "context",
}
const context = { revision: 1, specHash: "spec", version: 1, phaseID: "event" }

test("recognition targets require a complete delivery identity and nonreusable context", () => {
  const decode = Schema.decodeUnknownSync(ProContract.RecognitionTarget)
  expect(decode(target)).toEqual(target)
  for (const key of Object.keys(target))
    expect(() => decode(Object.fromEntries(Object.entries(target).filter(([name]) => name !== key)))).toThrow()
  expect(Schema.encodeSync(ProContract.ContextTarget)({ ...context, handoffID: undefined })).toEqual(context)
  expect(
    Schema.encodeSync(ProContract.Recognition)({
      context: undefined,
      handoff: undefined,
      pending: undefined,
      unavailable: "missing",
    }),
  ).toEqual({ unavailable: "missing" })
})

test("evaluation reports reject old versions and bind both delivery support and evaluation admission", () => {
  const decode = Schema.decodeUnknownSync(ProContract.EvaluationReport)
  const report = {
    version: 2,
    deliveryContractID: "pct_delivery",
    delivery: target,
    deliveryAttestationID: "pca_review",
    evaluation: context,
    evaluatorHash: "oracle",
    passed: true,
    disclosure: "sealed",
    summary: "accepted",
  }
  expect(decode(report)).toMatchObject(report)
  expect(() => decode({ ...report, version: 1 })).toThrow()
  expect(() => decode({ ...report, evaluation: { revision: 1, specHash: "spec" } })).toThrow()
  expect(() => decode({ ...report, deliveryAttestationID: undefined })).toThrow()
})
