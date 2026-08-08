export * as ProContract from "./pro-contract"
export * from "./pro-contract/kernel"
export {
  Attestation,
  AttestationID,
  Blocked,
  Capability,
  Challenge,
  Evidence,
  Handoff,
  ID,
  Info,
  Requirement,
  ReplayCheck,
  ReplayPolicy,
  ReplayResult,
  Spec,
  Status,
} from "@opencode-ai/schema/pro-contract"

import { ProContract as Schema } from "@opencode-ai/schema/pro-contract"
import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { ProContractKernel } from "./pro-contract/kernel"
import {
  ProContractAttestationTable,
  ProContractEventTable,
  ProContractLedgerTable,
  ProContractTable,
} from "./pro-contract/sql"
import { Hash } from "./util/hash"

const ZERO_HASH = "0".repeat(64)

export type Receipt = ProContractKernel.Result & { readonly frontier: number; readonly hash: string }
export type IssueReceipt = Receipt & { readonly contract?: ProContractKernel.Contract }
export type HistoryEntry = typeof ProContractEventTable.$inferSelect

export interface Interface {
  readonly issue: (input: {
    readonly id?: Schema.ID
    readonly scope: string
    readonly spec: Schema.Spec
    readonly executor: string
  }) => Effect.Effect<IssueReceipt>
  readonly release: (input: { readonly contractID: Schema.ID; readonly reason: string }) => Effect.Effect<Receipt>
  readonly challenge: (input: {
    readonly contractID: Schema.ID
    readonly revision: number
    readonly subjectHash: string
    readonly evidenceHash: string
    readonly disclosure: "executor" | "sealed"
    readonly summary?: string
    readonly time: number
  }) => Effect.Effect<Receipt>
  readonly reportReady: (input: {
    readonly contractID: Schema.ID
    readonly revision: number
    readonly summary: string
    readonly uncertainties: ReadonlyArray<string>
    readonly subjectHash: string
    readonly replay?: Schema.ReplayResult
    readonly time: number
  }) => Effect.Effect<Receipt>
  readonly reportBlocked: (input: {
    readonly contractID: Schema.ID
    readonly revision: number
    readonly reason: string
    readonly time: number
  }) => Effect.Effect<Receipt>
  readonly activate: (contractID: Schema.ID, revision: number, now: number) => Effect.Effect<Receipt>
  readonly resume: (contractID: Schema.ID) => Effect.Effect<Receipt>
  readonly escalate: (input: {
    readonly contractID: Schema.ID
    readonly revision: number
    readonly reason: string
    readonly time: number
  }) => Effect.Effect<Receipt>
  readonly petitionRevision: (input: {
    readonly contractID: Schema.ID
    readonly spec: Schema.Spec
    readonly reason: string
  }) => Effect.Effect<Receipt>
  readonly decideRevision: (input: {
    readonly contractID: Schema.ID
    readonly accept: boolean
  }) => Effect.Effect<Receipt>
  readonly principalAttest: (input: {
    readonly contractID: Schema.ID
    readonly evidenceHash: string
  }) => Effect.Effect<Receipt>
  readonly due: (now: number) => Effect.Effect<ReadonlyArray<ProContractKernel.Contract>>
  readonly get: (id: Schema.ID) => Effect.Effect<ProContractKernel.Contract | undefined>
  readonly getAttestation: (id: Schema.AttestationID) => Effect.Effect<Schema.Attestation | undefined>
  readonly list: (scope?: string) => Effect.Effect<ReadonlyArray<ProContractKernel.Contract>>
  readonly history: (input: {
    readonly contractID: Schema.ID
    readonly after?: number
  }) => Effect.Effect<ReadonlyArray<HistoryEntry>>
  readonly quiet: (scope: string) => Effect.Effect<{
    readonly scope: string
    readonly quiet: boolean
    readonly frontier: number
    readonly ledgerHash: string
    readonly stateHash: string
    readonly outstanding: ReadonlyArray<Schema.ID>
  }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContract") {}

export function evidenceClaim(spec: Schema.Spec) {
  return spec.evidence.claim ?? spec.goal
}

export function normalizeSpec(spec: Schema.Spec) {
  if (spec.evidence.claim) return spec
  return Schema.Spec.make({ ...spec, evidence: { ...spec.evidence, claim: spec.goal } })
}

export function defaultSpec(goal: string, now: number): Schema.Spec {
  return Schema.Spec.make({
    trigger: { type: "immediate" },
    goal,
    brief: "",
    requires: [],
    authority: ["filesystem.read"],
    budget: { turns: 4, actions: 32, deadline: now + 24 * 60 * 60 * 1_000 },
    evidence: { type: "principal", claim: goal },
    resolution: { maxAttempts: 3, retryDelay: 60_000 },
  })
}

export function info(contract: ProContractKernel.Contract): Schema.Info {
  return Schema.Info.make({
    id: contract.id,
    scope: contract.scope,
    spec: contract.spec,
    issuer: contract.issuer,
    revision: contract.revision,
    status: contract.status,
    specHash: contract.specHash,
    escalation: contract.escalation,
    blocked: contract.blocked,
    handoff: contract.handoff,
    challenge: contract.challenge,
    pendingRevision: contract.pendingRevision,
    attestationID: contract.attestationID,
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const execute = Effect.fn("ProContract.execute")((command: ProContractKernel.Command) =>
      db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const contractID = command.type === "issue" ? command.draft.id : command.contractID
              const stored = yield* tx
                .select({ data: ProContractTable.data })
                .from(ProContractTable)
                .all()
                .pipe(Effect.orDie)
              const attestationID = command.type === "discharge" ? command.attestation.id : undefined
              const attestation = attestationID
                ? yield* tx
                    .select({ data: ProContractAttestationTable.data })
                    .from(ProContractAttestationTable)
                    .where(eq(ProContractAttestationTable.id, attestationID))
                    .get()
                    .pipe(Effect.orDie)
                : undefined
              const result = ProContractKernel.transition(
                {
                  contracts: Object.fromEntries(stored.map((row) => [row.data.id, row.data])),
                  attestations: attestation ? { [attestation.data.id]: attestation.data } : {},
                },
                command,
              )
              const current = result.state.contracts[contractID]
              if (result.decision.type === "accepted" && current)
                yield* Effect.forEach(
                  command.type === "challenge" ? Object.values(result.state.contracts) : [current],
                  (current) =>
                    tx
                      .insert(ProContractTable)
                      .values({ id: current.id, scope: current.scope, status: current.status, data: current })
                      .onConflictDoUpdate({
                        target: ProContractTable.id,
                        set: { scope: current.scope, status: current.status, data: current },
                      })
                      .run()
                      .pipe(Effect.orDie),
                  { discard: true },
                )
              if (result.decision.type === "accepted" && command.type === "discharge") {
                const recorded = result.state.attestations[command.attestation.id]
                if (!recorded) return yield* Effect.die("Accepted attestation was not recorded")
                yield* tx
                  .insert(ProContractAttestationTable)
                  .values({ id: recorded.id, contract_id: recorded.contractID, data: recorded })
                  .run()
                  .pipe(Effect.orDie)
              }
              const head = yield* tx
                .select()
                .from(ProContractLedgerTable)
                .where(eq(ProContractLedgerTable.id, 1))
                .get()
                .pipe(Effect.orDie)
              const frontier = (head?.head_seq ?? -1) + 1
              const previous = head?.head_hash ?? ZERO_HASH
              const hash = Hash.sha256(JSON.stringify([previous, frontier, command, result.decision]))
              yield* tx
                .insert(ProContractEventTable)
                .values({
                  seq: frontier,
                  contract_id: contractID,
                  command,
                  decision: result.decision,
                  previous_hash: previous,
                  hash,
                })
                .run()
                .pipe(Effect.orDie)
              yield* tx
                .insert(ProContractLedgerTable)
                .values({ id: 1, head_seq: frontier, head_hash: hash })
                .onConflictDoUpdate({ target: ProContractLedgerTable.id, set: { head_seq: frontier, head_hash: hash } })
                .run()
                .pipe(Effect.orDie)
              return { ...result, frontier, hash }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie),
    )

    const discharge = Effect.fnUntraced(function* (contract: ProContractKernel.Contract, evidenceHash: string) {
      return yield* execute({
        type: "discharge",
        actor: contract.issuer,
        contractID: contract.id,
        attestation: {
          id: Schema.AttestationID.create(),
          revision: contract.revision,
          specHash: contract.specHash,
          subjectHash: contract.handoff?.subjectHash ?? "",
          evidenceHash,
          verifierID: contract.issuer,
          class: "principal",
        },
      })
    })

    const get = Effect.fn("ProContract.get")(function* (id: Schema.ID) {
      return yield* db
        .select({ data: ProContractTable.data })
        .from(ProContractTable)
        .where(eq(ProContractTable.id, id))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row?.data),
        )
    })

