export * as ProContractJob from "./job"

import { Usage, type LLMEvent } from "@opencode-ai/llm"
import { Location } from "@opencode-ai/schema/location"
import { Model } from "@opencode-ai/schema/model"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { ProContract } from "../pro-contract"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { ProContractActivity } from "./activity"
import { ProContractDriver } from "./driver"
import { ProContractOpenCode } from "./open-code"
import { ProContractRecognition } from "./recognition"
import { ProContractOperationAudit } from "./operation-audit"
import { ProContractJobSessionTable, ProContractJobTable, ProContractOperationUsageTable } from "./sql"

export type Input = {
  readonly id: string
  readonly contractID: ProContract.ID
  readonly context: ProContract.ContextTarget
  readonly driver: string
  readonly kind: "review" | "verify"
  readonly inputHash: string
  readonly sessionID: SessionSchema.ID
  readonly promptID: SessionMessage.ID
  readonly location: Location.Ref
  readonly model: Model.Ref
  readonly agent: AgentV2.ID
  readonly prompt: PromptInput.Prompt
  readonly verification?: {
    readonly subjectHash: string
    readonly policy: ProContract.ReplayPolicy
    readonly freshArtifacts?: ReadonlyArray<string>
    /** Extra host invariants strengthen checks without rewriting the issuer's replay policy. */
    readonly additionalProtected?: ProContract.ReplayPolicy["protected"]
  }
  readonly previousJobID?: string
}

export type Job = {
  readonly input: Input
  readonly fingerprint: string
  readonly deadline: number
  readonly version: number
  readonly generation: number
  readonly status: "prepared" | "open" | "completed" | "failed" | "interrupted" | "cancelled" | "unknown"
  readonly owner?: string
  readonly leaseExpiresAt?: number
  readonly leaseIdentity?: string
  readonly reason?: string
  readonly result?: ProContract.ReplayResult
}

export type Execution = {
  readonly jobID: string
  readonly sessionID: SessionSchema.ID
  readonly generation: number
  readonly version: number
  readonly owner: string
}

export type Source = {
  readonly contractID: ProContract.ID
  readonly sessionID: SessionSchema.ID
  readonly jobID?: string
  readonly identity: string
  readonly deadline: number
}

export type Operation = {
  readonly id: string
  readonly source: Source
  readonly kind: "provider" | "compaction" | "tool" | "verification"
  readonly detail?: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly status: "running" | "completed" | "failed" | "interrupted" | "unknown"
  readonly usage: { readonly state: "unknown" | "reported"; readonly value?: typeof Usage.Encoded }
  readonly usageEvents: ReadonlyArray<{
    readonly time: number
    readonly type: string
    readonly value: typeof Usage.Encoded
  }>
}

export class Denied extends Schema.TaggedErrorClass<Denied>()("ExecutionDenied", { message: Schema.String }) {}

