import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { EffectCache } from "drizzle-orm/cache/core/cache-effect"
import { Cause, Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

it.live("holds the delivery write lock and freezes the request before reading evaluation evidence", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
    )
    const filename = path.join(directory.path, "evaluation.db")
    yield* Effect.gen(function* () {
      const database = yield* Database.Service
      const contracts = yield* ProContract.Service
      const deliveryID = ProContract.ID.create()
      const spec = ProContract.defaultSpec("Deliver the evaluated subject", 0)
      yield* contracts.issue({ id: deliveryID, scope: "evaluation-lock", spec, executor: "opencode" })
      const evaluation = yield* contracts.issueEvaluation({
        deliveryContractID: deliveryID,
        evaluatorHash: "independent-evaluator",
        deadline: 100,
      })
      if (!evaluation.contract) throw new Error("Evaluation was not issued")
      const evaluationID = evaluation.contract.id
      yield* contracts.activate(deliveryID, 1, 0)
      yield* contracts.reportReady({
        contractID: deliveryID,
        revision: 1,
        summary: "subject A",
        uncertainties: [],
        subjectHash: "subject-A",
        time: 0,
      })
      yield* contracts.principalAttest({
        contractID: deliveryID,
        revision: 1,
        specHash: ProContract.hashSpec(spec),
        subjectHash: "subject-A",
        evidenceHash: "delivery-evidence-A",
      })
      const request = {
        contractID: evaluationID,
        report: {
          deliveryContractID: deliveryID,
          deliveryRevision: 1,
          subjectHash: "subject-A",
          evaluatorHash: "independent-evaluator",
          passed: true,
          disclosure: "sealed",
          summary: "accepted A",
        },
        evidenceHash: "evaluation-evidence-A",
        time: 1,
      } satisfies Parameters<ProContract.Interface["settleEvaluation"]>[0]
      const contender = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const { Database } = await import("bun:sqlite")
          return new Database(filename)
        }),
        (connection) => Effect.sync(() => connection.close()),
      )
      contender.run("pragma busy_timeout = 0")
      const observed: string[] = []
      const db = yield* EffectDrizzleSqlite.make().pipe(
        Effect.provideService(SqlClient, database.db.$client),
        Effect.provide(EffectCache.Default),
        Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
          logQuery: (query, params) =>
            Effect.gen(function* () {
              if (!query.startsWith("select") || !params.includes(deliveryID)) return
              // Observe actual SQLite locking at the delivery read, before any settlement command executes.
              const write = yield* Effect.try({
                try: () => contender.run("begin immediate"),
                catch: (cause) => cause,
              }).pipe(Effect.exit)
              if (Exit.isSuccess(write)) contender.run("rollback")
              expect(Exit.isFailure(write)).toBe(true)
              if (Exit.isFailure(write)) expect(Cause.pretty(write.cause)).toContain("database is locked")
              request.report.subjectHash = "changed-after-request"
              request.evidenceHash = "changed-after-request"
              observed.push(query)
            }),
        }),
      )
      const receipt = yield* Effect.gen(function* () {
        const settlement = yield* ProContract.Service
        return yield* settlement.settleEvaluation(request)
      }).pipe(
        Effect.provide(
          LayerNode.compile(ProContract.node, [[Database.node, Layer.succeed(Database.Service, { db })]]).pipe(
            Layer.fresh,
          ),
        ),
      )
      expect(observed).toHaveLength(1)
      expect(receipt.decision).toEqual({ type: "accepted" })
      expect(Object.values(receipt.state.attestations)).toMatchObject([
        { evidenceHash: "evaluation-evidence-A", subjectHash: "subject-A" },
      ])
      expect(yield* contracts.get(evaluationID)).toMatchObject({
        status: "discharged",
        handoff: { subjectHash: "subject-A" },
      })
      expect(() => contender.run("begin immediate")).not.toThrow()
      contender.run("rollback")
    }).pipe(
      Effect.provide(
        LayerNode.compile(LayerNode.group([Database.node, ProContract.node]), [
          [Database.node, Database.layerFromPath(filename)],
        ]),
      ),
    )
  }),
)
