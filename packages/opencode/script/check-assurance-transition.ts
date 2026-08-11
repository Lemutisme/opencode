#!/usr/bin/env bun

import { ProContract } from "@opencode-ai/schema/pro-contract"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"

const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const Ref = Schema.Struct({
  contractID: ProContract.ID,
  revision: PositiveInt,
  attestationID: ProContract.AttestationID,
  subjectHash: Schema.NonEmptyString,
})
const Risk = Schema.Struct({ used: NonNegative, limit: NonNegative })
const Frontier = Schema.Struct({
  version: Schema.Literal(1),
  decision: Schema.Literal("accept"),
  generation: NonNegativeInt,
  lineageHash: Schema.NonEmptyString,
  executor: Ref,
  judge: Ref,
  risk: Risk,
})
const Transition = Schema.Struct({
  version: Schema.Literal(1),
  previousHash: Schema.NonEmptyString,
  executor: Ref,
  judge: Ref,
  evidence: Schema.Array(Ref),
  bridge: Ref.pipe(Schema.optional),
  riskIncrement: NonNegative,
  provenance: Schema.Array(Schema.NonEmptyString),
})
const Contract = Schema.Struct({
  data: Schema.Struct({
    id: ProContract.ID,
    revision: PositiveInt,
    status: ProContract.Status,
    attestationID: ProContract.AttestationID.pipe(Schema.optional),
    handoff: Schema.Struct({ subjectHash: Schema.NonEmptyString }).pipe(Schema.optional),
    spec: Schema.Struct({ requires: Schema.Array(ProContract.Requirement) }),
  }),
})
const [frontierFile, transitionFile, outputFile] = Bun.argv.slice(2)
const api = Bun.env.PRO_CONTRACT_API
const password = Bun.env.OPENCODE_SERVER_PASSWORD

if (!frontierFile || !transitionFile || !api) {
  throw new Error(
    "usage: PRO_CONTRACT_API=http://host bun run script/check-assurance-transition.ts <frontier.json> <transition.json> [report.json]",
  )
}

const frontierSource = await Bun.file(frontierFile).text()
const transitionSource = await Bun.file(transitionFile).text()
const frontier = Schema.decodeUnknownSync(Schema.fromJsonString(Frontier))(frontierSource)
const transition = Schema.decodeUnknownSync(Schema.fromJsonString(Transition))(transitionSource)
const frontierHash = new Bun.CryptoHasher("sha256").update(JSON.stringify(frontier)).digest("hex")
const transitionHash = new Bun.CryptoHasher("sha256").update(transitionSource).digest("hex")
const reasons: string[] = []
const judgeChanged = !same(frontier.judge, transition.judge)

if (transition.previousHash !== frontierHash) reasons.push("transition does not extend the supplied frontier")
if (frontier.risk.used > frontier.risk.limit) reasons.push("predecessor risk already exceeds its limit")
if (frontier.risk.used + transition.riskIncrement > frontier.risk.limit)
  reasons.push("transition exceeds the cumulative risk limit")
if (same(frontier.executor, transition.executor) && !judgeChanged)
  reasons.push("transition changes no governed component")
if (transition.evidence.length === 0) reasons.push("transition has no evaluation evidence")
if (judgeChanged !== (transition.bridge !== undefined))
  reasons.push(judgeChanged ? "judge change requires a bridge" : "unchanged judge needs no bridge")

const successorKeys = new Set([key(transition.executor), key(transition.judge)])
transition.evidence.forEach((item) => {
  if (successorKeys.has(key(item))) reasons.push(`successor component cannot certify itself: ${item.contractID}`)
})
if (transition.bridge && successorKeys.has(key(transition.bridge)))
  reasons.push(`successor component cannot be its own bridge: ${transition.bridge.contractID}`)

const refs = [
  frontier.executor,
  frontier.judge,
  transition.executor,
  transition.judge,
  ...transition.evidence,
  ...(transition.bridge ? [transition.bridge] : []),
]
const unique = [...new Map(refs.map((item) => [key(item), item])).values()]
const resolved = new Map(
  await Promise.all(
    unique.map(async (item) => {
      const response = await fetch(new URL(`/api/contract/${encodeURIComponent(item.contractID)}`, api), {
        headers: password ? { authorization: `Basic ${btoa(`opencode:${password}`)}` } : undefined,
      })
      if (!response.ok) throw new Error(`failed to read ${item.contractID}: HTTP ${response.status}`)
      const contract = Schema.decodeUnknownSync(Contract)(await response.json()).data
      if (
        contract.id !== item.contractID ||
        contract.revision !== item.revision ||
        contract.status !== "discharged" ||
        contract.attestationID !== item.attestationID ||
        contract.handoff?.subjectHash !== item.subjectHash
      )
        reasons.push(`stale or unsupported Contract reference: ${item.contractID}`)
      return [key(item), contract] as const
    }),
  ),
)

transition.evidence.forEach((item) => {
  const contract = resolved.get(key(item))
  if (!contract) return
  const predecessorGrounding = [transition.executor, frontier.judge]
  predecessorGrounding.forEach((required) => {
    if (!requires(contract, required))
      reasons.push(`evidence ${item.contractID} lacks predecessor-grounded requirement ${required.contractID}`)
  })
})

if (transition.bridge) {
  const contract = resolved.get(key(transition.bridge))
  const required = [frontier.judge, transition.judge]
  required.forEach((item) => {
    if (contract && !requires(contract, item))
      reasons.push(`bridge ${transition.bridge?.contractID} lacks requirement ${item.contractID}`)
  })
}

const nextFrontier = {
  version: 1,
  decision: "accept" as const,
  generation: frontier.generation + 1,
  lineageHash: new Bun.CryptoHasher("sha256").update(`${frontier.lineageHash}:${transitionHash}`).digest("hex"),
  executor: transition.executor,
  judge: transition.judge,
  risk: { used: frontier.risk.used + transition.riskIncrement, limit: frontier.risk.limit },
}
const decision = reasons.length === 0 ? ("accept" as const) : ("reject" as const)
const body = {
  ...nextFrontier,
  decision,
  reasons,
  previousHash: frontierHash,
  transitionHash,
  provenance: transition.provenance,
}
const report = {
  ...body,
  reportHash: new Bun.CryptoHasher("sha256").update(JSON.stringify(body)).digest("hex"),
}
const output = `${JSON.stringify(report, null, 2)}\n`

if (outputFile) {
  const existing = Bun.file(outputFile)
  const exists = await existing.exists()
  if (exists && (await existing.text()) !== output)
    throw new Error(`assurance report already exists with different content: ${outputFile}`)
  if (!exists) await Bun.write(outputFile, output)
}

process.stdout.write(output)
if (decision === "reject") process.exitCode = 1

function key(input: typeof Ref.Type) {
  return `${input.contractID}@${input.revision}/${input.attestationID}/${input.subjectHash}`
}

function same(a: typeof Ref.Type, b: typeof Ref.Type) {
  return key(a) === key(b)
}

function requires(contract: typeof Contract.Type.data, dependency: typeof Ref.Type) {
  return contract.spec.requires.some(
    (item) => item.contractID === dependency.contractID && item.revision === dependency.revision,
  )
}
