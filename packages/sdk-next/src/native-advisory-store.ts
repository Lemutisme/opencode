export * as NativeAdvisoryStore from "./native-advisory-store"

import { asc, eq, sql } from "drizzle-orm"
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { ModelV2 } from "@opencode-ai/core/model"
import type { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractBlob } from "@opencode-ai/core/pro-contract/blob"
import { ProContractDelivery } from "@opencode-ai/core/pro-contract/delivery"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import type { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { PositiveInt, RelativePath } from "@opencode-ai/core/schema"
import type { SessionMessage } from "@opencode-ai/core/session/message"

export const Configuration = Schema.Struct({
  reviewer: Schema.Struct({ model: ModelV2.Ref, agent: AgentV2.ID, instructions: Schema.NonEmptyString }),
  materials: Schema.Array(RelativePath),
  evidence: Schema.Array(ProContractBlob.Ref),
  time: Schema.Struct({
    operationMs: PositiveInt,
    reviewMs: PositiveInt,
    // ContractJobs.cancel has two separate waits of up to 30 seconds each.
    cleanupMs: PositiveInt.check(Schema.isGreaterThanOrEqualTo(60_000)),
    resumeMs: PositiveInt,
  }),
})
export type Configuration = typeof Configuration.Type

export type Registration = {
  readonly contractID: ProContract.ID
  readonly revision: number
  readonly specHash: string
  readonly task: ProContract.Spec
  readonly context: ProContract.ContextTarget
  readonly location: ProContractOpenCode.Binding["location"]
  readonly configuration: Configuration
  readonly hash: string
  readonly directory: string
  readonly environment: Materials["environment"]
}

export type Materials = {
  readonly subjectHash: string
  readonly key: string
  readonly hash: string
  readonly directory: string
  readonly files: ReadonlyArray<{ readonly path: string; readonly blob: ProContractBlob.Ref }>
  // Historical records contain every approved file and omit this field.
  readonly missing?: ReadonlyArray<string>
  readonly evidence: ReadonlyArray<ProContractBlob.Ref>
  readonly environment: {
    readonly configurationHash: string
    readonly agentHash: string
    readonly instructionsHash: string
  }
}

export type Outcome = {
  readonly status: "complete" | "unavailable" | "not-started"
  readonly reason?: string
  readonly rawHash?: string
  readonly partialHash?: string
  readonly archiveHash?: string
  readonly systemHash?: string
  readonly messageID?: SessionMessage.ID
  readonly jobStatus?: ProContractJob.Job["status"]
}

export type Request = {
  readonly id: string
  readonly version: number
  readonly contractID: ProContract.ID
  readonly execution: ProContractOpenCode.Execution
  readonly call: NonNullable<ProContractDelivery.Request["call"]>
  readonly registration: Registration
  readonly createdAt: number
  readonly phase: "accepted" | "job" | "collected" | "resumed" | "returned"
  readonly prequery?: { readonly subjectHash: string; readonly key: string }
  readonly actual?: { readonly subjectHash: string; readonly key: string }
  readonly pause?: {
    readonly reason: string
    readonly stopAt: number
    readonly capabilities?: ReadonlyArray<ProContractOpenCode.Capability>
  }
  readonly job?: ProContractJob.Input
  readonly materials?: Materials
  readonly outcome?: Outcome
  readonly cachedFrom?: string
  readonly reason?: string
  readonly archiveFault?: string
  readonly recovering?: boolean
  readonly resume?: "preserve" | "replace"
  readonly delivery?: { readonly reason: string; readonly input: ProContractOpenCode.AdmissionInput }
  readonly resumedAt?: number
  readonly resumedSessionID?: ProContractOpenCode.Binding["sessionID"]
}

export const RegistrationTable = sqliteTable("sdk_native_advisory_registration_v1", {
  contract_id: text().primaryKey(),
  data: text({ mode: "json" }).$type<Registration>().notNull(),
})
export const RequestTable = sqliteTable("sdk_native_advisory_request_v1", {
  id: text().primaryKey(),
  contract_id: text().notNull(),
  version: integer().notNull(),
  data: text({ mode: "json" }).$type<Request>().notNull(),
})
export const EventTable = sqliteTable(
  "sdk_native_advisory_event_v1",
  {
    id: text().notNull(),
    version: integer().notNull(),
    data: text({ mode: "json" }).$type<Request>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.version] })],
)

