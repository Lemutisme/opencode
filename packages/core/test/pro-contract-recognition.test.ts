import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { eq } from "drizzle-orm"
import { LayerNode } from "../src/effect/layer-node"
import { ProContract } from "../src/pro-contract"
import { ProContractRecognition } from "../src/pro-contract/recognition"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import recognitionMigration from "../src/database/migration/20260918220926_contract_recognition"
import { ProContractContextTable, ProContractEventTable } from "../src/pro-contract/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ProContract.node, Database.node])))
const spec = ProContract.defaultSpec("Recognize the reviewed delivery", 0)

const issue = Effect.fnUntraced(function* (contracts: ProContract.Interface, input?: Partial<ProContract.Spec>) {
  const result = yield* contracts.issue({ scope: "recognition", executor: "researcher", spec: { ...spec, ...input } })
  expect(result.decision.type).toBe("accepted")
  return result.contract!.id
})

const ready = Effect.fnUntraced(function* (contracts: ProContract.Interface, contractID: ProContract.ID) {
  const contract = (yield* contracts.get(contractID))!
  expect((yield* contracts.activate(contractID, contract.revision, 1)).decision.type).toBe("accepted")
  expect(
    (yield* contracts.reportReady({
      contractID,
      revision: contract.revision,
      subjectHash: "same-subject",
      summary: "same candidate",
      uncertainties: [],
      time: 2,
    })).decision.type,
  ).toBe("accepted")
  return (yield* contracts.get(contractID))!
})

const challenge = (
  contracts: ProContract.Interface,
  current: ProContract.ContractView,
  disclosure: "sealed" | "executor" = "executor",
) =>
  contracts.challenge({
    contractID: current.id,
    operationID: crypto.randomUUID(),
    expected: current.recognition.handoff!,
    evidenceHash: "counterexample",
    disclosure,
    summary: disclosure === "executor" ? "reproduce mismatch" : undefined,
    time: 3,
  })

const request = (current: ProContract.ContractView) => ({
  contractID: current.id,
  operationID: crypto.randomUUID(),
  expected: current.recognition.handoff!,
  evidenceHash: "independent-report",
})

const evaluation = Effect.fnUntraced(function* (contracts: ProContract.Interface) {
  const id = yield* issue(contracts)
  const delivery = yield* ready(contracts, id)
  const attestation = yield* contracts.principalAttest(request(delivery))
  const result = yield* contracts.issueEvaluation({ deliveryContractID: id, evaluatorHash: "oracle", deadline: 100 })
  const current = (yield* contracts.get(result.contract!.id))!
  return {
    current,
    report: {
      version: 2,
      deliveryContractID: id,
      delivery: delivery.recognition.handoff!,
      deliveryAttestationID: attestation.support!.attestationID,
      evaluation: current.recognition.context!.target,
      evaluatorHash: "oracle",
      passed: true,
      disclosure: "executor",
      summary: "oracle accepted",
    } satisfies ProContract.EvaluationReport,
  }
})

test("support validation visits shared dependencies once and still rejects cycles", () => {
  const target = {
    revision: 1,
    specHash: "spec",
    subjectHash: "candidate",
    handoffID: "handoff",
    contextHash: "context",
  }
  const views = Array.from(
    { length: 80 },
    (_, index): ProContract.ContractView => ({
      id: ProContract.ID.make(`pct_diamond_${index}`),
      issuer: "owner",
      executor: "executor",
      scope: "diamond",
      revision: 1,
      specHash: "spec",
      status: "discharged",
      attestationID: ProContract.AttestationID.make(`pca_${index}`),
      spec: {
        ...spec,
        requires:
          index < 2
            ? []
            : [0, 1].map((offset) => ({
                contractID: ProContract.ID.make(`pct_diamond_${Math.floor(index / 2) * 2 - 2 + offset}`),
                revision: 1,
              })),
      },
      recognition: {
        handoff: target,
        context: {
          target: { revision: 1, specHash: "spec", version: 1, phaseID: "phase" },
          profile: "native",
          referenceHash: "none",
          admitted: true,
        },
      },
    }),
  )
  const last = views.at(-1)!
  const support = { contractID: last.id, attestationID: last.attestationID!, target, valid: true }
  expect(ProContractRecognition.validSupport(views, support)).toBe(true)
  expect(
    ProContractRecognition.validSupport(
      views.map((view, index) => (index === 0 ? { ...view, status: "dormant" } : view)),
      support,
    ),
  ).toBe(false)
  expect(
    ProContractRecognition.validSupport(
      views.map((view, index) =>
        index === 0 ? { ...view, spec: { ...view.spec, requires: [{ contractID: last.id, revision: 1 }] } } : view,
      ),
      support,
    ),
  ).toBe(false)
})

