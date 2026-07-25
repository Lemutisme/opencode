import { Location } from "@opencode-ai/schema/location"
import { Model } from "@opencode-ai/schema/model"
import { ProContract } from "@opencode-ai/schema/pro-contract"
import { NonNegativeInt, optional, PositiveInt } from "@opencode-ai/schema/schema"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError } from "../errors"

export class ProContractNotFoundError extends Schema.TaggedErrorClass<ProContractNotFoundError>()(
  "ProContractNotFoundError",
  { contractID: ProContract.ID, message: Schema.String },
  { httpApiStatus: 404 },
) {}

export const Receipt = Schema.Struct({ frontier: NonNegativeInt, hash: Schema.String }).annotate({
  identifier: "ProContract.Receipt",
})

export const OpenCodeExecution = Schema.Struct({
  contractID: ProContract.ID,
  revision: PositiveInt,
  location: Location.Ref,
  model: Model.Ref,
  sessionID: SessionID,
  promptID: SessionMessage.ID,
  dispatched: Schema.Boolean,
  attempts: NonNegativeInt,
  nextActionAt: NonNegativeInt,
  turnsUsed: NonNegativeInt,
  actionsUsed: NonNegativeInt,
  leaseOwner: Schema.NonEmptyString.pipe(optional),
  leaseExpiresAt: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "ProContract.OpenCodeExecution" })

export const ProContractGroup = HttpApiGroup.make("server.proContract")
  .add(
    HttpApiEndpoint.post("proContract.issue", "/api/contract", {
      payload: Schema.Struct({
        id: ProContract.ID.pipe(Schema.optional),
        scope: Schema.NonEmptyString,
        goal: Schema.NonEmptyString,
        brief: Schema.String.pipe(Schema.optional),
        requires: Schema.Array(ProContract.Requirement).pipe(Schema.optional),
        location: Location.Ref,
        model: Model.Ref,
        trigger: ProContract.Trigger.pipe(Schema.optional),
        authority: Schema.Array(ProContract.Capability).pipe(Schema.optional),
        budget: ProContract.Budget.pipe(Schema.optional),
        evidence: ProContract.Evidence.pipe(Schema.optional),
        resolution: ProContract.Resolution.pipe(Schema.optional),
      }),
      success: Schema.Struct({ data: ProContract.Info, execution: OpenCodeExecution, receipt: Receipt }),
      error: ConflictError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.proContract.issue", summary: "Issue contract" })),
  )
  .add(
    HttpApiEndpoint.get("proContract.list", "/api/contract", {
      query: Schema.Struct({ scope: Schema.String.pipe(Schema.optional) }),
      success: Schema.Struct({ data: Schema.Array(ProContract.Info) }),
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.proContract.list", summary: "List contracts" })),
  )
  .add(
    HttpApiEndpoint.get("proContract.quiet", "/api/contract/quiet", {
      query: Schema.Struct({ scope: Schema.NonEmptyString }),
      success: Schema.Struct({
        scope: Schema.NonEmptyString,
        quiet: Schema.Boolean,
        frontier: Schema.Int,
        ledgerHash: Schema.String,
        stateHash: Schema.String,
        outstanding: Schema.Array(ProContract.ID),
      }),
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.proContract.quiet", summary: "Check contract quiescence" })),
  )
  .add(
    HttpApiEndpoint.get("proContract.get", "/api/contract/:contractID", {
      params: { contractID: ProContract.ID },
      success: Schema.Struct({ data: ProContract.Info }),
      error: ProContractNotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.proContract.get", summary: "Get contract" })),
  )
  .add(
    HttpApiEndpoint.get("proContract.execution", "/api/contract/:contractID/execution", {
      params: { contractID: ProContract.ID },
      success: OpenCodeExecution,
      error: ProContractNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.proContract.execution", summary: "Get OpenCode execution" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("proContract.attest", "/api/contract/:contractID/attestation", {
      params: { contractID: ProContract.ID },
      payload: Schema.Struct({ evidenceHash: Schema.NonEmptyString }),
      success: Receipt,
      error: [ConflictError, ProContractNotFoundError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.proContract.attest", summary: "Attest contract evidence" })),
  )
  .add(
    HttpApiEndpoint.post("proContract.challenge", "/api/contract/:contractID/challenge", {
      params: { contractID: ProContract.ID },
      payload: Schema.Struct({
        revision: PositiveInt,
        subjectHash: Schema.NonEmptyString,
        evidenceHash: Schema.NonEmptyString,
        disclosure: Schema.Literals(["executor", "sealed"]),
        summary: Schema.NonEmptyString.pipe(Schema.optional),
      }),
      success: Receipt,
      error: [ConflictError, ProContractNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.proContract.challenge", summary: "Challenge contract verification" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("proContract.decideRevision", "/api/contract/:contractID/revision/decision", {
      params: { contractID: ProContract.ID },
      payload: Schema.Struct({ accept: Schema.Boolean }),
      success: Receipt,
      error: [ConflictError, ProContractNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.proContract.decideRevision", summary: "Decide contract revision" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("proContract.release", "/api/contract/:contractID/release", {
      params: { contractID: ProContract.ID },
      payload: Schema.Struct({ reason: Schema.NonEmptyString }),
      success: Receipt,
      error: [ConflictError, ProContractNotFoundError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.proContract.release", summary: "Release contract" })),
  )
  .add(
    HttpApiEndpoint.post("proContract.resume", "/api/contract/:contractID/resume", {
      params: { contractID: ProContract.ID },
      success: Receipt,
      error: [ConflictError, ProContractNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.proContract.resume", summary: "Resume escalated contract" }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "ProContract", description: "Persistent obligation routes." }))
