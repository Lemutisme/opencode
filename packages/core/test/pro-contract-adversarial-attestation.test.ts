import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProContract } from "@opencode-ai/core/pro-contract"
import {
  ProContractAttestationTable,
  ProContractEventTable,
  ProContractLedgerTable,
  ProContractTable,
} from "@opencode-ai/core/pro-contract/sql"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, ProContract.node])))
const contractID = ProContract.ID.make("pct_adversarial_attestation")
const scope = "adversarial-attestation"
const spec = ProContract.defaultSpec("Accept evidence only for the evaluated obligation", 0)
const subjectHash = "unchanged-subject"

describe("ProContract principal attestation boundaries", () => {
  it.effect("records an exact retry after discharge as rejected without duplicating its attestation", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const evidence = yield* ready()
      const accepted = yield* contracts.principalAttest(evidence)
      expect(accepted.decision).toEqual({ type: "accepted" })
      const before = yield* persisted()
      expect(before.attestations).toHaveLength(1)

      // Unlike issue admission, principal attestation does not expose an idempotency key.
      const retried = yield* contracts.principalAttest(evidence)
      expect(retried.decision).toEqual({ type: "rejected", reason: "contract is already settled" })
      const after = yield* persisted()
      expect(after.contracts).toEqual(before.contracts)
      expect(after.attestations).toEqual(before.attestations)
      expect(after.quiet).toMatchObject({
        quiet: true,
        stateHash: before.quiet.stateHash,
        frontier: before.quiet.frontier + 1,
      })
      expect(after.events.slice(0, -1)).toEqual(before.events)
      expect(after.events.at(-1)).toMatchObject({
        seq: retried.frontier,
        previous_hash: accepted.hash,
        hash: retried.hash,
        command: { type: "discharge", contractID, attestation: evidenceCoordinates(evidence) },
        decision: retried.decision,
      })
      if (retried.event.command.type !== "discharge") throw new Error("Attestation command missing")
      expect(retried.event.command.attestation.id).not.toBe(before.attestations[0]!.id)
      expect(yield* contracts.getAttestation(retried.event.command.attestation.id)).toBeUndefined()
      expect(after.ledger).toEqual([{ id: 1, head_seq: retried.frontier, head_hash: retried.hash }])
      expect(yield* contracts.history({ contractID, after: accepted.frontier })).toEqual(after.events.slice(-1))
    }),
  )
  ;[
    { name: "revision", evidence: { revision: 2 }, reason: "attestation revision does not match" },
    {
      name: "specification hash",
      evidence: { specHash: "another-specification" },
      reason: "attestation specification does not match",
    },
    {
      name: "subject hash",
      evidence: { subjectHash: "another-subject" },
      reason: "attestation subject does not match",
    },
  ].forEach((scenario) => {
    it.effect(`rejects a wrong ${scenario.name} without changing the handoff or storing an attestation`, () =>
      Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const evidence = yield* ready()
        const before = yield* persisted()
        const rejected = yield* contracts.principalAttest({ ...evidence, ...scenario.evidence })

        expect(rejected.decision).toEqual({ type: "rejected", reason: scenario.reason })
        const after = yield* persisted()
        expect(after.contracts).toEqual(before.contracts)
        expect(after.attestations).toEqual([])
        expect(after.quiet).toMatchObject({
          quiet: false,
          outstanding: [contractID],
          stateHash: before.quiet.stateHash,
          frontier: before.quiet.frontier + 1,
        })
        expect(after.events.slice(0, -1)).toEqual(before.events)
        expect(after.events.at(-1)).toMatchObject({
          seq: rejected.frontier,
          previous_hash: before.quiet.ledgerHash,
          hash: rejected.hash,
          command: {
            type: "discharge",
            contractID,
            attestation: { ...evidenceCoordinates(evidence), ...scenario.evidence },
          },
          decision: rejected.decision,
        })
        expect(after.ledger).toEqual([{ id: 1, head_seq: rejected.frontier, head_hash: rejected.hash }])

        const accepted = yield* contracts.principalAttest(evidence)
        expect(accepted.decision).toEqual({ type: "accepted" })
        const settled = yield* persisted()
        expect(settled.attestations).toHaveLength(1)
        expect(settled.attestations[0]?.data).toMatchObject(evidence)
        expect(settled.events.at(-1)?.previous_hash).toBe(rejected.hash)
        expect(settled.quiet).toMatchObject({ quiet: true, frontier: rejected.frontier + 1 })
      }),
    )
  })

  it.effect("rejects old revision evidence even when the revised handoff has identical subject bytes", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const evidence = yield* ready()
      const petition = yield* contracts.petitionRevision({
        contractID,
        spec: { ...spec, brief: "Verify the same artifact against the revised brief" },
        reason: "Clarify the obligation before adjudication",
      })
      expect(petition.decision).toEqual({ type: "accepted" })
      const revised = yield* contracts.decideRevision({ contractID, accept: true })
      expect(revised.decision).toEqual({ type: "accepted" })
      expect(yield* contracts.get(contractID)).toMatchObject({ revision: 2, status: "dormant" })
      expect((yield* contracts.get(contractID))?.handoff).toBeUndefined()
      expect((yield* contracts.activate(contractID, 2, 1)).decision).toEqual({ type: "accepted" })
      const handedOff = yield* contracts.reportReady({
        contractID,
        revision: 2,
        summary: "Identical artifact rechecked for the revised obligation",
        uncertainties: [],
        subjectHash,
        time: 1,
      })
      expect(handedOff.decision).toEqual({ type: "accepted" })
      const before = yield* persisted()
      expect(before.contracts[0]?.data.handoff?.subjectHash).toBe(evidence.subjectHash)
      expect(before.contracts[0]?.data.specHash).not.toBe(evidence.specHash)

      const stale = yield* contracts.principalAttest(evidence)
      expect(stale.decision).toEqual({ type: "rejected", reason: "attestation revision does not match" })
      const rebound = yield* contracts.principalAttest({ ...evidence, revision: 2 })
      expect(rebound.decision).toEqual({ type: "rejected", reason: "attestation specification does not match" })
      const after = yield* persisted()
      expect(after.contracts).toEqual(before.contracts)
      expect(after.attestations).toEqual([])
      expect(after.quiet).toMatchObject({
        quiet: false,
        stateHash: before.quiet.stateHash,
        frontier: before.quiet.frontier + 2,
      })
      expect(after.events.slice(0, -2)).toEqual(before.events)
      expect(after.events.slice(-2)).toMatchObject([
        { previous_hash: handedOff.hash, hash: stale.hash, decision: stale.decision },
        { previous_hash: stale.hash, hash: rebound.hash, decision: rebound.decision },
      ])
      expect(after.ledger).toEqual([{ id: 1, head_seq: rebound.frontier, head_hash: rebound.hash }])

      const accepted = yield* contracts.principalAttest({
        ...evidence,
        revision: 2,
        specHash: before.contracts[0]!.data.specHash,
        evidenceHash: "independent-evidence-for-revision-2",
      })
      expect(accepted.decision).toEqual({ type: "accepted" })
      const settled = yield* persisted()
      expect(settled.attestations).toHaveLength(1)
      expect(settled.attestations[0]?.data).toMatchObject({
        contractID,
        revision: 2,
        subjectHash,
        evidenceHash: "independent-evidence-for-revision-2",
      })
      expect(settled.events.at(-1)?.previous_hash).toBe(rebound.hash)
      expect(settled.quiet).toMatchObject({ quiet: true, frontier: rebound.frontier + 1 })
    }),
  )
})

