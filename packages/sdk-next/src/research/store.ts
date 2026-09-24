export * as ResearchStore from "./store"

import { asc, eq } from "drizzle-orm"
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { ProContractBlob } from "@opencode-ai/core/pro-contract/blob"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import type { ProContractDelivery } from "@opencode-ai/core/pro-contract/delivery"
import { ResearchModel } from "./model"

export const RunTable = sqliteTable("sdk_research_run_v1", {
  id: text().primaryKey(),
  version: integer().notNull(),
  data: text({ mode: "json" }).$type<ResearchModel.Run>().notNull(),
})

export const EventTable = sqliteTable(
  "sdk_research_event_v1",
  {
    id: text().notNull(),
    version: integer().notNull(),
    data: text({ mode: "json" }).$type<ResearchModel.Run>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.version] })],
)

export const PreparationTable = sqliteTable("sdk_research_preparation_v1", {
  id: text().primaryKey(),
  fingerprint: text().notNull(),
  directory: text().notNull().unique(),
  snapshot: text(),
})

export type CommandRecord = {
  readonly input: Parameters<NonNullable<ProContractDelivery.Handler["command"]>>[0]
  readonly at: number
  readonly result: unknown
}
export const CommandTable = sqliteTable("sdk_research_command_v3", {
  id: text().primaryKey(),
  contract_id: text().notNull(),
  data: text({ mode: "json" }).$type<CommandRecord>().notNull(),
})
export const CommandConflictTable = sqliteTable("sdk_research_command_conflict_v3", {
  id: text().primaryKey(),
  contract_id: text().notNull(),
  data: text({ mode: "json" }).$type<CommandRecord>().notNull(),
})

