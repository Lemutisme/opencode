export * as ProContractOpenCode from "./open-code"

import { Location } from "@opencode-ai/schema/location"
import { Model } from "@opencode-ai/schema/model"
import { ProContract as Schema } from "@opencode-ai/schema/pro-contract"
import { and, eq, sql } from "drizzle-orm"
import { Clock, Context, Data, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ProContract } from "../pro-contract"
import { ProContractDriver } from "./driver"
import { ProContractRecognition } from "./recognition"
import { ProContractActivity } from "./activity"
import { ProContractOperationAudit } from "./operation-audit"
import {
  ProContractContextTable,
  ProContractOpenCodeSessionTable,
  ProContractOpenCodeTable,
  ProContractTable,
  ProContractJobTable,
} from "./sql"

export type Capability = "read" | "write" | "process" | "reference" | "control" | "observe" | "compose"

export type AdmissionInput = {
  readonly text: string
  readonly delivery: "steer" | "queue"
  readonly once?: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly context: Schema.ContextTarget
  }
}

export type Binding = {
  readonly contractID: Schema.ID
  readonly revision: number
  readonly location: Location.Ref
  readonly model: Model.Ref
  readonly executionPolicy?: string
  readonly driver?: string
  readonly admission?: {
    readonly open: boolean
    readonly version: number
    readonly reason?: string
    readonly context?: Schema.ContextTarget
    readonly input?: AdmissionInput
    readonly capabilities?: ReadonlyArray<Capability>
  }
  readonly context?: Schema.ContextTarget
  readonly pendingOutcome?: { readonly decision: ProContractDriver.Decision; readonly reason: string }
  readonly sessionID: SessionSchema.ID
  readonly promptID: SessionMessage.ID
  readonly dispatched: boolean
  readonly attempts: number
  readonly nextActionAt: number
  readonly turnsUsed: number
  readonly actionsUsed: number
  readonly leaseOwner?: string
  readonly leaseExpiresAt?: number
  readonly leaseIdentity?: string
  readonly attemptKey?: string
  readonly generation?: number
}

export type Execution = {
  readonly contractID: Schema.ID
  readonly revision: number
  readonly sessionID: SessionSchema.ID
  readonly promptID: SessionMessage.ID
  readonly owner: string
  readonly generation: number
  readonly driver: string
  readonly context?: Schema.ContextTarget
  readonly admissionVersion: number
}

export class Unauthorized extends Data.TaggedError("ProContractOpenCode.Unauthorized")<{ readonly message: string }> {}

export function execution(binding: Binding): Execution {
  return {
    contractID: binding.contractID,
    revision: binding.revision,
    sessionID: binding.sessionID,
    promptID: binding.promptID,
    owner: binding.leaseOwner ?? "",
    generation: binding.generation ?? 0,
    driver: driverID(binding),
    admissionVersion: binding.admission?.version ?? 0,
    context: binding.context,
  }
}

