import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "../src/effect/layer-node"
import { ProContract } from "../src/pro-contract"
import { Hash } from "../src/util/hash"
import { testEffect } from "./lib/effect"

const scope = "task-independent-laws"
const it = testEffect(LayerNode.compile(ProContract.node))

const issue = Effect.fnUntraced(function* (goal: string, requires: ProContract.Requirement[] = []) {
  const contracts = yield* ProContract.Service
  const receipt = yield* contracts.issue({
    scope,
    executor: "worker",
    spec: {
      ...ProContract.defaultSpec(goal, 0),
      authority: [],
      budget: { deadline: 1_000 },
      requires,
    },
  })
  expect(receipt.decision).toEqual({ type: "accepted" })
  if (!receipt.contract) throw new Error("Issued Contract missing")
  return receipt.contract
})

const handoff = Effect.fnUntraced(function* (
  contract: ProContract.Contract,
  summary: string,
  uncertainties: string[] = [],
  now = 1,
) {
  const contracts = yield* ProContract.Service
  expect((yield* contracts.activate(contract.id, contract.revision, now)).decision).toEqual({ type: "accepted" })
  const receipt = yield* contracts.reportReady({
    contractID: contract.id,
    revision: contract.revision,
    summary,
    uncertainties,
    subjectHash: Hash.sha256(summary),
    time: now + 1,
  })
  expect(receipt.decision).toEqual({ type: "accepted" })
  const current = receipt.state.contracts[contract.id]
  if (!current?.handoff) throw new Error("Submitted handoff missing")
  return { ...current, handoff: current.handoff }
})

const accept = Effect.fnUntraced(function* (contract: ProContract.Contract & { handoff: ProContract.Handoff }) {
  const contracts = yield* ProContract.Service
  const receipt = yield* contracts.principalAttest({
    contractID: contract.id,
    revision: contract.revision,
    specHash: contract.specHash,
    subjectHash: contract.handoff.subjectHash,
    evidenceHash: Hash.sha256(`Principal review of ${contract.id}: ${contract.handoff.subjectHash}`),
  })
  expect(receipt.decision).toEqual({ type: "accepted" })
  const current = receipt.state.contracts[contract.id]
  if (!current?.attestationID) throw new Error("Accepted attestation missing")
  return { ...current, attestationID: current.attestationID }
})

