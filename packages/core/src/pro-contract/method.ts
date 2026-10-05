export * as ProContractMethod from "./method"

import { Schema } from "effect"
import { ProContract } from "@opencode-ai/schema/pro-contract"
import { Hash } from "../util/hash"

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

export const Definition = Schema.Struct({
  kind: Schema.Literal("version-method-v1"),
  versionHash: Digest,
  executionPolicy: Schema.String,
})
export type Definition = typeof Definition.Type

// Source is provenance of the executable bytes, not evidence that the method is better.
export const Source = Schema.Struct({
  contractID: ProContract.ID,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  specHash: Schema.NonEmptyString,
  subjectHash: Schema.NonEmptyString,
  runID: Schema.String,
  artifact: Schema.optional(Schema.NonEmptyString),
})
export type Source = typeof Source.Type

export const Grant = Schema.Struct({
  kind: Schema.Literal("version-method-grant-v1"),
  scope: Schema.NonEmptyString,
  method: Definition,
  source: Schema.optional(Source),
})

export function hash(input: Definition) {
  const method = Schema.decodeUnknownSync(Definition)(input, { onExcessProperty: "error" })
  if (method.executionPolicy.includes("\0") || new TextEncoder().encode(method.executionPolicy).length > 65_536)
    throw new Error("Method policy must be UTF-8 without NUL and at most 64 KiB")
  return Hash.sha256(
    JSON.stringify({
      kind: method.kind,
      versionHash: method.versionHash,
      executionPolicy: method.executionPolicy,
    }),
  )
}
