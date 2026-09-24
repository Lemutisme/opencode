import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { ResearchStore } from "../src/research/store"
import { testEffect } from "../../core/test/lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))
describe("Research storage admission", () => {
  for (const fault of ["version", "nullable", "ownership"] as const) {
    it.effect(`refuses an incompatible ${fault} schema before opening research authority`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        if (fault === "version") {
          yield* database.db.run("CREATE TABLE sdk_research_schema (version INTEGER PRIMARY KEY)").pipe(Effect.orDie)
          yield* database.db.run("INSERT INTO sdk_research_schema VALUES (2)").pipe(Effect.orDie)
        }
        if (fault === "nullable")
          yield* database.db
            .run("CREATE TABLE sdk_research_run_v1 (id TEXT PRIMARY KEY, version INTEGER, data TEXT)")
            .pipe(Effect.orDie)
        if (fault === "ownership")
          yield* database.db
            .run(
              "CREATE TABLE sdk_research_preparation_v1 (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, directory TEXT NOT NULL, snapshot TEXT)",
            )
            .pipe(Effect.orDie)
        const result = yield* ResearchStore.Service.pipe(
          Effect.provide(
            AppNodeBuilder.build(ResearchStore.node, [[Database.node, Layer.succeed(Database.Service, database)]]),
          ),
          Effect.exit,
        )
        expect(result._tag).toBe("Failure")
      }),
    )
  }
})
