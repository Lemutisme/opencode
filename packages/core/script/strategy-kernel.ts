// Issuer-only strategy settlement adapter. No model, scheduler, or task workspace.
import { Effect } from "effect"
import { ProContract } from "../src/pro-contract"
import { LayerNode } from "../src/effect/layer-node"

const [requestPath, outputPath] = process.argv.slice(2)
if (!requestPath || !outputPath || !process.env.OPENCODE_DB)
  throw new Error("request, output, and isolated database required")
const input = await Bun.file(requestPath).json()
const hash = (bytes: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
const id = ProContract.ID.make(input.id)
const reference = async (ref: { path: string; sha256: string }) => {
  if (!ref.path.startsWith("/") || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error("invalid artifact reference")
  const bytes = new Uint8Array(await Bun.file(ref.path).arrayBuffer())
  if (hash(bytes) !== ref.sha256) throw new Error("artifact identity mismatch")
  return bytes
}
const strategyBytes = await reference(input.strategy)
const strategy = JSON.parse(new TextDecoder().decode(strategyBytes))
if (strategy.kind !== "strategy-bundle-v1" || !Number.isInteger(strategy.generation))
  throw new Error("not a strategy bundle")
for (const name of ["solver_policy", "generator_policy"]) {
  const bytes = await reference(strategy[name])
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (!text.trim() || text.includes("\0") || bytes.length > 65536) throw new Error("invalid strategy text")
}
if (!/^[a-f0-9]{64}$/.test(strategy.runtime_sha256)) throw new Error("unbound strategy runtime")
const evidence = input.evidence ? JSON.parse(new TextDecoder().decode(await reference(input.evidence))) : undefined
if (evidence && evidence.strategy_sha256 !== input.strategy.sha256) throw new Error("evidence names another strategy")
const run = Effect.gen(function* () {
  const contracts = yield* ProContract.Service
  const existing = yield* contracts.get(id)
  if (input.action === "read") return { contract: existing, history: yield* contracts.history({ contractID: id }) }
  if (input.action === "challenge") {
    if (!existing?.handoff || !evidence) throw new Error("challenge requires materialized evidence and a handoff")
    const receipt = yield* contracts.challenge({
      contractID: id,
      revision: existing.revision,
      subjectHash: existing.handoff.subjectHash,
      evidenceHash: input.evidence.sha256,
      disclosure: "sealed",
      time: Date.now(),
    })
    if (receipt.decision.type !== "accepted") throw new Error(JSON.stringify(receipt.decision))
    return { receipt, contract: yield* contracts.get(id) }
  }
  if (input.action === "issue") {
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
  if (input.action !== "settle" || !existing || !evidence)
    throw new Error("existing contract and independent evidence required")
  const binding = JSON.parse(existing.spec.brief)
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
    if (!evidence.passed || prior?.evidenceHash !== input.evidence.sha256)
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
  const receipt = yield* contracts.principalAttest({ contractID: id, evidenceHash: input.evidence.sha256 })
  if (receipt.decision.type !== "accepted") throw new Error(JSON.stringify(receipt.decision))
  return { receipt, contract: yield* contracts.get(id), history: yield* contracts.history({ contractID: id }) }
})
const result = await Effect.runPromise(run.pipe(Effect.provide(LayerNode.compile(ProContract.node))))
await Bun.write(outputPath, JSON.stringify(result, null, 2) + "\n")
