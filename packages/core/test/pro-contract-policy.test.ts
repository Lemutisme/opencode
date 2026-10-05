import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
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
const generation = Effect.fnUntraced(function* (project: string, bundle: ProContractPolicy.Bundle = candidate) {
  const policies = yield* ProContractPolicy.Service
  const contracts = yield* ProContract.Service
  const bindings = yield* ProContractOpenCode.Service
  const snapshots = yield* Snapshot.Service
  const bound = yield* policies.bind({ scope: "test", role: "generator" })
  yield* Effect.promise(() => Bun.write(path.join(project, "strategy.json"), JSON.stringify(bundle)))
  const subjectHash = yield* snapshots.capture()
  if (!subjectHash) return yield* Effect.die("Snapshot capture failed")
  const id = ProContract.ID.create()
  yield* bindings.issue({
    id,
    scope: "generation",
    spec: { ...ProContract.defaultSpec("Generate strategy.json", 10), requires: [bound.requirement] },
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

  it.live("promotes frozen generated bytes and the actual next generator and solver consume them", () =>
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
        expect((yield* policies.bind({ scope: "test", role: "generator" })).executionPolicy).toBe(candidate.generator)
        const next = yield* generation(project)
        expect((yield* contracts.get(next.contractID))?.spec.requires).toEqual([
          { contractID: proposal.id, revision: 1 },
        ])
        expect(
          (yield* policies.settle({ contractID: proposal.id, evidence: evidence(), now: 22 })).state.revision,
        ).toBe(2)
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

  it.live("revocation stops bound execution through ordinary requires, then explicitly rolls back", () =>
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
          spec: { ...ProContract.defaultSpec("Use selected solver", 22), requires: [bound.requirement] },
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
        expect((yield* contracts.get(id))?.status).toBe("escalated")
        expect(yield* bindings.reserveTurn(binding!.sessionID, 25)).toBe(false)
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
})

function fixture(
  run: (
    project: string,
  ) => Effect.Effect<
    void,
    unknown,
    ProContractPolicy.Service | ProContract.Service | ProContractOpenCode.Service | Snapshot.Service | Database.Service
  >,
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
          yield* policies.authorize({ scope: "test", protocol, bundle: seed, now: 0 })
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