const make = Effect.gen(function* () {
  const database = yield* Database.Service
  const db = database.db
  const blobs = yield* ProContractBlob.Service
  const atomic = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    db.transaction(() => effect, { behavior: "immediate" }).pipe(Effect.catchTag("SqlError", Effect.die))
  yield* atomic(
    Effect.gen(function* () {
      yield* db
        .run(
          "CREATE TABLE IF NOT EXISTS sdk_native_advisory_registration_v1 (contract_id TEXT PRIMARY KEY, data TEXT NOT NULL)",
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          "CREATE TABLE IF NOT EXISTS sdk_native_advisory_request_v1 (id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL)",
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          "CREATE TABLE IF NOT EXISTS sdk_native_advisory_event_v1 (id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, version))",
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          "CREATE INDEX IF NOT EXISTS sdk_native_advisory_contract_v1 ON sdk_native_advisory_request_v1 (contract_id)",
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          "CREATE INDEX IF NOT EXISTS sdk_native_advisory_unfinished_v1 ON sdk_native_advisory_request_v1 (id) WHERE json_extract(data, '$.phase') IN ('accepted', 'job', 'collected')",
        )
        .pipe(Effect.orDie)
    }),
  )
  const get = (id: string) =>
    db
      .select()
      .from(RequestTable)
      .where(eq(RequestTable.id, id))
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((row) => row?.data),
      )
  const save = (previous: Request | undefined, next: Request) =>
    atomic(
      Effect.gen(function* () {
        const current = yield* get(next.id)
        if (current?.version !== previous?.version)
          return yield* new ProContractDelivery.Denied({ message: "Native advisory request changed" })
        const updated = { ...next, version: (previous?.version ?? -1) + 1 }
        yield* db
          .insert(RequestTable)
          .values({ id: updated.id, contract_id: updated.contractID, version: updated.version, data: updated })
          .onConflictDoUpdate({ target: RequestTable.id, set: { version: updated.version, data: updated } })
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
  return {
    db,
    atomic,
    get,
    save,
    blob: blobs.put,
    bytes: blobs.get,
    put: (value: unknown) =>
      blobs.put(Buffer.from(ProContractRecognition.canonical(value))).pipe(Effect.map((blob) => blob.hash)),
    registration: (id: ProContract.ID) =>
      db
        .select()
        .from(RegistrationTable)
        .where(eq(RegistrationTable.contract_id, id))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row?.data),
        ),
    register: (registration: Registration) =>
      db
        .insert(RegistrationTable)
        .values({ contract_id: registration.contractID, data: registration })
        .run()
        .pipe(Effect.orDie),
    unfinished: () =>
      db
        .select()
        .from(RequestTable)
        .where(sql`json_extract(${RequestTable.data}, '$.phase') IN ('accepted', 'job', 'collected')`)
        .orderBy(asc(RequestTable.id))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map((row) => row.data)),
        ),
    list: (contractID?: ProContract.ID) =>
      db
        .select()
        .from(RequestTable)
        .where(contractID ? eq(RequestTable.contract_id, contractID) : undefined)
        .orderBy(asc(RequestTable.id))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map((row) => row.data)),
        ),
    history: (id: string) =>
      db
        .select()
        .from(EventTable)
        .where(eq(EventTable.id, id))
        .orderBy(asc(EventTable.version))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map((row) => row.data)),
        ),
  }
})

export class Service extends Context.Service<Service, Effect.Success<typeof make>>()(
  "@opencode/sdk/NativeAdvisoryStore",
) {}
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [Database.node, ProContractBlob.node],
})