function ready() {
  return Effect.gen(function* () {
    const contracts = yield* ProContract.Service
    const issued = yield* contracts.issue({ id: contractID, scope, spec, executor: "opencode" })
    expect(issued.decision).toEqual({ type: "accepted" })
    expect((yield* contracts.activate(contractID, 1, 0)).decision).toEqual({ type: "accepted" })
    expect(
      (yield* contracts.reportReady({
        contractID,
        revision: 1,
        summary: "Candidate ready for independent adjudication",
        uncertainties: [],
        subjectHash,
        time: 0,
      })).decision,
    ).toEqual({ type: "accepted" })
    return {
      contractID,
      revision: 1,
      specHash: ProContract.hashSpec(spec),
      subjectHash,
      evidenceHash: "independent-evidence-for-revision-1",
    }
  })
}

function persisted() {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const contracts = yield* ProContract.Service
    return yield* Effect.all({
      contracts: database.db.select().from(ProContractTable).orderBy(ProContractTable.id).all(),
      attestations: database.db
        .select()
        .from(ProContractAttestationTable)
        .orderBy(ProContractAttestationTable.id)
        .all(),
      events: database.db.select().from(ProContractEventTable).orderBy(ProContractEventTable.seq).all(),
      ledger: database.db.select().from(ProContractLedgerTable).all(),
      quiet: contracts.quiet(scope),
    })
  })
}

function evidenceCoordinates(evidence: ProContract.AttestationEvidence) {
  return {
    revision: evidence.revision,
    specHash: evidence.specHash,
    subjectHash: evidence.subjectHash,
    evidenceHash: evidence.evidenceHash,
  }
}
