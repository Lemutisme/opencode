import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import {
  ProContractEventTable,
  ProContractLedgerTable,
  ProContractOpenCodeSessionTable,
  ProContractOpenCodeTable,
  ProContractTable,
} from "@opencode-ai/core/pro-contract/sql"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { WorkspaceID } from "@opencode-ai/schema/workspace-id"
import { sql } from "drizzle-orm"
import { Cause, Effect, Exit } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, ProContract.node, ProContractOpenCode.node])))
const input = {
  id: ProContract.ID.make("pct_atomic_admission"),
  scope: "admission",
  spec: ProContract.defaultSpec("Admit the obligation and its execution atomically", 0),
  location: { directory: AbsolutePath.make("/project"), workspaceID: WorkspaceID.make("wrk_original") },
  model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
  executionPolicy: "Use bounded individual operations",
  now: 0,
}

describe("ProContract OpenCode atomic admission", () => {
  ;[
    { name: "execution binding", table: ProContractOpenCodeTable },
    { name: "Session mapping", table: ProContractOpenCodeSessionTable },
  ].forEach((scenario) => {
    it.effect(`rolls back the obligation and global ledger when the ${scenario.name} insert fails`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        yield* bindings.issue({ ...input, id: ProContract.ID.make("pct_previous_admission") })
        const before = yield* admissionState()
        yield* database.db.run(sql`
          CREATE TRIGGER fail_admission BEFORE INSERT ON ${scenario.table}
          BEGIN
            SELECT RAISE(ABORT, 'admission interrupted');
          END
        `)

        const failed = yield* bindings.issue(input).pipe(Effect.exit)
        expect(Exit.isFailure(failed) ? Cause.pretty(failed.cause) : "").toContain("admission interrupted")
        expect(yield* contracts.get(input.id)).toBeUndefined()
        expect(yield* bindings.get(input.id)).toBeUndefined()
        expect(yield* contracts.history({ contractID: input.id })).toEqual([])
        expect(yield* admissionState()).toEqual(before)

        yield* database.db.run(sql`DROP TRIGGER fail_admission`)
        const admitted = yield* bindings.issue(input)
        expect(admitted.decision).toEqual({ type: "accepted" })
        expect(admitted.execution).toBeDefined()
        const after = yield* admissionState()
        expect(after.contracts).toHaveLength(2)
        expect(after.bindings).toHaveLength(2)
        expect(after.sessions).toHaveLength(2)
        expect(after.events).toHaveLength(2)
        expect(after.ledger).toEqual([{ id: 1, head_seq: admitted.frontier, head_hash: admitted.hash }])
        expect(admitted.frontier).toBe(before.ledger[0]!.head_seq + 1)
      }),
    )
  })

  it.effect("reuses the exact execution binding when admission is retried later", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const admitted = yield* bindings.issue(input)
      const retried = yield* bindings.issue({ ...input, now: 60_000 })

      expect(retried.decision).toEqual({ type: "accepted" })
      expect(retried.contract).toEqual(admitted.contract)
      expect(retried.execution).toEqual(admitted.execution)
      expect(yield* bindings.get(input.id)).toEqual(admitted.execution)
      expect(yield* contracts.get(input.id)).toEqual(admitted.contract)
      const state = yield* admissionState()
      expect(state.contracts).toHaveLength(1)
      expect(state.bindings).toHaveLength(1)
      expect(state.sessions).toHaveLength(1)
    }),
  )
  ;[
    {
      name: "directory",
      request: { ...input, location: { ...input.location, directory: AbsolutePath.make("/different") } },
    },
    {
      name: "workspace identity",
      request: { ...input, location: { ...input.location, workspaceID: WorkspaceID.make("wrk_different") } },
    },
    {
      name: "omitted workspace identity",
      request: { ...input, location: { directory: input.location.directory } },
    },
    {
      name: "model ID",
      request: { ...input, model: { ...input.model, id: Model.ID.make("different") } },
    },
    {
      name: "provider ID",
      request: { ...input, model: { ...input.model, providerID: Provider.ID.make("different") } },
    },
    {
      name: "model variant",
      request: { ...input, model: { ...input.model, variant: Model.VariantID.make("high") } },
    },
    { name: "execution policy", request: { ...input, executionPolicy: "Use a different policy" } },
    { name: "omitted execution policy", request: { ...input, executionPolicy: undefined } },
  ].forEach((scenario) => {
    it.effect(`rejects a conflicting ${scenario.name} without mutating any admission state`, () =>
      Effect.gen(function* () {
        const bindings = yield* ProContractOpenCode.Service
        yield* bindings.issue(input)
        const before = yield* admissionState()

        const rejected = yield* bindings.issue(scenario.request)
        expect(rejected.decision).toEqual({
          type: "rejected",
          reason: "OpenCode execution binding does not match",
        })
        expect(rejected.event).toBeUndefined()
        expect(rejected.frontier).toBe(before.ledger[0]!.head_seq)
        expect(rejected.hash).toBe(before.ledger[0]!.head_hash)
        expect(yield* admissionState()).toEqual(before)
      }),
    )
  })
  ;[undefined, Model.VariantID.make("default")].forEach((variant) => {
    it.effect(`treats a stored ${variant ?? "omitted"} model variant as the same default binding`, () =>
      Effect.gen(function* () {
        const bindings = yield* ProContractOpenCode.Service
        const admitted = yield* bindings.issue({ ...input, model: { ...input.model, variant } })
        const retried = yield* bindings.issue({
          ...input,
          model: { ...input.model, variant: variant === undefined ? Model.VariantID.make("default") : undefined },
          now: 60_000,
        })

        expect(retried.decision).toEqual({ type: "accepted" })
        expect(retried.execution).toEqual(admitted.execution)
        expect(yield* bindings.get(input.id)).toEqual(admitted.execution)
        expect((yield* admissionState()).sessions).toHaveLength(1)
      }),
    )
  })

  it.effect("does not treat an omitted execution policy as an empty policy", () =>
    Effect.gen(function* () {
      const bindings = yield* ProContractOpenCode.Service
      yield* bindings.issue({ ...input, executionPolicy: undefined })
      const before = yield* admissionState()

      const rejected = yield* bindings.issue({ ...input, executionPolicy: "" })
      expect(rejected.decision).toEqual({
        type: "rejected",
        reason: "OpenCode execution binding does not match",
      })
      expect(rejected.event).toBeUndefined()
      expect(rejected.frontier).toBe(before.ledger[0]!.head_seq)
      expect(rejected.hash).toBe(before.ledger[0]!.head_hash)
      expect(yield* admissionState()).toEqual(before)
    }),
  )
})

function admissionState() {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* Effect.all({
      contracts: database.db.select().from(ProContractTable).orderBy(ProContractTable.id).all(),
      bindings: database.db.select().from(ProContractOpenCodeTable).orderBy(ProContractOpenCodeTable.contract_id).all(),
      sessions: database.db
        .select()
        .from(ProContractOpenCodeSessionTable)
        .orderBy(ProContractOpenCodeSessionTable.session_id)
        .all(),
      events: database.db.select().from(ProContractEventTable).orderBy(ProContractEventTable.seq).all(),
      ledger: database.db.select().from(ProContractLedgerTable).all(),
    })
  })
}