export interface Interface {
  readonly owner: string
  readonly issue: (input: {
    readonly id: Schema.ID
    readonly scope: string
    readonly spec: Schema.Spec
    readonly location: Location.Ref
    readonly model: Model.Ref
    readonly executionPolicy?: string
    readonly driver?: string
    readonly now: number
  }) => Effect.Effect<ProContract.IssueReceipt & { readonly execution?: Binding }>
  readonly create: (input: {
    readonly contractID: Schema.ID
    readonly revision: number
    readonly location: Location.Ref
    readonly model: Model.Ref
    readonly executionPolicy?: string
    readonly nextActionAt: number
  }) => Effect.Effect<Binding>
  readonly activate: (contractID: Schema.ID, revision: number, now: number) => Effect.Effect<void>
  readonly claim: (contractID: Schema.ID, now: number) => Effect.Effect<Binding | undefined>
  readonly get: (contractID: Schema.ID) => Effect.Effect<Binding | undefined>
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<Binding | undefined>
  readonly authorize: (execution: Execution) => Effect.Effect<ProContract.Contract, Unauthorized>
  readonly control: <A, E, R>(execution: Execution, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly dispatch: <A, E, R>(
    execution: Execution,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A | undefined, E, R>
  readonly admit: <A, E, R>(execution: Execution, effect: Effect.Effect<A, E, R>) => Effect.Effect<A | undefined, E, R>
  readonly setAdmission: (input: {
    readonly expected: Binding
    readonly context: Schema.ContextTarget
    readonly open: boolean
    readonly reason: string
    readonly input?: AdmissionInput
    readonly session?: "preserve"
    readonly capabilities?: ReadonlyArray<Capability>
  }) => Effect.Effect<{ readonly binding?: Binding; readonly conflict?: string }>
  readonly due: (now: number) => Effect.Effect<ReadonlyArray<Binding>>
  readonly sweep: (
    sessionIDs: ReadonlySet<SessionSchema.ID>,
    now: number,
  ) => Effect.Effect<ReadonlyArray<SessionSchema.ID>>
  readonly heartbeat: (sessionIDs: ReadonlySet<SessionSchema.ID>, now: number) => Effect.Effect<void>
  readonly complete: (input: {
    readonly execution: Execution
    readonly outcome: ProContractDriver.Outcome
    readonly now: number
  }) => Effect.Effect<void>
  readonly reportBlocked: (execution: Execution, reason: string) => Effect.Effect<ProContract.Receipt>
  readonly reserveTurn: (sessionID: SessionSchema.ID, now: number, execution?: Execution) => Effect.Effect<boolean>
  readonly reserveAction: (
    sessionID: SessionSchema.ID,
    now: number,
    execution?: Execution | false,
  ) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractOpenCode") {}

const LEASE_MS = 30_000

export function attemptKey(contract: ProContract.Contract) {
  const context =
    contract.challenge?.disclosure === "executor"
      ? contract.challenge.time + ":" + contract.challenge.evidenceHash
      : contract.blocked
        ? contract.blocked.time + ":" + contract.blocked.reason
        : ""
  return contract.revision + ":" + context
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const contracts = yield* ProContract.Service
    const drivers = yield* ProContractDriver.Service
    const owner = crypto.randomUUID()
    const activity = yield* ProContractActivity.Service
    const jobActive = (contractID: Schema.ID, now: number) =>
      db
        .select({ data: ProContractJobTable.data })
        .from(ProContractJobTable)
        .where(eq(ProContractJobTable.contract_id, contractID))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.some(({ data }) => data.owner !== undefined && (data.leaseExpiresAt ?? 0) > now)),
        )
    const atomic = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      db.transaction(() => effect, { behavior: "immediate" }).pipe(Effect.orDie)
    const rows = () =>
      db
        .select({
          binding: ProContractOpenCodeTable.data,
          contract: ProContractTable.data,
          context: ProContractContextTable.data,
        })
        .from(ProContractOpenCodeTable)
        .innerJoin(ProContractTable, eq(ProContractTable.id, ProContractOpenCodeTable.contract_id))
        .leftJoin(
          ProContractContextTable,
          and(
            eq(ProContractContextTable.contract_id, ProContractOpenCodeTable.contract_id),
            sql`${ProContractContextTable.version} = (SELECT MAX(version) FROM pro_contract_context WHERE contract_id = ${ProContractOpenCodeTable.contract_id})`,
          ),
        )
    const read = (contractID: Schema.ID) =>
      rows().where(eq(ProContractOpenCodeTable.contract_id, contractID)).get().pipe(Effect.orDie)
    const save = (binding: Binding) =>
      db
        .update(ProContractOpenCodeTable)
        .set({ session_id: binding.sessionID, data: binding })
        .where(eq(ProContractOpenCodeTable.contract_id, binding.contractID))
        .run()
        .pipe(Effect.orDie)
    const remember = (binding: Binding) =>
      db
        .insert(ProContractOpenCodeSessionTable)
        .values({ session_id: binding.sessionID, contract_id: binding.contractID })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

    const get = Effect.fn("ProContractOpenCode.get")(function* (contractID: Schema.ID) {
      const row = yield* db
        .select({ data: ProContractOpenCodeTable.data })
        .from(ProContractOpenCodeTable)
        .where(eq(ProContractOpenCodeTable.contract_id, contractID))
        .get()
        .pipe(Effect.orDie)
      return row?.data
    })

    const forSession = Effect.fn("ProContractOpenCode.forSession")(function* (sessionID: SessionSchema.ID) {
      const current = yield* db
        .select({ data: ProContractOpenCodeTable.data })
        .from(ProContractOpenCodeTable)
        .where(eq(ProContractOpenCodeTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current) return current.data
      const retired = yield* db
        .select({ data: ProContractOpenCodeTable.data })
        .from(ProContractOpenCodeSessionTable)
        .innerJoin(
          ProContractOpenCodeTable,
          eq(ProContractOpenCodeTable.contract_id, ProContractOpenCodeSessionTable.contract_id),
        )
        .where(eq(ProContractOpenCodeSessionTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!retired) return undefined
      return { ...retired.data, sessionID, dispatched: false, leaseOwner: undefined, leaseExpiresAt: undefined }
    })

    const invoke = Effect.fnUntraced(function* <A>(row: Row, operation: string, callback: () => A) {
      const result = yield* Effect.try({ try: callback, catch: (error) => error }).pipe(
        Effect.match({
          onSuccess: (value) => ({ value }),
          onFailure: (error) => ({ error }),
        }),
      )
      if ("value" in result) return result.value
      // Host extension failures revoke admission durably. A later lease expiry
      // must not silently restart work whose lifecycle decision was lost.
      yield* save({
        ...row.binding,
        admission: {
          ...row.binding.admission,
          open: false,
          version: (row.binding.admission?.version ?? 0) + 1,
          reason: `Contract driver ${operation} failed`,
        },
      })
      yield* Effect.logError("Contract driver decision failed", result.error).pipe(
        Effect.annotateLogs({ contractID: row.contract.id, driver: driverID(row.binding), operation }),
      )
      return undefined
    })
    const permit = (
      row: Row,
      driver: ProContractDriver.Driver,
      operation: "activate" | "claim" | "heartbeat",
      now: number,
    ) =>
      invoke(row, operation, () => {
        const allowed = driver[operation](structuredClone({ binding: row.binding, contract: row.contract, now }))
        if (typeof allowed !== "boolean") throw new Error("Contract driver must return a boolean lifecycle permission")
        return allowed
      })

    const inspect = Effect.fnUntraced(function* (execution: Execution) {
      const row = yield* read(execution.contractID)
      return {
        contract: row?.contract,
        reason: executionRejection(execution, row, owner, yield* Clock.currentTimeMillis, drivers),
      }
    })
    const control = <A, E, R>(execution: Execution, effect: Effect.Effect<A, E, R>) =>
      ProContract.withCommandGuard(effect, (command) =>
        Effect.gen(function* () {
          if (command.type === "issue" || command.contractID !== execution.contractID)
            return "OpenCode execution cannot control another Contract"
          return (yield* inspect(execution)).reason
        }),
      )

    const settle = Effect.fnUntraced(function* (
      row: Row,
      decision: ProContractDriver.Decision,
      reason: string,
      now: number,
    ) {
      const exhausted =
        decision.type === "retry" &&
        decision.attempt === "new" &&
        row.contract.spec.resolution.maxAttempts !== undefined &&
        row.binding.attempts >= row.contract.spec.resolution.maxAttempts
      if (decision.type === "escalate" || exhausted)
        yield* contracts.escalate({ contractID: row.contract.id, revision: row.contract.revision, reason, time: now })
      yield* save({
        ...row.binding,
        dispatched: false,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        pendingOutcome: undefined,
        promptID: decision.type === "escalate" || exhausted ? row.binding.promptID : SessionMessage.ID.create(),
        nextActionAt: decision.type === "retry" ? now + row.contract.spec.resolution.retryDelay : now,
        attemptKey: decision.type === "retry" && decision.attempt === "new" ? "" : attemptKey(row.contract),
        admission:
          decision.type === "wait"
            ? { ...row.binding.admission, open: false, version: (row.binding.admission?.version ?? 0) + 1, reason }
            : row.binding.admission,
      })
    })
    const retire = (row: Row, now: number) =>
      save({
        ...row.binding,
        dispatched: false,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        pendingOutcome: undefined,
        promptID: SessionMessage.ID.create(),
        nextActionAt: now,
      })

    const reserve = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      now: number,
      kind: "turn" | "action",
      captured?: Execution | false,
    ) {
      const binding = yield* forSession(sessionID)
      if (!binding) return true
      if (!binding.dispatched || captured === false) return false
      // Callers without a provider capture still bind this reservation to the
      // observed generation; a concurrent claim cannot lend it fresh authority.
      const identity = captured ?? execution(binding)
      return yield* atomic(
        Effect.gen(function* () {
          const row = yield* read(binding.contractID)
          const time = Math.max(now, yield* Clock.currentTimeMillis)
          if (
            !row ||
            identityRejection(identity, row, owner, time) ||
            (row.binding.context !== undefined &&
              !ProContractRecognition.same(row.binding.context, row.context?.target)) ||
            !drivers.get(driverID(row.binding)) ||
            identity.admissionVersion !== (row.binding.admission?.version ?? 0) ||
            !isOpen(row) ||
            row.binding.pendingOutcome ||
            row.contract.status !== "active" ||
            row.contract.pendingRevision
          )
            return false
          const used = kind === "turn" ? row.binding.turnsUsed : row.binding.actionsUsed
          const limit = kind === "turn" ? row.contract.spec.budget.turns : row.contract.spec.budget.actions
          if (time >= row.contract.spec.budget.deadline || (limit !== undefined && used >= limit)) {
            yield* contracts.escalate({
              contractID: row.contract.id,
              revision: row.contract.revision,
              reason:
                time >= row.contract.spec.budget.deadline
                  ? "OpenCode deadline exhausted"
                  : `OpenCode ${kind} budget exhausted`,
              time,
            })
            return false
          }
          yield* save({ ...row.binding, ...(kind === "turn" ? { turnsUsed: used + 1 } : { actionsUsed: used + 1 }) })
          return true
        }),
      )
    })

    const create = Effect.fn("ProContractOpenCode.create")(function* (
      input: Parameters<Interface["create"]>[0] & { readonly driver?: string },
    ) {
      const binding: Binding = {
        ...input,
        driver: input.driver ?? ProContractDriver.native.identity,
        admission: {
          open: (input.driver ?? ProContractDriver.native.identity) === ProContractDriver.native.identity,
          version: 0,
        },
        sessionID: SessionSchema.ID.create(),
        promptID: SessionMessage.ID.create(),
        dispatched: false,
        attempts: 0,
        turnsUsed: 0,
        actionsUsed: 0,
        attemptKey: `${input.revision}:`,
      }
      yield* db
        .insert(ProContractOpenCodeTable)
        .values({ contract_id: binding.contractID, session_id: binding.sessionID, data: binding })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const stored = (yield* get(input.contractID)) ?? binding
      yield* remember(stored)
      return stored
    })

    return Service.of({
      owner,
      get,
      forSession,
      control,
      // Compatibility bootstrap is native-only. Host drivers must use atomic issue.
      create: (input) => atomic(create({ ...input, driver: ProContractDriver.native.identity })),
      authorize: Effect.fn("ProContractOpenCode.authorize")(function* (execution) {
        const result = yield* inspect(execution)
        if (result.reason || !result.contract)
          return yield* new Unauthorized({ message: result.reason ?? "Contract not found" })
        return result.contract
      }),
      dispatch: (execution, effect) =>
        activity.run(
          execution.contractID,
          Effect.gen(function* () {
            if ((yield* inspect(execution)).reason) return undefined
            return yield* effect
          }),
        ),
      admit: (execution, effect) =>
        atomic(
          Effect.gen(function* () {
            if ((yield* inspect(execution)).reason) return undefined
            return yield* effect
          }),
        ),
      issue: Effect.fn("ProContractOpenCode.issue")(function* (submitted) {
        const input = structuredClone(submitted)
        const driver = input.driver ?? ProContractDriver.native.identity
        return yield* atomic(
          Effect.gen(function* () {
            const receipt = yield* ProContract.withCommandGuard(
              contracts.issue({ id: input.id, scope: input.scope, spec: input.spec, executor: "opencode" }),
              () =>
                Effect.gen(function* () {
                  if (!drivers.get(driver)) return "Contract execution driver is unavailable"
                  const stored = yield* get(input.id)
                  if (
                    stored &&
                    (driverID(stored) !== driver ||
                      !ProContractRecognition.same(stored.location, input.location) ||
                      !ProContractRecognition.same(stored.model, input.model) ||
                      stored.executionPolicy !== input.executionPolicy)
                  )
                    return "contract execution binding does not match"
                  return undefined
                }),
            )
            if (receipt.decision.type === "rejected" || !receipt.contract) return receipt
            const binding = yield* create({
              contractID: receipt.contract.id,
              revision: receipt.contract.revision,
              location: input.location,
              model: input.model,
              executionPolicy: input.executionPolicy,
              driver,
              nextActionAt: input.spec.trigger.type === "time" ? input.spec.trigger.at : input.now,
            })
            return { ...receipt, execution: binding }
          }),
        )
      }),
      setAdmission: Effect.fn("ProContractOpenCode.setAdmission")(function* (submitted) {
        const input = structuredClone(submitted)
        return yield* atomic(
          Effect.gen(function* () {
            const row = yield* read(input.expected.contractID)
            const contract = yield* contracts.get(input.expected.contractID)
            if (
              !row ||
              !sameBinding(input.expected, row.binding) ||
              !ProContractRecognition.same(input.context, contract?.recognition.context?.target)
            )
              return { conflict: "Contract admission target is no longer current" }
            const now = yield* Clock.currentTimeMillis
            if (
              input.open &&
              (row.binding.dispatched ||
                activity.has(row.binding.contractID) ||
                (yield* jobActive(row.binding.contractID, now)) ||
                row.binding.pendingOutcome ||
                !drivers.get(driverID(row.binding)) ||
                !["active", "dormant"].includes(row.contract.status) ||
                row.contract.pendingRevision ||
                now >= row.contract.spec.budget.deadline)
            )
              return { conflict: "Contract admission cannot open while execution is in flight or unavailable" }
            if (
              (input.input?.once && input.session !== "preserve") ||
              (input.session === "preserve" &&
                (!input.open ||
                  row.binding.admission?.open !== false ||
                  row.binding.revision !== row.contract.revision ||
                  row.binding.attemptKey !== attemptKey(row.contract) ||
                  !ProContractRecognition.same(row.binding.context, input.context) ||
                  (input.input !== undefined &&
                    (!input.input.once ||
                      input.input.once.sessionID !== row.binding.sessionID ||
                      !ProContractRecognition.same(input.input.once.context, input.context)))))
            )
              return { conflict: "Preserved Session admission requires the same closed execution and input target" }
            const binding: Binding = {
              ...row.binding,
              admission: {
                open: input.open,
                version: (row.binding.admission?.version ?? 0) + 1,
                reason: input.reason,
                context: input.context,
                input: input.input,
                capabilities: input.session === "preserve" ? row.binding.admission?.capabilities : input.capabilities,
              },
              ...(input.open
                ? {
                    sessionID: input.session === "preserve" ? row.binding.sessionID : SessionSchema.ID.create(),
                    promptID: SessionMessage.ID.create(),
                    nextActionAt: now,
                  }
                : {}),
            }
            yield* save(binding)
            yield* remember(binding)
            return { binding }
          }),
        )
      }),
      activate: (contractID, revision, now) =>
        atomic(
          Effect.gen(function* () {
            const row = yield* read(contractID)
            const time = Math.max(now, yield* Clock.currentTimeMillis)
            if (!row || row.contract.revision !== revision || !isOpen(row) || row.binding.pendingOutcome) return
            const driver = drivers.get(driverID(row.binding))
            if (!driver || (yield* permit(row, driver, "activate", time)) !== true) return
            yield* contracts.activate(contractID, revision, time)
          }),
        ),
      claim: (contractID, now) =>
        atomic(
          Effect.gen(function* () {
            const row = yield* read(contractID)
            const time = Math.max(now, yield* Clock.currentTimeMillis)
            if (
              !row ||
              row.contract.status !== "active" ||
              row.contract.pendingRevision ||
              row.binding.pendingOutcome ||
              !isOpen(row)
            )
              return undefined
            const driver = drivers.get(driverID(row.binding))
            if (!driver || (yield* permit(row, driver, "claim", time)) !== true) return undefined
            if (
              activity.has(contractID) ||
              (yield* jobActive(contractID, time)) ||
              (row.binding.dispatched && (row.binding.leaseExpiresAt ?? 0) > time)
            )
              return undefined
            const key = attemptKey(row.contract)
            const attemptChanged =
              row.binding.attemptKey === undefined
                ? row.binding.revision !== row.contract.revision ||
                  row.contract.challenge?.disclosure === "executor" ||
                  row.contract.blocked !== undefined
                : row.binding.attemptKey !== key
            const leaseExpired = row.binding.dispatched && (row.binding.leaseExpiresAt ?? 0) <= time
            if (leaseExpired)
              yield* ProContractOperationAudit.expire(
                db,
                contractID,
                row.binding.leaseIdentity ?? ProContractRecognition.fingerprint({ root: execution(row.binding) }),
                time,
              )
            const newAttempt = row.binding.attempts === 0 || attemptChanged
            const rotate =
              row.binding.attempts > 0 &&
              (attemptChanged ||
                // Native admission may reopen after sweep retired a revoked lease.
                // Host drivers already rotate Sessions when explicitly reopening admission.
                (driver.identity === ProContractDriver.native.identity &&
                  row.binding.context !== undefined &&
                  !ProContractRecognition.same(row.binding.context, row.context?.target)) ||
                (leaseExpired && (row.binding.turnsUsed > 0 || row.binding.actionsUsed > 0)))
            if (!newAttempt && !rotate && row.binding.dispatched && !leaseExpired) return undefined
            if (!row.binding.dispatched && row.binding.nextActionAt > time) return undefined
            if (time >= row.contract.spec.budget.deadline) return undefined
            if (
              newAttempt &&
              row.contract.spec.resolution.maxAttempts !== undefined &&
              row.binding.attempts >= row.contract.spec.resolution.maxAttempts
            ) {
              yield* contracts.escalate({
                contractID,
                revision: row.contract.revision,
                reason: "OpenCode attempt budget exhausted",
                time,
              })
              return undefined
            }
            const leaseExpiresAt = Math.min(time + LEASE_MS, row.contract.spec.budget.deadline)
            const binding: Binding = {
              ...row.binding,
              revision: row.contract.revision,
              sessionID: rotate ? SessionSchema.ID.create() : row.binding.sessionID,
              promptID: rotate ? SessionMessage.ID.create() : row.binding.promptID,
              dispatched: true,
              attempts: row.binding.attempts + Number(newAttempt),
              nextActionAt: leaseExpiresAt,
              leaseOwner: owner,
              leaseExpiresAt,
              attemptKey: key,
              generation: (row.binding.generation ?? 0) + 1,
              context: row.context?.target,
            }
            const claimed = {
              ...binding,
              leaseIdentity: ProContractRecognition.fingerprint({ root: execution(binding) }),
            }
            yield* save(claimed)
            yield* remember(claimed)
            return claimed
          }),
        ),
      due: Effect.fn("ProContractOpenCode.due")(function* (now) {
        return (yield* rows().all().pipe(Effect.orDie))
          .filter(
            (row) =>
              row.contract.status === "active" &&
              !row.contract.pendingRevision &&
              !row.binding.pendingOutcome &&
              isOpen(row) &&
              drivers.get(driverID(row.binding)) &&
              (row.binding.revision !== row.contract.revision ||
                (row.contract.challenge?.disclosure === "executor" &&
                  row.binding.attemptKey !== attemptKey(row.contract)) ||
                row.binding.nextActionAt <= now),
          )
          .map((row) => row.binding)
      }),
      heartbeat: Effect.fn("ProContractOpenCode.heartbeat")(function* (sessionIDs, now) {
        yield* Effect.forEach(
          yield* rows().all().pipe(Effect.orDie),
          (observed) =>
            atomic(
              Effect.gen(function* () {
                const row = yield* read(observed.binding.contractID)
                const time = Math.max(now, yield* Clock.currentTimeMillis)
                if (
                  !row ||
                  !sameBinding(observed.binding, row.binding) ||
                  !row.binding.dispatched ||
                  row.binding.leaseOwner !== owner ||
                  (row.binding.leaseExpiresAt ?? 0) <= time ||
                  !sessionIDs.has(row.binding.sessionID) ||
                  row.binding.revision !== row.contract.revision ||
                  (row.binding.context !== undefined &&
                    !ProContractRecognition.same(row.binding.context, row.context?.target)) ||
                  row.contract.status !== "active" ||
                  row.contract.pendingRevision ||
                  row.binding.pendingOutcome ||
                  !isOpen(row) ||
                  time >= row.contract.spec.budget.deadline
                )
                  return
                const driver = drivers.get(driverID(row.binding))
                if (!driver || (yield* permit(row, driver, "heartbeat", time)) !== true) return
                const expires = Math.min(time + LEASE_MS, row.contract.spec.budget.deadline)
                yield* save({ ...row.binding, nextActionAt: expires, leaseExpiresAt: expires })
              }),
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Contract heartbeat failed", cause).pipe(
                  Effect.annotateLogs({ contractID: observed.binding.contractID }),
                ),
              ),
            ),
          { discard: true },
        )
      }),
      sweep: (sessionIDs, now) =>
        atomic(
          Effect.gen(function* () {
            const time = Math.max(now, yield* Clock.currentTimeMillis)
            const outstanding = yield* db
              .select({ data: ProContractTable.data })
              .from(ProContractTable)
              .all()
              .pipe(Effect.orDie)
            yield* Effect.forEach(
              outstanding.filter(
                ({ data }) => ["active", "dormant"].includes(data.status) && data.spec.budget.deadline <= time,
              ),
              ({ data }) =>
                contracts.escalate({
                  contractID: data.id,
                  revision: data.revision,
                  reason:
                    data.executor !== "opencode"
                      ? "External evaluation deadline exhausted while waiting"
                      : data.status === "dormant"
                        ? "OpenCode deadline exhausted while waiting"
                        : "OpenCode deadline exhausted",
                  time,
                }),
              { discard: true },
            )
            const interrupts: SessionSchema.ID[] = []
            yield* Effect.forEach(
              yield* rows().all().pipe(Effect.orDie),
              (row) =>
                Effect.gen(function* () {
                  if (!row.binding.dispatched) return
                  const unavailable = !drivers.get(driverID(row.binding)) || !isOpen(row)
                  const inactive =
                    (row.binding.context !== undefined &&
                      !ProContractRecognition.same(row.binding.context, row.context?.target)) ||
                    row.contract.status !== "active" ||
                    row.contract.pendingRevision !== undefined ||
                    row.binding.revision !== row.contract.revision
                  if (!unavailable && !inactive && !row.binding.pendingOutcome) return
                  if (row.binding.leaseOwner === owner && sessionIDs.has(row.binding.sessionID)) {
                    interrupts.push(row.binding.sessionID)
                    return
                  }
                  if (activity.has(row.binding.contractID)) return
                  if (row.binding.leaseOwner !== owner && (row.binding.leaseExpiresAt ?? 0) > time) return
                  if ((row.binding.leaseExpiresAt ?? 0) <= time)
                    yield* ProContractOperationAudit.expire(
                      db,
                      row.binding.contractID,
                      row.binding.leaseIdentity ?? ProContractRecognition.fingerprint({ root: execution(row.binding) }),
                      time,
                    )
                  if (inactive) {
                    yield* retire(row, time)
                    return
                  }
                  if (unavailable) {
                    yield* settle(
                      row,
                      { type: "wait" },
                      row.binding.admission?.reason ?? "Contract driver admission is unavailable",
                      time,
                    )
                    return
                  }
                  if (row.binding.pendingOutcome)
                    yield* settle(row, row.binding.pendingOutcome.decision, row.binding.pendingOutcome.reason, time)
                }),
              { discard: true },
            )
            return interrupts
          }),
        ),
      complete: (input) =>
        atomic(
          Effect.gen(function* () {
            const row = yield* read(input.execution.contractID)
            const now = Math.max(input.now, yield* Clock.currentTimeMillis)
            if (!row || identityRejection(input.execution, row, owner, now)) return
            if (
              row.contract.status !== "active" ||
              row.contract.pendingRevision ||
              (row.binding.context !== undefined &&
                !ProContractRecognition.same(row.binding.context, row.context?.target))
            ) {
              yield* retire(row, now)
              return
            }
            if (!isOpen(row)) {
              yield* settle(row, { type: "wait" }, row.binding.admission?.reason ?? input.outcome.reason, now)
              return
            }
            const driver = drivers.get(driverID(row.binding))
            if (!driver) return
            const decision =
              row.binding.pendingOutcome?.decision ??
              (yield* invoke(row, "outcome", () => outcomeDecision(driver, row, input.outcome, now)))
            if (!decision) return
            yield* settle(row, decision, row.binding.pendingOutcome?.reason ?? input.outcome.reason, now)
          }),
        ),
      reportBlocked: (identity, reason) =>
        atomic(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const receipt = yield* control(
              identity,
              contracts.reportBlocked({
                contractID: identity.contractID,
                revision: identity.revision,
                reason,
                time: now,
              }),
            )
            if (receipt.decision.type === "rejected") return receipt
            const row = yield* read(identity.contractID)
            const driver = row && drivers.get(driverID(row.binding))
            if (!row || !driver) return yield* Effect.die("Authorized Contract driver disappeared")
            const decision = yield* invoke(row, "blocked", () =>
              outcomeDecision(driver, row, { type: "blocked", reason }, now),
            )
            if (decision) yield* save({ ...row.binding, pendingOutcome: { decision, reason } })
            return receipt
          }),
        ),
      reserveTurn: (sessionID, now, execution) => reserve(sessionID, now, "turn", execution),
      reserveAction: (sessionID, now, execution) => reserve(sessionID, now, "action", execution),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, ProContract.node, ProContractDriver.node, ProContractActivity.node],
})

