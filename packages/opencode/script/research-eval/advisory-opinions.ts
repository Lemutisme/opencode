import path from "node:path"
import { mkdir } from "node:fs/promises"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { put } from "./archive"
import { prepareAdvisoryArchive } from "./advisory-archive"
import { runtimeMatches, type checkAdvisory } from "./advisory-config"
import { rateAdvisory } from "./advisory-rater"
import { measures } from "./advisory-measurement"
import { shareFeedbackHistory } from "./advisory-history"
import { shareFeedbackBundle } from "./advisory-bundle"
import type { Freeze } from "./instance-scoring"
import type { runInstance } from "./instance"
import type { checkObservation } from "./advisory-observation"

/** Separate prose observations. No formal score validator, aggregate verdict or Researcher admission effect. */
export async function observeAdvisory(input: {
  directory: string
  checked: Awaited<ReturnType<typeof checkAdvisory>>
  registered: Pick<Freeze["instances"][number], "id" | "files" | "roles">
  result?: Awaited<ReturnType<typeof runInstance>>
  inspection: Awaited<ReturnType<typeof checkObservation>>
  infrastructure: unknown
  evidence: string
  signal: AbortSignal
}) {
  const directory = path.join(input.directory, "opinions")
  await mkdir(directory, { recursive: false, mode: 0o700 })
  const candidate = input.result?.monitored.run
  const audit = input.inspection.audit
  const submitted = candidate?.stage === "ready" && !!candidate.bundleHash
  const absent =
    !submitted &&
    input.inspection.confirmed &&
    audit?.state === "stable_copy" &&
    audit.runs &&
    audit.history &&
    audit.preparation &&
    audit.contracts &&
    ![...audit.runs, ...audit.history.map((row) => row.data)].some(
      (run) => run.bundleHash || run.submissionHash || ["ready", "accepted"].includes(run.stage),
    )
  const records: {
    phase: "candidate" | "feedback"
    execution: string
    status: "returned" | "unavailable"
    result: Awaited<ReturnType<typeof rateAdvisory>>
  }[] = []
  const gaps: string[] = []
  const exported = submitted
    ? await prepareAdvisoryArchive({
        directory: path.join(input.directory, "archive"),
        archiveHash: input.result!.monitored.evidence.hash,
        files: input.registered.files,
        timeout: input.checked.config.timeouts.extraction,
      })
        .then((prepared) => {
          if (
            prepared.source.contractID !== input.inspection.agreement.id ||
            prepared.source.agreementHash !== ProContractRecognition.fingerprint(input.inspection.agreement) ||
            prepared.source.deadline !== input.inspection.attempt.deadline ||
            prepared.candidate.subjectHash !== candidate.subjectHash ||
            prepared.feedback.bundle.manifestHash !== candidate.manifestHash ||
            prepared.feedback.bundle.submissionHash !== candidate.submissionHash
          )
            throw new Error("Submitted archive differs from the observed instance, agreement or candidate")
          return prepared
        })
        .catch((error: unknown) => {
          gaps.push(String(error))
          return undefined
        })
    : undefined
  const terminal = {
    candidate: submitted ? "submitted_material_unavailable" : absent ? "not_submitted" : "unknown",
    agreement: input.inspection.agreement,
    attempt: input.inspection.attempt,
    reason: candidate?.reason ?? candidate?.stage ?? "issuance_failed_or_unobserved",
    run: candidate,
    audit,
    evidence: input.evidence,
    limitation:
      "Terminal host observations are not a submitted candidate; missing file/output contents remain evidence gaps.",
  }
  const material = {
    candidate: exported?.candidate,
    feedback: exported ? shareFeedbackBundle(shareFeedbackHistory(exported.feedback)) : terminal,
  }
  const seals: Partial<Record<"candidate" | "feedback", string>> = {}
  for (const phase of ["candidate", "feedback"] as const) {
    if (input.signal.aborted) {
      gaps.push("Cancelled; no further independent review requests or material exposure")
      break
    }
    const rubric = Object.fromEntries(
      Object.entries(input.checked.frozen.rubric).filter(
        ([, rule]) => (rule.dimension === "research_result") === (phase === "candidate"),
      ),
    )
    if (material[phase]) {
      const materialHash = await put(directory, material[phase])
      const rubricHash = await put(directory, rubric)
      for (const [index, context] of input.registered.roles[phase].entries()) {
        if (input.signal.aborted) break
        if (!(await runtimeMatches(input.checked.frozen.runner))) throw new Error("Frozen opinion runtime changed")
        const receipt = { instance: input.registered.id, phase, context, materialHash, rubricHash }
        const result = await rateAdvisory({
          directory,
          config: input.checked.config,
          model: index === 0 ? input.checked.config.raters.first.model : input.checked.config.raters.second.model,
          grant: { ...receipt, receipt: await put(directory, receipt), material: material[phase], rubric, prior: [] },
          format: "candidate-opinion:1",
          signal: input.signal,
        }).catch((error: unknown) => {
          gaps.push(context.execution + ": " + String(error))
          return undefined
        })
        if (result) {
          records.push({
            phase,
            execution: context.execution,
            status: result.opinion ? "returned" : "unavailable",
            result,
          })
          if (!result.opinion) gaps.push(`Independent ${phase} reviewer unavailable: ${context.rater}`)
        }
      }
    }
    // Both independent candidate attempts (including unavailable results) are saved before any feedback exposure.
    seals[phase] = await put(directory, {
      phase,
      instance: input.registered.id,
      at: Date.now(),
      materialHash: material[phase] ? await put(directory, material[phase]) : undefined,
      candidateRecord: phase === "feedback" ? seals.candidate : undefined,
      records: records.filter((record) => record.phase === phase),
      terminal: phase === "candidate" && !material.candidate ? terminal : undefined,
      gaps: [...gaps],
      meaning: "Immutable attempt record, not a quality approval or completed formal double scoring",
    })
    await Bun.write(
      path.join(directory, phase + "-record.json"),
      JSON.stringify({ hash: seals[phase] }, null, 2) + "\n",
    )
  }
  const measurement = measures({
    candidate: undefined,
    feedback: undefined,
    candidateStatus: submitted ? "present" : absent ? "absent" : "unknown",
    rubric: {},
    audit: exported?.audit ?? { terminal, limitation: "No delivery audit reconstructed" },
    infrastructure: input.infrastructure,
  })
  return {
    id: input.registered.id,
    ...measurement,
    version: "candidate-opinion:1",
    researchResult: {
      ...measurement.researchResult,
      record: seals.candidate,
      reviews: records.filter((row) => row.phase === "candidate"),
    },
    feedbackHandling: {
      ...measurement.feedbackHandling,
      record: seals.feedback,
      reviews: records.filter((row) => row.phase === "feedback"),
    },
    auditCompleteness: { ...measurement.auditCompleteness, assessmentRecord: seals.feedback },
    candidateSeal: undefined,
    feedbackSeal: undefined,
    formalScoring: "not_run",
    adjudication: "not_requested; preserve separate opinions and disagreements",
    gaps,
  }
}
