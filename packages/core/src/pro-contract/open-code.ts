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
import { ProContractOpenCodeSessionTable, ProContractOpenCodeTable, ProContractTable } from "./sql"

export type Binding = {
  readonly contractID: Schema.ID
  readonly revision: number
  readonly location: Location.Ref
  readonly model: Model.Ref
  readonly executionPolicy?: string
  readonly authorization?: Schema.ExecutionAuthorization
  readonly mode?: "reason"
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
}

export type IssueReceipt = Omit<ProContract.IssueReceipt, "event"> & {
  readonly event?: ProContract.IssueReceipt["event"]
  readonly execution?: Binding
}

export type Execution = { readonly binding: Binding; readonly contract: ProContract.Contract }

export interface Interface {
  readonly owner: string
  readonly issue: (input: {
    readonly id: Schema.ID
    readonly scope: string
    readonly spec: Schema.Spec
    readonly location: Location.Ref
    readonly model: Model.Ref
    readonly executionPolicy?: string
    readonly authorization?: Schema.ExecutionAuthorization
    readonly mode?: "reason"
    readonly now: number
  }) => Effect.Effect<IssueReceipt>
  readonly create: (input: {
    readonly contractID: Schema.ID
    readonly revision: number
    readonly location: Location.Ref
    readonly model: Model.Ref
    readonly executionPolicy?: string
    readonly authorization?: Schema.ExecutionAuthorization
    readonly mode?: "reason"
    readonly nextActionAt: number
  }) => Effect.Effect<Binding>
  readonly claim: (contractID: Schema.ID, now: number) => Effect.Effect<Binding | undefined>
  readonly get: (contractID: Schema.ID) => Effect.Effect<Binding | undefined>
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<Binding | undefined>
  /** Non-counting ownership check. Call inside the same transaction as any authoritative control mutation. */
  readonly current: (sessionID: SessionSchema.ID, now: number) => Effect.Effect<Execution | undefined>
  readonly due: (now: number) => Effect.Effect<ReadonlyArray<Binding>>
  readonly heartbeat: (sessionIDs: ReadonlySet<SessionSchema.ID>, now: number) => Effect.Effect<void>
  /** Withdraw execution only. Accepted results are governed by their own evidence, never their executor's grant. */
  readonly reconcile: (now: number) => Effect.Effect<ReadonlyArray<SessionSchema.ID>>
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

export function attemptKey(contract: ProContract.Contract) {
  const context =
    contract.challenge?.disclosure === "executor"
      ? contract.challenge.time + ":" + contract.challenge.evidenceHash
      : contract.blocked
        ? contract.blocked.time + ":" + contract.blocked.reason
        : ""
  return contract.revision + ":" + context
}

/** The caller must read the Contract and act on this check within one transaction. */
export function authorizationMatches(
  contract: ProContract.Contract | undefined,
  authorization: Schema.ExecutionAuthorization,
) {
  return (
    contract?.status === "discharged" &&
    !contract.pendingRevision &&
    contract.id === authorization.contractID &&
    contract.revision === authorization.revision &&
    contract.specHash === authorization.specHash &&
    contract.handoff?.subjectHash === authorization.subjectHash &&
    contract.attestationID === authorization.attestationID
  )
}

function sameAuthorization(a?: Schema.ExecutionAuthorization, b?: Schema.ExecutionAuthorization) {
  return (
    a?.contractID === b?.contractID &&
    a?.revision === b?.revision &&
    a?.specHash === b?.specHash &&
    a?.subjectHash === b?.subjectHash &&
    a?.attestationID === b?.attestationID
  )
}

export function sameBinding(
  binding: Binding,
  input: Pick<Binding, "location" | "model" | "executionPolicy" | "authorization" | "mode">,
) {
  return (
    binding.location.directory === input.location.directory &&
    binding.location.workspaceID === input.location.workspaceID &&
    binding.model.id === input.model.id &&
    binding.model.providerID === input.model.providerID &&
    (binding.model.variant ?? "default") === (input.model.variant ?? "default") &&
    binding.executionPolicy === input.executionPolicy &&
    binding.mode === input.mode &&
    sameAuthorization(binding.authorization, input.authorization)
  )
}

function ownsExecution(execution: Execution, owner: string, now: number) {
  const binding = execution.binding
  const contract = execution.contract
  return (
    binding.dispatched &&
    binding.leaseOwner === owner &&
    (binding.leaseExpiresAt ?? 0) > now &&
    binding.revision === contract.revision &&
    contract.status === "active" &&
    !contract.pendingRevision &&
    (binding.attemptKey === undefined
      ? contract.challenge?.disclosure !== "executor" && contract.blocked === undefined
      : binding.attemptKey === attemptKey(contract))
  )
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const contracts = yield* ProContract.Service
    const owner = crypto.randomUUID()

    const authorized = Effect.fn("ProContractOpenCode.authorized")(function* (
      authorization?: Schema.ExecutionAuthorization,
    ) {
      if (!authorization) return true
      return authorizationMatches(yield* contracts.get(authorization.contractID), authorization)
    })

    const withdraw = Effect.fn("ProContractOpenCode.withdraw")(function* (execution: Execution, now: number) {
      if (
        execution.contract.status === "discharged" ||
        execution.contract.status === "released" ||
        !execution.binding.authorization ||
        (yield* authorized(execution.binding.authorization))
      )
        return false
      if (execution.contract.status !== "escalated")
        yield* contracts.escalate({
          contractID: execution.contract.id,
          revision: execution.contract.revision,
          reason: `OpenCode execution authorization withdrawn: ${execution.binding.authorization.contractID}`,
          time: now,
        })
      return true
    })

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
              if (yield* withdraw(row, now)) return { allowed: false }
              if (!ownsExecution(row, owner, now)) return { allowed: false }
              // A native request ID denotes one observation, not a retryable provider loop. Additional
              // reasoning needs a new explicit request under the parent's unchanged deadline, not a larger cap.
              if (kind === "turn" && row.binding.mode === "reason" && row.binding.turnsUsed > 0)
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
              if (limit !== undefined && used >= limit)
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

    const create = Effect.fn("ProContractOpenCode.create")(function* (input: {
      readonly contractID: Schema.ID
      readonly revision: number
      readonly location: Location.Ref
      readonly model: Model.Ref
      readonly executionPolicy?: string
      readonly authorization?: Schema.ExecutionAuthorization
      readonly mode?: "reason"
      readonly nextActionAt: number
    }) {
      const request = structuredClone(input)
      return yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              const existing = yield* get(request.contractID)
              if (existing && !sameBinding(existing, request))
                return yield* Effect.die(new Error("OpenCode execution binding does not match"))
              if (!(yield* authorized(request.authorization)))
                return yield* Effect.die(new Error("OpenCode execution authorization is no longer current"))
              const binding: Binding = existing ?? {
                contractID: request.contractID,
                revision: request.revision,
                location: request.location,
                model: request.model,
                executionPolicy: request.executionPolicy,
                authorization: request.authorization,
                mode: request.mode,
                sessionID: SessionSchema.ID.create(),
                promptID: SessionMessage.ID.create(),
                dispatched: false,
                attempts: 0,
                nextActionAt: request.nextActionAt,
                turnsUsed: 0,
                actionsUsed: 0,
                attemptKey: `${request.revision}:`,
              }
              if (!existing)
                yield* db
                  .insert(ProContractOpenCodeTable)
                  .values({ contract_id: binding.contractID, session_id: binding.sessionID, data: binding })
                  .run()
                  .pipe(Effect.orDie)
              yield* db
                .insert(ProContractOpenCodeSessionTable)
                .values({ session_id: binding.sessionID, contract_id: binding.contractID })
                .onConflictDoNothing()
                .run()
                .pipe(Effect.orDie)
              return binding
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    return Service.of({
      owner,
      issue: Effect.fn("ProContractOpenCode.issue")(function* (input) {
        const request = structuredClone(input)
        // The duty, its execution binding, and the Session index are admitted as one durable unit.
        return yield* db
          .transaction(
            () =>
              Effect.gen(function* () {
                const existing = yield* get(request.id)
                const reason =
                  existing && !sameBinding(existing, request)
                    ? "OpenCode execution binding does not match"
                    : !(yield* authorized(request.authorization))
                      ? "OpenCode execution authorization is no longer current"
                      : undefined
                if (reason) {
                  const head = yield* contracts.quiet(request.scope)
                  // This is an adapter admission rejection, not a Kernel command; report the unchanged ledger head.
                  return {
                    decision: { type: "rejected" as const, reason },
                    state: {
                      contracts: Object.fromEntries(
                        (yield* contracts.list()).map((contract) => [contract.id, contract]),
                      ),
                      attestations: {},
                    },
                    frontier: head.frontier,
                    hash: head.ledgerHash,
                  }
                }
                const receipt = yield* contracts.issue({
                  id: request.id,
                  scope: request.scope,
                  spec: request.spec,
                  executor: "opencode",
                })
                if (receipt.decision.type === "rejected" || !receipt.contract) return receipt
                const execution = yield* create({
                  contractID: receipt.contract.id,
                  revision: receipt.contract.revision,
                  location: request.location,
                  model: request.model,
                  executionPolicy: request.executionPolicy,
                  authorization: request.authorization,
                  mode: request.mode,
                  nextActionAt: request.spec.trigger.type === "time" ? request.spec.trigger.at : request.now,
                })
                return { ...receipt, execution }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      create,
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
                if (!row || row.contract.status !== "active" || row.contract.pendingRevision) return {}
                if (yield* withdraw(row, now)) return {}
                // A native observation is explicitly owned by its host; never replay a started request.
                if (row.binding.mode === "reason" && row.binding.attempts > 0) return {}
                // Transport retries preserve this key; authoritative context changes replace the Session.
                const key = attemptKey(row.contract)
                const attemptChanged =
                  row.binding.attemptKey === undefined
                    ? row.binding.revision !== row.contract.revision ||
                      row.contract.challenge?.disclosure === "executor" ||
                      row.contract.blocked !== undefined
                    : row.binding.attemptKey !== key
                const leaseExpired = row.binding.dispatched && (row.binding.leaseExpiresAt ?? 0) <= now
                const newAttempt = row.binding.attempts === 0 || attemptChanged
                const rotate =
                  row.binding.attempts > 0 &&
                  (attemptChanged || (leaseExpired && (row.binding.turnsUsed > 0 || row.binding.actionsUsed > 0)))
                if (!newAttempt && !rotate && row.binding.dispatched && !leaseExpired) return {}
                if (!newAttempt && !rotate && row.binding.nextActionAt > now) return {}
                if (now >= row.contract.spec.budget.deadline) return {}
                if (newAttempt && row.binding.attempts >= row.contract.spec.resolution.maxAttempts)
                  return { exhausted: row.contract }
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
                  attemptKey: key,
                }
                yield* tx
                  .update(ProContractOpenCodeTable)
                  .set({ session_id: next.sessionID, data: next })
                  .where(eq(ProContractOpenCodeTable.contract_id, contractID))
                  .run()
                  .pipe(Effect.orDie)
                yield* tx
                  .insert(ProContractOpenCodeSessionTable)
                  .values({ session_id: next.sessionID, contract_id: next.contractID })
                  .onConflictDoNothing()
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
      current: Effect.fn("ProContractOpenCode.current")(function* (sessionID, now) {
        const row = yield* db
          .select({ binding: ProContractOpenCodeTable.data, contract: ProContractTable.data })
          .from(ProContractOpenCodeTable)
          .innerJoin(ProContractTable, eq(ProContractTable.id, ProContractOpenCodeTable.contract_id))
          .where(eq(ProContractOpenCodeTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        return row &&
          ownsExecution(row, owner, now) &&
          now < row.contract.spec.budget.deadline &&
          (yield* authorized(row.binding.authorization))
          ? row
          : undefined
      }),
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
              // Native requests are host-owned. The scheduler may only retire them at their original deadline.
              (row.binding.mode !== "reason" || now >= row.contract.spec.budget.deadline) &&
              !row.contract.pendingRevision &&
              (row.binding.revision !== row.contract.revision ||
                (row.contract.challenge?.disclosure === "executor" &&
                  row.binding.attemptKey !== attemptKey(row.contract)) ||
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
                      !row.contract.pendingRevision,
                  ),
                  (row) =>
                    Effect.gen(function* () {
                      if (yield* withdraw(row, now)) return
                      const expires = Math.min(now + LEASE_MS, row.contract.spec.budget.deadline)
                      yield* tx
                        .update(ProContractOpenCodeTable)
                        .set({ data: { ...row.binding, nextActionAt: expires, leaseExpiresAt: expires } })
                        .where(eq(ProContractOpenCodeTable.contract_id, row.binding.contractID))
                        .run()
                        .pipe(Effect.orDie)
                    }),
                  { discard: true },
                )
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      reconcile: Effect.fn("ProContractOpenCode.reconcile")(function* (now) {
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const rows = yield* tx
                  .select({ binding: ProContractOpenCodeTable.data, contract: ProContractTable.data })
                  .from(ProContractOpenCodeTable)
                  .innerJoin(ProContractTable, eq(ProContractTable.id, ProContractOpenCodeTable.contract_id))
                  .all()
                  .pipe(Effect.orDie)
                const withdrawn = yield* Effect.filter(rows, (row) => withdraw(row, now))
                return withdrawn.map((row) => row.binding.sessionID)
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
                  row.contract.revision !== input.revision ||
                  row.binding.revision !== input.revision ||
                  row.binding.promptID !== input.promptID ||
                  row.binding.leaseOwner !== owner ||
                  !row.binding.dispatched
                )
                  return undefined
                if (yield* withdraw(row, input.now)) return undefined
                if (row.binding.mode === "reason")
                  return {
                    contractID: row.contract.id,
                    revision: row.contract.revision,
                    reason: "Native reasoning interrupted; automatic replay is forbidden",
                  }
                if (row.contract.pendingRevision) {
                  yield* tx
                    .update(ProContractOpenCodeTable)
                    .set({
                      data: {
                        ...row.binding,
                        promptID: SessionMessage.ID.create(),
                        dispatched: false,
                        nextActionAt: input.now,
                        leaseOwner: undefined,
                        leaseExpiresAt: undefined,
                      },
                    })
                    .where(eq(ProContractOpenCodeTable.contract_id, input.contractID))
                    .run()
                    .pipe(Effect.orDie)
                  return undefined
                }
                if (
                  (input.attempt === "new" && row.binding.attempts >= row.contract.spec.resolution.maxAttempts) ||
                  input.now >= row.contract.spec.budget.deadline
                )
                  return {
                    contractID: row.contract.id,
                    revision: row.contract.revision,
                    reason:
                      input.now >= row.contract.spec.budget.deadline ? "OpenCode deadline exhausted" : input.reason,
                  }
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
        if (escalation) yield* contracts.escalate({ ...escalation, time: input.now })
      }),
      reserveTurn: (sessionID, now) => reserve(sessionID, now, "turn"),
      reserveAction: (sessionID, now) => reserve(sessionID, now, "action"),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, ProContract.node] })