type Row = { binding: Binding; contract: ProContract.Contract; context: Schema.RecognitionContext | null }

function driverID(binding: Binding) {
  return binding.driver ?? ProContractDriver.native.identity
}

function isOpen(row: Row) {
  if (driverID(row.binding) === ProContractDriver.native.identity) return row.binding.admission?.open !== false
  return (
    row.binding.admission?.open === true &&
    row.binding.admission.context !== undefined &&
    row.context?.target.revision === row.contract.revision &&
    row.context.target.specHash === row.contract.specHash &&
    ProContractRecognition.same(row.binding.admission.context, row.context.target)
  )
}

function sameBinding(expected: Binding, current: Binding) {
  return (
    expected.contractID === current.contractID &&
    expected.revision === current.revision &&
    expected.sessionID === current.sessionID &&
    expected.promptID === current.promptID &&
    expected.leaseOwner === current.leaseOwner &&
    expected.dispatched === current.dispatched &&
    (expected.generation ?? 0) === (current.generation ?? 0) &&
    driverID(expected) === driverID(current) &&
    (expected.admission?.version ?? 0) === (current.admission?.version ?? 0)
  )
}

function outcomeDecision(
  driver: ProContractDriver.Driver,
  row: Row,
  outcome: ProContractDriver.Outcome,
  now: number,
): ProContractDriver.Decision {
  const decision = driver.outcome(structuredClone({ binding: row.binding, contract: row.contract, outcome, now }))
  if (decision?.type === "wait" || decision?.type === "escalate") return { type: decision.type }
  if (decision?.type === "retry" && (decision.attempt === "same" || decision.attempt === "new"))
    return { type: decision.type, attempt: decision.attempt }
  throw new Error("Contract driver returned an invalid lifecycle decision")
}

