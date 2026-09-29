// Issuer-only strategy settlement adapter. No model, scheduler, or task workspace.
import { Effect, Schema } from "effect"
import { lstat } from "node:fs/promises"
import { ProContract } from "../src/pro-contract.js"
import { Database } from "../src/database/database.js"
import { LayerNode } from "@opencode/util/effect/layer-node"

const [requestPath, outputPath] = process.argv.slice(2)
if (!requestPath || !outputPath || !process.env.OPENCODE_DB?.startsWith("/") || process.env.OPENCODE_DB.includes("\0"))
  throw new Error("request, output, and isolated database required")
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Artifact = Schema.Struct({ path: Schema.NonEmptyString, sha256: Hash })
const Strategy = Schema.Struct({
  kind: Schema.Literal("strategy-bundle-v1"),
  generation: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  runtime_sha256: Hash,
  solver_policy: Artifact,
  generator_policy: Artifact,
  parent: Schema.optional(Schema.NullOr(Artifact)),
})
const Evidence = Schema.Struct({
  strategy_sha256: Hash,
  protocol_sha256: Schema.optional(Hash),
  purpose: Schema.optional(Schema.NonEmptyString),
  passed: Schema.optional(Schema.Boolean),
})
const Binding = Schema.Struct({
  strategy_sha256: Hash,
  protocol_sha256: Hash,
  purpose: Schema.NonEmptyString,
})
const Request = Schema.Struct({
  action: Schema.Literals(["issue", "read", "settle", "challenge"]),
  id: ProContract.ID,
  strategy: Artifact,
  protocol_sha256: Schema.optional(Hash),
  evidence: Schema.optional(Artifact),
  purpose: Schema.optional(Schema.NonEmptyString),
  claim: Schema.optional(Schema.NonEmptyString),
  scope: Schema.optional(Schema.NonEmptyString),
  created_at: Schema.optional(Schema.Int),
  deadline: Schema.optional(Schema.Int),
  requires: Schema.optional(Schema.Array(ProContract.Requirement)),
  summary: Schema.optional(Schema.String),
})
const input = Schema.decodeUnknownSync(Schema.fromJsonString(Request))(await Bun.file(requestPath).text())
const hash = (bytes: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
const id = input.id
const reference = async (ref: typeof Artifact.Type, limit = 16 * 1024 * 1024) => {
  if (!ref.path.startsWith("/") || ref.path.includes("\0")) throw new Error("invalid artifact path")
  const info = await lstat(ref.path)
  if (!info.isFile() || info.size > limit) throw new Error("artifact is not a bounded regular file")
  const bytes = new Uint8Array(await Bun.file(ref.path).arrayBuffer())
  if (bytes.length > limit || hash(bytes) !== ref.sha256) throw new Error("artifact identity mismatch")
  return bytes
}
const strategyBytes = await reference(input.strategy)
const strategy = Schema.decodeUnknownSync(Schema.fromJsonString(Strategy))(
  new TextDecoder("utf-8", { fatal: true }).decode(strategyBytes),
)
for (const ref of [strategy.solver_policy, strategy.generator_policy]) {
  const bytes = await reference(ref, 65536)
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (!text.trim() || text.includes("\0")) throw new Error("invalid strategy text")
}
const evidence = input.evidence
  ? Schema.decodeUnknownSync(Schema.fromJsonString(Evidence))(
      new TextDecoder("utf-8", { fatal: true }).decode(await reference(input.evidence)),
    )
  : undefined
if (evidence && evidence.strategy_sha256 !== input.strategy.sha256) throw new Error("evidence names another strategy")
const run = Effect.gen(function* () {
  const contracts = yield* ProContract.Service
  const existing = yield* contracts.get(id)
  const binding = existing ? Schema.decodeUnknownSync(Schema.fromJsonString(Binding))(existing.spec.brief) : undefined
  if (
    binding &&
    (binding.strategy_sha256 !== input.strategy.sha256 ||
      (input.protocol_sha256 && binding.protocol_sha256 !== input.protocol_sha256))
  )
    throw new Error("request differs from the frozen strategy binding")
  if (input.action === "read") return { contract: existing, history: yield* contracts.history({ contractID: id }) }
  if (input.action === "challenge") {
    if (!existing?.handoff || !evidence) throw new Error("challenge requires materialized evidence and a handoff")
    const receipt = yield* contracts.challenge({
      contractID: id,
      revision: existing.revision,
      subjectHash: existing.handoff.subjectHash,
      evidenceHash: input.evidence!.sha256,
      disclosure: "sealed",
      time: Date.now(),
    })
    if (receipt.decision.type !== "accepted") throw new Error(JSON.stringify(receipt.decision))
    return { receipt, contract: yield* contracts.get(id) }
  }
  if (input.action === "issue") {
    if (
      !input.claim ||
      !input.scope ||
      !input.purpose ||
      !input.protocol_sha256 ||
      input.created_at === undefined ||
      input.deadline === undefined ||
      input.created_at < 0 ||
      input.deadline <= input.created_at
    )
      throw new Error("issuance requires exact claim, scope, protocol, purpose and time bounds")
    const spec = {
      ...ProContract.defaultSpec(input.claim, input.created_at),
      brief: JSON.stringify({
        kind: "strategy-settlement-v1",
        strategy_sha256: input.strategy.sha256,
        protocol_sha256: input.protocol_sha256,
        purpose: input.purpose,
      }),
      requires: input.requires ?? [],
      authority: [],
      budget: { deadline: input.deadline },
      resolution: { maxAttempts: 1, retryDelay: 0 },
      evidence: { type: "principal" as const, claim: input.claim },
    }
    const receipt = yield* contracts.issue({ id, scope: input.scope, spec, executor: "issuer-strategy-adapter" })
    if (receipt.decision.type !== "accepted") throw new Error(JSON.stringify(receipt.decision))
    return { receipt, contract: yield* contracts.get(id) }
  }
  if (input.action !== "settle" || !existing || !evidence || !binding)
    throw new Error("existing contract and independent evidence required")
  if (
    binding.strategy_sha256 !== input.strategy.sha256 ||
    binding.protocol_sha256 !== input.protocol_sha256 ||
    binding.purpose !== evidence.purpose ||
    evidence.protocol_sha256 !== input.protocol_sha256
  )
    throw new Error("evidence differs from the frozen strategy claim")
  if (typeof evidence.passed !== "boolean") throw new Error("missing evidence outcome")
  if (existing.status === "discharged") {
    const prior = existing.attestationID ? yield* contracts.getAttestation(existing.attestationID) : undefined
    if (!evidence.passed || prior?.evidenceHash !== input.evidence!.sha256)
      throw new Error("conflicting settlement retry")
    return { contract: existing, exact_retry: true }
  }
  if (!evidence.passed) {
    const receipt = yield* contracts.escalate({
      contractID: id,
      revision: existing.revision,
      reason: "Independent strategy evidence did not satisfy the frozen claim",
      time: Date.now(),
    })
    if (receipt.decision.type !== "accepted") throw new Error(JSON.stringify(receipt.decision))
    return { receipt, contract: yield* contracts.get(id) }
  }
  if (existing.status === "dormant") {
    const receipt = yield* contracts.activate(id, existing.revision, Date.now())
    if (receipt.decision.type !== "accepted") throw new Error(JSON.stringify(receipt.decision))
  }
  const current = yield* contracts.get(id)
  if (current?.status === "active") {
    const ready = yield* contracts.reportReady({
      contractID: id,
      revision: current.revision,
      subjectHash: input.strategy.sha256,
      summary: existing.spec.goal,
      uncertainties: ["Evidence is scoped to the frozen external protocol, not universal improvement."],
      time: Date.now(),
    })
    if (ready.decision.type !== "accepted") throw new Error(JSON.stringify(ready.decision))
  }
  const ready = yield* contracts.get(id)
  if (ready?.handoff?.subjectHash !== input.strategy.sha256)
    throw new Error("handoff differs from the strategy artifact")
  const receipt = yield* contracts.principalAttest({ contractID: id, evidenceHash: input.evidence!.sha256 })
  if (receipt.decision.type !== "accepted") throw new Error(JSON.stringify(receipt.decision))
  return { receipt, contract: yield* contracts.get(id), history: yield* contracts.history({ contractID: id }) }
})
const result = await Effect.runPromise(
  run.pipe(
    Effect.provide(
      LayerNode.compile(ProContract.node, {
        replacements: [Database.node.replace(Database.configured({ path: process.env.OPENCODE_DB }))],
      }),
    ),
  ),
)
await Bun.write(outputPath, JSON.stringify(result, null, 2) + "\n")
