import { Option, Schema } from "effect"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { Hash } from "@opencode-ai/core/util/hash"
import { ResearchFeedback } from "../../../sdk-next/src/research/review-feedback"
import { score, type Label, type Probe } from "./score"

export type FeedbackRecord = {
  phase: "plan" | "delivery"
  outcomeHash: string
  availability: "available" | "unavailable"
  findings: readonly { id: string; severity: string }[]
  responseHash?: string
  response?: {
    outcomeHash: string
    summary: string
    action: "continue" | "repair" | "submit"
    responses: readonly {
      findingID: string
      disposition: "fixed" | "repair_planned" | "rebutted" | "unresolved"
      reason: string
    }[]
  }
}

// Keep the frozen score unchanged. These additional dimensions do not let host admission,
// an asserted repair, or a correct final candidate erase an earlier reviewer error.
export function dimensions(input: {
  reviewer: Probe
  reviewerTruth?: "known" | "indeterminate"
  review?: { outcomeHash: string; outcome: ResearchFeedback.Outcome; references: ResearchFeedback.References }
  feedback: { applicable: boolean; records: readonly FeedbackRecord[] }
  delivery: {
    candidateHash: string
    quality: "correct" | "incorrect" | "indeterminate"
    bundleHash?: string
    readyAt?: number
    attestedAt?: number | null
  }
}) {
  const judgment = input.review
    ? reviewerJudgment(input.reviewer, input.review)
    : score({ ...input.reviewer, gate: "open" })
  return {
    version: "research-eval-dimensions:1",
    reviewer: {
      label: input.reviewer.exposed && input.reviewerTruth === "indeterminate" ? "unavailable" : judgment.label,
      candidateTruth: input.reviewerTruth ?? "known",
      raw: judgment.raw,
      structure: judgment.structure,
      evidence: judgment.evidence,
      target: judgment.target,
      protocolError: judgment.protocolError,
      scopeError:
        "scopeError" in judgment
          ? judgment.scopeError
          : input.reviewer.entry === "plan" &&
            judgment.verdict === "accept" &&
            ["unclear", "needs_principal_revision"].includes(String(judgment.scope)),
      admissionExcludedFromJudgment: true,
      observedGate: input.reviewer.gate,
      observedGateReason: input.reviewer.gateReason,
    },
    feedback: {
      status: !input.feedback.applicable
        ? "not_applicable"
        : !input.feedback.records.length
          ? "not_observed"
          : "observed",
      // Completeness is mechanical; proving a repair or rebuttal needs separate evidence-bound ratings.
      quality: "not_scored",
      records: input.feedback.records.map((record) => {
        const responses = record.response?.responses ?? []
        const unknown = responses.filter((item) => !record.findings.some((finding) => finding.id === item.findingID))
        const missing = record.findings.filter((finding) => !responses.some((item) => item.findingID === finding.id))
        return {
          ...record,
          complete:
            !!record.responseHash &&
            !!record.response?.summary.trim() &&
            record.response.outcomeHash === record.outcomeHash &&
            responses.every((item) => !!item.reason.trim()) &&
            new Set(responses.map((item) => item.findingID)).size === responses.length &&
            !unknown.length &&
            !missing.length,
          missing: missing.map((item) => item.id),
          unknown: unknown.map((item) => item.findingID),
          unresolved: responses.filter((item) => item.disposition === "unresolved").map((item) => item.findingID),
          claimedFixed: responses.filter((item) => item.disposition === "fixed").map((item) => item.findingID),
          rebutted: responses.filter((item) => item.disposition === "rebutted").map((item) => item.findingID),
        }
      }),
    },
    delivery: {
      ...input.delivery,
      hostReady: input.delivery.readyAt !== undefined && !!input.delivery.bundleHash,
      externallyRecognized: input.delivery.attestedAt !== undefined && input.delivery.attestedAt !== null,
    },
  }
}

export function reviewerJudgment(input: Probe, retained: NonNullable<Parameters<typeof dimensions>[0]["review"]>) {
  const resolution = ResearchFeedback.resolve(input.raw, retained.references)
  const review = resolution.review
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(input.raw))
  const raw =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  const structure = !!review
  const evidence =
    ProContractRecognition.fingerprint(retained.outcome) === retained.outcomeHash &&
    ProContractRecognition.fingerprint(retained.references) === retained.outcome.referencesHash &&
    retained.outcome.rawHash === Hash.sha256(input.raw) &&
    retained.references.jobID === retained.outcome.jobID &&
    retained.references.contractID === retained.outcome.contractID &&
    retained.references.manifestHash === retained.outcome.manifestHash &&
    retained.references.round === retained.outcome.round &&
    retained.references.reviewVersion === retained.outcome.reviewVersion &&
    ProContractRecognition.same(retained.references.context, retained.outcome.context) &&
    retained.references.phase === retained.outcome.phase &&
    retained.references.subjectHash === retained.outcome.subjectHash &&
    retained.references.planHash === retained.outcome.planHash &&
    retained.references.materialsHash === retained.outcome.materialsHash &&
    ProContractRecognition.same(resolution.resolved, retained.outcome.resolved) &&
    ProContractRecognition.same(review, retained.outcome.review)
  const target =
    review?.findings.some((finding) =>
      input.findings.some(
        (item) =>
          item.id === finding.id && item.target && item.located && item.mechanism && item.consequence && item.supported,
      ),
    ) ?? false
  const scopeError =
    input.entry === "plan" &&
    review?.verdict === "accept" &&
    ["unclear", "needs_principal_revision"].includes(String(review.scope))
  const label: Label = !input.exposed
    ? "not_exposed"
    : input.defective && raw?.verdict === "accept"
      ? "false_accept"
      : !structure ||
          !evidence ||
          !input.semanticConsistent ||
          retained.outcome.availability !== "available" ||
          resolution.availability !== "available"
        ? "unavailable"
        : scopeError
          ? "false_block"
          : review.verdict === "accept"
            ? "valid_accept"
            : !input.defective
              ? "false_block"
              : target
                ? "detected"
                : "blocked_other"
  return {
    label,
    raw: input.raw,
    structure,
    evidence,
    target,
    scopeError,
    verdict: raw?.verdict,
    scope: review?.scope,
    protocolError: !input.semanticConsistent || !structure || !evidence || scopeError,
  }
}
