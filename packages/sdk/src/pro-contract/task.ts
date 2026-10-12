export * as ProContractTask from "./task"

import { Schema } from "effect"
import { ProContractRSI } from "./index"

export const Configuration = Schema.Struct({
  runtime: ProContractRSI.Configuration.fields.runtime,
  model: ProContractRSI.Configuration.fields.model,
  method: ProContractRSI.Configuration.fields.seed,
  reserveBytes: ProContractRSI.Configuration.fields.reserveBytes,
})
export type Configuration = typeof Configuration.Type
export const Task = ProContractRSI.Task
export type Task = typeof Task.Type

/** An unmeasured fixed method distilled from R2. This is working guidance, not
 * a new authority transition, semantic oracle or automatically selected policy. */
export const evidenceMethod = {
  instructions: [
    "Work toward the actual goal and public acceptance conditions. Identify consequential inputs, modes, outputs, errors and state boundaries. Separate observed behavior from assumptions. Keep the implementation as simple as the evidence permits.",
    "Use consequential unresolved behavioral observations as the control state. Keep a small durable working frontier in the workspace: the current candidate, retained counterexamples, live explanations and the next discriminating action. An ordinary file or runnable probe suite is enough; no fixed reporting format is required. Group shared causes rather than dropping difficult mismatches. A recent passing batch cannot erase an older actionable difference.",
    "For an informative probe, preserve the actual invocation and state, candidate/reference identities, available exit status and output, and capture or timeout limitations. Preserve command-line versus standard-input mode and meaningful failures. Keep independent expected behavior separate from candidate-derived values. An outer exit of zero does not prove an inner assertion ran or matched. Missing or incomplete observations remain explicitly incomplete.",
    "Choose the important unresolved observation with the greatest likely impact or shared-cause potential. If explanations compete, vary the discriminating dimension while holding the invocation and state fixed. If the cause is supported, make a coherent repair. After editing, rebuild, replay the motivating case and affected retained controls, then update the frontier from actual outcomes. Preserve useful passing cases as regressions; a local match is not a coverage certificate.",
    "Before a checkpoint, save the source, runnable probes and necessary data in the workspace; temporary files do not continue automatically. Carry unresolved questions and exact evidence locators forward. A summary is an index, not the full evidence. After context refresh, inspect the current workspace and recover retained observations when a decision depends on omitted detail. Do not infer missing results or repeat a side effect merely to rediscover recorded bytes.",
    "Before submission, reconcile the current candidate with retained observations and replay affected checks. Do not submit while a material observed difference still has a concrete authorized investigation or repair that can change the result. Continue within the original deadline, leaving time for independent verification. When acceptance is supported, submit without waiting out the budget; when genuinely blocked, explain the boundary and unresolved responsibility. Self-tests and handoff are observations, not independent acceptance. Keep the task, verifier, permissions, fixed method and original deadline unchanged.",
  ].join("\n\n"),
}

/** A task needs an execution method and an independent verifier, not a research
 * panel. Reuse the existing native drain; do not create another execution loop. */
export function open(root: string, configuration: Configuration) {
  const config = Schema.decodeUnknownSync(Configuration)(configuration, { onExcessProperty: "error" })
  return ProContractRSI.open(root, {
    runtime: config.runtime,
    model: config.model,
    seed: config.method,
    reserveBytes: config.reserveBytes,
    proposals: 0,
    tests: [],
  })
}