describe("ProContract task-independent laws", () => {
  it.effect("preserves accepted part A while independent part B fails, is challenged, and is revised", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      // Separate acceptance boundaries are necessary: one monolithic Contract cannot retain a partial discharge.
      const a = yield* issue("Deliver the reviewed introduction")
      const b = yield* issue("Deliver the reviewed conclusion")
      const submitted = yield* handoff(a, "Introduction with checked sources")
      const accepted = yield* accept(submitted)
      const evidence = yield* contracts.getAttestation(accepted.attestationID)

      yield* contracts.activate(b.id, b.revision, 1)
      yield* contracts.escalate({ contractID: b.id, revision: b.revision, reason: "Worker exited", time: 2 })
      expect(yield* contracts.get(b.id)).toMatchObject({ status: "escalated", revision: 1 })
      expect(yield* contracts.get(a.id)).toEqual(accepted)
      expect(yield* contracts.quiet(scope)).toMatchObject({ quiet: false, outstanding: [b.id] })

      yield* contracts.resume(b.id)
      const conclusion = yield* handoff(b, "Conclusion incorrectly extrapolates the available evidence", [], 3)
      expect(
        (yield* contracts.challenge({
          contractID: b.id,
          revision: b.revision,
          subjectHash: conclusion.handoff.subjectHash,
          evidenceHash: Hash.sha256("Counterexample to the conclusion"),
          disclosure: "executor",
          summary: "The conclusion claims more than its sources support",
          time: 5,
        })).decision,
      ).toEqual({ type: "accepted" })
      expect(yield* contracts.get(a.id)).toEqual(accepted)

      const goal = "Deliver a conclusion explicitly bounded by the available evidence"
      yield* contracts.petitionRevision({
        contractID: b.id,
        spec: { ...b.spec, goal, evidence: { type: "principal", claim: goal } },
        reason: "Clarify the requested scope, not the already accepted introduction",
      })
      expect((yield* contracts.decideRevision({ contractID: b.id, accept: true })).decision).toEqual({
        type: "accepted",
      })
      expect(yield* contracts.get(b.id)).toMatchObject({ id: b.id, status: "dormant", revision: 2, spec: { goal } })
      expect(yield* contracts.get(a.id)).toEqual(accepted)
      expect(yield* contracts.getAttestation(accepted.attestationID)).toEqual(evidence)
      expect(yield* contracts.quiet(scope)).toMatchObject({ quiet: false, outstanding: [b.id] })
      expect((yield* contracts.history({ contractID: b.id })).map((entry) => entry.command.type)).toEqual([
        "issue",
        "activate",
        "escalate",
        "resume",
        "activate",
        "report-ready",
        "challenge",
        "petition-revision",
        "decide-revision",
      ])
    }),
  )

  it.effect("reopens actual dependents when their support is challenged, not unrelated accepted results", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const premise = yield* issue("Establish the lemma")
      const submitted = yield* handoff(premise, "Lemma proof")
      const accepted = yield* accept(submitted)
      const theorem = yield* issue("Prove the theorem using the lemma", [{ contractID: premise.id, revision: 1 }])
      const proof = yield* handoff(theorem, "Theorem proof depending on the lemma")
      const dependent = yield* accept(proof)
      const independent = yield* issue("Prove an independent identity")
      const identity = yield* handoff(independent, "Direct proof without the lemma")
      const unrelated = yield* accept(identity)
      const evidence = yield* contracts.getAttestation(dependent.attestationID)

      expect(
        (yield* contracts.challenge({
          contractID: premise.id,
          revision: 1,
          subjectHash: submitted.handoff.subjectHash,
          evidenceHash: Hash.sha256("Lemma counterexample"),
          disclosure: "executor",
          summary: "The lemma fails on a boundary case",
          time: 3,
        })).decision,
      ).toEqual({ type: "accepted" })
      const challenged = yield* contracts.get(premise.id)
      const reopened = yield* contracts.get(theorem.id)
      expect(challenged?.status).toBe("dormant")
      expect(challenged?.attestationID).toBeUndefined()
      expect(reopened?.status).toBe("escalated")
      expect(reopened?.attestationID).toBeUndefined()
      expect(yield* contracts.get(independent.id)).toEqual(unrelated)
      expect(yield* contracts.getAttestation(dependent.attestationID)).toEqual(evidence)
      expect(yield* contracts.getAttestation(accepted.attestationID)).toBeDefined()

      yield* contracts.resume(theorem.id)
      expect((yield* contracts.activate(theorem.id, 1, 4)).decision).toEqual({
        type: "rejected",
        reason: `required contract is not evidenced: ${premise.id}`,
      })
      expect((yield* contracts.quiet(scope)).outstanding.toSorted()).toEqual([premise.id, theorem.id].toSorted())
    }),
  )

  it.effect("keeps a historical observation valid when a separately scoped later observation differs", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const yesterday = yield* issue("Report service availability during 2026-10-04 UTC")
      const earlier = yield* handoff(yesterday, "All scheduled observations on 2026-10-04 reported availability")
      const accepted = yield* accept(earlier)
      const evidence = yield* contracts.getAttestation(accepted.attestationID)
      const today = yield* issue("Report service availability during 2026-10-05 UTC")

      expect(yield* contracts.quiet(scope)).toMatchObject({ quiet: false, outstanding: [today.id] })
      const later = yield* handoff(today, "An outage was observed on 2026-10-05")
      yield* accept(later)
      expect(yield* contracts.get(yesterday.id)).toEqual(accepted)
      expect(yield* contracts.getAttestation(accepted.attestationID)).toEqual(evidence)
      expect((yield* contracts.history({ contractID: yesterday.id })).map((entry) => entry.command.type)).toEqual([
        "issue",
        "activate",
        "report-ready",
        "discharge",
      ])
      expect(yield* contracts.quiet(scope)).toMatchObject({ quiet: true })
    }),
  )

  it.effect("accepts negative or inconclusive experiment reports without claiming the improvement goal is met", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const improvement = yield* issue("Demonstrate a more effective working method")
      yield* Effect.forEach(
        [
          {
            summary: "The proposed step did not improve the measured outcome",
            uncertainties: ["Other tasks untested"],
          },
          {
            summary: "The comparison was inconclusive",
            uncertainties: ["The observations cannot distinguish methods"],
          },
        ],
        (outcome) =>
          Effect.gen(function* () {
            const experiment = yield* issue("Run the specified comparison and report its outcome and uncertainty")
            const report = yield* handoff(experiment, outcome.summary, outcome.uncertainties)
            const accepted = yield* accept(report)
            expect(yield* contracts.get(experiment.id)).toMatchObject({
              status: "discharged",
              handoff: outcome,
              attestationID: accepted.attestationID,
            })
            expect(yield* contracts.get(improvement.id)).toEqual(improvement)
          }),
      )
      expect(yield* contracts.quiet(scope)).toMatchObject({ quiet: false, outstanding: [improvement.id] })
    }),
  )

  it.effect("does not confuse a completed handoff or executor self-approval with authorized acceptance", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const duty = yield* issue("Produce a report acceptable to the principal")
      const ready = yield* handoff(duty, "The worker declares the report finished")
      const unverified = yield* contracts.get(duty.id)
      expect(unverified?.status).toBe("verification")
      expect(unverified?.attestationID).toBeUndefined()
      expect(yield* contracts.quiet(scope)).toMatchObject({ quiet: false, outstanding: [duty.id] })

      const state = { contracts: { [ready.id]: ready }, attestations: {} }
      const selfApproved = ProContract.transition(state, {
        type: "discharge",
        actor: ready.executor,
        contractID: ready.id,
        attestation: {
          id: ProContract.AttestationID.create(),
          revision: ready.revision,
          specHash: ready.specHash,
          subjectHash: ready.handoff.subjectHash,
          evidenceHash: Hash.sha256("Worker self-approval"),
          verifierID: ready.executor,
          class: "principal",
        },
      })
      expect(selfApproved.decision).toEqual({
        type: "rejected",
        reason: "principal evidence requires issuer attestation",
      })
      expect(selfApproved.state).toBe(state)

      yield* accept(ready)
      expect(yield* contracts.quiet(scope)).toMatchObject({ quiet: true, outstanding: [] })
    }),
  )
})