describe("exact recognition boundary", () => {
  it.effect("rejects same-subject ABA and never replays historical success into new support", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const id = yield* issue(contracts)
      const first = yield* ready(contracts, id)
      const old = request(first)
      const accepted = yield* contracts.principalAttest(old)
      expect(accepted.support?.valid).toBe(true)
      yield* challenge(contracts, (yield* contracts.get(id))!)
      const second = yield* ready(contracts, id)
      expect(second.recognition.handoff?.handoffID).not.toBe(old.expected.handoffID)
      const retry = yield* contracts.principalAttest(old)
      expect(retry).toMatchObject({
        decision: accepted.decision,
        frontier: accepted.frontier,
        hash: accepted.hash,
        replayed: true,
        support: { valid: false },
      })
      const stale = yield* contracts.principalAttest({ ...old, operationID: crypto.randomUUID() })
      expect(stale.decision.type).toBe("rejected")
      expect((yield* challenge(contracts, first)).decision.type).toBe("rejected")
      expect((yield* contracts.get(id))!.status).toBe("verification")
      expect((yield* contracts.principalAttest(request(second))).support?.valid).toBe(true)
    }),
  )

  it.effect("rejects empty operation IDs before mutation across every principal entry point", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const state = yield* evaluation(contracts)
      const id = yield* issue(contracts)
      const current = yield* ready(contracts, id)
      const proposed = yield* issue(contracts)
      yield* contracts.petitionRevision({
        contractID: proposed,
        spec: { ...spec, goal: "Changed" },
        reason: "new criteria",
      })
      const before = yield* contracts.quiet("recognition")
      const actions = [
        contracts.principalAttest({ ...request(current), operationID: "" }),
        contracts.challenge({
          contractID: id,
          operationID: "",
          expected: current.recognition.handoff!,
          evidenceHash: "negative",
          disclosure: "sealed",
          time: 3,
        }),
        contracts.decideRevision({
          contractID: proposed,
          operationID: "",
          expected: (yield* contracts.get(proposed))!.recognition.pending!,
          accept: true,
        }),
        contracts.settleEvaluation({
          contractID: state.current.id,
          operationID: "",
          report: state.report,
          evidenceHash: "report",
          time: 4,
        }),
      ]
      for (const action of actions) {
        expect(Exit.isFailure(yield* action.pipe(Effect.exit))).toBe(true)
        expect(yield* contracts.quiet("recognition")).toEqual(before)
      }
    }),
  )

  it.effect("serializes duplicate first submissions and persists conflicting attempts separately", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const id = yield* issue(contracts)
      const input = request(yield* ready(contracts, id))
      const results = yield* Effect.all(
        Array.from({ length: 8 }, () => contracts.principalAttest(input)),
        { concurrency: "unbounded" },
      )
      expect(results.filter((result) => !result.replayed)).toHaveLength(1)
      expect(new Set(results.map((result) => result.hash)).size).toBe(1)
      const before = yield* contracts.history({ contractID: id })
      const changed = { ...input, evidenceHash: "different" }
      const conflict = yield* contracts.principalAttest(changed)
      expect(conflict.decision).toMatchObject({ type: "rejected", reason: expect.stringContaining("operationID") })
      expect(conflict.hash).not.toBe(results[0]!.hash)
      expect(yield* contracts.principalAttest(changed)).toEqual({ ...conflict, replayed: true })
      expect(yield* contracts.principalAttest(input)).toEqual({ ...results[0]!, replayed: true })
      expect(yield* contracts.history({ contractID: id })).toHaveLength(before.length + 1)
      const other = yield* issue(contracts)
      const reused = yield* contracts.principalAttest({ ...input, contractID: other })
      expect(reused.decision.type).toBe("rejected")
      const anotherKind = yield* contracts.challenge({ ...input, disclosure: "sealed", time: 4 })
      expect(anotherKind.decision.type).toBe("rejected")
      expect((yield* contracts.get(id))!.status).toBe("discharged")
    }),
  )

  it.effect("binds public revision decisions to the accepted petition, including identical replacements", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const id = yield* issue(contracts)
      const proposal = { ...spec, goal: "Revised goal" }
      yield* contracts.petitionRevision({ contractID: id, spec: proposal, reason: "first" })
      const expected = (yield* contracts.get(id))!.recognition.pending!
      yield* contracts.decideRevision({ contractID: id, operationID: "reject-first", expected, accept: false })
      yield* contracts.petitionRevision({ contractID: id, spec: proposal, reason: "replacement" })
      for (const accept of [true, false])
        expect(
          (yield* contracts.decideRevision({ contractID: id, operationID: crypto.randomUUID(), expected, accept }))
            .decision.type,
        ).toBe("rejected")
      expect(
        (yield* contracts.decideRevision({
          contractID: id,
          operationID: "accept-new",
          expected: (yield* contracts.get(id))!.recognition.pending!,
          accept: true,
        })).decision.type,
      ).toBe("accepted")
      const current = yield* ready(contracts, id)
      expect(current.recognition.handoff?.revision).toBe(2)
      expect((yield* contracts.principalAttest(request(current))).support?.valid).toBe(true)
    }),
  )

  it.effect("rejects late host context publication and preserves custom profile across issue and revision", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const id = yield* issue(contracts)
      const first = yield* ready(contracts, id)
      const publication = {
        contractID: id,
        expected: first.recognition.context!.target,
        profile: "research",
        referenceHash: "report-1",
        admitted: true,
      }
      const custom = yield* contracts.setRecognitionContext(publication)
      expect(custom.context?.profile).toBe("research")
      yield* contracts.issue({ id, scope: "recognition", executor: "researcher", spec })
      expect((yield* contracts.get(id))!.recognition.context).toEqual(custom.context)
      const missing = request((yield* contracts.get(id))!)
      expect((yield* contracts.principalAttest(missing)).decision.type).toBe("rejected")
      // Withdrawing support remains available without a research acceptance validator.
      yield* challenge(contracts, (yield* contracts.get(id))!)
      const second = yield* ready(contracts, id)
      expect(second.recognition.context).toMatchObject({ profile: "research", admitted: false, referenceHash: "none" })
      expect(
        (yield* contracts.setRecognitionContext({ ...publication, expected: custom.context!.target })).conflict,
      ).toBeDefined()
      yield* contracts.petitionRevision({ contractID: id, spec: { ...spec, goal: "Changed" }, reason: "new terms" })
      yield* contracts.decideRevision({
        contractID: id,
        operationID: "custom-revision",
        expected: (yield* contracts.get(id))!.recognition.pending!,
        accept: true,
      })
      expect((yield* contracts.get(id))!.recognition.context).toMatchObject({ profile: "research", admitted: false })
    }),
  )

  it.effect("keeps a missing-validator rejection immutable after installation and accepts only a fresh operation", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const id = yield* issue(contracts)
      const current = yield* ready(contracts, id)
      yield* contracts.setRecognitionContext({
        contractID: id,
        expected: current.recognition.context!.target,
        profile: "custom",
        referenceHash: "bound-report",
        admitted: true,
      })
      const input = request((yield* contracts.get(id))!)
      const rejected = yield* contracts.principalAttest(input)
      expect(rejected.decision.type).toBe("rejected")
      const calls: string[] = []
      const validator: ProContractRecognition.Validator = {
        identity: "custom:1",
        validate: (input) =>
          Effect.sync(() => {
            calls.push(input.evidenceHash)
            return input.contract.recognition.context?.referenceHash === "bound-report" ? undefined : "wrong report"
          }),
      }
      yield* Effect.gen(function* () {
        expect(yield* contracts.principalAttest(input)).toEqual({ ...rejected, replayed: true })
        expect(calls).toHaveLength(0)
        const accepted = yield* contracts.principalAttest({ ...input, operationID: "new-validator-operation" })
        expect(accepted.support?.valid).toBe(true)
        expect(calls).toEqual([input.evidenceHash])
        expect((yield* contracts.principalAttest({ ...input, evidenceHash: "conflict" })).decision.type).toBe(
          "rejected",
        )
        expect(calls).toHaveLength(1)
      }).pipe(Effect.provideService(ProContract.Validators, { get: () => validator }))
    }),
  )

  it.effect("persists an empty-string validator rejection instead of treating it as success", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const id = yield* issue(contracts)
      const current = yield* ready(contracts, id)
      yield* contracts.setRecognitionContext({
        contractID: id,
        expected: current.recognition.context!.target,
        profile: "custom",
        referenceHash: "report",
        admitted: true,
      })
      const input = request((yield* contracts.get(id))!)
      const calls: string[] = []
      const validator: ProContractRecognition.Validator = {
        identity: "empty-rejection",
        validate: () =>
          Effect.sync(() => {
            calls.push("called")
            return ""
          }),
      }
      yield* Effect.gen(function* () {
        const rejected = yield* contracts.principalAttest(input)
        expect(rejected.decision).toEqual({ type: "rejected", reason: "command rejected without a reason" })
        expect(rejected.support).toBeUndefined()
        expect((yield* contracts.get(id))!.status).toBe("verification")
        expect((yield* contracts.history({ contractID: id })).at(-1)!.decision).toEqual(rejected.decision)
        expect(yield* contracts.principalAttest(input)).toEqual({ ...rejected, replayed: true })
        expect(calls).toHaveLength(1)
      }).pipe(Effect.provideService(ProContract.Validators, { get: () => validator }))
      const guarded = yield* ProContract.withCommandGuard(
        contracts.reportBlocked({ contractID: id, revision: 1, reason: "block", time: 3 }),
        () => Effect.succeed(""),
      )
      expect(guarded.decision).toEqual({ type: "rejected", reason: "command rejected without a reason" })
    }),
  )

  it.effect("does not recover a handoff identity from an accepted failed replay", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const policy = { checks: [{ argv: ["test"], timeout: 1000, exit: 0 }], protected: [], artifacts: [] }
      const id = yield* issue(contracts, { evidence: { type: "principal", replay: policy } })
      yield* contracts.activate(id, 1, 0)
      const input = {
        contractID: id,
        revision: 1,
        summary: "replay",
        uncertainties: [],
        subjectHash: "same",
        time: 1,
        replay: {
          policyHash: ProContract.hashReplay(policy),
          subjectHash: "same",
          evidenceHash: "replay",
          passed: false,
          summary: "failed",
        },
      }
      expect((yield* contracts.reportReady(input)).decision.type).toBe("accepted")
      expect((yield* contracts.get(id))!.recognition.handoff).toBeUndefined()
      yield* contracts.activate(id, 1, 2)
      const success = yield* contracts.reportReady({ ...input, replay: { ...input.replay, passed: true } })
      expect((yield* contracts.get(id))!.recognition.handoff?.handoffID).toBe(`pch_${success.hash}`)
    }),
  )

  for (const race of ["context", "validator", "petition"] as const)
    it.effect(`fences ${race} replacement during external validation`, () =>
      Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const id = yield* issue(contracts)
        const current = yield* ready(contracts, id)
        yield* contracts.setRecognitionContext({
          contractID: id,
          expected: current.recognition.context!.target,
          profile: "custom",
          admitted: true,
          referenceHash: "immutable",
        })
        const started = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const registrations = new Map<string, ProContractRecognition.Validator>([
          [
            "custom",
            {
              identity: "v1",
              validate: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(finish)
                  return undefined
                }),
            },
          ],
        ])
        const input = request((yield* contracts.get(id))!)
        const fiber = yield* contracts
          .principalAttest(input)
          .pipe(
            Effect.provideService(ProContract.Validators, { get: (profile) => registrations.get(profile) }),
            Effect.forkChild,
          )
        yield* Deferred.await(started)
        if (race === "context")
          yield* contracts.setRecognitionContext({
            contractID: id,
            expected: (yield* contracts.get(id))!.recognition.context!.target,
            profile: "custom",
            admitted: false,
            referenceHash: "revoked",
          })
        if (race === "validator")
          registrations.set("custom", { identity: "v2", validate: () => Effect.succeed(undefined) })
        if (race === "petition") {
          expect(
            (yield* contracts.petitionRevision({
              contractID: id,
              spec: { ...(yield* contracts.get(id))!.spec, goal: "Proposed change" },
              reason: "Ask external Principal",
            })).decision.type,
          ).toBe("accepted")
          const pending = (yield* contracts.get(id))!
          expect(pending.recognition.handoff?.handoffID).toBe(input.expected.handoffID)
          expect(
            (yield* contracts.decideRevision({
              contractID: id,
              accept: false,
              expected: pending.recognition.pending!,
              operationID: crypto.randomUUID(),
            })).decision.type,
          ).toBe("accepted")
          expect((yield* contracts.get(id))!.pendingRevision).toBeUndefined()
        }
        yield* Deferred.succeed(finish, undefined)
        const rejected = yield* Fiber.join(fiber)
        expect(rejected.decision.type).toBe("rejected")
        expect((yield* contracts.get(id))!.status).toBe("verification")
        expect(yield* contracts.principalAttest(input)).toEqual({ ...rejected, replayed: true })
      }),
    )

  it.effect("invalidates contexts throughout the dependency closure, including dormant evaluation", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const state = yield* evaluation(contracts)
      const before = state.current.recognition.context!
      const delivery = (yield* contracts.get(state.report.deliveryContractID))!
      yield* challenge(contracts, delivery)
      const current = (yield* contracts.get(state.current.id))!
      expect(current.status).toBe("dormant")
      expect(current.recognition.context!.target.phaseID).not.toBe(before.target.phaseID)
      expect(
        (yield* contracts.setRecognitionContext({
          contractID: current.id,
          expected: before.target,
          profile: "custom",
          admitted: false,
          referenceHash: "old",
        })).conflict,
      ).toBeDefined()
      const restored = yield* ready(contracts, delivery.id)
      yield* contracts.principalAttest(request(restored))
      expect(
        (yield* contracts.settleEvaluation({
          contractID: current.id,
          report: state.report,
          operationID: "late-report",
          evidenceHash: "report",
          time: 4,
        })).decision.type,
      ).toBe("rejected")
    }),
  )

  for (const disclosure of ["executor", "sealed"] as const)
    it.effect(`rejects old evaluation reports after its own ${disclosure} challenge while delivery is unchanged`, () =>
      Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const state = yield* evaluation(contracts)
        const input = {
          contractID: state.current.id,
          report: state.report,
          operationID: "evaluation",
          evidenceHash: "report",
          time: 4,
        }
        const accepted = yield* contracts.settleEvaluation(input)
        expect(accepted.support?.valid).toBe(true)
        yield* challenge(contracts, (yield* contracts.get(state.current.id))!, disclosure)
        if (disclosure === "sealed") yield* contracts.resume(state.current.id)
        expect((yield* contracts.settleEvaluation({ ...input, operationID: "late-positive" })).decision.type).toBe(
          "rejected",
        )
        expect(
          (yield* contracts.settleEvaluation({
            ...input,
            operationID: "late-negative",
            report: { ...input.report, passed: false },
          })).decision.type,
        ).toBe("rejected")
        expect((yield* contracts.get(state.report.deliveryContractID))!.status).toBe("discharged")
        expect(yield* contracts.settleEvaluation(input)).toMatchObject({
          hash: accepted.hash,
          replayed: true,
          support: { valid: false },
        })
        expect(
          (yield* contracts.settleEvaluation({
            ...input,
            operationID: "fresh-report",
            report: {
              ...input.report,
              evaluation: (yield* contracts.get(state.current.id))!.recognition.context!.target,
            },
          })).support?.valid,
        ).toBe(true)
      }),
    )

  for (const passed of [true, false])
    it.effect(`rejects empty evaluation evidence for passed=${passed} without partial state`, () =>
      Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const state = yield* evaluation(contracts)
        const before = yield* contracts.get(state.report.deliveryContractID)
        const input = {
          contractID: state.current.id,
          report: { ...state.report, passed },
          operationID: "empty-evidence",
          evidenceHash: "",
          time: 4,
        }
        const rejected = yield* contracts.settleEvaluation(input)
        expect(rejected.decision).toEqual({ type: "rejected", reason: "independent evidence hash is required" })
        expect(yield* contracts.get(state.current.id)).toEqual(state.current)
        expect(yield* contracts.get(state.report.deliveryContractID)).toEqual(before)
        expect(yield* contracts.settleEvaluation({ ...input, time: 5 })).toEqual({ ...rejected, replayed: true })
      }),
    )

  it.effect("rolls back all evaluation intermediate state and events on a normal final rejection", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const state = yield* evaluation(contracts)
      const before = yield* contracts.history({ contractID: state.current.id })
      const input = {
        contractID: state.current.id,
        report: state.report,
        operationID: "rollback",
        evidenceHash: "report",
        time: 4,
      }
      const rejected = yield* ProContract.withCommandGuard(contracts.settleEvaluation(input), (command) =>
        Effect.succeed(command.type === "discharge" ? "final gate rejected" : undefined),
      )
      expect(rejected.decision).toEqual({ type: "rejected", reason: "final gate rejected" })
      expect(yield* contracts.get(state.current.id)).toEqual(state.current)
      const after = yield* contracts.history({ contractID: state.current.id })
      expect(after).toHaveLength(before.length + 1)
      expect(after.at(-1)!.decision.type).toBe("rejected")
      expect(yield* contracts.settleEvaluation(input)).toEqual({ ...rejected, replayed: true })
    }),
  )

  it.effect("rolls back an evaluation on database failure without partial handoff or receipt", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const database = yield* Database.Service
      const state = yield* evaluation(contracts)
      const before = yield* contracts.history({ contractID: state.current.id })
      yield* database.db.run(
        "CREATE TRIGGER fail_attestation BEFORE INSERT ON pro_contract_attestation BEGIN SELECT RAISE(ABORT, 'disk fault'); END;",
      )
      const result = yield* contracts
        .settleEvaluation({
          contractID: state.current.id,
          report: state.report,
          operationID: "db-failure",
          evidenceHash: "report",
          time: 4,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* contracts.get(state.current.id)).toEqual(state.current)
      expect(yield* contracts.history({ contractID: state.current.id })).toEqual(before)
      yield* database.db.run("DROP TRIGGER fail_attestation")
      expect(
        (yield* contracts.settleEvaluation({
          contractID: state.current.id,
          report: state.report,
          operationID: "db-failure",
          evidenceHash: "report",
          time: 4,
        })).support?.valid,
      ).toBe(true)
    }),
  )

  it.effect("migrates legacy native support without modifying ledger bytes or inventing operation history", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const database = yield* Database.Service
      const id = yield* issue(contracts)
      const current = yield* ready(contracts, id)
      yield* contracts.principalAttest(request(current))
      const before = yield* contracts.history({ contractID: id })
      yield* database.db.run("DROP TABLE pro_contract_context")
      yield* database.db.run("DROP TABLE pro_contract_operation")
      yield* database.db.run("DROP TABLE pro_contract_attempt")
      yield* database.db.run("DELETE FROM migration WHERE id = '20260918220926_contract_recognition'")
      yield* DatabaseMigration.applyOnly(database.db, [recognitionMigration])
      const recovered = (yield* contracts.get(id))!
      expect(recovered.recognition.unavailable).toBeUndefined()
      expect(recovered.recognition.handoff?.handoffID).toBe(current.recognition.handoff?.handoffID)
      expect(recovered.recognition.context?.profile).toBe("native")
      expect(yield* contracts.history({ contractID: id })).toEqual(before)
      expect(yield* database.db.all("SELECT * FROM pro_contract_operation")).toEqual([])
      expect((yield* challenge(contracts, recovered)).decision.type).toBe("accepted")
    }),
  )

  for (const damage of ["context", "history"] as const)
    it.effect(`fails closed for missing ${damage} without repairing it on reads or reissue`, () =>
      Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const database = yield* Database.Service
        const id = yield* issue(contracts)
        const input = request(yield* ready(contracts, id))
        if (damage === "context")
          yield* database.db.delete(ProContractContextTable).where(eq(ProContractContextTable.contract_id, id)).run()
        if (damage === "history")
          yield* database.db.delete(ProContractEventTable).where(eq(ProContractEventTable.seq, 1)).run()
        expect((yield* contracts.get(id))!.recognition.handoff).toBeUndefined()
        yield* contracts.issue({ id, scope: "recognition", executor: "researcher", spec })
        expect((yield* contracts.get(id))!.recognition.handoff).toBeUndefined()
        expect((yield* contracts.get(id))!.recognition.unavailable).toBeDefined()
        expect((yield* contracts.principalAttest(input)).decision.type).toBe("rejected")
      }),
    )
})
