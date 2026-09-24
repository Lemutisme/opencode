import { Schema } from "effect"
import { ResearchModel } from "../../../sdk-next/src/research/model"
import { ResearchProtocol } from "../../../sdk-next/src/research/protocol"
import { assertEvaluation } from "./lifecycle-scenarios"
import { digest, duration } from "./ledger"
import type { Packet } from "./corpus"

export function issue(
  packet: ReturnType<typeof import("./corpus").publish>,
  input: {
    directory: string
    contractID: string
    issuedAt: number
    worker: ResearchModel.Input["model"]
    reviewer: ResearchModel.Input["model"]
    executable: string
    executableHash: string
    timeout: number
    evaluation?: "feedback-v2" | "repair-lifecycle-v1" | "advisory-v3"
    feedbackGuidance?: "closure:1"
  },
) {
  assertEvaluation({ evaluation: input.evaluation, scenario: packet.version }, input.evaluation === "advisory-v3")
  if (input.feedbackGuidance && input.evaluation !== "repair-lifecycle-v1")
    throw new Error("Closeout guidance requires lifecycle evaluation")
  return Schema.decodeUnknownSync(ResearchModel.Input)({
    planning: true,
    id: input.contractID,
    scope: "research-eval",
    source: { directory: input.directory },
    model: input.worker,
    spec: {
      trigger: { type: "immediate" },
      goal: "Complete the frozen research task",
      brief: packet.brief,
      requires: [],
      authority: ["filesystem.read", "filesystem.write", "process.execute"],
      budget: { deadline: input.issuedAt + duration },
      evidence: { type: "principal", claim: "Externally evaluated evidence-bound research" },
      resolution: { retryDelay: 1 },
    },
    manifest: {
      version: 1,
      // Frozen S6c probes measure the original mandatory-review protocol.
      reviewPolicy:
        input.evaluation === "advisory-v3"
          ? { version: 3, plan: "advisory", delivery: "advisory" }
          : input.evaluation
            ? { version: 2, plan: "advisory", delivery: "advisory" }
            : { version: 1 },
      ...(input.evaluation && input.evaluation !== "advisory-v3"
        ? { feedbackProtocol: input.evaluation === "repair-lifecycle-v1" ? "repair-lifecycle:1" : "response:1" }
        : {}),
      ...(input.feedbackGuidance ? { feedbackGuidance: input.feedbackGuidance } : {}),
      requirements: packet.requirements,
      include: [...Object.keys(packet.files), "result.json"],
      dependencies: [],
      verification: {
        adapter: "node-test-tap:1",
        executable: input.executable,
        executableHash: input.executableHash,
        tests: ["acceptance.mjs"],
        harness: ["acceptance.mjs", "data.json", "report.schema.json"].map((file) => ({
          path: file,
          hash: digest(packet.files[file]),
        })),
        expectedTests: packet.expectedTests,
        minimumTests: packet.expectedTests.length,
        maximumSkipped: 0,
        timeout: input.timeout,
      },
      artifacts: [{ path: "result.json", kind: "generated" }],
      reviewer: {
        model: input.reviewer,
        agent: "build",
        instructions:
          "Independently check the original agreement, method, implementation, raw evidence and conclusions. Negative and unidentifiable results may be correct. Locate any blocking error and its causal consequence; never replace external constraints.",
      },
    },
  })
}

// Only opaque agreement and content identities are filled after issuance. Text stays frozen.
export function bindPlan(packet: Packet, run: ResearchModel.Run) {
  return Schema.decodeUnknownSync(ResearchModel.Plan)({
    version: (run.plan?.value.version ?? 0) + 1,
    agreement: { revision: run.revision, specHash: run.specHash, manifestHash: run.manifestHash },
    scope: "within_task",
    ...packet.plan,
    protected: [],
  })
}

export function target(run: ResearchModel.Run, entry: "plan" | "final", observedJobs: readonly string[] = []) {
  const jobID = entry === "plan" ? run.plan?.jobID : run.reviewJobID
  const reportHash = entry === "plan" ? run.plan?.reportHash : run.reviewHash
  return {
    jobID,
    reportHash,
    exposed: !!reportHash || (!!jobID && observedJobs.includes(jobID)),
    decided: !!reportHash || (run.stage === "unavailable" && !!jobID),
    gate:
      entry === "plan"
        ? ResearchProtocol.planAdmitted(run)
          ? ("open" as const)
          : ("closed" as const)
        : run.stage === "ready"
          ? ("open" as const)
          : ("closed" as const),
    evidence: (entry === "plan"
      ? [run.plan?.hash, run.plan?.materialsHash]
      : [
          run.verificationHash,
          run.materialsHash,
          run.plan?.hash,
          run.plan?.reportHash,
          run.experiment?.verificationHash,
        ]
    ).filter((item): item is string => !!item),
  }
}

// Match the production final-review allowlist, checking the retained Verification by content identity.
export async function evidence(
  run: ResearchModel.Run,
  entry: "plan" | "final",
  object: (hash: string) => Promise<string>,
) {
  const allowed = target(run, entry).evidence
  if (entry === "plan" || !run.verificationHash) return allowed
  const raw = await object(run.verificationHash)
  if (digest(raw) !== run.verificationHash) throw new Error("Verification content identity mismatch")
  const verification = Schema.decodeUnknownSync(
    Schema.UnknownFromJsonString.pipe(Schema.decodeTo(ResearchModel.Verification)),
  )(raw)
  if (
    verification.jobID !== run.verifierJobID ||
    verification.subjectHash !== run.subjectHash ||
    verification.manifestHash !== run.manifestHash
  )
    throw new Error("Verification belongs to another candidate")
  for (const item of verification.evidence) {
    const value = await object(item.hash)
    if (digest(value) !== item.hash || Buffer.byteLength(value) !== item.bytes)
      throw new Error("Verification artifact identity mismatch")
  }
  return [...new Set([...allowed, ...verification.evidence.map((item) => item.hash)])]
}

export function firstTarget(runs: readonly ResearchModel.Run[], entry: "plan" | "final") {
  return runs.toSorted((a, b) => a.version - b.version).find((run) => target(run, entry).decided)
}

// A completed experiment clears the current verifier field; recovery lineage remains in history.
export function recoveryJobs(
  versions: readonly { version: number; data: ResearchModel.Run }[],
  after: number,
  entry: "plan" | "experiment",
  oldID: string,
) {
  return [
    ...new Set(
      versions
        .filter((item) => item.version > after)
        .map((item) => (entry === "plan" ? item.data.plan?.jobID : item.data.verifierJobID))
        .filter((id): id is string => !!id && id !== oldID),
    ),
  ]
}
