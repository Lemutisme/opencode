export * as ProContract from "./pro-contract"
export * from "./pro-contract/kernel"
export {
  Attestation,
  AttestationID,
  Blocked,
  Capability,
  Challenge,
  Evidence,
  ExecutionPolicyCoordinate,
  Handoff,
  ID,
  Info,
  Requirement,
  ReplayCheck,
  ReplayPolicy,
  ReplayResult,
  Spec,
  Status,
  SubjectCoordinate,
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
export type EvaluationReport = {
  readonly deliveryContractID: Schema.ID
  readonly deliveryRevision: number
  readonly subjectHash: string
  readonly claimHash: string
  readonly evaluatorHash: string
  readonly passed: boolean
  readonly defeatsClaim: boolean
  readonly disclosure: "executor" | "sealed"
  readonly summary: string
}

export interface Interface {
  readonly issue: (input: {
    readonly id?: Schema.ID
    readonly scope: string
    readonly spec: Schema.Spec
    readonly executor: string
  }) => Effect.Effect<IssueReceipt>
  readonly issueEvaluation: (input: {
    readonly deliveryContractID: Schema.ID
    readonly evaluatorHash: string
    readonly deadline: number
  }) => Effect.Effect<IssueReceipt>
  readonly settleEvaluation: (input: {
    readonly contractID: Schema.ID
    readonly report: EvaluationReport
    readonly evidenceHash: string
    readonly time: number
  }) => Effect.Effect<Receipt>
  readonly release: (input: {
    readonly contractID: Schema.ID
    readonly revision: number
    readonly specHash: string
    readonly reason: string
  }) => Effect.Effect<Receipt>
  readonly challenge: (input: {
    readonly contractID: Schema.ID
    readonly revision: number
    readonly specHash: string
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
  readonly resume: (input: {
    readonly contractID: Schema.ID
    readonly revision: number
    readonly specHash: string
  }) => Effect.Effect<Receipt>
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
    readonly revision: number
    readonly specHash: string
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

export function claimHash(spec: Schema.Spec) {
  return Hash.sha256(JSON.stringify(evidenceClaim(spec)))
}

export function evaluationID(deliveryContractID: Schema.ID, revision: number, evaluatorHash: string) {
  return Schema.ID.make(`pct_eval_${Hash.sha256(JSON.stringify([deliveryContractID, revision, evaluatorHash]))}`)
}

export function normalizeSpec(spec: Schema.Spec) {
  const canonical = ProContractKernel.canonicalSpec(spec)
  if (canonical.evidence.claim) return canonical
  return Schema.Spec.make({ ...canonical, evidence: { ...canonical.evidence, claim: canonical.goal } })
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

    const executeAll = Effect.fn("ProContract.executeAll")((commands: ReadonlyArray<ProContractKernel.Command>) =>
      db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              if (commands.length === 0) return yield* Effect.die("Atomic Contract transition is empty")
              const stored = yield* tx
                .select({ data: ProContractTable.data })
                .from(ProContractTable)
                .all()
                .pipe(Effect.orDie)
              const storedAttestations = yield* tx
                .select({ data: ProContractAttestationTable.data })
                .from(ProContractAttestationTable)
                .all()
                .pipe(Effect.orDie)
              const initial: ProContractKernel.State = {
                contracts: Object.fromEntries(stored.map((row) => [row.data.id, row.data])),
                attestations: Object.fromEntries(storedAttestations.map((row) => [row.data.id, row.data])),
              }
              const results = commands.reduce(
                (items, command) => [
                  ...items,
                  ProContractKernel.transition(items.at(-1)?.state ?? initial, command),
                ],
                [] as ProContractKernel.Result[],
              )
              const rejected = results.find((result) => result.decision.type === "rejected")
              if (commands.length > 1 && rejected?.decision.type === "rejected")
                return yield* Effect.die(`Atomic Contract transition rejected: ${rejected.decision.reason}`)
              const result = results.at(-1)
              if (!result) return yield* Effect.die("Atomic Contract transition produced no result")
              if (result.decision.type === "accepted")
                yield* Effect.forEach(
                  Object.values(result.state.contracts).filter(
                    (contract) => initial.contracts[contract.id] !== contract,
                  ),
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
              if (result.decision.type === "accepted")
                yield* Effect.forEach(
                  Object.values(result.state.attestations).filter(
                    (attestation) => initial.attestations[attestation.id] !== attestation,
                  ),
                  (attestation) =>
                    tx
                      .insert(ProContractAttestationTable)
                      .values({ id: attestation.id, contract_id: attestation.contractID, data: attestation })
                      .run()
                      .pipe(Effect.orDie),
                  { discard: true },
                )
              const head = yield* tx
                .select()
                .from(ProContractLedgerTable)
                .where(eq(ProContractLedgerTable.id, 1))
                .get()
                .pipe(Effect.orDie)
              const events = results.reduce(
                (items, current, index) => {
                  const previous = items.at(-1)?.hash ?? head?.head_hash ?? ZERO_HASH
                  const seq = (head?.head_seq ?? -1) + index + 1
                  const command = commands[index]
                  if (!command) return items
                  return [
                    ...items,
                    {
                      seq,
                      contract_id: command.type === "issue" ? command.draft.id : command.contractID,
                      command,
                      decision: current.decision,
                      previous_hash: previous,
                      hash: Hash.sha256(JSON.stringify([previous, seq, command, current.decision])),
                    },
                  ]
                },
                [] as Array<{
                  seq: number
                  contract_id: string
                  command: ProContractKernel.Command
                  decision: ProContractKernel.Decision
                  previous_hash: string
                  hash: string
                }>,
              )
              yield* Effect.forEach(
                events,
                (event) => tx.insert(ProContractEventTable).values(event).run().pipe(Effect.orDie),
                { discard: true },
              )
              const last = events.at(-1)
              if (!last) return yield* Effect.die("Atomic Contract transition produced no ledger event")
              yield* tx
                .insert(ProContractLedgerTable)
                .values({ id: 1, head_seq: last.seq, head_hash: last.hash })
                .onConflictDoUpdate({
                  target: ProContractLedgerTable.id,
                  set: { head_seq: last.seq, head_hash: last.hash },
                })
                .run()
                .pipe(Effect.orDie)
              return { ...result, frontier: last.seq, hash: last.hash }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie),
    )

    const execute = Effect.fn("ProContract.execute")((command: ProContractKernel.Command) => executeAll([command]))

    const dischargeCommand = (contract: ProContractKernel.Contract, evidenceHash: string) =>
      ({
        type: "discharge",
        actor: contract.issuer,
        contractID: contract.id,
        attestation: {
          id: Schema.AttestationID.create(),
          revision: contract.revision,
          specHash: contract.specHash,
          subjectHash: ProContractKernel.handoffSubject(contract)?.hash ?? "",
          evidenceHash,
          verifierID: contract.issuer,
          class: "principal",
        },
      }) as const

    const discharge = Effect.fnUntraced(function* (contract: ProContractKernel.Contract, evidenceHash: string) {
      return yield* execute(dischargeCommand(contract, evidenceHash))
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

    const issue = Effect.fn("ProContract.issue")(function* (input: {
      readonly id?: Schema.ID
      readonly scope: string
      readonly spec: Schema.Spec
      readonly executor: string
    }) {
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
    })

    return Service.of({
      issue,
      issueEvaluation: Effect.fn("ProContract.issueEvaluation")(function* (input) {
        const delivery = yield* get(input.deliveryContractID)
        if (!delivery) return yield* Effect.die(`Contract not found: ${input.deliveryContractID}`)
        if (!input.evaluatorHash) return yield* Effect.die("Evaluator hash is required")
        const id = evaluationID(delivery.id, delivery.revision, input.evaluatorHash)
        return yield* issue({
          id,
          scope: delivery.scope,
          executor: `external-evaluator:${input.evaluatorHash}`,
          spec: Schema.Spec.make({
            trigger: { type: "immediate" },
            goal: `Independently evaluate the exact handoff for: ${delivery.spec.goal}`,
            brief: `Evaluate ${delivery.id}@${delivery.revision} claim ${claimHash(delivery.spec)} with evaluator ${input.evaluatorHash}. Delivery evidence alone does not settle this obligation.`,
            requires: [{ contractID: delivery.id, revision: delivery.revision, relation: "subject" }],
            authority: [],
            budget: { turns: 1, actions: 1, deadline: input.deadline },
            evidence: {
              type: "principal",
              claim: `Evaluator ${input.evaluatorHash} produced an authentic report for the exact handoff from ${delivery.id}@${delivery.revision}.`,
            },
            resolution: { maxAttempts: 1, retryDelay: 0 },
          }),
        })
      }),
      settleEvaluation: Effect.fn("ProContract.settleEvaluation")(function* (input) {
        const evaluation = yield* get(input.contractID)
        if (!evaluation) return yield* Effect.die(`Contract not found: ${input.contractID}`)
        const report = input.report
        const expectedID = evaluationID(report.deliveryContractID, report.deliveryRevision, report.evaluatorHash)
        if (evaluation.id !== expectedID) return yield* Effect.die("Evaluation identity does not match report")
        if (evaluation.executor !== `external-evaluator:${report.evaluatorHash}`)
          return yield* Effect.die("Evaluator identity does not match Contract")
        if (
          evaluation.spec.requires.length !== 1 ||
          evaluation.spec.requires[0]?.contractID !== report.deliveryContractID ||
          evaluation.spec.requires[0]?.revision !== report.deliveryRevision ||
          evaluation.spec.requires[0]?.relation !== "subject"
        )
          return yield* Effect.die("Evaluation dependency does not match report")
        const delivery = yield* get(report.deliveryContractID)
        if (!delivery?.handoff || delivery.status !== "discharged" || !delivery.attestationID)
          return yield* Effect.die("Delivery Contract is not independently evidenced")
        if (report.claimHash !== claimHash(delivery.spec))
          return yield* Effect.die("Evaluation claim does not match delivery claim")
        if (report.passed && report.defeatsClaim)
          return yield* Effect.die("Passing evaluation cannot defeat the target claim")
        if (
          delivery.revision !== report.deliveryRevision ||
          ProContractKernel.handoffSubject(delivery)?.hash !== report.subjectHash
        )
          return yield* Effect.die("Evaluation subject does not match delivery handoff")

        const activated =
          evaluation.status === "dormant"
            ? yield* execute({
                type: "activate",
                actor: "institution",
                contractID: evaluation.id,
                revision: evaluation.revision,
                time: input.time,
              })
            : undefined
        if (activated?.decision.type === "rejected") return activated
        const current = activated?.state.contracts[evaluation.id] ?? evaluation
        const ready =
          current.status === "active"
            ? yield* execute({
                type: "report-ready",
                actor: "institution",
                contractID: current.id,
                revision: current.revision,
                summary:
                  report.disclosure === "sealed"
                    ? `External evaluator produced a sealed ${report.passed ? "passing" : "failing"} report`
                    : report.summary,
                uncertainties: [],
                subjectHash: report.subjectHash,
                time: input.time,
              })
            : undefined
        if (ready?.decision.type === "rejected") return ready
        const handedOff = ready?.state.contracts[current.id] ?? current
        if (!report.defeatsClaim) return yield* discharge(handedOff, input.evidenceHash)
        return yield* executeAll([
          dischargeCommand(handedOff, input.evidenceHash),
          {
            type: "challenge",
            actor: delivery.issuer,
            contractID: delivery.id,
            challenge: {
              revision: delivery.revision,
              specHash: delivery.specHash,
              subjectHash: report.subjectHash,
              evidenceHash: input.evidenceHash,
              disclosure: report.disclosure,
              summary: report.disclosure === "executor" ? report.summary : undefined,
              time: input.time,
            },
          },
        ])
      }),
      release: (input) => execute({ type: "release", actor: "local-owner", ...input }),
      challenge: (input) =>
        execute({
          type: "challenge",
          actor: "local-owner",
          contractID: input.contractID,
          challenge: {
            revision: input.revision,
            specHash: input.specHash,
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
      resume: (input) => execute({ type: "resume", actor: "local-owner", ...input }),
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
