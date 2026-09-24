import { Schema } from "effect"
import { ResearchAdvisoryProtocol } from "../../../sdk-next/src/research/advisory-protocol"
import { ResearchModel } from "../../../sdk-next/src/research/model"
import { digest } from "./ledger"

export const measurementVersion = "advisory-measurement:1"
export const revealVersion = "instance-isolated:1"
export type Availability = "scored" | "not_observed" | "not_applicable" | "insufficient_evidence" | "not_scored"
export type Judgment = {
  rater: string
  context: string
  materialHash: string
  rubricHash: string
  items: Record<string, { status: Availability; value: boolean | null; reason: string; evidence: string[] }>
}
export type Rubric = Record<
  string,
  {
    dimension: "research_result" | "reviewer_judgment" | "feedback_handling" | "audit_completeness"
    question: string
  }
>

/** Preserve scientific facts and optional declarations on separate axes. No completion-based repair gate. */
export function measures(input: {
  candidate: Record<string, Judgment["items"][string]> | undefined
  feedback: Record<string, Judgment["items"][string]> | undefined
  rubric: Rubric
  audit: unknown
  infrastructure: unknown
  candidateStatus: "present" | "absent" | "unknown"
}) {
  const select = (dimension: Rubric[string]["dimension"], items: Judgment["items"] | undefined) =>
    Object.fromEntries(
      Object.entries(input.rubric)
        .filter(([, rule]) => rule.dimension === dimension)
        .map(([key]) => [
          key,
          items?.[key] ?? {
            status: "not_scored",
            value: null,
            reason: "Independent scoring is incomplete",
            evidence: [],
          },
        ]),
    )
  return {
    version: measurementVersion,
    researchResult: { candidate: input.candidateStatus, items: select("research_result", input.candidate) },
    feedbackHandling: {
      reviewer: select("reviewer_judgment", input.feedback),
      researcher: select("feedback_handling", input.feedback),
    },
    auditCompleteness: { facts: input.audit, judgments: select("audit_completeness", input.feedback) },
    infrastructure: input.infrastructure,
  }
}

/** The exporter, never the Researcher, supplies the exact immutable host bundle and its source identity. */
export function advisoryMaterials(input: {
  run: ResearchModel.Run
  bundle: unknown
  bundleHash: string
  candidate: {
    subjectHash: string
    archiveHash: string
    task: unknown
    files: Record<string, string>
    plan: unknown
    verification: unknown
  }
  evidence: Record<string, string>
}) {
  const bundle = Schema.decodeUnknownSync(ResearchAdvisoryProtocol.Bundle, { onExcessProperty: "error" })(input.bundle)
  if (
    input.run.input.manifest.reviewPolicy?.version !== 3 ||
    input.run.bundleHash !== input.bundleHash ||
    digest(input.evidence[input.bundleHash] ?? "") !== input.bundleHash ||
    JSON.stringify(JSON.parse(input.evidence[input.bundleHash])) !== JSON.stringify(input.bundle) ||
    bundle.contractID !== input.run.id ||
    bundle.manifestHash !== input.run.manifestHash ||
    bundle.subjectHash !== input.run.subjectHash ||
    bundle.submissionHash !== input.run.submissionHash ||
    input.candidate.subjectHash !== bundle.subjectHash
  )
    throw new Error("Advisory measurement requires the exact submitted v3 host material")
  for (const [hash, bytes] of Object.entries(input.evidence))
    if (digest(bytes) !== hash) throw new Error("Measurement source evidence is corrupt")
  const required = [
    bundle.verificationHash,
    bundle.submissionHash,
    ...bundle.feedback.flatMap((entry) => [entry.outcomeHash, entry.outcome.rawHash, entry.outcome.referencesHash]),
    ...bundle.records.flatMap((entry) => [entry.hash, entry.record.basisHash, ...entry.record.evidence]),
  ].filter((hash): hash is string => !!hash)
  if (required.some((hash) => !(hash in input.evidence))) throw new Error("Measurement provenance is incomplete")
  return {
    candidate: input.candidate,
    feedback: { version: measurementVersion, bundle, evidence: input.evidence },
    audit: {
      treatment: bundle.treatment.status,
      opinions: bundle.feedback.map((entry) => ({
        outcomeHash: entry.outcomeHash,
        unaddressed: entry.unaddressed,
        availability: entry.outcome.availability,
      })),
      responses: bundle.records.filter((entry) => entry.record.kind === "response"),
      intents: bundle.records.filter((entry) => entry.record.kind === "intent"),
      completions: bundle.records.filter((entry) => entry.record.kind === "completion"),
      completion: bundle.records.some((entry) => entry.current && entry.record.kind === "completion")
        ? "present"
        : "absent",
      // These are declarations. Independent rubric judgments establish actual repair/removal and support.
      declarationIsProof: false,
    },
  }
}

