import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import path from "node:path"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { ModelV2 } from "../src/model"
import { ProContract } from "../src/pro-contract"
import { ProContractOpenCode } from "../src/pro-contract/open-code"
import { ProContractPolicy } from "../src/pro-contract/policy"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"

const historicalTime = 1_750_000_000_000
const cappedID = ProContract.ID.make("pct_upgrade_capped")
const boundID = ProContract.ID.make("pct_upgrade_bound_policy")
const migrationID = "20261005011555_contract_policy"

describe("persisted ProContract upgrades", () => {
  test("migrates historical contracts, bindings, attestations and ledger without rewriting their bytes", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "historical.db")
    await seed(filename)
    const before = await persisted(filename)
    expect(before.tables).not.toContain("pro_contract_policy")

    await run(
      filename,
      Effect.gen(function* () {
        const database = yield* Database.Service
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const capped = (yield* contracts.get(cappedID))!
        const bound = (yield* contracts.get(boundID))!
        expect(capped.spec.budget).toEqual({ turns: 4, actions: 32, deadline: historicalTime + 21_600_000 })
        expect(bound.spec.requires).toEqual([{ contractID: ProContract.ID.make("pct_upgrade_support"), revision: 1 }])
        expect((yield* contracts.get(ProContract.ID.make("pct_upgrade_support")))?.status).toBe("discharged")
        expect(yield* bindings.get(boundID)).toMatchObject({
          turnsUsed: 1,
          actionsUsed: 1,
          attempts: 1,
          executionPolicy: "Frozen historical solver policy",
        })
        expect(ProContract.info(capped).specHash).toBe(capped.specHash)
        expect(ProContract.hashSpec(capped.spec)).toBe(capped.specHash)
        expect(yield* database.db.all(sql`PRAGMA integrity_check`)).toEqual([{ integrity_check: "ok" }])
        expect(yield* database.db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
        yield* DatabaseMigration.apply(database.db)
        yield* DatabaseMigration.apply(database.db)
      }),
    )

    const after = await persisted(filename)
    expect(after.historical).toEqual(before.historical)
    expect(after.ledger).toEqual(before.ledger)
    expect(after.journal.filter((row) => row.id !== migrationID)).toEqual(before.journal)
    expect(after.journal.filter((row) => row.id === migrationID)).toHaveLength(1)
    expect(after.journal).toHaveLength(migrations.length)
    expect(after.policy).toEqual([])
    await run(filename, Effect.void)
    expect(await persisted(filename)).toEqual(after)
  })

  test("preserves newly admitted deadline-only contracts and policy selections across reopen and repeated migration", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "historical.db")
    await seed(filename)
    const before = await persisted(filename)
    const id = ProContract.ID.make("pct_after_upgrade_deadline")
    await run(
      filename,
      Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const policies = yield* ProContractPolicy.Service
        yield* policies.authorize({
          scope: "after-upgrade",
          bundle: { version: 1, solver: "Selected solver", generator: "Selected generator" },
          protocol: {
            version: 1,
            performanceRule: "task-pareto",
            evaluatorHash: Hash.sha256("synthetic upgrade evaluator"),
            tests: [
              { id: "safety", total: 1 },
              ...(["development", "confirmation"] as const).flatMap((panel) =>
                ["0", "1"].map((replicate) => ({
                  id: `${panel}-${replicate}`,
                  total: 1,
                  performance: { panel, task: "task", replicate },
                })),
              ),
            ],
          },
          now: historicalTime,
        })
        const selected = yield* policies.bind({ scope: "after-upgrade", role: "solver" })
        expect(
          (yield* bindings.issue({
            id,
            scope: "after-upgrade",
            spec: {
              ...ProContract.defaultSpec("Current deadline-only admission", historicalTime),
              budget: { deadline: historicalTime + 21_600_000 },
            },
            location: { directory: AbsolutePath.make(tmp.path) },
            model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("no-call") }),
            executionPolicy: selected.executionPolicy,
            authorization: selected.authorization,
            now: historicalTime,
          })).decision.type,
        ).toBe("accepted")
        yield* contracts.activate(id, 1, historicalTime)
        const execution = (yield* bindings.claim(id, historicalTime))!
        yield* Effect.forEach(
          Array.from({ length: 6 }, (_, index) => index),
          (offset) =>
            Effect.gen(function* () {
              expect(yield* bindings.reserveTurn(execution.sessionID, historicalTime + offset)).toBe(true)
            }),
        )
        expect((yield* bindings.get(id))?.turnsUsed).toBe(6)
      }),
    )
    const admitted = await persisted(filename)
    expect(admitted.historical).toEqual(before.historical)
    expect(admitted.policy).toHaveLength(1)

    await run(
      filename,
      Effect.gen(function* () {
        const database = yield* Database.Service
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const policies = yield* ProContractPolicy.Service
        yield* DatabaseMigration.apply(database.db)
        yield* DatabaseMigration.apply(database.db)
        expect((yield* contracts.get(id))?.spec.budget).toEqual({ deadline: historicalTime + 21_600_000 })
        expect(yield* bindings.get(id)).toMatchObject({ turnsUsed: 6, executionPolicy: "Selected solver" })
        expect((yield* policies.bind({ scope: "after-upgrade", role: "solver" })).executionPolicy).toBe(
          "Selected solver",
        )
      }),
    )
    expect(await persisted(filename)).toEqual(admitted)
  })

  test("retains historical caps and consumed usage when the new process takes over an expired binding", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "historical.db")
    await seed(filename)
    const before = await persisted(filename)
    await run(
      filename,
      Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const prior = (yield* bindings.get(cappedID))!
        const now = historicalTime + 30_001
        const execution = (yield* bindings.claim(cappedID, now))!
        expect(execution.sessionID).not.toBe(prior.sessionID)
        expect(execution).toMatchObject({ turnsUsed: 1, actionsUsed: 1, attempts: 1 })
        expect(yield* bindings.reserveTurn(prior.sessionID, now)).toBe(false)
        yield* Effect.forEach([0, 1, 2], (offset) =>
          Effect.gen(function* () {
            expect(yield* bindings.reserveTurn(execution.sessionID, now + offset)).toBe(true)
          }),
        )
        expect(yield* bindings.reserveTurn(execution.sessionID, now + 3)).toBe(false)
        expect((yield* bindings.get(cappedID))?.turnsUsed).toBe(4)
        expect((yield* contracts.get(cappedID))?.status).toBe("escalated")
        expect((yield* contracts.get(cappedID))?.spec.budget.turns).toBe(4)
      }),
    )
    expect((await persisted(filename)).historical.events.slice(0, before.historical.events.length)).toEqual(
      before.historical.events,
    )
  })

  test("rolls back policy DDL if journaling fails, preserving historical data for a safe retry", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "historical.db")
    await seed(filename, true)
    const before = await persisted(filename)
    // Real SQLite failure after migration.up: the schema and journal must share a transaction.
    await expect(run(filename, Effect.void)).rejects.toThrow('INSERT INTO "migration"')
    expect(await persisted(filename)).toEqual(before)
    const { Database } = await import("bun:sqlite")
    using db = new Database(filename)
    db.exec("DROP TRIGGER reject_policy_journal")
    await run(filename, Effect.void)
    const retried = await persisted(filename)
    expect(retried.historical).toEqual(before.historical)
    expect(retried.ledger).toEqual(before.ledger)
    expect(retried.tables).toContain("pro_contract_policy")
    expect(retried.journal.filter((row) => row.id === migrationID)).toHaveLength(1)
  })
})

