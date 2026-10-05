import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractAttestationTable } from "@opencode-ai/core/pro-contract/sql"
import { Cause, Effect, Exit } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, ProContract.node])))
const contractID = ProContract.ID.make("pct_evaluation_atomicity")
const scope = "evaluation-atomicity"
const spec = ProContract.defaultSpec("Deliver an independently evaluated change", 0)
const evaluatorHash = "evaluator-v1"
const evaluationID = ProContract.evaluationID(contractID, 1, evaluatorHash)
const settlement = {
  contractID: evaluationID,
  evidenceHash: "evaluation-evidence-A",
  time: 2,
  report: {
    deliveryContractID: contractID,
    deliveryRevision: 1,
    subjectHash: "subject-A",
    evaluatorHash,
    passed: true,
    disclosure: "sealed",
    summary: "Independent evaluator accepted candidate A",
  },
} satisfies Parameters<ProContract.Interface["settleEvaluation"]>[0]

describe("ProContract evaluation settlement", () => {
  it.effect("rolls back activation, handoff, attestation and ledger writes when settlement fails", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const database = yield* Database.Service
      yield* readyDelivery()
      const before = {
        delivery: yield* contracts.get(contractID),
        evaluation: yield* contracts.get(evaluationID),
        history: yield* contracts.history({ contractID: evaluationID }),
        quiet: yield* contracts.quiet(scope),
        attestations: yield* database.db.select().from(ProContractAttestationTable).all(),
      }
      expect(before.evaluation?.status).toBe("dormant")
      expect(before.evaluation?.handoff).toBeUndefined()

      // Fail attestation persistence after activation and handoff have both run.
      yield* database.db.run(`
        CREATE TEMP TRIGGER fail_evaluation_attestation
        BEFORE INSERT ON pro_contract_attestation
        WHEN NEW.contract_id = '${evaluationID}'
        BEGIN
          SELECT RAISE(ABORT, 'injected settlement failure');
        END
      `)
      const failed = yield* contracts.settleEvaluation(settlement).pipe(Effect.exit)
      expect(Exit.isFailure(failed) ? Cause.pretty(failed.cause) : "").toContain("injected settlement failure")
      expect(yield* contracts.get(contractID)).toEqual(before.delivery)
      expect(yield* contracts.get(evaluationID)).toEqual(before.evaluation)
      expect(yield* contracts.history({ contractID: evaluationID })).toEqual(before.history)
      expect(yield* contracts.quiet(scope)).toEqual(before.quiet)
      expect(yield* database.db.select().from(ProContractAttestationTable).all()).toEqual(before.attestations)

      yield* database.db.run("DROP TRIGGER fail_evaluation_attestation")
      const settled = yield* contracts.settleEvaluation(settlement)
      expect(settled.decision).toEqual({ type: "accepted" })
      expect(yield* contracts.get(evaluationID)).toMatchObject({
        status: "discharged",
        handoff: { subjectHash: settlement.report.subjectHash },
      })
      expect((yield* contracts.history({ contractID: evaluationID })).map((event) => event.command.type)).toEqual([
        "issue",
        "activate",
        "report-ready",
        "discharge",
      ])
      expect(yield* contracts.quiet(scope)).toMatchObject({
        quiet: true,
        frontier: before.quiet.frontier + 3,
        outstanding: [],
      })
      expect(yield* contracts.get(contractID)).toEqual(before.delivery)
    }),
  )

  it.effect("rejects an evaluation for a replaced delivery handoff without changing the ledger", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      yield* readyDelivery()
      yield* contracts.challenge({
        contractID,
        revision: 1,
        subjectHash: settlement.report.subjectHash,
        evidenceHash: "counterexample-A",
        disclosure: "executor",
        summary: "Candidate A failed independent verification",
        time: 3,
      })
      yield* contracts.activate(contractID, 1, 4)
      yield* contracts.reportReady({
        contractID,
        revision: 1,
        summary: "Candidate B",
        uncertainties: [],
        subjectHash: "subject-B",
        time: 5,
      })
      yield* contracts.principalAttest({
        contractID,
        revision: 1,
        specHash: ProContract.hashSpec(spec),
        subjectHash: "subject-B",
        evidenceHash: "delivery-evidence-B",
      })
      const before = {
        contracts: yield* contracts.list(scope),
        history: yield* contracts.history({ contractID: evaluationID }),
        quiet: yield* contracts.quiet(scope),
      }
      const failed = yield* contracts.settleEvaluation({ ...settlement, time: 6 }).pipe(Effect.exit)
      expect(Exit.isFailure(failed) ? Cause.pretty(failed.cause) : "").toContain(
        "Evaluation subject does not match delivery handoff",
      )
      expect(yield* contracts.list(scope)).toEqual(before.contracts)
      expect(yield* contracts.history({ contractID: evaluationID })).toEqual(before.history)
      expect(yield* contracts.quiet(scope)).toEqual(before.quiet)
      expect(yield* contracts.get(evaluationID)).toMatchObject({ status: "dormant" })

      expect(
        (yield* contracts.settleEvaluation({
          ...settlement,
          evidenceHash: "evaluation-evidence-B",
          time: 6,
          report: { ...settlement.report, subjectHash: "subject-B", summary: "Candidate B accepted" },
        })).decision,
      ).toEqual({ type: "accepted" })
      expect(yield* contracts.quiet(scope)).toMatchObject({ quiet: true })
    }),
  )
})

function readyDelivery() {
  return Effect.gen(function* () {
    const contracts = yield* ProContract.Service
    yield* contracts.issue({ id: contractID, scope, spec, executor: "opencode" })
    yield* contracts.issueEvaluation({ deliveryContractID: contractID, evaluatorHash, deadline: 100 })
    yield* contracts.activate(contractID, 1, 0)
    yield* contracts.reportReady({
      contractID,
      revision: 1,
      summary: "Candidate A",
      uncertainties: [],
      subjectHash: settlement.report.subjectHash,
      time: 1,
    })
    yield* contracts.principalAttest({
      contractID,
      revision: 1,
      specHash: ProContract.hashSpec(spec),
      subjectHash: settlement.report.subjectHash,
      evidenceHash: "delivery-evidence-A",
    })
  })
}