function identityRejection(execution: Execution, row: Row | undefined, owner: string, now: number) {
  if (
    !row ||
    row.binding.contractID !== execution.contractID ||
    row.binding.sessionID !== execution.sessionID ||
    row.binding.promptID !== execution.promptID ||
    row.binding.revision !== execution.revision ||
    row.contract.revision !== execution.revision ||
    (row.binding.generation ?? 0) !== execution.generation ||
    driverID(row.binding) !== execution.driver ||
    !ProContractRecognition.same(row.binding.context, execution.context) ||
    execution.owner !== owner ||
    row.binding.leaseOwner !== owner ||
    !row.binding.dispatched ||
    (row.binding.leaseExpiresAt ?? 0) <= now
  )
    return "OpenCode execution identity or lease is no longer current"
  return undefined
}

function executionRejection(
  execution: Execution,
  row: Row | undefined,
  owner: string,
  now: number,
  drivers: ProContractDriver.Interface,
) {
  const rejected = identityRejection(execution, row, owner, now)
  if (rejected || !row) return rejected ?? "OpenCode execution is unavailable"
  if (row.binding.context !== undefined && !ProContractRecognition.same(row.binding.context, row.context?.target))
    return "OpenCode execution identity or lease is no longer current"
  if (
    !drivers.get(driverID(row.binding)) ||
    !isOpen(row) ||
    row.binding.pendingOutcome ||
    execution.admissionVersion !== (row.binding.admission?.version ?? 0)
  )
    return "OpenCode driver admission is no longer current"
  if (row.contract.status !== "active" || row.contract.pendingRevision) return "Contract execution is not active"
  if (row.contract.spec.budget.deadline <= now) return "Contract deadline exhausted"
  return undefined
}