function run<A, E>(
  filename: string,
  effect: Effect.Effect<
    A,
    E,
    Database.Service | ProContract.Service | ProContractOpenCode.Service | ProContractPolicy.Service
  >,
) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        LayerNode.compile(
          LayerNode.group([Database.node, ProContract.node, ProContractOpenCode.node, ProContractPolicy.node]),
          [
            [Database.node, Database.layerFromPath(filename)],
            [
              Global.node,
              Global.layerWith({
                data: path.dirname(filename),
                config: path.dirname(filename),
                cache: path.dirname(filename),
              }),
            ],
          ],
        ),
      ),
      Effect.scoped,
    ),
  )
}

async function seed(filename: string, failJournal = false) {
  const { Database } = await import("bun:sqlite")
  using db = new Database(filename)
  db.exec(await Bun.file(path.join(import.meta.dir, "fixture/pro-contract-upgrade.sql")).text())
  if (failJournal)
    db.exec(`
    CREATE TRIGGER reject_policy_journal BEFORE INSERT ON migration
    WHEN NEW.id = '${migrationID}' BEGIN SELECT RAISE(ABORT, 'upgrade journal failure'); END;
  `)
}

async function persisted(filename: string) {
  const { Database } = await import("bun:sqlite")
  using db = new Database(filename, { readonly: true })
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name)
  return {
    tables,
    journal: db.query<{ id: string; time_completed: number }, []>("SELECT * FROM migration ORDER BY id").all(),
    ledger: db.query("SELECT * FROM pro_contract_ledger ORDER BY id").all(),
    policy: tables.includes("pro_contract_policy")
      ? db.query("SELECT * FROM pro_contract_policy ORDER BY scope").all()
      : [],
    current: {
      contracts: db.query("SELECT * FROM pro_contract WHERE id NOT LIKE 'pct_upgrade_%' ORDER BY id").all(),
      bindings: db
        .query("SELECT * FROM pro_contract_opencode WHERE contract_id NOT LIKE 'pct_upgrade_%' ORDER BY contract_id")
        .all(),
      events: db
        .query("SELECT * FROM pro_contract_event WHERE contract_id NOT LIKE 'pct_upgrade_%' ORDER BY seq")
        .all(),
    },
    historical: {
      contracts: db.query("SELECT * FROM pro_contract WHERE id LIKE 'pct_upgrade_%' ORDER BY id").all(),
      bindings: db
        .query("SELECT * FROM pro_contract_opencode WHERE contract_id LIKE 'pct_upgrade_%' ORDER BY contract_id")
        .all(),
      sessions: db
        .query("SELECT * FROM pro_contract_opencode_session WHERE contract_id LIKE 'pct_upgrade_%' ORDER BY session_id")
        .all(),
      attestations: db
        .query("SELECT * FROM pro_contract_attestation WHERE contract_id LIKE 'pct_upgrade_%' ORDER BY id")
        .all(),
      events: db.query("SELECT * FROM pro_contract_event WHERE contract_id LIKE 'pct_upgrade_%' ORDER BY seq").all(),
    },
  }
}
