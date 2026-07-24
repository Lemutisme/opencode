export * as ProContractOpenCode from "./open-code"

import { Location } from "@opencode-ai/schema/location"
import { Model } from "@opencode-ai/schema/model"
import { ProContract as Schema } from "@opencode-ai/schema/pro-contract"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ProContract } from "../pro-contract"
import { ProContractOpenCodeTable, ProContractTable } from "./sql"

export type Binding = {
  readonly contractID: Schema.ID
  readonly revision: number
  readonly location: Location.Ref
  readonly model: Model.Ref
  readonly sessionID: SessionSchema.ID
  readonly promptID: SessionMessage.ID
  readonly dispatched: boolean
  readonly attempts: number
  readonly nextActionAt: number
  readonly turnsUsed: number
  readonly actionsUsed: number
  readonly leaseOwner?: string
  readonly leaseExpiresAt?: number
  readonly attemptKey?: string
  readonly retiredSessionIDs?: ReadonlyArray<SessionSchema.ID>
}

export interface Interface {
  readonly owner: string
  readonly create: (input: {
    readonly contractID: Schema.ID
    readonly revision: number
    readonly location: Location.Ref
    readonly model: Model.Ref
    readonly nextActionAt: number
  }) => Effect.Effect<Binding>
  readonly claim: (contractID: Schema.ID, now: number) => Effect.Effect<Binding | undefined>
  readonly get: (contractID: Schema.ID) => Effect.Effect<Binding | undefined>
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<Binding | undefined>
  readonly due: (now: number) => Effect.Effect<ReadonlyArray<Binding>>
  readonly heartbeat: (sessionIDs: ReadonlySet<SessionSchema.ID>, now: number) => Effect.Effect<void>
  readonly reschedule: (input: {
    readonly contractID: Schema.ID
    readonly revision: number
    readonly promptID: SessionMessage.ID
    readonly reason: string
    readonly now: number
    readonly attempt: "same" | "new"
  }) => Effect.Effect<void>
  readonly reserveTurn: (sessionID: SessionSchema.ID, now: number) => Effect.Effect<boolean>
  readonly reserveAction: (sessionID: SessionSchema.ID, now: number) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractOpenCode") {}

const LEASE_MS = 30_000

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const contracts = yield* ProContract.Service
    const owner = crypto.randomUUID()

    const get = Effect.fn("ProContractOpenCode.get")(function* (contractID: Schema.ID) {
      return yield* db
        .select({ data: ProContractOpenCodeTable.data })
        .from(ProContractOpenCodeTable)
        .where(eq(ProContractOpenCodeTable.contract_id, contractID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row?.data),
        )
    })

