import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { ModelV2 } from "../src/model"
import { ProContract } from "../src/pro-contract"
import { ProContractOpenCode } from "../src/pro-contract/open-code"
import { ProContractPolicy } from "../src/pro-contract/policy"
import { ProContractPromotion } from "../src/pro-contract/promotion"
import { ProContractVersion } from "../src/pro-contract/version"
import { ProContractPolicyTable } from "../src/pro-contract/policy.sql"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { Snapshot } from "../src/snapshot"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const seed = { version: 1, solver: "seed solver", generator: "seed generator" } as const
const candidate = { version: 1, solver: "successor solver", generator: "successor generator" } as const
const protocol: ProContractPromotion.Protocol = {
  version: 1,
  performanceRule: "task-pareto",
  evaluatorHash: Hash.sha256("independent evaluator"),
  tests: [
    { id: "safety", total: 1 },
    ...(["development", "confirmation"] as const).flatMap((panel) =>
      ["0", "1"].map((replicate) => ({
        id: `${panel}-${replicate}`,
        total: 100,
        performance: { panel, task: "task", replicate },
      })),
    ),
  ],
}
const it = testEffect(Layer.empty)

function evidence(
  bundle: ProContractPolicy.Bundle = candidate,
  baseline: ProContractPolicy.Bundle = seed,
): ProContractPromotion.Evidence {
  return {
    protocolHash: ProContractPromotion.hashProtocol(protocol),
    candidateHash: ProContractPolicy.hashBundle(bundle),
    baselineHash: ProContractPolicy.hashBundle(baseline),
    receiptHash: Hash.sha256("complete external accounting"),
    rows: protocol.tests.map((row) => ({
      id: row.id,
      total: row.total,
      passed: row.total === 1 ? 1 : 60,
      valid: true,
    })),
    baseline: protocol.tests.map((row) => ({
      id: row.id,
      total: row.total,
      passed: row.total === 1 ? 1 : 50,
      valid: true,
    })),
  }
}
const generation = Effect.fnUntraced(function* (
  project: string,
  bundle: ProContractPolicy.Bundle = candidate,
  selection?: ProContractPolicy.Bound,
) {
  const policies = yield* ProContractPolicy.Service
  const contracts = yield* ProContract.Service
  const bindings = yield* ProContractOpenCode.Service
  const snapshots = yield* Snapshot.Service
  const bound = selection ?? (yield* policies.bind({ scope: "test", role: "generator" }))
  yield* Effect.promise(() => Bun.write(path.join(project, "strategy.json"), JSON.stringify(bundle)))
  const subjectHash = yield* snapshots.capture()
  if (!subjectHash) return yield* Effect.die("Snapshot capture failed")
  const id = ProContract.ID.create()
  yield* bindings.issue({
    id,
    scope: "generation",
    spec: ProContract.defaultSpec("Generate strategy.json", 10),
    authorization: bound.authorization,
    location: { directory: AbsolutePath.make(project) },
    model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("no-provider-call") }),
    executionPolicy: bound.executionPolicy,
    now: 10,
  })
  yield* contracts.activate(id, 1, 10)
  const binding = yield* bindings.claim(id, 10)
  expect(binding?.executionPolicy).toBe(bound.executionPolicy)
  expect(yield* bindings.reserveTurn(binding!.sessionID, 11)).toBe(true)
  yield* contracts.reportReady({
    contractID: id,
    revision: 1,
    subjectHash,
    summary: "Frozen generated policy",
    uncertainties: [],
    time: 12,
  })
  return { contractID: id, revision: 1, subjectHash }
})