export function execution(job: Job): Execution {
  return {
    jobID: job.input.id,
    sessionID: job.input.sessionID,
    generation: job.generation,
    version: job.version,
    owner: job.owner ?? "",
  }
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Job, Denied>
  readonly get: (id: string) => Effect.Effect<Job | undefined>
  readonly forSession: (id: SessionSchema.ID) => Effect.Effect<Job | undefined, Denied>
  readonly start: (id: string) => Effect.Effect<Job, Denied>
  readonly recover: (id: string) => Effect.Effect<Job, Denied>
  readonly cancel: (id: string, reason: string) => Effect.Effect<Job, Denied>
  readonly audit: (id: string) => Effect.Effect<Job, Denied>
  readonly authorize: (execution: Execution) => Effect.Effect<Job, Denied>
  readonly heartbeat: (execution: Execution) => Effect.Effect<void, Denied>
  readonly finish: (
    execution: Execution,
    status: "completed" | "failed" | "interrupted",
    result?: ProContract.ReplayResult,
  ) => Effect.Effect<void>
  readonly assertCoordinates: (input: {
    readonly id: SessionSchema.ID
    readonly location: Location.Ref
    readonly model?: Model.Ref
    readonly agent?: string
  }) => Effect.Effect<void, Denied>
  readonly begin: (source: Source, kind: Operation["kind"], detail?: string) => Effect.Effect<Operation>
  readonly observe: (operationID: string, event: LLMEvent) => Effect.Effect<void>
  readonly end: (operationID: string, status: Exclude<Operation["status"], "running">) => Effect.Effect<void>
  readonly operations: (contractID: ProContract.ID) => Effect.Effect<ReadonlyArray<Operation>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractJob") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const bindings = yield* ProContractOpenCode.Service
    const contracts = yield* ProContract.Service
    const drivers = yield* ProContractDriver.Service
    const activity = yield* ProContractActivity.Service
    const atomic = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      db.transaction(() => effect, { behavior: "immediate" }).pipe(Effect.catchTag("SqlError", Effect.die))
    const get = (id: string) =>
      db
        .select({ data: ProContractJobTable.data })
        .from(ProContractJobTable)
        .where(eq(ProContractJobTable.id, id))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row?.data),
        )
    const save = (job: Job) =>
      db
        .update(ProContractJobTable)
        .set({ data: job })
        .where(eq(ProContractJobTable.id, job.input.id))
        .run()
        .pipe(Effect.orDie, Effect.as(job))
    const forSession = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const marker = yield* db
        .select()
        .from(ProContractJobSessionTable)
        .where(eq(ProContractJobSessionTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!marker) {
        const reserved = yield* db
          .select({ id: ProContractJobTable.id })
          .from(ProContractJobTable)
          .where(eq(ProContractJobTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (reserved) return yield* new Denied({ message: "Controlled Session mapping is unavailable" })
        return undefined
      }
      const job = yield* get(marker.job_id)
      if (!job || job.input.sessionID !== sessionID)
        return yield* new Denied({ message: "Controlled Session job is unavailable" })
      return job
    })
    const requireRoot = Effect.fnUntraced(function* (job: Job) {
      const contract = yield* contracts.get(job.input.contractID)
      const binding = yield* bindings.get(job.input.contractID)
      const now = yield* Clock.currentTimeMillis
      if (
        !contract ||
        !binding ||
        !drivers.get(job.input.driver) ||
        (binding.driver ?? ProContractDriver.native.identity) !== job.input.driver
      )
        return yield* new Denied({ message: "Controlled job driver is unavailable" })
      if (
        !ProContractRecognition.same(job.input.context, contract.recognition.context?.target) ||
        !["active", "dormant", "verification"].includes(contract.status) ||
        contract.pendingRevision
      )
        return yield* new Denied({ message: "Controlled job root context is no longer current" })
      if (now >= Math.min(job.deadline, contract.spec.budget.deadline))
        return yield* new Denied({ message: "Controlled job deadline exhausted" })
      if (binding.dispatched) return yield* new Denied({ message: "Root execution is still in flight" })
      if (contract.spec.budget.turns !== undefined || contract.spec.budget.actions !== undefined)
        return yield* new Denied({ message: "Controlled jobs require a deadline-only root budget" })
      if (
        !contract.spec.authority.includes("filesystem.read") ||
        (job.input.kind === "verify" && !contract.spec.authority.includes("process.execute"))
      )
        return yield* new Denied({ message: "Root authority does not delegate the job capabilities" })
      return contract
    })
    const authorize = Effect.fnUntraced(function* (captured: Execution) {
      const job = yield* get(captured.jobID)
      if (
        !job ||
        !ProContractRecognition.same(execution(job), captured) ||
        job.owner !== bindings.owner ||
        job.status !== "open" ||
        (job.leaseExpiresAt ?? 0) <= (yield* Clock.currentTimeMillis)
      )
        return yield* new Denied({ message: "Controlled job execution identity or lease is no longer current" })
      yield* requireRoot(job)
      return job
    })
    const operations = (contractID: ProContract.ID) =>
      db
        .select({ data: ProContractOperationUsageTable.data })
        .from(ProContractOperationUsageTable)
        .where(eq(ProContractOperationUsageTable.contract_id, contractID))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map((row) => row.data).sort((a, b) => a.startedAt - b.startedAt)),
        )
    const updateOperation = (id: string, change: (operation: Operation) => Operation) =>
      atomic(
        Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(ProContractOperationUsageTable)
            .where(eq(ProContractOperationUsageTable.id, id))
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          yield* db
            .update(ProContractOperationUsageTable)
            .set({ data: change(row.data) })
            .where(eq(ProContractOperationUsageTable.id, id))
            .run()
            .pipe(Effect.orDie)
        }),
      ).pipe(Effect.orDie)
    const open = Effect.fnUntraced(function* (job: Job) {
      yield* requireRoot(job)
      if (activity.has(job.input.contractID))
        return yield* new Denied({ message: "Root execution cleanup is still in flight" })
      const others = yield* db
        .select({ data: ProContractJobTable.data })
        .from(ProContractJobTable)
        .where(eq(ProContractJobTable.contract_id, job.input.contractID))
        .all()
        .pipe(Effect.orDie)
      const now = yield* Clock.currentTimeMillis
      if (others.some(({ data }) => data.input.id !== job.input.id && data.owner && (data.leaseExpiresAt ?? 0) > now))
        return yield* new Denied({ message: "Another job still owns the root execution lease" })
      const next: Job = {
        ...job,
        status: "open",
        version: job.version + 1,
        generation: job.generation + 1,
        owner: bindings.owner,
        leaseExpiresAt: Math.min(now + 30_000, job.deadline),
        reason: undefined,
      }
      return yield* save({ ...next, leaseIdentity: ProContractRecognition.fingerprint({ job: execution(next) }) })
    })
    return Service.of({
      get,
      forSession,
      authorize,
      operations,
      create: (submitted) =>
        atomic(
          Effect.gen(function* () {
            const input = structuredClone(submitted)
            if (
              !input.id ||
              !/^[a-f0-9]{64}$/.test(input.inputHash) ||
              !input.prompt.text ||
              (input.kind === "verify") !== (input.verification !== undefined)
            )
              return yield* new Denied({
                message: "Controlled job requires fixed input and role-specific execution material",
              })
            const fingerprint = ProContractRecognition.fingerprint(input)
            const previous = yield* get(input.id)
            if (previous) {
              if (previous.fingerprint !== fingerprint)
                return yield* new Denied({ message: "Controlled job ID conflicts with its immutable input" })
              return previous
            }
            const marker = yield* db
              .select()
              .from(ProContractJobSessionTable)
              .where(eq(ProContractJobSessionTable.session_id, input.sessionID))
              .get()
              .pipe(Effect.orDie)
            const session = yield* db
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(eq(SessionTable.id, input.sessionID))
              .get()
              .pipe(Effect.orDie)
            if (marker || session || (yield* bindings.forSession(input.sessionID)))
              return yield* new Denied({ message: "Controlled job cannot adopt an existing Session" })
            const contract = yield* contracts.get(input.contractID)
            if (!contract) return yield* new Denied({ message: "Root Contract is unavailable" })
            const job: Job = {
              input,
              fingerprint,
              deadline: contract.spec.budget.deadline,
              status: "prepared",
              version: 0,
              generation: 0,
            }
            yield* requireRoot(job)
            if (input.previousJobID) {
              const parent = yield* get(input.previousJobID)
              if (
                !parent ||
                parent.input.contractID !== input.contractID ||
                parent.status === "open" ||
                parent.deadline !== job.deadline
              )
                return yield* new Denied({ message: "Controlled job lineage is invalid or still executing" })
            }
            yield* db
              .insert(ProContractJobTable)
              .values({ id: input.id, contract_id: input.contractID, session_id: input.sessionID, data: job })
              .run()
              .pipe(Effect.orDie)
            yield* db
              .insert(ProContractJobSessionTable)
              .values({ session_id: input.sessionID, job_id: input.id })
              .run()
              .pipe(Effect.orDie)
            return job
          }),
        ),
      start: (id) =>
        atomic(
          Effect.gen(function* () {
            const job = yield* get(id)
            if (!job || job.status !== "prepared")
              return yield* new Denied({
                message: "Only a prepared job may start; recovery requires an explicit decision",
              })
            return yield* open(job)
          }),
        ),
      recover: (id) =>
        atomic(
          Effect.gen(function* () {
            const job = yield* get(id)
            if (
              !job ||
              job.status !== "open" ||
              (job.leaseExpiresAt ?? 0) > (yield* Clock.currentTimeMillis) ||
              activity.has(job.input.contractID)
            )
              return yield* new Denied({ message: "Job recovery requires an expired lease and stopped execution" })
            const history = (yield* operations(job.input.contractID)).filter(
              (operation) => operation.source.jobID === id,
            )
            if (history.length) {
              const now = yield* Clock.currentTimeMillis
              yield* ProContractOperationAudit.expire(db, job.input.contractID, job.leaseIdentity!, now)
              return yield* save({
                ...job,
                status: "unknown",
                version: job.version + 1,
                owner: undefined,
                leaseExpiresAt: undefined,
                reason: "Prior execution requires inspection; automatic replay is forbidden",
              })
            }
            return yield* open(job)
          }),
        ),
      cancel: (id, reason) =>
        atomic(
          Effect.gen(function* () {
            const job = yield* get(id)
            if (!job) return yield* new Denied({ message: "Controlled job is unavailable" })
            if (["completed", "failed", "interrupted", "cancelled", "unknown"].includes(job.status)) return job
            // Retain the lease until actual cleanup; cancellation does not release the root barrier.
            return yield* save({ ...job, status: "cancelled", version: job.version + 1, reason })
          }),
        ),
      audit: (id) =>
        atomic(
          Effect.gen(function* () {
            const job = yield* get(id)
            if (!job || job.status === "open" || job.status === "prepared")
              return yield* new Denied({ message: "Live job recovery requires an explicit recovery decision" })
            if (!job.owner) return job
            const now = yield* Clock.currentTimeMillis
            if ((job.leaseExpiresAt ?? 0) > now || activity.has(job.input.contractID))
              return yield* new Denied({ message: "Cannot audit an execution whose cleanup may still be active" })
            yield* ProContractOperationAudit.expire(db, job.input.contractID, job.leaseIdentity!, now)
            return yield* save({ ...job, owner: undefined, leaseExpiresAt: undefined })
          }),
        ),
      heartbeat: (captured) =>
        atomic(
          Effect.gen(function* () {
            const job = yield* authorize(captured)
            yield* save({ ...job, leaseExpiresAt: Math.min((yield* Clock.currentTimeMillis) + 30_000, job.deadline) })
          }),
        ),
      finish: (captured, status, result) =>
        atomic(
          Effect.gen(function* () {
            const job = yield* get(captured.jobID)
            if (
              !job ||
              captured.owner !== bindings.owner ||
              job.owner !== captured.owner ||
              job.generation !== captured.generation ||
              job.input.sessionID !== captured.sessionID
            )
              return
            const valid = yield* authorize(captured).pipe(Effect.isSuccess)
            yield* save({
              ...job,
              status: job.status === "cancelled" ? "cancelled" : valid ? status : "interrupted",
              result: valid && status === "completed" ? result : undefined,
              version: job.version + 1,
              owner: undefined,
              leaseExpiresAt: undefined,
            })
          }),
        ).pipe(Effect.orDie),
      assertCoordinates: (input) =>
        Effect.gen(function* () {
          const job = yield* forSession(input.id)
          if (!job) return
          if (
            !ProContractRecognition.same(input.location, job.input.location) ||
            !input.model ||
            !ProContractRecognition.same(
              { ...input.model, variant: input.model.variant ?? "default" },
              { ...job.input.model, variant: job.input.model.variant ?? "default" },
            ) ||
            input.agent !== job.input.agent
          )
            return yield* new Denied({ message: "Controlled Session coordinates do not match its reservation" })
        }),
      begin: (source, kind, detail) =>
        Effect.gen(function* () {
          const operation: Operation = {
            id: crypto.randomUUID(),
            source,
            kind,
            detail,
            startedAt: yield* Clock.currentTimeMillis,
            status: "running",
            usage: { state: "unknown" },
            usageEvents: [],
          }
          yield* db
            .insert(ProContractOperationUsageTable)
            .values({
              id: operation.id,
              contract_id: source.contractID,
              session_id: source.sessionID,
              job_id: source.jobID,
              data: operation,
            })
            .run()
            .pipe(Effect.orDie)
          return operation
        }),
      observe: (id, event) =>
        Effect.gen(function* () {
          if (!("usage" in event) || event.usage === undefined) return
          const time = yield* Clock.currentTimeMillis
          const value = yield* Schema.encodeEffect(Usage)(event.usage).pipe(Effect.orDie)
          yield* updateOperation(id, (stored) => ({
            ...stored,
            usage: { state: "reported", value },
            usageEvents: [...stored.usageEvents, { time, type: event.type, value }],
          }))
        }),
      end: (id, status) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          yield* updateOperation(id, (stored) =>
            stored.status === "running" ? { ...stored, status, endedAt: now } : stored,
          )
        }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, ProContractOpenCode.node, ProContract.node, ProContractDriver.node, ProContractActivity.node],
})
