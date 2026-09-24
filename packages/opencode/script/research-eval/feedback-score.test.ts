import { expect, test } from "bun:test"
import { dimensions, type FeedbackRecord } from "./feedback-score"
import { score, type Probe } from "./score"
import { Schema } from "effect"
import { ResearchFeedback } from "../../../sdk-next/src/research/review-feedback"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { Hash } from "@opencode-ai/core/util/hash"

const hash = "a".repeat(64)
const finding = {
  id: "selection",
  severity: "blocking",
  path: "plan.method",
  reason: "Test observations were also used for threshold selection",
  resolution: "Use validation for selection",
}
const reviewer: Probe = {
  exposed: true,
  defective: false,
  entry: "plan",
  raw: JSON.stringify({
    version: 1,
    verdict: "changes_requested",
    scope: "within_task",
    summary: "A concern about selection",
    findings: [finding],
    claims: [{ text: "Original plan", evidence: [hash] }],
  }),
  evidence: [hash],
  findings: [{ id: "selection", located: true, mechanism: true, consequence: true, supported: true, target: true }],
  semanticConsistent: true,
  gate: "open",
  gateReason: "advisory response admitted",
  mechanicalBlock: false,
}
const record: FeedbackRecord = {
  phase: "plan",
  outcomeHash: hash,
  availability: "available",
  findings: [finding],
  responseHash: "b".repeat(64),
  response: {
    outcomeHash: hash,
    summary: "The selection uses the disjoint validation IDs in the bound plan",
    action: "continue",
    responses: [{ findingID: "selection", disposition: "rebutted", reason: "Validation IDs and test IDs differ" }],
  },
}

test("reviewer judgment, feedback handling, and final candidate correctness remain separate", () => {
  const result = dimensions({
    reviewer,
    feedback: { applicable: true, records: [record] },
    delivery: { candidateHash: hash, quality: "correct", bundleHash: hash, readyAt: 10 },
  })
  expect(result.reviewer.label).toBe("false_block")
  expect(result.feedback.records[0]).toMatchObject({ complete: true, rebutted: ["selection"] })
  expect(result.feedback.quality).toBe("not_scored")
  expect(result.delivery).toMatchObject({ quality: "correct", hostReady: true, externallyRecognized: false })
  const repaired = dimensions({
    reviewer: { ...reviewer, defective: true },
    feedback: {
      applicable: true,
      records: [
        {
          ...record,
          response: {
            ...record.response!,
            action: "repair",
            responses: [{ findingID: "selection", disposition: "fixed", reason: "Changed the plan" }],
          },
        },
      ],
    },
    delivery: { candidateHash: hash, quality: "incorrect", bundleHash: hash, readyAt: 10 },
  })
  expect(repaired.reviewer.label).toBe("detected")
  expect(repaired.feedback.records[0].claimedFixed).toEqual(["selection"])
  expect(repaired.feedback.quality).toBe("not_scored")
  expect(repaired.delivery.quality).toBe("incorrect")
})

test("unavailable review with a complete response never becomes reviewer acceptance", () => {
  const result = dimensions({
    reviewer: { ...reviewer, raw: "malformed 63-character hash output" },
    feedback: {
      applicable: true,
      records: [
        {
          ...record,
          availability: "unavailable",
          findings: [],
          response: {
            outcomeHash: hash,
            summary: "Report unavailable; remaining scientific risk retained",
            action: "submit",
            responses: [],
          },
        },
      ],
    },
    delivery: { candidateHash: hash, quality: "correct", bundleHash: hash, readyAt: 10 },
  })
  expect(result.reviewer.label).toBe("unavailable")
  expect(result.reviewer.raw).toBe("malformed 63-character hash output")
  expect(result.feedback.records[0].complete).toBe(true)
  expect(result.delivery.hostReady).toBe(true)
  expect(result.delivery.externallyRecognized).toBe(false)
})

test("missing, unknown, duplicate and stale responses remain incomplete, with unresolved risks retained", () => {
  const missing = { ...record, responseHash: undefined, response: undefined }
  const partial = { ...record, response: { ...record.response!, responses: [] } }
  const unknown = {
    ...record,
    response: {
      ...record.response!,
      responses: [{ findingID: "foreign", disposition: "fixed" as const, reason: "Claim" }],
    },
  }
  const duplicate = {
    ...record,
    response: { ...record.response!, responses: [...record.response!.responses, ...record.response!.responses] },
  }
  const stale = { ...record, response: { ...record.response!, outcomeHash: "c".repeat(64) } }
  const unresolved = {
    ...record,
    response: {
      ...record.response!,
      responses: [{ findingID: "selection", disposition: "unresolved" as const, reason: "Needs further evidence" }],
    },
  }
  const result = dimensions({
    reviewer,
    feedback: { applicable: true, records: [missing, partial, unknown, duplicate, stale, unresolved] },
    delivery: { candidateHash: hash, quality: "indeterminate" },
  })
  expect(result.feedback.records.map((item) => item.complete)).toEqual([false, false, false, false, false, true])
  expect(result.feedback.records.at(-1)?.unresolved).toEqual(["selection"])
  expect(result.delivery.hostReady).toBe(false)
})

