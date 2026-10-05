import { expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Context, Effect, Layer, Scope } from "effect"
import { join } from "node:path"
import { tmpdir } from "./fixture/tmpdir"

const layer = LayerNode.compile(Database.node)

test("independent hosts acquire the current database without changing an existing host", async () => {
  await using first = await tmpdir()
  await using second = await tmpdir()
  const configured = Flag.OPENCODE_DB

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        const firstMemo = yield* Layer.makeMemoMap
        const secondMemo = yield* Layer.makeMemoMap

        Flag.OPENCODE_DB = join(first.path, "first.sqlite")
        const original = Context.get(yield* Layer.buildWithMemoMap(layer, firstMemo, scope), Database.Service)
        expect(yield* original.db.all("PRAGMA database_list")).toContainEqual({
          seq: 0,
          name: "main",
          file: Flag.OPENCODE_DB,
        })
        yield* original.db.run("CREATE TABLE host_marker (value TEXT NOT NULL)")
        yield* original.db.run("INSERT INTO host_marker VALUES ('first')")

        Flag.OPENCODE_DB = join(second.path, "second.sqlite")
        const reused = Context.get(yield* Layer.buildWithMemoMap(layer, firstMemo, scope), Database.Service)
        const independent = Context.get(yield* Layer.buildWithMemoMap(layer, secondMemo, scope), Database.Service)
        expect(reused).toBe(original)
        expect(independent).not.toBe(original)
        expect(yield* independent.db.all("PRAGMA database_list")).toContainEqual({
          seq: 0,
          name: "main",
          file: Flag.OPENCODE_DB,
        })
        yield* independent.db.run("CREATE TABLE host_marker (value TEXT NOT NULL)")
        yield* independent.db.run("INSERT INTO host_marker VALUES ('second')")

        expect(yield* original.db.all("SELECT value FROM host_marker")).toEqual([{ value: "first" }])
        expect(yield* independent.db.all("SELECT value FROM host_marker")).toEqual([{ value: "second" }])
      }).pipe(Effect.scoped),
    )
  } finally {
    Flag.OPENCODE_DB = configured
  }
})

test("a disposed host does not pin the database path for later hosts", async () => {
  const configured = Flag.OPENCODE_DB

  try {
    {
      await using previous = await tmpdir()
      Flag.OPENCODE_DB = join(previous.path, "previous.sqlite")
      await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped))
      expect(await Bun.file(Flag.OPENCODE_DB).exists()).toBe(true)
    }

    await using current = await tmpdir()
    Flag.OPENCODE_DB = join(current.path, "current.sqlite")
    await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped))
    expect(await Bun.file(Flag.OPENCODE_DB).exists()).toBe(true)
  } finally {
    Flag.OPENCODE_DB = configured
  }
})