    const forSession = Effect.fn("ProContractOpenCode.forSession")(function* (sessionID: SessionSchema.ID) {
      const current = yield* db
        .select({ data: ProContractOpenCodeTable.data })
        .from(ProContractOpenCodeTable)
        .where(eq(ProContractOpenCodeTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current) return current.data
      // Rotated Sessions stay reserved; otherwise their old IDs regain ordinary Session permissions.
      const retired = (yield* db
        .select({ data: ProContractOpenCodeTable.data })
        .from(ProContractOpenCodeTable)
        .all()
        .pipe(Effect.orDie)).find((row) => row.data.retiredSessionIDs?.includes(sessionID))
      if (!retired) return undefined
      return {
        ...retired.data,
        sessionID,
        dispatched: false,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
      }
    })

    const reserve = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, now: number, kind: "turn" | "action") {
      const binding = yield* forSession(sessionID)
      if (!binding) return true
      if (!binding.dispatched) return false
      const decision = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select({ binding: ProContractOpenCodeTable.data, contract: ProContractTable.data })
                .from(ProContractOpenCodeTable)
                .innerJoin(ProContractTable, eq(ProContractTable.id, ProContractOpenCodeTable.contract_id))
                .where(eq(ProContractOpenCodeTable.session_id, sessionID))
                .get()
                .pipe(Effect.orDie)
              if (!row) return { allowed: false }
              if (
                !row.binding.dispatched ||
                row.binding.leaseOwner !== owner ||
                (row.binding.leaseExpiresAt ?? 0) <= now ||
                row.binding.revision !== row.contract.revision ||
                row.contract.status !== "active" ||
                row.contract.escalation
              )
                return { allowed: false }
              if (now >= row.contract.spec.budget.deadline)
                return {
                  allowed: false,
                  escalation: {
                    contractID: row.contract.id,
                    revision: row.contract.revision,
                    reason: "OpenCode deadline exhausted",
                  },
                }
              const used = kind === "turn" ? row.binding.turnsUsed : row.binding.actionsUsed
              const limit = kind === "turn" ? row.contract.spec.budget.turns : row.contract.spec.budget.actions
              if (used >= limit)
                return {
                  allowed: false,
                  escalation: {
                    contractID: row.contract.id,
                    revision: row.contract.revision,
                    reason: `OpenCode ${kind} budget exhausted`,
                  },
                }
              yield* tx
                .update(ProContractOpenCodeTable)
                .set({
                  data: {
                    ...row.binding,
                    ...(kind === "turn"
                      ? { turnsUsed: row.binding.turnsUsed + 1 }
                      : { actionsUsed: row.binding.actionsUsed + 1 }),
                  },
                })
                .where(eq(ProContractOpenCodeTable.contract_id, row.binding.contractID))
                .run()
                .pipe(Effect.orDie)
              return { allowed: true }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (decision.escalation) yield* contracts.escalate({ ...decision.escalation, time: now })
      return decision.allowed
    })

    return Service.of({
      owner,
      create: Effect.fn("ProContractOpenCode.create")(function* (input) {
        const binding: Binding = {
          contractID: input.contractID,
          revision: input.revision,
          location: input.location,
          model: input.model,
          sessionID: SessionSchema.ID.create(),
          promptID: SessionMessage.ID.create(),
          dispatched: false,
          attempts: 0,
          nextActionAt: input.nextActionAt,
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
        return (yield* get(input.contractID)) ?? binding
      }),
      claim: Effect.fn("ProContractOpenCode.claim")(function* (contractID, now) {
        const result = yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const row = yield* tx
                  .select({ binding: ProContractOpenCodeTable.data, contract: ProContractTable.data })
                  .from(ProContractOpenCodeTable)
                  .innerJoin(ProContractTable, eq(ProContractTable.id, ProContractOpenCodeTable.contract_id))
                  .where(eq(ProContractOpenCodeTable.contract_id, contractID))
                  .get()
                  .pipe(Effect.orDie)
                if (!row || row.contract.status !== "active" || row.contract.escalation) return {}
                // Transport retries preserve this key; authoritative context changes replace the Session.
                const attemptKey = `${row.contract.revision}:${
                  row.contract.challenge?.disclosure === "executor"
                    ? `${row.contract.challenge.time}:${row.contract.challenge.evidenceHash}`
                    : ""
                }`
                const attemptChanged =
                  row.binding.attemptKey === undefined
                    ? row.binding.revision !== row.contract.revision ||
                      row.contract.challenge?.disclosure === "executor"
                    : row.binding.attemptKey !== attemptKey
                const newAttempt =
                  row.binding.attempts === 0 ||
                  attemptChanged ||
                  (row.binding.dispatched && (row.binding.leaseExpiresAt ?? 0) <= now)
                if (!newAttempt && row.binding.dispatched) return {}
                if (!newAttempt && row.binding.nextActionAt > now) return {}
                if (now >= row.contract.spec.budget.deadline) return {}
                if (newAttempt && row.binding.attempts >= row.contract.spec.resolution.maxAttempts)
                  return { exhausted: row.contract }
                const rotate = newAttempt && row.binding.attempts > 0
                const leaseExpiresAt = Math.min(now + LEASE_MS, row.contract.spec.budget.deadline)
                const next = {
                  ...row.binding,
                  revision: row.contract.revision,
                  sessionID: rotate ? SessionSchema.ID.create() : row.binding.sessionID,
                  promptID: rotate ? SessionMessage.ID.create() : row.binding.promptID,
                  dispatched: true,
                  attempts: row.binding.attempts + Number(newAttempt),
                  nextActionAt: leaseExpiresAt,
                  leaseOwner: owner,
                  leaseExpiresAt,
                  attemptKey,
                  retiredSessionIDs: rotate
                    ? [...(row.binding.retiredSessionIDs ?? []), row.binding.sessionID]
                    : row.binding.retiredSessionIDs,
                }
                yield* tx
                  .update(ProContractOpenCodeTable)
                  .set({ session_id: next.sessionID, data: next })
                  .where(eq(ProContractOpenCodeTable.contract_id, contractID))
                  .run()
                  .pipe(Effect.orDie)
                return { binding: next }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        if (result.exhausted)
          yield* contracts.escalate({
            contractID: result.exhausted.id,
            revision: result.exhausted.revision,
            reason: "OpenCode attempt budget exhausted",
            time: now,
          })
        return result.binding
      }),
      get,
      forSession,
      due: Effect.fn("ProContractOpenCode.due")(function* (now) {
        const rows = yield* db
          .select({ binding: ProContractOpenCodeTable.data, contract: ProContractTable.data })
          .from(ProContractOpenCodeTable)
          .innerJoin(ProContractTable, eq(ProContractTable.id, ProContractOpenCodeTable.contract_id))
          .all()
          .pipe(Effect.orDie)
        return rows
          .filter(
            (row) =>
              row.contract.status === "active" &&
              !row.contract.escalation &&
              (row.binding.revision !== row.contract.revision ||
                (row.contract.challenge?.disclosure === "executor" &&
                  row.binding.attemptKey !==
                    `${row.contract.revision}:${row.contract.challenge.time}:${row.contract.challenge.evidenceHash}`) ||
                row.binding.nextActionAt <= now),
          )
          .map((row) => row.binding)
      }),
      heartbeat: Effect.fn("ProContractOpenCode.heartbeat")(function* (sessionIDs, now) {
        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const rows = yield* tx
                  .select({ binding: ProContractOpenCodeTable.data, contract: ProContractTable.data })
                  .from(ProContractOpenCodeTable)
                  .innerJoin(ProContractTable, eq(ProContractTable.id, ProContractOpenCodeTable.contract_id))
                  .all()
                  .pipe(Effect.orDie)
                yield* Effect.forEach(
                  rows.filter(
                    (row) =>
                      row.binding.dispatched &&
                      row.binding.leaseOwner === owner &&
                      sessionIDs.has(row.binding.sessionID) &&
                      row.binding.revision === row.contract.revision &&
                      row.contract.status === "active" &&
                      !row.contract.escalation,
                  ),
                  (row) => {
                    const expires = Math.min(now + LEASE_MS, row.contract.spec.budget.deadline)
                    return tx
                      .update(ProContractOpenCodeTable)
                      .set({ data: { ...row.binding, nextActionAt: expires, leaseExpiresAt: expires } })
                      .where(eq(ProContractOpenCodeTable.contract_id, row.binding.contractID))
                      .run()
                      .pipe(Effect.orDie)
                  },
                  { discard: true },
                )
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      reschedule: Effect.fn("ProContractOpenCode.reschedule")(function* (input) {
        const escalation = yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const row = yield* tx
                  .select({ binding: ProContractOpenCodeTable.data, contract: ProContractTable.data })
                  .from(ProContractOpenCodeTable)
                  .innerJoin(ProContractTable, eq(ProContractTable.id, ProContractOpenCodeTable.contract_id))
                  .where(eq(ProContractOpenCodeTable.contract_id, input.contractID))
                  .get()
                  .pipe(Effect.orDie)
                if (
                  !row ||
                  row.contract.status !== "active" ||
                  row.contract.escalation ||
                  row.contract.revision !== input.revision ||
                  row.binding.revision !== input.revision ||
                  row.binding.promptID !== input.promptID ||
                  row.binding.leaseOwner !== owner ||
                  !row.binding.dispatched
                )
                  return undefined
                if (
                  (input.attempt === "new" && row.binding.attempts >= row.contract.spec.resolution.maxAttempts) ||
                  input.now >= row.contract.spec.budget.deadline
                )
                  return { contractID: row.contract.id, revision: row.contract.revision }
                yield* tx
                  .update(ProContractOpenCodeTable)
                  .set({
                    data: {
                      ...row.binding,
                      promptID: input.attempt === "same" ? SessionMessage.ID.create() : row.binding.promptID,
                      dispatched: false,
                      nextActionAt: input.now + row.contract.spec.resolution.retryDelay,
                      leaseOwner: undefined,
                      leaseExpiresAt: undefined,
                      attemptKey: input.attempt === "new" ? "" : row.binding.attemptKey,
                    },
                  })
                  .where(eq(ProContractOpenCodeTable.contract_id, input.contractID))
                  .run()
                  .pipe(Effect.orDie)
                return undefined
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        if (escalation) yield* contracts.escalate({ ...escalation, reason: input.reason, time: input.now })
      }),
      reserveTurn: (sessionID, now) => reserve(sessionID, now, "turn"),
      reserveAction: (sessionID, now) => reserve(sessionID, now, "action"),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, ProContract.node] })
