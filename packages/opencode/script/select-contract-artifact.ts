import { ProContract } from "@opencode-ai/schema/pro-contract"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"

const Evaluation = Schema.Struct({
  contractID: ProContract.ID,
  revision: PositiveInt,
  subjectHash: Schema.NonEmptyString,
  score: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  timeouts: NonNegativeInt,
  admissible: Schema.Boolean,
})
const Contract = Schema.Struct({
  data: Schema.Struct({
    id: ProContract.ID,
    revision: PositiveInt,
    status: ProContract.Status,
    attestationID: ProContract.AttestationID.pipe(Schema.optional),
    handoff: Schema.Struct({
      subjectHash: Schema.NonEmptyString,
      replay: Schema.Struct({ passed: Schema.Boolean }).pipe(Schema.optional),
    }).pipe(Schema.optional),
  }),
})
const [output, ...files] = Bun.argv.slice(2)
const api = Bun.env.PRO_CONTRACT_API
const password = Bun.env.OPENCODE_SERVER_PASSWORD

if (!output || files.length < 2 || !api) {
  throw new Error(
    "usage: PRO_CONTRACT_API=http://host bun run script/select-contract-artifact.ts <output> <evaluation> <evaluation> [...]",
  )
}

const evaluations = await Promise.all(
  files.map(async (file) => {
    const source = await Bun.file(file).text()
    const evaluation = Schema.decodeUnknownSync(Schema.fromJsonString(Evaluation))(source)
    const response = await fetch(new URL(`/api/contract/${encodeURIComponent(evaluation.contractID)}`, api), {
      headers: password ? { authorization: `Basic ${btoa(`opencode:${password}`)}` } : undefined,
    })
    if (!response.ok) throw new Error(`failed to read ${evaluation.contractID}: HTTP ${response.status}`)
    const contract = Schema.decodeUnknownSync(Contract)(await response.json()).data

    if (contract.id !== evaluation.contractID || contract.revision !== evaluation.revision)
      throw new Error(`evaluation identity does not match ${evaluation.contractID}`)
    if (contract.status !== "discharged" || !contract.attestationID || !contract.handoff?.replay?.passed)
      throw new Error(`contract is not independently evidenced: ${evaluation.contractID}`)
    if (contract.handoff.subjectHash !== evaluation.subjectHash)
      throw new Error(`evaluation subject does not match ${evaluation.contractID}`)

    return {
      ...evaluation,
      attestationID: contract.attestationID,
      evaluationSha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
    }
  }),
)

if (new Set(evaluations.map((item) => item.contractID)).size !== evaluations.length)
  throw new Error("candidate contracts must be unique")

const candidates = evaluations.toSorted((a, b) => (a.contractID < b.contractID ? -1 : 1))
const winner = candidates
  .filter((item) => item.admissible)
  .toSorted((a, b) => b.score - a.score || a.timeouts - b.timeouts || (a.contractID < b.contractID ? -1 : 1))[0]
if (!winner) throw new Error("no candidate passed the frozen evaluation protocol")

const selection =
  JSON.stringify(
    {
      version: 1,
      use: "development artifact selection only",
      rule: "require an exact discharged handoff and passed replay; maximize normalized score; break ties by fewer timeouts, then contract ID",
      candidates,
      winner: {
        contractID: winner.contractID,
        revision: winner.revision,
        subjectHash: winner.subjectHash,
      },
      policyPromotion: false,
      validationOpened: false,
      holdoutOpened: false,
    },
    null,
    2,
  ) + "\n"
const existing = Bun.file(output)

if (await existing.exists()) {
  if ((await existing.text()) !== selection)
    throw new Error(`selection already exists with different content: ${output}`)
} else {
  await Bun.write(output, selection)
}

console.log(`${winner.contractID}@${winner.revision} ${winner.subjectHash}`)
