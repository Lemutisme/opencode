// Host-only finite command adapter. Never mount this database into an executor.
import { Effect, Schema } from "effect"
import { ProContract } from "../src/pro-contract.js"
import { Database } from "../src/database/database.js"
import { LayerNode } from "@opencode/util/effect/layer-node"

const Input = Schema.Struct({
  action: Schema.Literals(["issue", "ready", "settle", "escalate", "read"]),
  id: ProContract.ID,
  scope: Schema.String,
  goal: Schema.String,
  started: Schema.Number,
  deadline: Schema.Number,
  subjectHash: Schema.optional(Schema.String),
  evidenceHash: Schema.optional(Schema.String),
  passed: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
})
const input = Schema.decodeUnknownSync(Schema.fromJsonString(Input))(await Bun.file(process.argv[2]).text())
const database = process.env.OPENCODE_DB
if (!database?.startsWith("/")) throw new Error("An explicit host database is required")
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const contracts = yield* ProContract.Service
    const requireAccepted = (receipt: ProContract.Receipt) => {
      if (receipt.decision.type !== "accepted") throw new Error(receipt.decision.reason)
    }
    if (input.action === "issue") {
      requireAccepted(
        yield* contracts.issue({
          id: input.id,
          scope: input.scope,
          executor: "native-v2-worker",
          spec: {
            ...ProContract.defaultSpec(input.goal, input.started),
            budget: { deadline: input.deadline },
            authority: ["sandbox.read", "sandbox.write", "sandbox.execute"],
            evidence: {
              type: "principal",
              claim: "Independent offline preflight and all official assertions pass on the exact archived submission.",
            },
          },
        }),
      )
      requireAccepted(yield* contracts.activate(input.id, 1, input.started))
    }
    const contract = yield* contracts.get(input.id)
    if (
      !contract ||
      contract.spec.budget.deadline !== input.deadline ||
      contract.spec.goal !== input.goal ||
      contract.scope !== input.scope
    )
      throw new Error("Frozen Contract coordinates differ")
    if (input.action === "ready") {
      if (!input.subjectHash) throw new Error("Exact archive identity required")
      requireAccepted(
        yield* contracts.reportReady({
          contractID: input.id,
          revision: contract.revision,
          subjectHash: input.subjectHash,
          summary: "Worker stopped; the host archived its candidate for independent verification.",
          uncertainties: ["The worker cannot certify official task correctness."],
          time: Date.now(),
        }),
      )
    }
    if (input.action === "settle") {
      if (
        !input.evidenceHash ||
        !input.subjectHash ||
        contract.handoff?.subjectHash !== input.subjectHash ||
        input.passed === undefined
      )
        throw new Error("Exact handoff and independent evidence are required")
      if (input.passed)
        requireAccepted(yield* contracts.principalAttest({ contractID: input.id, evidenceHash: input.evidenceHash }))
      if (!input.passed)
        requireAccepted(
          yield* contracts.challenge({
            contractID: input.id,
            revision: contract.revision,
            subjectHash: input.subjectHash,
            evidenceHash: input.evidenceHash,
            disclosure: "sealed",
            time: Date.now(),
          }),
        )
    }
    if (input.action === "escalate")
      requireAccepted(
        yield* contracts.escalate({
          contractID: input.id,
          revision: contract.revision,
          reason: input.reason ?? "Native execution unavailable",
          time: Date.now(),
        }),
      )
    return {
      contract: yield* contracts.get(input.id),
      history: yield* contracts.history({ contractID: input.id }),
      quiet: yield* contracts.quiet(input.scope),
    }
  }).pipe(
    Effect.provide(
      LayerNode.compile(ProContract.node, {
        replacements: [Database.node.replace(Database.configured({ path: database }))],
      }),
    ),
  ),
)
await Bun.write(process.argv[3], JSON.stringify(result, null, 2))
