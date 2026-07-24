export * as ProContract from "./pro-contract"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { NonNegativeInt, optional, PositiveInt, statics } from "./schema"

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
  turns: PositiveInt,
  actions: PositiveInt,
  deadline: NonNegativeInt,
}).annotate({ identifier: "ProContract.Budget" })
export interface Budget extends Schema.Schema.Type<typeof Budget> {}

export const Evidence = Schema.Struct({ type: Schema.Literal("principal") }).annotate({
  identifier: "ProContract.Evidence",
})
export type Evidence = typeof Evidence.Type

export const Challenge = Schema.Struct({
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
  time: NonNegativeInt,
}).annotate({ identifier: "ProContract.Handoff" })
export interface Handoff extends Schema.Schema.Type<typeof Handoff> {}

export const Resolution = Schema.Struct({
  maxAttempts: PositiveInt,
  retryDelay: NonNegativeInt,
}).annotate({ identifier: "ProContract.Resolution" })
export interface Resolution extends Schema.Schema.Type<typeof Resolution> {}

export const Spec = Schema.Struct({
  trigger: Trigger,
  goal: Schema.NonEmptyString,
  brief: Schema.String,
  requires: Schema.Array(Requirement),
  authority: Schema.Array(Capability),
  budget: Budget,
  evidence: Evidence,
  resolution: Resolution,
}).annotate({ identifier: "ProContract.Spec" })
export interface Spec extends Schema.Schema.Type<typeof Spec> {}

export const Status = Schema.Literals(["dormant", "active", "discharged", "released"]).annotate({
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
  evidenceHash: Schema.NonEmptyString,
  verifierID: Schema.NonEmptyString,
  class: Schema.Literal("principal"),
}).annotate({ identifier: "ProContract.Attestation" })
export interface Attestation extends Schema.Schema.Type<typeof Attestation> {}
