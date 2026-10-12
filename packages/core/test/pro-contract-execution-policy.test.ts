import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "../src/config"
import { ConfigProContract } from "../src/config/pro-contract"
import { ConfigMigrateV1 } from "../src/v1/config/migrate"
import { ConfigV1 } from "../src/v1/config/config"
import { ProContractExecutionPolicy } from "../src/pro-contract/execution-policy"
import { Hash } from "../src/util/hash"

describe("interactive Contract execution policy", () => {
  test("embeds the original R2 v5 bytes", () => {
    expect(Hash.sha256(ProContractExecutionPolicy.R2V5)).toBe(
      "b382202cc07a74e212a8ab41e47a117a291dce1815e4967125a360a62e76d067",
    )
  })

  test("requires explicit selection and preserves explicit adapter policy", () => {
    expect(ProContractExecutionPolicy.select(undefined)).toBeUndefined()
    expect(ProContractExecutionPolicy.select(undefined, { execution_policy: false })).toBeUndefined()
    expect(ProContractExecutionPolicy.select(undefined, { execution_policy: "r2-v5" })).toBe(
      ProContractExecutionPolicy.R2V5,
    )
    expect(ProContractExecutionPolicy.select("Independent policy", { execution_policy: "r2-v5" })).toBe(
      "Independent policy",
    )
  })

  test("current and legacy configuration retain the same explicit selection", () => {
    const input = { procontract: { execution_policy: "r2-v5" as const } }
    expect(Schema.decodeUnknownSync(Config.Info)(input).procontract).toEqual(input.procontract)
    expect(ConfigMigrateV1.migrate(Schema.decodeUnknownSync(ConfigV1.Info)(input)).procontract).toEqual(
      input.procontract,
    )
    expect(() => Schema.decodeUnknownSync(ConfigProContract.Info)({ execution_policy: "unknown" })).toThrow()
  })
})