export type TerminalObservation = {
  agreement: ResearchModel.Input
  result?: { monitored: { run: ResearchModel.Run } }
  inspection: {
    contractID: string
    at: number
    stopped: "confirmed" | "unknown"
    cleanup: "confirmed" | "unknown"
    exhaustive: boolean
    runs: ResearchModel.Run[]
    pendingOperations: string[]
  }
  reason: string
}

/** A stopped host's exhaustive observation is required; client timeout or absent result alone proves nothing. */
export function terminalMaterial(input: TerminalObservation) {
  const agreement = input.result?.monitored.run.input ?? input.agreement
  if (
    JSON.stringify(agreement) !== JSON.stringify(input.agreement) ||
    input.inspection.contractID !== agreement.id ||
    !input.reason ||
    !Number.isFinite(input.inspection.at) ||
    input.inspection.runs.some(
      (run) => run.id !== agreement.id || JSON.stringify(run.input) !== JSON.stringify(agreement),
    )
  )
    throw new Error("Terminal agreement or host observation identity changed")
  const runs = [...input.inspection.runs, ...(input.result ? [input.result.monitored.run] : [])]
  if (runs.some((run) => run.subjectHash || run.bundleHash || ["ready", "accepted"].includes(run.stage)))
    throw new Error("Existing or captured candidate cannot be relabeled absent")
  if (
    input.inspection.stopped !== "confirmed" ||
    input.inspection.cleanup !== "confirmed" ||
    !input.inspection.exhaustive ||
    input.inspection.pendingOperations.length
  )
    throw new Error("Candidate absence requires confirmed termination, cleanup and exhaustive host state")
  return {
    version: measurementVersion,
    candidate: "absent" as const,
    originalDeadline: agreement.spec.budget.deadline,
    agreement,
    observation: input.inspection,
    reason: input.reason,
  }
}

/** A local failure never buys a retry or a new deadline; unknown safety is conservatively shared. */
export function failureScope(input: {
  phase: string
  operation: "stopped" | "running" | "unknown"
  cleanup: "confirmed" | "unknown"
  isolation: "instance" | "shared" | "unknown"
  integrity: "intact" | "broken" | "unknown"
  evidence: string[]
}) {
  return {
    ...input,
    scope:
      input.operation === "stopped" &&
      input.cleanup === "confirmed" &&
      input.isolation === "instance" &&
      input.integrity === "intact" &&
      input.evidence.length > 0
        ? "instance"
        : "shared",
  }
}

/** A future launcher adapter supplies observed cleanup, never just its client-side timeout. */
export async function isolatedSchedule(input: {
  instances: { id: string; started: number; deadline: number }[]
  now: () => number
  signal?: AbortSignal
  attempt: (instance: {
    id: string
    started: number
    deadline: number
  }) => Promise<
    { status: "completed"; evidence: string[] } | { status: "failed"; failure: Parameters<typeof failureScope>[0] }
  >
}) {
  if (
    new Set(input.instances.map((item) => item.id)).size !== input.instances.length ||
    input.instances.some(
      (item) => !item.id || !Number.isFinite(item.started) || item.deadline - item.started !== 21_600_000,
    )
  )
    throw new Error("The frozen schedule must contain unique instances with original six-hour coordinates")
  const rows: { id: string; deadline: number; result: unknown }[] = []
  let stopped = false
  for (const instance of input.instances) {
    if (instance.deadline - instance.started !== 21_600_000) throw new Error("Original six-hour coordinates changed")
    if (stopped || input.signal?.aborted || input.now() >= instance.deadline) {
      rows.push({
        id: instance.id,
        deadline: instance.deadline,
        result: {
          status: "not_started",
          reason: stopped ? "shared_safety_unknown" : input.signal?.aborted ? "cancelled" : "original_deadline",
        },
      })
      continue
    }
    const result = await input
      .attempt({ ...instance })
      .catch((error: unknown) => ({
        status: "failed" as const,
        failure: {
          phase: String(error),
          operation: "unknown" as const,
          cleanup: "unknown" as const,
          isolation: "unknown" as const,
          integrity: "unknown" as const,
          evidence: [],
        },
      }))
    const classified = result.status === "failed" ? { ...result, failure: failureScope(result.failure) } : result
    if (classified.status === "failed" && classified.failure.scope === "shared") stopped = true
    rows.push({ id: instance.id, deadline: instance.deadline, result: classified })
  }
  return { denominator: input.instances.length, rows }
}
