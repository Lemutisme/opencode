import { development, measurement } from "./scenarios"
import { digest } from "./ledger"
import type { ResearchModel } from "../../../sdk-next/src/research/model"

export const lifecycleScenarioVersion = "repair-lifecycle-development:1"

/** Lifecycle materials may never be silently scored with the previous response-only protocol. */
export function assertEvaluation(
  input: {
    evaluation?: string
    scenario?: string
    manifest?: ResearchModel.Input["manifest"]
  },
  allowAdvisory = false,
) {
  const advisory = input.evaluation === "advisory-v3"
  const advisoryScenario = ["advisory-development:1", "required-calculation:1", "subject-generalization:1"].includes(
    input.scenario ?? "",
  )
  if (advisory && !allowAdvisory) throw new Error("Use the dedicated advisory scoring entrypoint for v3")
  if (!advisory && (advisoryScenario || input.manifest?.reviewPolicy?.version === 3))
    throw new Error("Advisory materials require their explicit evaluation protocol")
  if (
    advisory &&
    ((input.scenario !== undefined && !advisoryScenario) ||
      (input.manifest !== undefined &&
        (input.manifest.reviewPolicy?.version !== 3 || input.manifest.feedbackProtocol !== undefined)))
  )
    throw new Error("Advisory evaluation requires matching scenario and manifest")
  const lifecycle = input.evaluation === "repair-lifecycle-v1"
  if (
    (input.scenario === lifecycleScenarioVersion || input.manifest?.feedbackProtocol === "repair-lifecycle:1") &&
    !lifecycle
  )
    throw new Error("Lifecycle materials require their explicit evaluation protocol")
  if (
    lifecycle &&
    ((input.scenario !== undefined && input.scenario !== lifecycleScenarioVersion) ||
      (input.manifest !== undefined && input.manifest.feedbackProtocol !== "repair-lifecycle:1"))
  )
    throw new Error("Lifecycle evaluation requires matching scenario and protocol")
}
export const lifecycleMeasurement = {
  ...measurement,
  version: "repair-lifecycle-measurement:1",
  scenario: lifecycleScenarioVersion,
  feedbackProtocol: "repair-lifecycle:1",
  feedback: "intent-plan-action-completion-current-applicability:1",
  finalQuality: "all-cohort-candidate-seals-before-feedback-reveal:1",
  accounting: "original-ledger-supplements-and-unknowns-separate:1",
}

/** Preserve the fourth-round data, plans, truth and diagnostic checks under a distinct task identity. */
export function lifecycleDevelopment(seed = "s6b-frozen-20260919") {
  return development(seed).map((item) => {
    const packet = {
      ...item.packet,
      version: lifecycleScenarioVersion,
      id: digest(lifecycleScenarioVersion + ":" + item.packet.id).slice(0, 24),
      brief: [
        item.packet.brief,
        "This task uses repair-lifecycle:1. Record intended repairs before doing them. Maintain the execution plan when methods or optional diagnostics change. After execution and verification, read the evidence and append an evidence-bound completion claim when warranted. Distinguish actual repair, removal, rebuttal and unresolved intent. A requirement already satisfied before feedback is not a new repair. Completion records are your claims, not host certification or Principal recognition.",
      ].join("\n\n"),
    }
    return {
      packet,
      oracle: {
        ...item.oracle,
        instance: { ...item.oracle.instance, id: packet.id, packetHash: digest(JSON.stringify(packet)) },
      },
    }
  })
}