    return Service.of({
      issue: Effect.fn("ProContract.issue")(function* (input) {
        const id = input.id ?? Schema.ID.create()
        const spec = normalizeSpec(input.spec)
        const receipt = yield* execute({
          type: "issue",
          actor: "local-owner",
          draft: {
            id,
            scope: input.scope,
            spec,
            issuer: "local-owner",
            executor: input.executor,
            specHash: ProContractKernel.hashSpec(spec),
          },
        })
        if (receipt.decision.type === "rejected") return receipt
        const contract = receipt.state.contracts[id]
        if (!contract) return yield* Effect.die("Issued contract was not loaded")
        return { ...receipt, contract }
      }),
      release: (input) => execute({ type: "release", actor: "local-owner", ...input }),
      challenge: (input) =>
        execute({
          type: "challenge",
          actor: "local-owner",
          contractID: input.contractID,
          challenge: {
            revision: input.revision,
            subjectHash: input.subjectHash,
            evidenceHash: input.evidenceHash,
            disclosure: input.disclosure,
            summary: input.summary,
            time: input.time,
          },
        }),
      reportReady: (input) => execute({ type: "report-ready", actor: "institution", ...input }),
      reportBlocked: (input) => execute({ type: "report-blocked", actor: "institution", ...input }),
      activate: (contractID, revision, time) =>
        execute({ type: "activate", actor: "institution", contractID, revision, time }),
      resume: (contractID) => execute({ type: "resume", actor: "local-owner", contractID }),
      escalate: (input) => execute({ type: "escalate", actor: "institution", ...input }),
      petitionRevision: Effect.fn("ProContract.petitionRevision")(function* (input) {
        const contract = yield* get(input.contractID)
        if (!contract) return yield* Effect.die(`Contract not found: ${input.contractID}`)
        const spec = normalizeSpec(input.spec)
        return yield* execute({
          type: "petition-revision",
          actor: contract.executor,
          contractID: contract.id,
          spec,
          specHash: ProContractKernel.hashSpec(spec),
          reason: input.reason,
        })
      }),
      decideRevision: (input) => execute({ type: "decide-revision", actor: "local-owner", ...input }),
      principalAttest: Effect.fn("ProContract.principalAttest")(function* (input) {
        const contract = yield* get(input.contractID)
        if (!contract) return yield* Effect.die(`Contract not found: ${input.contractID}`)
        return yield* discharge(contract, input.evidenceHash)
      }),
      due: Effect.fn("ProContract.due")(function* (now) {
        const rows = yield* db.select({ data: ProContractTable.data }).from(ProContractTable).all().pipe(Effect.orDie)
        const state = {
          contracts: Object.fromEntries(rows.map((row) => [row.data.id, row.data])),
          attestations: {},
        }
        return rows
          .map((row) => row.data)
          .filter((contract) => {
            if (contract.status !== "dormant") return false
            if (contract.spec.budget.deadline <= now) return true
            return (
              ProContractKernel.transition(state, {
                type: "activate",
                actor: "institution",
                contractID: contract.id,
                revision: contract.revision,
                time: now,
              }).decision.type === "accepted"
            )
          })
      }),
      get,
      getAttestation: Effect.fn("ProContract.getAttestation")(function* (id) {
        return yield* db
          .select({ data: ProContractAttestationTable.data })
          .from(ProContractAttestationTable)
          .where(eq(ProContractAttestationTable.id, id))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => row?.data),
          )
      }),
      list: Effect.fn("ProContract.list")(function* (scope) {
        const query = db.select({ data: ProContractTable.data }).from(ProContractTable)
        const rows = yield* (scope ? query.where(eq(ProContractTable.scope, scope)).all() : query.all()).pipe(
          Effect.orDie,
        )
        return rows.map((row) => row.data)
      }),
      history: Effect.fn("ProContract.history")(function* (input) {
        const rows = yield* db
          .select()
          .from(ProContractEventTable)
          .where(eq(ProContractEventTable.contract_id, input.contractID))
          .orderBy(asc(ProContractEventTable.seq))
          .all()
          .pipe(Effect.orDie)
        if (input.after === undefined) return rows
        const after = input.after
        return rows.filter((row) => row.seq > after)
      }),
      quiet: Effect.fn("ProContract.quiet")(function* (scope) {
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const head = yield* tx
                  .select()
                  .from(ProContractLedgerTable)
                  .where(eq(ProContractLedgerTable.id, 1))
                  .get()
                  .pipe(Effect.orDie)
                const rows = yield* tx
                  .select({ id: ProContractTable.id, status: ProContractTable.status, data: ProContractTable.data })
                  .from(ProContractTable)
                  .where(eq(ProContractTable.scope, scope))
                  .orderBy(asc(ProContractTable.id))
                  .all()
                  .pipe(Effect.orDie)
                const outstanding = rows
                  .filter((row) => row.status !== "discharged" && row.status !== "released")
                  .map((row) => Schema.ID.make(row.id))
                return {
                  scope,
                  quiet: outstanding.length === 0,
                  frontier: head?.head_seq ?? -1,
                  ledgerHash: head?.head_hash ?? ZERO_HASH,
                  stateHash: Hash.sha256(JSON.stringify([scope, rows.map((row) => row.data)])),
                  outstanding,
                }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
