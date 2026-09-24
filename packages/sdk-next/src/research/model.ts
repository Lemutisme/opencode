export * as ResearchModel from "./model"

import { Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractBlob } from "@opencode-ai/core/pro-contract/blob"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import type { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { SessionMessage } from "@opencode-ai/core/session/message"

export const profile = "research-final:1"
export const plannedProfile = "research:1"
export const ReviewPolicy = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1) }),
  Schema.Struct({
    version: Schema.Literal(2),
    plan: Schema.Literals(["advisory", "required"]),
    delivery: Schema.Literals(["advisory", "required"]),
  }),
  Schema.Struct({
    version: Schema.Literal(3),
    plan: Schema.Literal("advisory"),
    delivery: Schema.Literal("advisory"),
  }),
])
const verification = {
  executable: AbsolutePath,
  executableHash: ProContractBlob.Digest,
  tests: Schema.NonEmptyArray(RelativePath),
  harness: Schema.NonEmptyArray(Schema.Struct({ path: RelativePath, hash: ProContractBlob.Digest })),
  expectedTests: Schema.NonEmptyArray(Schema.NonEmptyString),
  minimumTests: Schema.Int.check(Schema.isGreaterThan(0)),
  maximumSkipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  timeout: Schema.Int.check(Schema.isGreaterThan(0)),
}
const binary = Schema.Struct({ executable: AbsolutePath, executableHash: ProContractBlob.Digest })
export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  reviewPolicy: Schema.optional(ReviewPolicy),
  feedbackProtocol: Schema.optional(Schema.Literals(["response:1", "repair-lifecycle:1"])),
  feedbackGuidance: Schema.optional(Schema.Literal("closure:1")),
  requirements: Schema.NonEmptyArray(Schema.NonEmptyString),
  include: Schema.Array(RelativePath),
  dependencies: Schema.Array(Schema.String),
  verification: Schema.Union([
    Schema.Struct({ ...verification, adapter: Schema.Literal("node-test-tap:1") }),
    Schema.Struct({
      ...verification,
      adapter: Schema.Literal("python-script:1"),
      python: binary,
      isolation: binary,
    }),
  ]),
  artifacts: Schema.Array(Schema.Struct({ path: RelativePath, kind: Schema.Literals(["input", "generated"]) })),
  reviewer: Schema.Struct({ model: ModelV2.Ref, agent: AgentV2.ID, instructions: Schema.NonEmptyString }),
})
export type Manifest = typeof Manifest.Type

export const Input = Schema.Struct({
  planning: Schema.optional(Schema.Boolean),
  id: ProContract.ID,
  scope: Schema.NonEmptyString,
  spec: ProContract.Spec,
  source: Location.Ref,
  model: ModelV2.Ref,
  manifest: Manifest,
})
export type Input = typeof Input.Type

export class Denied extends Schema.TaggedErrorClass<Denied>()("ResearchDenied", { message: Schema.String }) {}

export const Review = Schema.Struct({
  version: Schema.Literal(1),
  verdict: Schema.Literals(["accept", "changes_requested", "unavailable"]),
  summary: Schema.NonEmptyString,
  findings: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      severity: Schema.Literals(["blocking", "note"]),
      path: Schema.NonEmptyString,
      reason: Schema.NonEmptyString,
      resolution: Schema.NonEmptyString,
    }),
  ),
  claims: Schema.Array(
    Schema.Struct({ text: Schema.NonEmptyString, evidence: Schema.NonEmptyArray(ProContractBlob.Digest) }),
  ),
})
export type Review = typeof Review.Type

export const Plan = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  agreement: Schema.Struct({
    revision: Schema.Int,
    specHash: ProContractBlob.Digest,
    manifestHash: ProContractBlob.Digest,
  }),
  scope: Schema.Literals(["within_task", "needs_principal_revision"]),
  question: Schema.NonEmptyString,
  hypothesis: Schema.NonEmptyString,
  baseline: Schema.NonEmptyString,
  implementation: Schema.NonEmptyString,
  method: Schema.NonEmptyString,
  controls: Schema.NonEmptyString,
  data: Schema.NonEmptyString,
  evaluation: Schema.NonEmptyString,
  uncertainties: Schema.NonEmptyString,
  protected: Schema.Array(Schema.Struct({ path: RelativePath, hash: ProContractBlob.Digest })),
})
export type Plan = typeof Plan.Type
export const PlanReview = Schema.Struct({
  ...Review.fields,
  scope: Schema.Literals(["within_task", "needs_principal_revision", "unclear"]),
})
export type PlanState = {
  readonly value: Plan
  readonly hash: string
  readonly approved?: boolean
  readonly admitted?: boolean
  readonly admissionHash?: string
  readonly referencesHash?: string
  readonly subjectHash?: string
  readonly directory?: string
  readonly preparation?: "started" | "complete"
  readonly materialsHash?: string
  readonly jobID?: string
  readonly reportHash?: string
}
export const Experiment = Schema.Struct({
  planHash: ProContractBlob.Digest,
  approvalHash: ProContractBlob.Digest,
  subjectHash: Schema.NonEmptyString,
  verificationHash: ProContractBlob.Digest,
})
export type Experiment = typeof Experiment.Type

