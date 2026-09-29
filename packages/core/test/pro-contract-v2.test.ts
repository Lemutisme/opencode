import { describe, expect, test } from "bun:test"
import { ProContract } from "@opencode/core/pro-contract"
import { Database } from "@opencode/core/database/database"
import { DatabaseMigration } from "@opencode/core/database/migration"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { testEffect } from "./lib/effect.js"
import migration from "../src/database/migration/20260929061514_pro_contract_kernel.js"

const it = testEffect(LayerNode.compile(LayerNode.group([ProContract.node, Database.node, Global.node])))

describe("ProContract V2 migration", () => {
  test("new contracts default to six hours with no cumulative request or action cap", () => {
    const spec = ProContract.defaultSpec("Keep responsibility until evidenced settlement", 100)
    expect(spec.budget).toEqual({ deadline: 100 + 6 * 60 * 60 * 1_000 })
    expect(Schema.encodeSync(ProContract.Spec)(spec).budget).toEqual(spec.budget)
  })

  test("explicit historical count limits remain part of the frozen identity", () => {
    const spec = ProContract.defaultSpec("Historical protocol", 0)
    const historical = ProContract.Spec.make({ ...spec, budget: { ...spec.budget, turns: 1000, actions: 2000 } })
    expect(Schema.decodeUnknownSync(ProContract.Spec)(historical).budget).toEqual(historical.budget)
    expect(ProContract.hashSpec(historical)).not.toBe(ProContract.hashSpec(spec))
    expect(() => ProContract.Spec.make({ ...spec, budget: { ...spec.budget, turns: 0 } })).toThrow()
    expect(() => ProContract.Spec.make({ ...spec, budget: { ...spec.budget, actions: 0 } })).toThrow()
  })

  it.effect("upgrades existing V2 storage once without altering other data or replaying the ledger", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const contracts = yield* ProContract.Service
      const db = database.db
      // Reconstruct the pre-migration V2 schema from the real bootstrap, retaining
      // every upstream table and migration marker. Never open a user's database.
      yield* db.run(sql`DROP TABLE pro_contract`)
      yield* db.run(sql`DROP TABLE pro_contract_attestation`)
      yield* db.run(sql`DROP TABLE pro_contract_event`)
      yield* db.run(sql`DROP TABLE pro_contract_ledger`)
      yield* db.run(sql`DELETE FROM migration WHERE id = ${migration.id}`)
      yield* db.run(sql`CREATE TABLE _migration_witness (value TEXT NOT NULL)`)
      yield* db.run(sql`INSERT INTO _migration_witness VALUES ('keep upstream state')`)

      yield* DatabaseMigration.apply(db)
      const issued = yield* contracts.issue({
        id: ProContract.ID.make("pct_migration"),
        scope: "migration",
        spec: ProContract.defaultSpec("Preserve the ledger", 0),
        executor: "migration-fixture",
      })
      expect(issued.decision.type).toBe("accepted")
      const before = yield* contracts.quiet("migration")
      yield* DatabaseMigration.apply(db)
      expect(yield* contracts.quiet("migration")).toEqual(before)
      expect(yield* db.all(sql`SELECT value FROM _migration_witness`)).toEqual([{ value: "keep upstream state" }])
      expect(yield* db.all(sql`SELECT id FROM migration WHERE id = ${migration.id}`)).toEqual([{ id: migration.id }])
      expect(yield* contracts.history({ contractID: ProContract.ID.make("pct_migration") })).toHaveLength(1)
    }),
  )
})