test("additional gate-independent judgment does not rewrite frozen scoring or treat absent handling as success", () => {
  const accepted = {
    ...reviewer,
    gate: "closed" as const,
    raw: JSON.stringify({
      version: 1,
      verdict: "accept",
      scope: "within_task",
      summary: "Valid plan",
      findings: [],
      claims: [{ text: "Plan", evidence: [hash] }],
    }),
  }
  expect(score(accepted).label).toBe("unavailable")
  const input = {
    reviewer: accepted,
    feedback: { applicable: false, records: [] },
    delivery: { candidateHash: hash, quality: "correct" as const },
  }
  expect(dimensions(input).reviewer.label).toBe("valid_accept")
  expect(dimensions(input).feedback.status).toBe("not_applicable")
  expect(dimensions({ ...input, reviewerTruth: "indeterminate" }).reviewer.label).toBe("unavailable")
  expect(dimensions({ ...input, feedback: { applicable: true, records: [] } }).feedback.status).toBe("not_observed")
  expect(score(accepted).label).toBe("unavailable")
})

test("v2 judgment replays exact job-local references and never treats admission or a P1 severity as proof", () => {
  const references = Schema.decodeUnknownSync(ResearchFeedback.References)({
    version: 2,
    contractID: "pct_score",
    phase: "plan",
    round: 1,
    reviewVersion: 1,
    jobID: "review-job",
    context: { revision: 1, specHash: hash, version: 1, phaseID: "phase" },
    manifestHash: hash,
    materialsHash: hash,
    subjectHash: "candidate",
    planHash: hash,
    entries: [{ id: "plan", hash }],
  })
  for (const defective of [true, false]) {
    for (const verdict of ["accept", "changes_requested"] as const) {
      const raw = JSON.stringify({
        version: 2,
        scope: "within_task",
        verdict,
        summary: "Independent assessment",
        findings: [{ ...finding, severity: "P1" }],
        claims: [{ text: "Bound plan", evidence: [{ jobID: references.jobID, id: "plan" }] }],
      })
      const outcome = Schema.decodeUnknownSync(ResearchFeedback.Outcome)({
        ...ResearchFeedback.resolve(raw, references),
        version: 2,
        contractID: references.contractID,
        phase: "plan",
        round: 1,
        reviewVersion: 1,
        jobID: references.jobID,
        inputHash: hash,
        fingerprint: hash,
        generation: 1,
        jobStatus: "completed",
        context: references.context,
        manifestHash: hash,
        materialsHash: hash,
        subjectHash: "candidate",
        planHash: hash,
        referencesHash: ProContractRecognition.fingerprint(references),
        capture: "complete",
        rawHash: Hash.sha256(raw),
      })
      const input = {
        reviewer: { ...reviewer, raw, defective },
        review: { outcomeHash: ProContractRecognition.fingerprint(outcome), outcome, references },
        feedback: { applicable: true, records: [] },
        delivery: { candidateHash: hash, quality: "indeterminate" as const },
      }
      expect(dimensions(input).reviewer.label).toBe(
        verdict === "accept" ? (defective ? "false_accept" : "valid_accept") : defective ? "detected" : "false_block",
      )
      expect(dimensions(input).reviewer.raw).toBe(raw)
      if (!defective && verdict === "accept") {
        for (const scope of ["unclear", "needs_principal_revision"]) {
          const scopedRaw = JSON.stringify({ ...JSON.parse(raw), scope })
          const scopedOutcome = {
            ...outcome,
            ...ResearchFeedback.resolve(scopedRaw, references),
            rawHash: Hash.sha256(scopedRaw),
          }
          const result = dimensions({
            ...input,
            reviewer: { ...input.reviewer, raw: scopedRaw },
            review: {
              ...input.review,
              outcome: scopedOutcome,
              outcomeHash: ProContractRecognition.fingerprint(scopedOutcome),
            },
          })
          expect(result.reviewer.label).toBe("false_block")
          expect(result.reviewer.scopeError).toBe(true)
          expect(result.reviewer.observedGate).toBe("open")
        }
        for (const changed of [
          { ...references, contractID: "pct_other" as typeof references.contractID },
          { ...references, manifestHash: "b".repeat(64) },
          { ...references, round: 2 },
          { ...references, reviewVersion: 2 },
          { ...references, context: { ...references.context, version: 2 } },
        ]) {
          const mismatched = { ...outcome, referencesHash: ProContractRecognition.fingerprint(changed) }
          expect(
            dimensions({
              ...input,
              review: {
                outcome: mismatched,
                outcomeHash: ProContractRecognition.fingerprint(mismatched),
                references: changed,
              },
            }).reviewer.label,
          ).toBe("unavailable")
        }
      }
      if (defective && verdict === "accept") continue
      expect(
        dimensions({ ...input, review: { ...input.review, references: { ...references, jobID: "foreign-job" } } })
          .reviewer.label,
      ).toBe("unavailable")
      expect(
        dimensions({ ...input, review: { ...input.review, outcome: { ...outcome, subjectHash: "other-candidate" } } })
          .reviewer.label,
      ).toBe("unavailable")
    }
  }
})