export type Run = {
  readonly id: ProContract.ID
  readonly input: Input
  readonly inputHash: string
  readonly manifestHash: string
  readonly sourceSnapshot: string
  readonly workspace: Location.Ref
  readonly revision: number
  readonly specHash: string
  readonly context: ProContract.ContextTarget
  readonly version: number
  readonly generation: number
  readonly owner?: string
  readonly leaseExpiresAt?: number
  readonly round: number
  readonly reviewVersion: number
  readonly stage:
    | "exploration"
    | "plan_review"
    | "execution"
    | "freezing"
    | "verification"
    | "review"
    | "feedback"
    | "ready"
    | "changes_requested"
    | "unavailable"
    | "cancelled"
    | "accepted"
    | "released"
  readonly reason?: string
  readonly plan?: PlanState
  readonly experiment?: Experiment
  /** Latest completed experiment permits evidence inspection, never delivery by itself. */
  readonly lastExperiment?: Experiment
  readonly purpose?: "experiment"
  readonly runner?: { readonly path: string; readonly hash: string }
  readonly replan?: boolean
  readonly admissionPending?: boolean
  readonly executionPrompt?: string
  readonly request?: {
    readonly execution: ProContractOpenCode.Execution
    readonly summary: string
    readonly uncertainties: ReadonlyArray<string>
  }
  readonly captureID?: string
  readonly captureStarted?: boolean
  readonly reviewPreparation?: "started" | "complete"
  readonly retryJobID?: string
  readonly recoverJobID?: string
  readonly resumeStage?:
    | "exploration"
    | "plan_review"
    | "execution"
    | "freezing"
    | "verification"
    | "review"
    | "feedback"
  readonly feedback?: {
    readonly phase: "plan" | "delivery"
    readonly outcomeHash: string
    readonly responseHash?: string
  }
  readonly feedbackHistory?: ReadonlyArray<{
    readonly phase: "plan" | "delivery"
    readonly outcomeHash: string
    readonly responseHash?: string
  }>
  readonly referencesHash?: string
  readonly submission?: boolean
  readonly completionHashes?: ReadonlyArray<string>
  readonly advisoryView?: {
    readonly id: string
    readonly basis: string
    readonly execution: ProContractOpenCode.Execution
    readonly inputs: Plan["protected"]
  }
  readonly advisoryRecords?: ReadonlyArray<string>
  readonly submissionHash?: string
  readonly subjectHash?: string
  readonly verifierJobID?: string
  readonly verificationHash?: string
  readonly reviewJobID?: string
  readonly reviewHash?: string
  readonly materialsHash?: string
  readonly reviewDirectory?: string
  readonly bundleHash?: string
  readonly handoff?: ProContract.RecognitionTarget
  readonly published?: ProContract.RecognitionTarget
  readonly interruptedWorker?: ProContractOpenCode.Execution
  readonly previous: ReadonlyArray<{
    readonly round: number
    readonly subjectHash?: string
    readonly bundleHash?: string
    readonly verificationHash?: string
    readonly reviewHash?: string
    readonly handoff?: ProContract.RecognitionTarget
  }>
}

export type Token = {
  readonly id: ProContract.ID
  readonly owner: string
  readonly generation: number
  readonly context: ProContract.ContextTarget
  readonly round: number
  readonly reviewVersion: number
}
export const Verification = Schema.Struct({
  version: Schema.Literal(1),
  jobID: Schema.NonEmptyString,
  inputHash: ProContractBlob.Digest,
  fingerprint: ProContractBlob.Digest,
  generation: Schema.Int,
  context: ProContract.ContextTarget,
  subjectHash: Schema.NonEmptyString,
  manifestHash: ProContractBlob.Digest,
  verdict: Schema.Literals(["passed", "failed", "unavailable"]),
  reason: Schema.String,
  tests: Schema.Array(
    Schema.Struct({ name: Schema.String, passed: Schema.Boolean, skipped: Schema.Boolean, todo: Schema.Boolean }),
  ),
  replay: ProContract.ReplayResult,
  evidence: Schema.Array(Schema.Struct({ path: Schema.String, hash: ProContractBlob.Digest, bytes: Schema.Int })),
})
export type Verification = typeof Verification.Type

export const ReviewReport = Schema.Struct({
  version: Schema.Literal(1),
  jobID: Schema.NonEmptyString,
  inputHash: ProContractBlob.Digest,
  fingerprint: ProContractBlob.Digest,
  generation: Schema.Int,
  context: ProContract.ContextTarget,
  subjectHash: Schema.NonEmptyString,
  manifestHash: ProContractBlob.Digest,
  materialsHash: ProContractBlob.Digest,
  systemHash: ProContractBlob.Digest,
  messageID: SessionMessage.ID,
  rawHash: ProContractBlob.Digest,
  review: Review,
})
export type ReviewReport = typeof ReviewReport.Type

export const PlanReport = Schema.Struct({
  ...ReviewReport.fields,
  planHash: ProContractBlob.Digest,
  agreement: Plan.fields.agreement,
  review: PlanReview,
})
export type PlanReport = typeof PlanReport.Type

export const Bundle = Schema.Struct({
  version: Schema.Literal(1),
  profile: Schema.Literals([profile, plannedProfile]),
  contractID: ProContract.ID,
  round: Schema.Int,
  reviewVersion: Schema.Int,
  manifestHash: ProContractBlob.Digest,
  subjectHash: Schema.NonEmptyString,
  handoff: ProContract.RecognitionTarget,
  context: ProContract.ContextTarget,
  verificationHash: ProContractBlob.Digest,
  reviewHash: ProContractBlob.Digest,
  materialsHash: ProContractBlob.Digest,
  verdict: Schema.Literals(["accept", "changes_requested", "unavailable"]),
  operations: Schema.Array(Schema.Unknown),
  dependencies: Schema.Array(Schema.String),
  isolation: Schema.Literal("cooperative"),
  experiment: Schema.optional(Experiment),
})
export type Bundle = typeof Bundle.Type