describe("ordinary Contract policy succession", () => {
  test("bundle identity is canonical and rejects invalid policy text", () => {
    expect(ProContractPolicy.hashBundle({ generator: seed.generator, solver: seed.solver, version: 1 })).toBe(
      ProContractPolicy.hashBundle(seed),
    )
    expect(() => ProContractPolicy.hashBundle({ ...seed, solver: " " })).toThrow("nonempty")
    expect(() => ProContractPolicy.hashBundle({ ...seed, generator: "x\0" })).toThrow("NUL")
    expect(() => ProContractPolicy.hashBundle({ ...seed, solver: "x".repeat(65_537) })).toThrow("64 KiB")
  })

  it.live("authorizes seed without claiming improvement and freezes scope configuration", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const contracts = yield* ProContract.Service
        const state = (yield* policies.get("test"))!
        expect(state.evaluations).toEqual([])
        expect((yield* contracts.get(state.history[0].contractID))?.spec.goal).toContain("no performance improvement")
        expect(yield* policies.authorize({ scope: "test", protocol, bundle: seed, now: 99 })).toEqual(state)
        expect(
          Exit.isFailure(
            yield* policies.authorize({ scope: "test", protocol, bundle: candidate, now: 99 }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* policies.bind({ scope: "test", role: "solver" })).executionPolicy).toBe(seed.solver)
        expect(Exit.isFailure(yield* policies.bind({ scope: "unknown", role: "solver" }).pipe(Effect.exit))).toBe(true)
      }),
    ),
  )

  it.live("promotes only the incumbent; research adoption requires an independent grant", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const contracts = yield* ProContract.Service
        const proposal = yield* policies.propose({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: yield* generation(project),
          now: 20,
        })
        const settled = yield* policies.settle({ contractID: proposal.id, evidence: evidence(), now: 21 })
        expect(settled.decision.eligible).toBe(true)
        expect(settled.contract.status).toBe("discharged")
        expect(settled.state.evaluations[0].evidence).toEqual(evidence())
        expect((yield* policies.bind({ scope: "test", role: "solver" })).executionPolicy).toBe(candidate.solver)
        expect((yield* policies.bind({ scope: "test", role: "generator" })).executionPolicy).toBe(seed.generator)
        yield* policies.selectResearch({
          scope: "test",
          expectedRevision: 2,
          bundleHash: ProContractPolicy.hashBundle(candidate),
          now: 22,
        })
        expect((yield* policies.bind({ scope: "test", role: "research_executor" })).executionPolicy).toBe(
          candidate.generator,
        )
        const next = yield* generation(project)
        expect((yield* contracts.get(next.contractID))?.spec.requires).toEqual([])
        expect(
          (yield* policies.settle({ contractID: proposal.id, evidence: evidence(), now: 22 })).state.revision,
        ).toBe(3)
        expect(
          Exit.isFailure(
            yield* policies
              .settle({
                contractID: proposal.id,
                evidence: { ...evidence(), receiptHash: Hash.sha256("conflicting retry") },
                now: 22,
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    ),
  )

  it.live("ordinary incumbent text execution may produce candidates without gaining another role", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const contracts = yield* ProContract.Service
        const before = (yield* policies.get("test"))!
        const incumbent = yield* policies.bind({ scope: "test", role: "incumbent" })
        const researcher = yield* policies.bind({ scope: "test", role: "research_executor" })
        const produced = yield* generation(project, candidate, incumbent)
        const archived = yield* policies.archiveCandidate({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: produced,
          now: 20,
        })
        expect(archived.versions).toHaveLength(2)
        expect(archived.versions[1].generations[0].executorHash).toBe(ProContractPolicy.hashBundle(seed))
        expect(archived.roles).toEqual(before.roles)
        expect(archived.history).toEqual(before.history)
        expect(archived.evaluations).toEqual([])
        expect((yield* contracts.get(produced.contractID))?.status).toBe("verification")
        yield* Effect.forEach(
          [
            { ...incumbent, executionPolicy: seed.generator },
            { ...researcher, executionPolicy: seed.solver },
          ],
          (binding) =>
            Effect.gen(function* () {
              const forged = yield* generation(project, candidate, binding)
              const rejected = yield* policies
                .archiveCandidate({
                  scope: "test",
                  expectedRevision: archived.revision,
                  bundle: candidate,
                  generation: forged,
                  now: 21,
                })
                .pipe(Effect.exit)
              expect(Exit.isFailure(rejected) ? Cause.pretty(rejected.cause) : "").toContain(
                "Execution has no exact authorized method provenance",
              )
              expect(yield* policies.get("test")).toEqual(archived)
            }),
        )
      }),
    ),
  )

  it.live("rejects substituted Bundle bytes and ignores post-handoff workspace edits", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const produced = yield* generation(project)
        yield* Effect.promise(() => Bun.write(path.join(project, "strategy.json"), JSON.stringify(seed)))
        expect(
          Exit.isFailure(
            yield* policies
              .propose({
                scope: "test",
                expectedRevision: 1,
                bundle: { ...candidate, solver: "substituted" },
                generation: produced,
                now: 20,
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const proposal = yield* policies.propose({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: produced,
          now: 20,
        })
        expect(proposal.spec.brief).toContain(ProContractPolicy.hashBundle(candidate))
      }),
    ),
  )

  it.live("incomplete, foreign, and stale reports cannot change standing or selection", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const contracts = yield* ProContract.Service
        const proposal = yield* policies.propose({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: yield* generation(project),
          now: 20,
        })
        const before = yield* policies.get("test")
        for (const report of [
          { ...evidence(), baselineHash: Hash.sha256("foreign") },
          { ...evidence(), rows: evidence().rows.slice(1) },
          { ...evidence(), protocolHash: Hash.sha256("foreign protocol") },
        ]) {
          expect(
            Exit.isFailure(
              yield* policies.settle({ contractID: proposal.id, evidence: report, now: 21 }).pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(yield* policies.get("test")).toEqual(before)
          expect((yield* contracts.get(proposal.id))?.status).toBe("dormant")
        }
        yield* policies.revoke({
          scope: "test",
          expectedRevision: 1,
          evidenceHash: Hash.sha256("withdraw seed"),
          now: 22,
        })
        expect(
          Exit.isFailure(
            yield* policies.settle({ contractID: proposal.id, evidence: evidence(), now: 23 }).pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    ),
  )

  it.live("all ties reject, preserve complete negative evidence, and retain baseline full passes", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const proposal = yield* policies.propose({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: yield* generation(project),
          now: 20,
        })
        const rows = protocol.tests.map((row) => ({ id: row.id, total: row.total, passed: row.total, valid: true }))
        const result = yield* policies.settle({
          contractID: proposal.id,
          evidence: { ...evidence(), baseline: rows, rows },
          now: 21,
        })
        expect(result.decision.eligible).toBe(false)
        expect(result.contract.status).toBe("escalated")
        expect(result.state.selected).toBe(0)
        expect(result.state.retainedFull).toEqual(["development:task", "confirmation:task"])
        expect(result.state.evaluations).toHaveLength(1)
        const retried = yield* policies.settle({
          contractID: proposal.id,
          evidence: { ...evidence(), baseline: rows, rows },
          now: 22,
        })
        expect(retried).toEqual(result)
        expect(
          Exit.isFailure(
            yield* policies.settle({ contractID: proposal.id, evidence: evidence(), now: 23 }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* policies.get("test")).toEqual(result.state)
      }),
    ),
  )

  it.live("revocation fences bound execution separately from evidence, then explicitly rolls back", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const proposal = yield* policies.propose({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: yield* generation(project),
          now: 20,
        })
        yield* policies.settle({ contractID: proposal.id, evidence: evidence(), now: 21 })
        const bound = yield* policies.bind({ scope: "test", role: "solver" })
        const id = ProContract.ID.create()
        yield* bindings.issue({
          id,
          scope: "solver",
          spec: ProContract.defaultSpec("Use selected solver", 22),
          authorization: bound.authorization,
          location: { directory: AbsolutePath.make(project) },
          model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("no-call") }),
          executionPolicy: bound.executionPolicy,
          now: 22,
        })
        yield* contracts.activate(id, 1, 22)
        const binding = yield* bindings.claim(id, 22)
        expect(yield* bindings.reserveTurn(binding!.sessionID, 23)).toBe(true)
        const revoked = yield* policies.revoke({
          scope: "test",
          expectedRevision: 2,
          evidenceHash: Hash.sha256("counterevidence"),
          now: 24,
        })
        expect(revoked.revision).toBe(3)
        expect(yield* bindings.reserveTurn(binding!.sessionID, 25)).toBe(false)
        expect((yield* contracts.get(id))?.status).toBe("escalated")
        expect(Exit.isFailure(yield* policies.bind({ scope: "test", role: "solver" }).pipe(Effect.exit))).toBe(true)
        expect(
          Exit.isFailure(yield* policies.rollback({ scope: "test", expectedRevision: 2, now: 26 }).pipe(Effect.exit)),
        ).toBe(true)
        const rollback = yield* policies.rollback({ scope: "test", expectedRevision: 3, now: 26 })
        expect(rollback.selected).toBe(0)
        expect((yield* policies.bind({ scope: "test", role: "generator" })).executionPolicy).toBe(seed.generator)
        expect((yield* contracts.get(proposal.id))?.attestationID).toBeUndefined()
        expect(
          (yield* contracts.history({ contractID: proposal.id })).some((entry) => entry.command.type === "discharge"),
        ).toBe(true)
      }),
    ),
  )

  it.live("cannot roll back to a revoked seed or hot-readmit the rejected successor", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        yield* policies.revoke({ scope: "test", expectedRevision: 1, evidenceHash: Hash.sha256("withdrawal"), now: 1 })
        expect(
          Exit.isFailure(yield* policies.rollback({ scope: "test", expectedRevision: 2, now: 2 }).pipe(Effect.exit)),
        ).toBe(true)
        yield* policies.authorize({ scope: "test", protocol, bundle: seed, now: 3 })
        expect(Exit.isFailure(yield* policies.bind({ scope: "test", role: "solver" }).pipe(Effect.exit))).toBe(true)
      }),
    ),
  )

  it.live("selection storage failure atomically rolls back ordinary discharge and its ledger", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const contracts = yield* ProContract.Service
        const database = yield* Database.Service
        const proposal = yield* policies.propose({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: yield* generation(project),
          now: 20,
        })
        const history = yield* contracts.history({ contractID: proposal.id })
        yield* database.db.run(
          "CREATE TRIGGER reject_selection BEFORE UPDATE ON pro_contract_policy BEGIN SELECT RAISE(ABORT, 'fixture selection failure'); END",
        )
        expect(
          Exit.isFailure(
            yield* policies.settle({ contractID: proposal.id, evidence: evidence(), now: 21 }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* policies.get("test"))?.revision).toBe(1)
        expect((yield* contracts.get(proposal.id))?.status).toBe("dormant")
        expect(yield* contracts.history({ contractID: proposal.id })).toEqual(history)
        yield* database.db.run("DROP TRIGGER reject_selection")
        expect(
          (yield* policies.settle({ contractID: proposal.id, evidence: evidence(), now: 21 })).state.revision,
        ).toBe(2)
      }),
    ),
  )

  it.live("competing proposals cannot both select against the same baseline revision", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const contracts = yield* ProContract.Service
        const first = yield* policies.propose({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: yield* generation(project),
          now: 20,
        })
        const sibling = { ...candidate, solver: "other solver" }
        const second = yield* policies.propose({
          scope: "test",
          expectedRevision: 1,
          bundle: sibling,
          generation: yield* generation(project, sibling),
          now: 20,
        })
        const outcomes = yield* Effect.all(
          [
            policies.settle({ contractID: first.id, evidence: evidence(), now: 21 }).pipe(Effect.exit),
            policies.settle({ contractID: second.id, evidence: evidence(sibling), now: 21 }).pipe(Effect.exit),
          ],
          { concurrency: "unbounded" },
        )
        expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1)
        expect(outcomes.filter(Exit.isFailure)).toHaveLength(1)
        expect((yield* policies.get("test"))?.revision).toBe(2)
        const statuses = yield* Effect.forEach([first.id, second.id], (id) =>
          contracts.get(id).pipe(Effect.map((contract) => contract?.status)),
        )
        expect(statuses.toSorted()).toEqual(["discharged", "dormant"])
      }),
    ),
  )

  it.live("withdrawn successor content cannot be silently readmitted under the same frozen scope", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const proposal = yield* policies.propose({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: yield* generation(project),
          now: 20,
        })
        yield* policies.settle({ contractID: proposal.id, evidence: evidence(), now: 21 })
        yield* policies.revoke({ scope: "test", expectedRevision: 2, evidenceHash: Hash.sha256("withdrawn"), now: 22 })
        yield* policies.rollback({ scope: "test", expectedRevision: 3, now: 23 })
        expect(
          Exit.isFailure(
            yield* policies
              .propose({
                scope: "test",
                expectedRevision: 4,
                bundle: candidate,
                generation: yield* generation(project),
                now: 24,
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* policies.get("test"))?.revision).toBe(4)
      }),
    ),
  )

  it.live("a direct historical challenge after proposal prevents same-scope readmission", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const contracts = yield* ProContract.Service
        const first = yield* policies.propose({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: yield* generation(project),
          now: 20,
        })
        yield* policies.settle({ contractID: first.id, evidence: evidence(), now: 21 })
        yield* policies.rollback({ scope: "test", expectedRevision: 2, now: 22 })
        const readmission = yield* policies.propose({
          scope: "test",
          expectedRevision: 3,
          bundle: candidate,
          generation: yield* generation(project),
          now: 23,
        })
        const before = yield* policies.get("test")
        yield* contracts.challenge({
          contractID: first.id,
          revision: first.revision,
          subjectHash: ProContractPolicy.hashBundle(candidate),
          evidenceHash: Hash.sha256("historical withdrawal"),
          disclosure: "sealed",
          time: 24,
        })
        expect(yield* policies.get("test")).toEqual(before)
        expect(
          Exit.isFailure(
            yield* policies.settle({ contractID: readmission.id, evidence: evidence(), now: 25 }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* contracts.get(readmission.id))?.status).toBe("dormant")
        expect(yield* policies.get("test")).toEqual(before)
      }),
    ),
  )
  it.live("negative research completes, rejected v1 researches v2, and deployment still compares against v0", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const contracts = yield* ProContract.Service
        const produced = yield* generation(project)
        const proposal = yield* policies.propose({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: produced,
          targetVersion: ProContractPolicy.hashBundle(seed),
          now: 20,
        })
        const report = evidence()
        const rejected = yield* policies.settle({
          contractID: proposal.id,
          evidence: { ...report, rows: report.baseline },
          now: 21,
        })
        expect(rejected.decision.eligible).toBe(false)
        expect(rejected.state.versions).toHaveLength(2)
        const experiment: ProContractPolicy.Experiment = {
          id: Hash.sha256("negative research"),
          source: { contractID: produced.contractID, revision: produced.revision },
          executorHash: ProContractPolicy.hashBundle(seed),
          targetVersion: ProContractPolicy.hashBundle(seed),
          candidateHash: ProContractPolicy.hashBundle(candidate),
          question: "Does an extra diagnostic step help?",
          hypothesis: "Repeated feedback can be detected without more search",
          intervention: "Enable feedback comparison",
          observations: ["artifact:development-comparison"],
          conclusion: "No improvement in the measured development tasks; keep researching the mechanism",
          outcome: "unsupported",
          evidenceHash: Hash.sha256("independent report acceptance"),
          budget: { startedAt: 10, finishedAt: 21, deadline: 100 },
        }
        const completed = yield* policies.completeResearch({
          scope: "test",
          expectedRevision: 2,
          generation: produced,
          experiment,
          now: 22,
        })
        expect(completed.contract.status).toBe("discharged")
        expect((yield* contracts.get(proposal.id))?.status).toBe("escalated")
        const research = yield* policies.selectResearch({
          scope: "test",
          expectedRevision: 3,
          bundleHash: ProContractPolicy.hashBundle(candidate),
          now: 23,
        })
        expect(research.history[research.roles.incumbent].bundleHash).toBe(ProContractPolicy.hashBundle(seed))
        expect(research.history[research.roles.research_executor].bundleHash).toBe(
          ProContractPolicy.hashBundle(candidate),
        )
        const successor = { ...candidate, solver: "v2 removes always-on overhead", generator: "v2 generator" }
        const next = yield* policies.propose({
          scope: "test",
          expectedRevision: 4,
          bundle: successor,
          generation: yield* generation(project, successor),
          targetVersion: ProContractPolicy.hashBundle(candidate),
          now: 24,
        })
        expect(JSON.parse(next.spec.brief).baselineHash).toBe(ProContractPolicy.hashBundle(seed))
        expect(JSON.parse(next.spec.brief).executorHash).toBe(ProContractPolicy.hashBundle(candidate))
        const adopted = yield* policies.settle({ contractID: next.id, evidence: evidence(successor, seed), now: 25 })
        expect(adopted.decision.eligible).toBe(true)
        expect(adopted.state.history[adopted.state.roles.incumbent].bundleHash).toBe(
          ProContractPolicy.hashBundle(successor),
        )
        expect(adopted.state.history[adopted.state.roles.research_executor].bundleHash).toBe(
          ProContractPolicy.hashBundle(candidate),
        )
        const view = yield* policies.view({
          scope: "test",
          versionHashes: [ProContractPolicy.hashBundle(candidate)],
          experimentIDs: [experiment.id],
        })
        expect(view.versions.map((item) => item.bundleHash)).toEqual([ProContractPolicy.hashBundle(candidate)])
        expect(view.experiments).toEqual([experiment])
        expect("evaluations" in view).toBe(false)
        expect("protocol" in view).toBe(false)
        expect(yield* policies.view({ scope: "test", versionHashes: [], experimentIDs: [] })).toEqual({
          versions: [],
          experiments: [],
        })
        yield* policies.revoke({
          scope: "test",
          expectedRevision: 5,
          role: "research_executor",
          evidenceHash: Hash.sha256("research permission withdrawn"),
          now: 26,
        })
        expect((yield* contracts.get(produced.contractID))?.status).toBe("discharged")
        expect((yield* contracts.get(next.id))?.status).toBe("discharged")
        expect((yield* policies.bind({ scope: "test", role: "incumbent" })).executionPolicy).toBe(successor.solver)
        const recovered = yield* policies.rollback({
          scope: "test",
          expectedRevision: 6,
          role: "research_executor",
          now: 27,
        })
        expect(recovered.experiments).toEqual([experiment])
        expect(recovered.versions).toHaveLength(3)
        expect((yield* policies.bind({ scope: "test", role: "research_executor" })).executionPolicy).toBe(
          seed.generator,
        )
      }),
    ),
  )

  it.live("research archival and researcher withdrawal do not stale an unchanged incumbent comparison", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const produced = yield* generation(project)
        const proposal = yield* policies.propose({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: produced,
          now: 20,
        })
        yield* policies.completeResearch({
          scope: "test",
          expectedRevision: 1,
          generation: produced,
          now: 21,
          experiment: {
            id: Hash.sha256("completed before confirmation"),
            source: { contractID: produced.contractID, revision: 1 },
            executorHash: ProContractPolicy.hashBundle(seed),
            targetVersion: ProContractPolicy.hashBundle(seed),
            question: "Does feedback deduplication work?",
            hypothesis: "Repeated feedback is avoidable",
            intervention: "Detect unchanged feedback",
            observations: ["artifact:development-result"],
            conclusion: "Development evidence supports independent confirmation",
            outcome: "supported",
            evidenceHash: Hash.sha256("independent development report"),
            budget: { startedAt: 10, finishedAt: 20, deadline: 100 },
          },
        })
        yield* policies.revoke({
          scope: "test",
          expectedRevision: 2,
          role: "research_executor",
          evidenceHash: Hash.sha256("no further research permission"),
          now: 22,
        })
        const settled = yield* policies.settle({ contractID: proposal.id, evidence: evidence(), now: 23 })
        expect(settled.contract.status).toBe("discharged")
        expect(settled.state.revision).toBe(4)
        expect((yield* policies.bind({ scope: "test", role: "incumbent" })).executionPolicy).toBe(candidate.solver)
        expect(
          Exit.isFailure(yield* policies.bind({ scope: "test", role: "research_executor" }).pipe(Effect.exit)),
        ).toBe(true)
      }),
    ),
  )

  it.live("research permission is independent, exact, and cannot be silently readmitted", () =>
    fixture(() =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const incumbent = yield* policies.bind({ scope: "test", role: "incumbent" })
        const researcher = yield* policies.bind({ scope: "test", role: "research_executor" })
        expect(researcher.authorization.contractID).not.toBe(incumbent.authorization.contractID)
        expect(researcher.authorization.subjectHash).toBe(incumbent.authorization.subjectHash)
        yield* policies.revoke({
          scope: "test",
          expectedRevision: 1,
          role: "research_executor",
          evidenceHash: Hash.sha256("withdraw researcher"),
          now: 20,
        })
        expect(
          Exit.isFailure(yield* policies.bind({ scope: "test", role: "research_executor" }).pipe(Effect.exit)),
        ).toBe(true)
        expect((yield* policies.bind({ scope: "test", role: "incumbent" })).authorization).toEqual(
          incumbent.authorization,
        )
        expect(
          Exit.isFailure(
            yield* policies
              .selectResearch({
                scope: "test",
                expectedRevision: 2,
                bundleHash: ProContractPolicy.hashBundle(seed),
                now: 21,
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    ),
  )

  it.live("a candidate without safety evidence remains archived but cannot receive research permission", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        yield* policies.propose({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: yield* generation(project),
          now: 20,
        })
        expect((yield* policies.get("test"))?.versions).toHaveLength(2)
        expect(
          Exit.isFailure(
            yield* policies
              .selectResearch({
                scope: "test",
                expectedRevision: 1,
                bundleHash: ProContractPolicy.hashBundle(candidate),
                now: 21,
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    ),
  )

  it.live("failed experiments remain findings, not invented task completion, and retries are immutable", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const contracts = yield* ProContract.Service
        const produced = yield* generation(project)
        const experiment: ProContractPolicy.Experiment = {
          id: Hash.sha256("failed build"),
          source: { contractID: produced.contractID, revision: 1 },
          executorHash: ProContractPolicy.hashBundle(seed),
          targetVersion: ProContractPolicy.hashBundle(seed),
          question: "Can the proposed harness start?",
          hypothesis: "Package is executable",
          intervention: "Rebuild frozen source",
          observations: ["artifact:full-build-error"],
          conclusion: "Build failed; no execution quality conclusion",
          outcome: "failed",
          evidenceHash: Hash.sha256("build receipt"),
          budget: { startedAt: 10, finishedAt: 12, deadline: 100 },
        }
        const recorded = yield* policies.recordExperiment({ scope: "test", expectedRevision: 1, experiment })
        expect((yield* contracts.get(produced.contractID))?.status).toBe("verification")
        expect(recorded.experiments).toEqual([experiment])
        expect(yield* policies.recordExperiment({ scope: "test", expectedRevision: 2, experiment })).toEqual(recorded)
        expect(
          Exit.isFailure(
            yield* policies
              .recordExperiment({
                scope: "test",
                expectedRevision: 2,
                experiment: { ...experiment, conclusion: "changed" },
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* policies
              .recordExperiment({
                scope: "test",
                expectedRevision: 2,
                experiment: {
                  ...experiment,
                  id: Hash.sha256("forged executor"),
                  executorHash: ProContractPolicy.hashBundle(candidate),
                },
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* policies.get("test"))?.experiments).toHaveLength(1)
      }),
    ),
  )

  it.live("operational qualification allows research before confirmation without adopting the candidate", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const contracts = yield* ProContract.Service
        yield* policies.archiveCandidate({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: yield* generation(project),
          now: 20,
        })
        expect(yield* contracts.list("test")).toHaveLength(2)
        const selected = yield* policies.selectResearch({
          scope: "test",
          expectedRevision: 1,
          bundleHash: ProContractPolicy.hashBundle(candidate),
          qualification: { evidenceHash: Hash.sha256("independently checked research eligibility") },
          now: 21,
        })
        expect(selected.evaluations).toEqual([])
        expect(selected.history[selected.roles.incumbent].bundleHash).toBe(ProContractPolicy.hashBundle(seed))
        expect(selected.history[selected.roles.research_executor].bundleHash).toBe(
          ProContractPolicy.hashBundle(candidate),
        )
        expect(
          Exit.isFailure(
            yield* policies
              .selectResearch({
                scope: "test",
                expectedRevision: 2,
                bundleHash: ProContractPolicy.hashBundle(candidate),
                qualification: { evidenceHash: Hash.sha256("substituted evidence") },
                now: 22,
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* policies.selectResearch({
          scope: "test",
          expectedRevision: 2,
          bundleHash: ProContractPolicy.hashBundle(seed),
          now: 23,
        })
        const rollback = yield* policies.rollback({
          scope: "test",
          expectedRevision: 3,
          role: "research_executor",
          now: 24,
        })
        expect(rollback.history[rollback.roles.research_executor].bundleHash).toBe(
          ProContractPolicy.hashBundle(candidate),
        )
        expect(
          rollback.transitions.filter((item) => item.role === "research_executor").map((item) => item.selection),
        ).toEqual([1, 2, 1, 2])
        expect(rollback.versions).toHaveLength(2)
      }),
    ),
  )

  it.live("a text Session cannot impersonate execution of a version-2 research package", () =>
    fixture(
      (project) =>
        Effect.gen(function* () {
          const policies = yield* ProContractPolicy.Service
          const produced = yield* generation(project)
          expect(
            Exit.isFailure(
              yield* policies
                .propose({ scope: "test", expectedRevision: 1, bundle: candidate, generation: produced, now: 20 })
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          expect((yield* policies.get("test"))?.versions).toHaveLength(1)
        }),
      { ...seed, version: 2, versionHash: Hash.sha256("code that the text Session did not execute") },
    ),
  )

  it.live("concurrent proposal admission and rollback cannot lose accepted candidate provenance", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const proposal = yield* policies.propose({
          scope: "test",
          expectedRevision: 1,
          bundle: candidate,
          generation: yield* generation(project),
          now: 20,
        })
        yield* policies.settle({ contractID: proposal.id, evidence: evidence(), now: 21 })
        const sibling = { ...candidate, solver: "another branch" }
        const produced = yield* generation(project, sibling)
        const results = yield* Effect.all(
          [
            policies
              .propose({ scope: "test", expectedRevision: 2, bundle: sibling, generation: produced, now: 22 })
              .pipe(Effect.exit),
            policies.rollback({ scope: "test", expectedRevision: 2, now: 23 }).pipe(Effect.exit),
          ],
          { concurrency: "unbounded" },
        )
        expect(Exit.isSuccess(results[1])).toBe(true)
        const state = (yield* policies.get("test"))!
        if (Exit.isSuccess(results[0]))
          expect(state.versions.some((item) => item.bundleHash === ProContractPolicy.hashBundle(sibling))).toBe(true)
        expect(state.versions.some((item) => item.bundleHash === ProContractPolicy.hashBundle(candidate))).toBe(true)
        expect(state.history[state.roles.incumbent].bundleHash).toBe(ProContractPolicy.hashBundle(seed))
      }),
    ),
  )

  it.live("ordinary incumbent code produces archival candidates and reports without role adoption", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const contracts = yield* ProContract.Service
        const source = path.join(path.dirname(project), "ordinary-source")
        yield* Effect.promise(() =>
          Bun.write(
            path.join(source, "workflow.ts"),
            `
        await Bun.write("candidate/workflow.ts", 'console.log(JSON.stringify({version:1,observations:[],requests:[],artifacts:[]}));');
        await Bun.write("strategy.json", ${JSON.stringify(JSON.stringify(candidate))});
        console.log(JSON.stringify({version:1, observations:["ordinary work produced a reusable method"], requests:[], artifacts:["candidate", "strategy.json"]}));
      `,
          ),
        )
        const store = ProContractVersion.make({ directory: ProContractVersion.storePath(path.dirname(project)) })
        const frozen = yield* Effect.promise(() => store.freeze({ directory: source, entrypoint: "workflow.ts" }))
        const bundle: ProContractPolicy.Bundle = { ...seed, version: 2, versionHash: frozen.versionHash }
        const bundleHash = ProContractPolicy.hashBundle(bundle)
        const initial = yield* policies.authorize({ scope: "ordinary-work", protocol, bundle, now: Date.now() })
        const incumbent = yield* policies.bind({ scope: "ordinary-work", role: "incumbent" })
        const researcher = yield* policies.bind({ scope: "ordinary-work", role: "research_executor" })
        yield* Effect.forEach(
          [
            { role: "incumbent", authorization: researcher.authorization, executionPolicy: seed.solver, valid: false },
            {
              role: "research_executor",
              authorization: incumbent.authorization,
              executionPolicy: seed.generator,
              valid: false,
            },
            {
              role: "incumbent",
              authorization: incumbent.authorization,
              executionPolicy: seed.generator,
              valid: false,
            },
            {
              role: "research_executor",
              authorization: researcher.authorization,
              executionPolicy: seed.solver,
              valid: false,
            },
            { role: "incumbent", authorization: incumbent.authorization, executionPolicy: seed.solver, valid: true },
          ],
          (input) =>
            Effect.gen(function* () {
              const deadline = Date.now() + 30_000
              const issued = yield* contracts.issue({
                id: ProContract.ID.create(),
                scope: "ordinary-task",
                executor: `version:${frozen.versionHash}`,
                spec: {
                  ...ProContract.defaultSpec("Complete ordinary work and retain reusable methods", Date.now()),
                  budget: { deadline },
                  authority: [],
                  requires: [],
                  brief: JSON.stringify({
                    kind: "version-run-v1",
                    versionHash: frozen.versionHash,
                    bundleHash,
                    role: input.role,
                    executionPolicy: input.executionPolicy,
                    authorization: input.authorization,
                    targetVersion: bundleHash,
                    targetExecutable: frozen.versionHash,
                  }),
                },
              })
              const contract = issued.contract!
              yield* contracts.activate(contract.id, contract.revision, Date.now())
              const run = yield* Effect.promise(() =>
                store.run({
                  versionHash: frozen.versionHash,
                  targetVersion: frozen.versionHash,
                  task: {
                    contractID: contract.id,
                    revision: contract.revision,
                    specHash: contract.specHash,
                    input: {},
                  },
                  view: {},
                  workspace: project,
                  deadline,
                }),
              )
              expect(run.status).toBe("completed")
              yield* contracts.reportReady({
                contractID: contract.id,
                revision: contract.revision,
                subjectHash: ProContractVersion.subjectHash(run),
                summary: "Ordinary work and a reusable method",
                uncertainties: ["The candidate has not been independently evaluated"],
                time: Date.now(),
              })
              const successor = yield* Effect.promise(async () =>
                store.freeze({
                  directory: path.join(await store.artifactDirectory(run.id), "candidate"),
                  entrypoint: "workflow.ts",
                }),
              )
              const generated: ProContractPolicy.Bundle = {
                ...candidate,
                version: 2,
                versionHash: successor.versionHash,
              }
              const generation = {
                contractID: contract.id,
                revision: contract.revision,
                subjectHash: ProContractVersion.subjectHash(run),
                runID: run.id,
              }
              const archive = policies.archiveCandidate({
                scope: "ordinary-work",
                expectedRevision: 1,
                bundle: generated,
                generation,
                now: Date.now(),
              })
              const experiment: ProContractPolicy.Experiment = {
                id: Hash.sha256(`ordinary report ${run.id}`),
                source: { contractID: contract.id, revision: contract.revision, runID: run.id },
                executorHash: bundleHash,
                targetVersion: bundleHash,
                question: "Does ordinary work yield a reusable method?",
                hypothesis: "Its artifact can be retained without deployment",
                intervention: "Package the method used for the task",
                observations: [run.stdout],
                conclusion: "Candidate retained; no evidence of performance improvement",
                outcome: "inconclusive",
                evidenceHash: ProContractVersion.subjectHash(run),
                budget: { startedAt: run.startedAt, finishedAt: run.completedAt, deadline },
              }
              if (!input.valid) {
                const rejected = yield* archive.pipe(Effect.exit)
                expect(Exit.isFailure(rejected) ? Cause.pretty(rejected.cause) : "").toContain(
                  "Executable research provenance differs from the frozen Contract and run",
                )
                expect(
                  Exit.isFailure(
                    yield* policies
                      .recordExperiment({ scope: "ordinary-work", expectedRevision: 1, experiment })
                      .pipe(Effect.exit),
                  ),
                ).toBe(true)
                expect(yield* policies.get("ordinary-work")).toEqual(initial)
                expect((yield* contracts.get(contract.id))?.status).toBe("verification")
                return
              }
              const archived = yield* archive
              expect(archived.versions).toHaveLength(2)
              expect(archived.versions[1].generations).toEqual([
                { handoff: generation, executorHash: bundleHash, targetVersion: bundleHash },
              ])
              expect(archived.roles).toEqual(initial.roles)
              expect(archived.history).toEqual(initial.history)
              expect(archived.evaluations).toEqual([])
              expect((yield* contracts.get(contract.id))?.status).toBe("verification")
              const completed = yield* policies.completeResearch({
                scope: "ordinary-work",
                expectedRevision: 1,
                generation,
                experiment,
                now: Date.now(),
              })
              expect(completed.contract.status).toBe("discharged")
              expect(completed.state.experiments).toEqual([experiment])
              expect(completed.state.roles).toEqual(initial.roles)
              expect(completed.state.history).toEqual(initial.history)
              expect(completed.state.evaluations).toEqual([])
              expect((yield* policies.bind({ scope: "ordinary-work", role: "incumbent" })).authorization).toEqual(
                incumbent.authorization,
              )
              expect(
                (yield* policies.bind({ scope: "ordinary-work", role: "research_executor" })).authorization,
              ).toEqual(researcher.authorization)
            }),
        )
      }),
    ),
  )

  it.live("a failed run remains archivable after recovery produces a different successful handoff", () =>
    fixture((project) =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const contracts = yield* ProContract.Service
        const source = path.join(path.dirname(project), "native-source")
        yield* Effect.promise(() =>
          Bun.write(
            path.join(source, "workflow.ts"),
            `
        const input = await Bun.stdin.json();
        if (!input.view.previous.length) throw new Error("intentional first-run failure");
        console.log(JSON.stringify({version:1, observations:["recovered"], requests:[], artifacts:[]}));
      `,
          ),
        )
        const store = ProContractVersion.make({ directory: ProContractVersion.storePath(path.dirname(project)) })
        const frozen = yield* Effect.promise(() => store.freeze({ directory: source, entrypoint: "workflow.ts" }))
        const bundle: ProContractPolicy.Bundle = { ...seed, version: 2, versionHash: frozen.versionHash }
        const bundleHash = ProContractPolicy.hashBundle(bundle)
        yield* policies.authorize({ scope: "native-history", protocol, bundle, now: Date.now() })
        const bound = yield* policies.bind({ scope: "native-history", role: "research_executor" })
        const deadline = Date.now() + 30_000
        const issued = yield* contracts.issue({
          id: ProContract.ID.create(),
          scope: "native-history-task",
          executor: `version:${frozen.versionHash}`,
          spec: {
            ...ProContract.defaultSpec("Execute and report a research experiment", Date.now()),
            budget: { deadline },
            authority: [],
            requires: [],
            brief: JSON.stringify({
              kind: "version-run-v1",
              versionHash: frozen.versionHash,
              bundleHash,
              role: "research_executor",
              executionPolicy: bound.executionPolicy,
              authorization: bound.authorization,
              targetVersion: bundleHash,
              targetExecutable: frozen.versionHash,
            }),
          },
        })
        const contract = issued.contract!
        yield* contracts.activate(contract.id, contract.revision, Date.now())
        const task = { contractID: contract.id, revision: contract.revision, specHash: contract.specHash, input: {} }
        const failed = yield* Effect.promise(() =>
          store.run({
            versionHash: frozen.versionHash,
            targetVersion: frozen.versionHash,
            task,
            view: { previous: [] },
            workspace: project,
            deadline,
          }),
        )
        expect(failed.status).toBe("failed")
        yield* contracts.escalate({
          contractID: contract.id,
          revision: contract.revision,
          reason: "Actual invocation failed",
          time: Date.now(),
        })
        yield* contracts.resume(contract.id)
        yield* contracts.activate(contract.id, contract.revision, Date.now())
        const recovered = yield* Effect.promise(() =>
          store.run({
            versionHash: frozen.versionHash,
            targetVersion: frozen.versionHash,
            task,
            view: { previous: [{ id: failed.id, status: failed.status }] },
            workspace: project,
            deadline,
          }),
        )
        expect(recovered.status).toBe("completed")
        const other = yield* Effect.promise(() =>
          store.run({
            versionHash: frozen.versionHash,
            targetVersion: frozen.versionHash,
            task,
            view: { previous: [{ id: failed.id, status: failed.status }] },
            workspace: project,
            deadline,
          }),
        )
        expect(other.status).toBe("completed")
        yield* contracts.reportReady({
          contractID: contract.id,
          revision: contract.revision,
          subjectHash: ProContractVersion.subjectHash(recovered),
          summary: "Recovered experiment report",
          uncertainties: [],
          time: Date.now(),
        })
        const experiment: ProContractPolicy.Experiment = {
          id: Hash.sha256("actual failed invocation"),
          source: { contractID: contract.id, revision: contract.revision, runID: failed.id },
          executorHash: bundleHash,
          targetVersion: bundleHash,
          question: "Can this method recover from an interrupted attempt?",
          hypothesis: "Past failures can steer a new attempt",
          intervention: "Inject one startup failure",
          observations: [failed.error ?? failed.stderr],
          conclusion: "First invocation failed; subsequent recovery is recorded separately",
          outcome: "failed",
          evidenceHash: ProContractVersion.subjectHash(failed),
          budget: { startedAt: failed.startedAt, finishedAt: failed.completedAt, deadline },
        }
        const indexed = yield* policies.recordExperiment({ scope: "native-history", expectedRevision: 1, experiment })
        expect(indexed.experiments).toEqual([experiment])
        expect((yield* contracts.get(contract.id))?.status).toBe("verification")
        expect((yield* contracts.get(contract.id))?.handoff?.subjectHash).toBe(
          ProContractVersion.subjectHash(recovered),
        )
        expect(
          Exit.isFailure(
            yield* policies
              .completeResearch({
                scope: "native-history",
                expectedRevision: 2,
                generation: {
                  contractID: contract.id,
                  revision: contract.revision,
                  subjectHash: ProContractVersion.subjectHash(recovered),
                  runID: failed.id,
                },
                experiment,
                now: Date.now(),
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* policies
              .completeResearch({
                scope: "native-history",
                expectedRevision: 2,
                generation: {
                  contractID: contract.id,
                  revision: contract.revision,
                  subjectHash: ProContractVersion.subjectHash(recovered),
                  runID: other.id,
                },
                experiment: {
                  ...experiment,
                  id: Hash.sha256("wrong completed handoff"),
                  source: { ...experiment.source, runID: other.id },
                  outcome: "inconclusive",
                  budget: { startedAt: other.startedAt, finishedAt: other.completedAt, deadline },
                },
                now: Date.now(),
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* policies.get("native-history"))?.experiments).toEqual([experiment])
        expect((yield* contracts.get(contract.id))?.attestationID).toBeUndefined()
      }),
    ),
  )

  it.live(
    "evidence requirements recover only historical shared generator provenance, never modern role authority",
    () =>
      fixture((project) =>
        Effect.gen(function* () {
          const policies = yield* ProContractPolicy.Service
          const contracts = yield* ProContract.Service
          const bindings = yield* ProContractOpenCode.Service
          const snapshots = yield* Snapshot.Service
          const database = yield* Database.Service
          const current = (yield* policies.get("test"))!
          yield* Effect.promise(() => Bun.write(path.join(project, "strategy.json"), JSON.stringify(candidate)))
          const subjectHash = (yield* snapshots.capture())!
          const produce = Effect.fnUntraced(function* (
            selection: ProContractPolicy.Selection,
            executionPolicy: string,
          ) {
            const id = ProContract.ID.create()
            yield* bindings.issue({
              id,
              scope: "legacy-generation",
              spec: {
                ...ProContract.defaultSpec("Generate a reusable method with historical dependency semantics", 10),
                requires: [{ contractID: selection.contractID, revision: selection.revision }],
              },
              location: { directory: AbsolutePath.make(project) },
              model: ModelV2.Ref.make({
                providerID: ProviderV2.ID.make("fixture"),
                id: ModelV2.ID.make("no-provider-call"),
              }),
              executionPolicy,
              now: 10,
            })
            yield* contracts.activate(id, 1, 10)
            const binding = yield* bindings.claim(id, 10)
            expect(yield* bindings.reserveTurn(binding!.sessionID, 11)).toBe(true)
            yield* contracts.reportReady({
              contractID: id,
              revision: 1,
              subjectHash,
              summary: "Frozen reusable method",
              uncertainties: [],
              time: 12,
            })
            return { contractID: id, revision: 1, subjectHash }
          })
          const modern = yield* produce(current.history[current.roles.research_executor], seed.generator)
          const denied = yield* policies
            .archiveCandidate({ scope: "test", expectedRevision: 1, bundle: candidate, generation: modern, now: 20 })
            .pipe(Effect.exit)
          expect(Exit.isFailure(denied) ? Cause.pretty(denied.cause) : "").toContain(
            "Execution has no exact authorized method provenance",
          )
          expect(yield* policies.get("test")).toEqual(current)
          const historical: ProContractPolicy.LegacyState = {
            scope: current.scope,
            revision: current.revision,
            protocol: current.protocol,
            protocolHash: current.protocolHash,
            selected: 0,
            history: current.history.slice(0, 1).map(({ role, ...item }) => item),
            retainedFull: [],
            evaluations: [],
          }
          yield* database.db
            .update(ProContractPolicyTable)
            .set({ data: historical })
            .where(eq(ProContractPolicyTable.scope, "test"))
            .run()
          const legacySolver = yield* produce(historical.history[0], seed.solver)
          const rejected = yield* policies
            .archiveCandidate({
              scope: "test",
              expectedRevision: 1,
              bundle: candidate,
              generation: legacySolver,
              now: 21,
            })
            .pipe(Effect.exit)
          expect(Exit.isFailure(rejected) ? Cause.pretty(rejected.cause) : "").toContain(
            "Execution has no exact authorized method provenance",
          )
          const legacyGenerator = yield* produce(historical.history[0], seed.generator)
          const archived = yield* policies.archiveCandidate({
            scope: "test",
            expectedRevision: 1,
            bundle: candidate,
            generation: legacyGenerator,
            now: 22,
          })
          expect(archived.versions).toHaveLength(2)
          expect(archived.roles).toEqual({ incumbent: 0, research_executor: 0 })
          expect(archived.history).toEqual(historical.history)
          expect((yield* contracts.get(legacyGenerator.contractID))?.spec.requires).toEqual([
            { contractID: historical.history[0].contractID, revision: historical.history[0].revision },
          ])
          expect(archived.evaluations).toEqual([])
        }),
      ),
  )

  it.live("legacy selection is projected read-only without relabeling historical grants", () =>
    fixture(() =>
      Effect.gen(function* () {
        const policies = yield* ProContractPolicy.Service
        const database = yield* Database.Service
        const current = (yield* policies.get("test"))!
        const historical: ProContractPolicy.LegacyState = {
          scope: current.scope,
          revision: current.revision,
          protocol: current.protocol,
          protocolHash: current.protocolHash,
          selected: 0,
          history: current.history.slice(0, 1).map(({ role, ...item }) => item),
          retainedFull: [],
          evaluations: [],
        }
        yield* database.db
          .update(ProContractPolicyTable)
          .set({ data: historical })
          .where(eq(ProContractPolicyTable.scope, "test"))
          .run()
        const projected = (yield* policies.get("test"))!
        expect(projected.roles).toEqual({ incumbent: 0, research_executor: 0 })
        expect(projected.history[0].role).toBeUndefined()
        expect(projected.versions).toHaveLength(1)
        const row = yield* database.db
          .select()
          .from(ProContractPolicyTable)
          .where(eq(ProContractPolicyTable.scope, "test"))
          .get()
        expect(row?.data).toEqual(historical)
      }),
    ),
  )
})

function fixture(
  run: (
    project: string,
  ) => Effect.Effect<
    void,
    unknown,
    ProContractPolicy.Service | ProContract.Service | ProContractOpenCode.Service | Snapshot.Service | Database.Service
  >,
  bundle: ProContractPolicy.Bundle = seed,
) {
  return Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const project = path.join(tmp.path, "project")
        yield* Effect.promise(async () => {
          await mkdir(project)
          await Bun.write(path.join(project, "strategy.json"), JSON.stringify(seed))
          await $`git init`.cwd(project).quiet()
          await $`git config core.fsmonitor false`.cwd(project).quiet()
          await $`git config commit.gpgsign false`.cwd(project).quiet()
          await $`git config user.email test@opencode.test`.cwd(project).quiet()
          await $`git config user.name Test`.cwd(project).quiet()
          await $`git add .`.cwd(project).quiet()
          await $`git commit -m initial`.cwd(project).quiet()
        })
        yield* Effect.gen(function* () {
          const policies = yield* ProContractPolicy.Service
          yield* policies.authorize({ scope: "test", protocol, bundle, now: 0 })
          yield* run(project)
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ProContractPolicy.node,
                ProContract.node,
                ProContractOpenCode.node,
                Snapshot.node,
                Database.node,
              ]),
              [
                [Database.node, Database.layerFromPath(path.join(tmp.path, "policy.db"))],
                [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))],
                [
                  Global.node,
                  Global.layerWith({ data: tmp.path, config: path.join(tmp.path, "config"), cache: tmp.path }),
                ],
              ],
            ),
          ),
        )
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
}
