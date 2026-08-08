export * as ProContract from "./pro-contract"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { NonNegativeInt, optional, PositiveInt, RelativePath, statics } from "./schema"

export const ID = Schema.String.check(Schema.isStartsWith("pct_")).pipe(
  Schema.brand("ProContract.ID"),
  statics((schema) => ({ create: () => schema.make("pct_" + ascending()) })),
)
export type ID = typeof ID.Type

export const AttestationID = Schema.String.check(Schema.isStartsWith("pca_")).pipe(
  Schema.brand("ProContract.AttestationID"),
  statics((schema) => ({ create: () => schema.make("pca_" + ascending()) })),
)
export type AttestationID = typeof AttestationID.Type

export const Requirement = Schema.Struct({
  contractID: ID,
  revision: PositiveInt,
}).annotate({ identifier: "ProContract.Requirement" })
export interface Requirement extends Schema.Schema.Type<typeof Requirement> {}

export const Trigger = Schema.Union([
  Schema.Struct({ type: Schema.Literal("immediate") }),
  Schema.Struct({ type: Schema.Literal("time"), at: NonNegativeInt }),
]).annotate({ identifier: "ProContract.Trigger" })
export type Trigger = typeof Trigger.Type

export const Capability = Schema.Literals(["filesystem.read", "filesystem.write", "process.execute"]).annotate({
  identifier: "ProContract.Capability",
})
export type Capability = typeof Capability.Type

export const Budget = Schema.Struct({
  turns: PositiveInt.annotate({
    description: "Exact provider-turn ceiling shared by every attempt.",
  }),
  actions: PositiveInt.annotate({
    description: "Exact tool-action ceiling shared by every attempt.",
  }),
  deadline: NonNegativeInt.annotate({ description: "Absolute Unix timestamp in milliseconds." }),
}).annotate({ identifier: "ProContract.Budget" })
export interface Budget extends Schema.Schema.Type<typeof Budget> {}

const CandidatePath = RelativePath.check(
  Schema.isPattern(/^(?![\\/])(?![A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/),
)

export const ReplayCheck = Schema.Struct({
  argv: Schema.Array(Schema.NonEmptyString),
  cwd: CandidatePath.pipe(optional),
  timeout: PositiveInt.check(
    Schema.isGreaterThanOrEqualTo(1_000),
    Schema.isLessThanOrEqualTo(10 * 60 * 1_000),
  ).annotate({ description: "Timeout in milliseconds (1,000 to 600,000)." }),
  exit: NonNegativeInt,
}).annotate({ identifier: "ProContract.ReplayCheck" })
export interface ReplayCheck extends Schema.Schema.Type<typeof ReplayCheck> {}

export const ReplayPolicy = Schema.Struct({
  checks: Schema.Array(ReplayCheck),
  protected: Schema.Array(Schema.Struct({ path: CandidatePath, hash: Schema.NonEmptyString })),
  artifacts: Schema.Array(CandidatePath),
}).annotate({
  identifier: "ProContract.ReplayPolicy",
  description:
    "Harness-owned preflight replay for the frozen candidate. It is not final acceptance evidence. Implementation Contracts that promise a build command or named output artifact should include finite checks and exact user-named artifact paths, never guessed internal source paths.",
})
export interface ReplayPolicy extends Schema.Schema.Type<typeof ReplayPolicy> {}

export const ReplayResult = Schema.Struct({
  policyHash: Schema.NonEmptyString,
  subjectHash: Schema.NonEmptyString,
  evidenceHash: Schema.NonEmptyString,
  passed: Schema.Boolean,
  summary: Schema.NonEmptyString,
}).annotate({ identifier: "ProContract.ReplayResult" })
export interface ReplayResult extends Schema.Schema.Type<typeof ReplayResult> {}

export const Evidence = Schema.Struct({
  type: Schema.Literal("principal"),
  claim: Schema.NonEmptyString.pipe(optional),
  replay: ReplayPolicy.pipe(optional).annotate({
    description:
      "Required for implementation work with honest finite build, test, or artifact checks; omit only when no mechanical criterion represents the goal.",
  }),
}).annotate({
  identifier: "ProContract.Evidence",
})
export type Evidence = typeof Evidence.Type

export const Challenge = Schema.Struct({
  revision: PositiveInt,
  subjectHash: Schema.NonEmptyString,
  evidenceHash: Schema.NonEmptyString,
  disclosure: Schema.Literals(["executor", "sealed"]),
  summary: Schema.NonEmptyString.pipe(optional),
  time: NonNegativeInt,
  attestationID: AttestationID.pipe(optional),
}).annotate({ identifier: "ProContract.Challenge" })
export interface Challenge extends Schema.Schema.Type<typeof Challenge> {}

export const Handoff = Schema.Struct({
  summary: Schema.NonEmptyString,
  uncertainties: Schema.Array(Schema.NonEmptyString),
  subjectHash: Schema.NonEmptyString,
  replay: ReplayResult.pipe(optional),
  time: NonNegativeInt,
}).annotate({ identifier: "ProContract.Handoff" })
export interface Handoff extends Schema.Schema.Type<typeof Handoff> {}

export const Blocked = Schema.Struct({
  reason: Schema.NonEmptyString,
  time: NonNegativeInt,
}).annotate({ identifier: "ProContract.Blocked" })
export interface Blocked extends Schema.Schema.Type<typeof Blocked> {}

export const Resolution = Schema.Struct({
  maxAttempts: PositiveInt,
  retryDelay: NonNegativeInt,
}).annotate({ identifier: "ProContract.Resolution" })
export interface Resolution extends Schema.Schema.Type<typeof Resolution> {}

export const Spec = Schema.Struct({
  trigger: Trigger,
  goal: Schema.NonEmptyString,
  brief: Schema.String.annotate({
    description:
      "Self-contained handoff brief. Preserve user-stated quality criteria. For open-ended optimization, state the evaluation protocol, required exploration, known quality floor, stopping rule, and assumptions; expose missing criteria instead of inventing them.",
  }),
  requires: Schema.Array(Requirement),
  authority: Schema.Array(Capability),
  budget: Budget,
  evidence: Evidence,
  resolution: Resolution,
}).annotate({ identifier: "ProContract.Spec" })
export interface Spec extends Schema.Schema.Type<typeof Spec> {}

export const Status = Schema.Literals([
  "dormant",
  "active",
  "verification",
  "escalated",
  "discharged",
  "released",
]).annotate({
  identifier: "ProContract.Status",
})
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  id: ID,
  scope: Schema.NonEmptyString,
  spec: Spec,
  issuer: Schema.NonEmptyString,
  revision: PositiveInt,
  status: Status,
  specHash: Schema.String,
  escalation: Schema.Struct({ reason: Schema.String, time: NonNegativeInt }).pipe(optional),
  blocked: Blocked.pipe(optional),
  handoff: Handoff.pipe(optional),
  challenge: Challenge.pipe(optional),
  pendingRevision: Schema.Struct({ spec: Spec, specHash: Schema.String, reason: Schema.String }).pipe(optional),
  attestationID: AttestationID.pipe(optional),
}).annotate({ identifier: "ProContract.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Attestation = Schema.Struct({
  id: AttestationID,
  contractID: ID,
  revision: PositiveInt,
  specHash: Schema.String,
  subjectHash: Schema.NonEmptyString,
  evidenceHash: Schema.NonEmptyString,
  verifierID: Schema.NonEmptyString,
  class: Schema.Literal("principal"),
}).annotate({ identifier: "ProContract.Attestation" })
export interface Attestation extends Schema.Schema.Type<typeof Attestation> {}