const make = Effect.gen(function* () {
  const database = yield* Database.Service
  const db = database.db
  const blobs = yield* ProContractBlob.Service
  const atomic = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    db.transaction(() => effect, { behavior: "immediate" }).pipe(Effect.catchTag("SqlError", Effect.die))

  // The optional host owns these tables, but authority changes share Core's exact transaction context.
  yield* atomic(
    Effect.gen(function* () {
      yield* db.run("CREATE TABLE IF NOT EXISTS sdk_research_schema (version INTEGER PRIMARY KEY)").pipe(Effect.orDie)
      const versions = yield* db.all<{ version: number }>("SELECT version FROM sdk_research_schema").pipe(Effect.orDie)
      if (versions.length && (versions.length !== 1 || versions[0].version !== 1))
        return yield* Effect.die("Unsupported research storage version")
      yield* db
        .run(
          "CREATE TABLE IF NOT EXISTS sdk_research_run_v1 (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL)",
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          "CREATE TABLE IF NOT EXISTS sdk_research_event_v1 (id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, version))",
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          "CREATE TABLE IF NOT EXISTS sdk_research_preparation_v1 (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, directory TEXT NOT NULL UNIQUE, snapshot TEXT)",
        )
        .pipe(Effect.orDie)
      for (const table of ["sdk_research_command_v3", "sdk_research_command_conflict_v3"])
        yield* db
          .run(
            `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, data TEXT NOT NULL)`,
          )
          .pipe(Effect.orDie)
      for (const [table, expected] of [
        [
          "sdk_research_run_v1",
          [
            ["id", "TEXT", 1],
            ["version", "INTEGER", 0],
            ["data", "TEXT", 0],
          ],
        ],
        [
          "sdk_research_event_v1",
          [
            ["id", "TEXT", 1],
            ["version", "INTEGER", 2],
            ["data", "TEXT", 0],
          ],
        ],
        [
          "sdk_research_preparation_v1",
          [
            ["id", "TEXT", 1],
            ["fingerprint", "TEXT", 0],
            ["directory", "TEXT", 0],
            ["snapshot", "TEXT", 0],
          ],
        ],
      ] as const) {
        const columns = yield* db
          .all<{ name: string; type: string; pk: number }>(`PRAGMA table_info(${table})`)
          .pipe(Effect.orDie)
        if (
          !ProContractRecognition.same(
            columns.map((column) => [column.name, column.type, column.pk]),
            expected,
          )
        )
          return yield* Effect.die("Incompatible research storage schema")
        const required =
          table === "sdk_research_run_v1"
            ? ["version", "data"]
            : table === "sdk_research_event_v1"
              ? ["id", "version", "data"]
              : ["fingerprint", "directory"]
        const constraints = yield* db
          .all<{ name: string; notnull: number }>(`PRAGMA table_info(${table})`)
          .pipe(Effect.orDie)
        if (constraints.some((column) => required.includes(column.name) && column.notnull !== 1))
          return yield* Effect.die("Incompatible research storage nullability")
      }
      const indexes = yield* db
        .all<{ name: string; unique: number }>("PRAGMA index_list(sdk_research_preparation_v1)")
        .pipe(Effect.orDie)
      const keys = yield* Effect.forEach(
        indexes.filter((index) => index.unique === 1),
        (index) =>
          db.all<{ name: string }>(`PRAGMA index_info('${index.name.replaceAll("'", "''")}')`).pipe(Effect.orDie),
      )
      if (!keys.some((columns) => columns.length === 1 && columns[0].name === "directory"))
        return yield* Effect.die("Research preparation directory must have unique ownership")
      yield* db.run("INSERT OR IGNORE INTO sdk_research_schema (version) VALUES (1)").pipe(Effect.orDie)
    }),
  )

  const get = (id: string) =>
    db
      .select()
      .from(RunTable)
      .where(eq(RunTable.id, id))
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((row) => row?.data),
      )
  const save = (previous: ResearchModel.Run | undefined, next: ResearchModel.Run) =>
    atomic(
      Effect.gen(function* () {
        const current = yield* get(next.id)
        if (current?.version !== previous?.version)
          return yield* new ResearchModel.Denied({ message: "Research state changed" })
        const updated = { ...next, version: (previous?.version ?? -1) + 1 }
        yield* db
          .insert(RunTable)
          .values({ id: updated.id, version: updated.version, data: updated })
          .onConflictDoUpdate({ target: RunTable.id, set: { version: updated.version, data: updated } })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values({ id: updated.id, version: updated.version, data: updated })
          .run()
          .pipe(Effect.orDie)
        return updated
      }),
    )
  const assert = Effect.fnUntraced(function* (token: ResearchModel.Token, stage?: ResearchModel.Run["stage"]) {
    const run = yield* get(token.id)
    const now = yield* Clock.currentTimeMillis
    if (
      !run ||
      run.owner !== token.owner ||
      run.generation !== token.generation ||
      run.round !== token.round ||
      run.reviewVersion !== token.reviewVersion ||
      !ProContractRecognition.same(run.context, token.context) ||
      (run.leaseExpiresAt ?? 0) <= now ||
      (stage && run.stage !== stage) ||
      ["cancelled", "released"].includes(run.stage)
    )
      return yield* new ResearchModel.Denied({ message: "Research coordinator identity, phase or lease is stale" })
    return run
  })
  return {
    db,
    atomic,
    get,
    save,
    assert,
    list: () =>
      db
        .select()
        .from(RunTable)
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map((row) => row.data)),
        ),
    history: (id: string) => db.select().from(EventTable).where(eq(EventTable.id, id)).all().pipe(Effect.orDie),
    command: (id: string) =>
      db
        .select()
        .from(CommandTable)
        .where(eq(CommandTable.id, id))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row?.data),
        ),
    recordCommand: (id: string, record: CommandRecord, conflict = false) =>
      db
        .insert(conflict ? CommandConflictTable : CommandTable)
        .values({ id, contract_id: record.input.execution.contractID, data: record })
        .run()
        .pipe(Effect.orDie),
    commands: (id: string) =>
      db
        .select()
        .from(CommandTable)
        .where(eq(CommandTable.contract_id, id))
        .orderBy(asc(CommandTable.id))
        .all()
        .pipe(Effect.orDie),
    commandConflicts: (id: string) =>
      db
        .select()
        .from(CommandConflictTable)
        .where(eq(CommandConflictTable.contract_id, id))
        .orderBy(asc(CommandConflictTable.id))
        .all()
        .pipe(Effect.orDie),
    put: (value: unknown) =>
      blobs.put(Buffer.from(ProContractRecognition.canonical(value))).pipe(
        Effect.map((blob) => blob.hash),
        Effect.mapError((error) => new ResearchModel.Denied({ message: error.message })),
      ),
    bytes: blobs.get,
    blob: blobs.put,
    json: (hash: string) =>
      blobs.get(hash).pipe(
        Effect.flatMap((bytes) =>
          Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(Buffer.from(bytes).toString("utf8")),
        ),
        Effect.mapError(() => new ResearchModel.Denied({ message: "Research evidence is unavailable or corrupt" })),
      ),
  }
})

export class Service extends Context.Service<Service, Effect.Success<typeof make>>()("@opencode/sdk/ResearchStore") {}
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [Database.node, ProContractBlob.node],
})
