export * as ProContract from "./pro-contract"
export * from "./pro-contract/kernel"
export {
  Attestation,
  AttestationID,
  Blocked,
  Capability,
  Challenge,
  Evidence,
  EvaluationPlan,
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
import { formationFaultBarrier } from "./pro-contract/formation-fault"
import { ProContractKernel } from "./pro-contract/kernel"
import {
  ProContractAttestationTable,
  ProContractEventTable,
  ProContractFormationTable,
  ProContractLedgerTable,
  ProContractTable,
} from "./pro-contract/sql"
import { Hash } from "./util/hash"

const ZERO_HASH = "0".repeat(64)

export type Receipt = ProContractKernel.Result & { readonly frontier: number; readonly hash: string }
export type IssueReceipt = Receipt & { readonly contract?: ProContractKernel.Contract }
export type HistoryEntry = typeof ProContractEventTable.$inferSelect
export type IssueInput = {
  readonly id: Schema.ID
  readonly scope: string
  readonly spec: Schema.Spec
  readonly executor: string
}
export type FormationReceipt = {
  readonly formationHash: string
  readonly contextHash: string
  readonly rootContractID: Schema.ID
  readonly components: ReadonlyArray<{ readonly contractID: Schema.ID; readonly specHash: string }>
  readonly frontier: number
  readonly ledgerHash: string
}
export type FormationResult = {
  readonly formationHash: string
  readonly decision: ProContractKernel.Decision
  readonly formation?: FormationReceipt
  readonly contracts: ReadonlyArray<ProContractKernel.Contract>
  readonly frontier: number
  readonly hash: string
}
export type EvaluationReport = {
  readonly deliveryContractID: Schema.ID
  readonly deliveryRevision: number
  readonly subjectHash: string
  readonly evaluatorHash: string
  readonly passed: boolean
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
  readonly form: (input: {
    readonly contextHash: string
    readonly issues: readonly [IssueInput, ...IssueInput[]]
  }) => Effect.Effect<FormationResult>
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

export function evaluationID(deliveryContractID: Schema.ID, revision: number, evaluatorHash: string) {
  return Schema.ID.make(`pct_eval_${Hash.sha256(JSON.stringify([deliveryContractID, revision, evaluatorHash]))}`)
}

export function evaluationSpec(input: {
  readonly deliveryContractID: Schema.ID
  readonly deliveryRevision: number
  readonly deliveryGoal: string
  readonly evaluatorHash: string
  readonly deadline: number
}) {
  return Schema.Spec.make({
    trigger: { type: "immediate" },
    goal: `Independently evaluate the exact handoff for: ${input.deliveryGoal}`,
    brief: `Evaluate ${input.deliveryContractID}@${input.deliveryRevision} with evaluator ${input.evaluatorHash}. Delivery evidence alone does not settle this obligation.`,
    requires: [{ contractID: input.deliveryContractID, revision: input.deliveryRevision }],
    authority: [],
    budget: { turns: 1, actions: 1, deadline: input.deadline },
    evidence: {
      type: "principal",
      claim: `Evaluator ${input.evaluatorHash} accepted the exact handoff from ${input.deliveryContractID}@${input.deliveryRevision}.`,
    },
    resolution: { maxAttempts: 1, retryDelay: 0 },
  })
}

export function hashFormation(input: {
  readonly contextHash: string
  readonly components: FormationReceipt["components"]
}) {
  return Hash.sha256(JSON.stringify({ version: 1, contextHash: input.contextHash, components: input.components }))
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

// Adapter-profile failures stay transactional and audited without becoming authority-changing kernel semantics.
function issueProfileRejection(state: ProContractKernel.State, draft: ProContractKernel.Draft) {
  const replay = draft.spec.evidence.replay
  if (replay && replay.checks.length === 0 && replay.protected.length === 0 && replay.artifacts.length === 0)
    return "replay policy is empty"
  if (replay?.checks.some((check) => check.argv.length === 0)) return "replay check command is empty"
  const policies = draft.spec.requires.filter((requirement) => requirement.policy)
  if (policies.length > 1) return "contract may require only one execution policy"
  const requirement = policies[0]
  if (!requirement) return
  const dependency = state.contracts[requirement.contractID]
  if (!dependency) return
  if (!dependency.spec.policy) return "required contract defines no execution policy"
  if (dependency.status !== "discharged" || !dependency.attestationID) return "execution policy is not evidenced"
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const transact = Effect.fn("ProContract.transact")(function* (input: {
      readonly commands: readonly [ProContractKernel.Command, ...ProContractKernel.Command[]]
      readonly formation?: {
        readonly formationHash: string
        readonly contextHash: string
        readonly rootContractID: Schema.ID
        readonly components: FormationReceipt["components"]
      }
    }) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const stored = yield* tx
                .select({ data: ProContractTable.data })
                .from(ProContractTable)
                .all()
                .pipe(Effect.orDie)
              const attestations = yield* Effect.forEach(
                input.commands.flatMap((command) => (command.type === "discharge" ? [command.attestation.id] : [])),
                (id) =>
                  tx
                    .select({ data: ProContractAttestationTable.data })
                    .from(ProContractAttestationTable)
                    .where(eq(ProContractAttestationTable.id, id))
                    .get()
                    .pipe(Effect.orDie),
              )
              const state = {
                contracts: Object.fromEntries(stored.map((row) => [row.data.id, row.data])),
                attestations: Object.fromEntries(
                  attestations.flatMap((row) => (row ? [[row.data.id, row.data] as const] : [])),
                ),
              }
              const exact = input.formation
                ? yield* tx
                    .select({ data: ProContractFormationTable.data })
                    .from(ProContractFormationTable)
                    .where(eq(ProContractFormationTable.hash, input.formation.formationHash))
                    .get()
                    .pipe(Effect.orDie)
                : undefined
              if (exact && JSON.stringify(exact.data.components) === JSON.stringify(input.formation?.components))
                return {
                  state,
                  results: [] as ProContractKernel.Result[],
                  formation: exact.data,
                  frontier: exact.data.frontier,
                  hash: exact.data.ledgerHash,
                }
              const root = input.formation
                ? yield* tx
                    .select({ data: ProContractFormationTable.data })
                    .from(ProContractFormationTable)
                    .where(eq(ProContractFormationTable.root_contract_id, input.formation.rootContractID))
                    .get()
                    .pipe(Effect.orDie)
                : undefined
              const applied = input.commands.reduce(
                (current, command) => {
                  const reason =
                    command.type === "issue" ? issueProfileRejection(current.state, command.draft) : undefined
                  const decision = reason ? { type: "rejected" as const, reason } : undefined
                  const result = decision
                    ? { state: current.state, decision, event: { command, decision } }
                    : ProContractKernel.transition(current.state, command)
                  return { state: result.state, results: [...current.results, result] }
                },
                { state, results: [] as ProContractKernel.Result[] },
              )
              const rejected = applied.results.find((result) => result.decision.type === "rejected")
              const outside = input.formation?.components.find((component) => state.contracts[component.contractID])
              const failure = exact
                ? "formation hash does not match its components"
                : root
                  ? `contract belongs to formation ${root.data.formationHash}`
                  : outside
                    ? `component exists outside formation: ${outside.contractID}`
                    : rejected?.decision.type === "rejected"
                      ? rejected.decision.reason
                      : undefined
              const results =
                input.formation && failure
                  ? input.commands.map((command) => {
                      const decision = {
                        type: "rejected" as const,
                        reason: `formation ${input.formation?.formationHash} rejected: ${failure}`,
                      }
                      return { state, decision, event: { command, decision } }
                    })
                  : applied.results
              const next = input.formation && failure ? state : applied.state
              if (!failure || !input.formation) {
                const changed = input.commands.some(
                  (command, index) => command.type === "challenge" && results[index]?.decision.type === "accepted",
                )
                  ? Object.values(next.contracts)
                  : input.commands.flatMap((command, index) => {
                      if (results[index]?.decision.type !== "accepted") return []
                      const id = command.type === "issue" ? command.draft.id : command.contractID
                      const contract = next.contracts[id]
                      return contract ? [contract] : []
                    })
                yield* Effect.forEach(
                  changed,
                  (contract) =>
                    tx
                      .insert(ProContractTable)
                      .values({ id: contract.id, scope: contract.scope, status: contract.status, data: contract })
                      .onConflictDoUpdate({
                        target: ProContractTable.id,
                        set: { scope: contract.scope, status: contract.status, data: contract },
                      })
                      .run()
                      .pipe(Effect.orDie),
                  { discard: true },
                )
                yield* Effect.forEach(
                  input.commands.flatMap((command, index) => {
                    if (command.type !== "discharge" || results[index]?.decision.type !== "accepted") return []
                    const recorded = next.attestations[command.attestation.id]
                    return recorded ? [recorded] : []
                  }),
                  (attestation) =>
                    tx
                      .insert(ProContractAttestationTable)
                      .values({ id: attestation.id, contract_id: attestation.contractID, data: attestation })
                      .run()
                      .pipe(Effect.orDie),
                  { discard: true },
                )
              }
              const head = yield* tx
                .select()
                .from(ProContractLedgerTable)
                .where(eq(ProContractLedgerTable.id, 1))
                .get()
                .pipe(Effect.orDie)
              const events = results.reduce<
                Array<{
                  seq: number
                  contractID: Schema.ID
                  command: ProContractKernel.Command
                  decision: ProContractKernel.Decision
                  previous: string
                  hash: string
                }>
              >((events, result, index) => {
                const seq = (head?.head_seq ?? -1) + index + 1
                const previous = events.at(-1)?.hash ?? head?.head_hash ?? ZERO_HASH
                const hash = Hash.sha256(JSON.stringify([previous, seq, result.event.command, result.decision]))
                const command = result.event.command
                return [
                  ...events,
                  {
                    seq,
                    contractID: command.type === "issue" ? command.draft.id : command.contractID,
                    command,
                    decision: result.decision,
                    previous,
                    hash,
                  },
                ]
              }, [])
              yield* Effect.forEach(
                events,
                (event) =>
                  tx
                    .insert(ProContractEventTable)
                    .values({
                      seq: event.seq,
                      contract_id: event.contractID,
                      command: event.command,
                      decision: event.decision,
                      previous_hash: event.previous,
                      hash: event.hash,
                    })
                    .run()
                    .pipe(Effect.orDie),
                { discard: true },
              )
              const last = events.at(-1)
              if (!last) return yield* Effect.die("Contract transaction produced no ledger event")
              yield* tx
                .insert(ProContractLedgerTable)
                .values({ id: 1, head_seq: last.seq, head_hash: last.hash })
                .onConflictDoUpdate({
                  target: ProContractLedgerTable.id,
                  set: { head_seq: last.seq, head_hash: last.hash },
                })
                .run()
                .pipe(Effect.orDie)
              const formation =
                input.formation && !failure
                  ? {
                      ...input.formation,
                      frontier: last.seq,
                      ledgerHash: last.hash,
                    }
                  : undefined
              if (formation)
                yield* tx
                  .insert(ProContractFormationTable)
                  .values({
                    hash: formation.formationHash,
                    root_contract_id: formation.rootContractID,
                    data: formation,
                  })
                  .run()
                  .pipe(Effect.orDie)
              if (formation) yield* formationFaultBarrier("before_commit")
              return { state: next, results, formation, frontier: last.seq, hash: last.hash }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const execute = Effect.fn("ProContract.execute")(function* (command: ProContractKernel.Command) {
      const transaction = yield* transact({ commands: [command] })
      const result = transaction.results[0]
      if (!result) return yield* Effect.die("Contract transaction produced no decision")
      return { ...result, frontier: transaction.frontier, hash: transaction.hash }
    })

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

    const form = Effect.fn("ProContract.form")(function* (input: {
      readonly contextHash: string
      readonly issues: readonly [IssueInput, ...IssueInput[]]
    }) {
      const issues = input.issues.map((item) => ({ ...item, spec: normalizeSpec(item.spec) }))
      const commands = issues.map(
        (item) =>
          ({
            type: "issue",
            actor: "local-owner",
            draft: {
              ...item,
              issuer: "local-owner",
              specHash: ProContractKernel.hashSpec(item.spec),
            },
          }) as const,
      )
      const command = commands[0]
      if (!command) return yield* Effect.die("Formation requires at least one Contract")
      const components = commands.map((item) => ({
        contractID: item.draft.id,
        specHash: item.draft.specHash,
      }))
      const formationHash = hashFormation({ contextHash: input.contextHash, components })
      const transaction = yield* transact({
        commands: [command, ...commands.slice(1)],
        formation: {
          formationHash,
          contextHash: input.contextHash,
          rootContractID: command.draft.id,
          components,
        },
      })
      const decision = transaction.formation
        ? { type: "accepted" as const }
        : (transaction.results[0]?.decision ?? { type: "rejected" as const, reason: "formation was not decided" })
      return {
        formationHash,
        decision,
        formation: transaction.formation,
        contracts:
          decision.type === "accepted"
            ? components.flatMap((item) => {
                const contract = transaction.state.contracts[item.contractID]
                return contract ? [contract] : []
              })
            : [],
        frontier: transaction.frontier,
        hash: transaction.hash,
      }
    })

    return Service.of({
      issue,
      form,
      issueEvaluation: Effect.fn("ProContract.issueEvaluation")(function* (input) {
        const delivery = yield* get(input.deliveryContractID)
        if (!delivery) return yield* Effect.die(`Contract not found: ${input.deliveryContractID}`)
        if (!input.evaluatorHash) return yield* Effect.die("Evaluator hash is required")
        const id = evaluationID(delivery.id, delivery.revision, input.evaluatorHash)
        return yield* issue({
          id,
          scope: delivery.scope,
          executor: `external-evaluator:${input.evaluatorHash}`,
          spec: evaluationSpec({
            deliveryContractID: delivery.id,
            deliveryRevision: delivery.revision,
            deliveryGoal: delivery.spec.goal,
            evaluatorHash: input.evaluatorHash,
            deadline: input.deadline,
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
          evaluation.spec.requires[0]?.revision !== report.deliveryRevision
        )
          return yield* Effect.die("Evaluation dependency does not match report")
        const delivery = yield* get(report.deliveryContractID)
        if (!delivery?.handoff || delivery.status !== "discharged" || !delivery.attestationID)
          return yield* Effect.die("Delivery Contract is not independently evidenced")
        if (delivery.revision !== report.deliveryRevision || delivery.handoff.subjectHash !== report.subjectHash)
          return yield* Effect.die("Evaluation subject does not match delivery handoff")

        if (!report.passed)
          return yield* execute({
            type: "challenge",
            actor: delivery.issuer,
            contractID: delivery.id,
            challenge: {
              revision: delivery.revision,
              subjectHash: report.subjectHash,
              evidenceHash: input.evidenceHash,
              disclosure: report.disclosure,
              summary: report.disclosure === "executor" ? report.summary : undefined,
              time: input.time,
            },
          })

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
                  report.disclosure === "sealed" ? "External evaluator accepted sealed evidence" : report.summary,
                uncertainties: [],
                subjectHash: report.subjectHash,
                time: input.time,
              })
            : undefined
        if (ready?.decision.type === "rejected") return ready
        const handedOff = ready?.state.contracts[current.id] ?? current
        return yield* discharge(handedOff, input.evidenceHash)
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
