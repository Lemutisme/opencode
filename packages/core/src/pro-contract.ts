export * as ProContract from "./pro-contract"
export * from "./pro-contract/kernel"
export {
  Attestation,
  AttestationID,
  ContextTarget,
  EvaluationReport,
  OperationReceipt,
  Recognition,
  RecognitionContext,
  RecognitionTarget,
  RevisionTarget,
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

import { ProContract } from "@opencode-ai/schema/pro-contract"
import { and, asc, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { ProContractKernel } from "./pro-contract/kernel"
import {
  ProContractAttemptTable,
  ProContractContextTable,
  ProContractOperationTable,
  ProContractAttestationTable,
  ProContractEventTable,
  ProContractLedgerTable,
  ProContractTable,
} from "./pro-contract/sql"
import { ProContractRecognition } from "./pro-contract/recognition"
import { Hash } from "./util/hash"

const ZERO_HASH = "0".repeat(64)

export type Receipt = ProContractKernel.Result & { readonly frontier: number; readonly hash: string }
export type IssueReceipt = Receipt & { readonly contract?: ContractView }
export type HistoryEntry = typeof ProContractEventTable.$inferSelect
export type ContractView = ProContractRecognition.View
export { Validators } from "./pro-contract/recognition"

export interface Interface {
  readonly issue: (input: {
    readonly id?: ProContract.ID
    readonly scope: string
    readonly spec: ProContract.Spec
    readonly executor: string
  }) => Effect.Effect<IssueReceipt>
  readonly issueEvaluation: (input: {
    readonly deliveryContractID: ProContract.ID
    readonly evaluatorHash: string
    readonly deadline: number
  }) => Effect.Effect<IssueReceipt>
  readonly settleEvaluation: (input: {
    readonly contractID: ProContract.ID
    readonly report: ProContract.EvaluationReport
    readonly operationID: string
    readonly evidenceHash: string
    readonly time: number
  }) => Effect.Effect<ProContract.OperationReceipt>
  readonly release: (input: { readonly contractID: ProContract.ID; readonly reason: string }) => Effect.Effect<Receipt>
  readonly challenge: (input: {
    readonly contractID: ProContract.ID
    readonly expected: ProContract.RecognitionTarget
    readonly operationID: string
    readonly evidenceHash: string
    readonly disclosure: "executor" | "sealed"
    readonly summary?: string
    readonly time: number
  }) => Effect.Effect<ProContract.OperationReceipt>
  readonly reportReady: (input: {
    readonly contractID: ProContract.ID
    readonly revision: number
    readonly summary: string
    readonly uncertainties: ReadonlyArray<string>
    readonly subjectHash: string
    readonly replay?: ProContract.ReplayResult
    readonly time: number
  }) => Effect.Effect<Receipt>
  readonly reportBlocked: (input: {
    readonly contractID: ProContract.ID
    readonly revision: number
    readonly reason: string
    readonly time: number
  }) => Effect.Effect<Receipt>
  readonly activate: (contractID: ProContract.ID, revision: number, now: number) => Effect.Effect<Receipt>
  readonly resume: (contractID: ProContract.ID) => Effect.Effect<Receipt>
  readonly escalate: (input: {
    readonly contractID: ProContract.ID
    readonly revision: number
    readonly reason: string
    readonly time: number
  }) => Effect.Effect<Receipt>
  readonly petitionRevision: (input: {
    readonly contractID: ProContract.ID
    readonly spec: ProContract.Spec
    readonly reason: string
  }) => Effect.Effect<Receipt>
  readonly decideRevision: (input: {
    readonly contractID: ProContract.ID
    readonly accept: boolean
    readonly expected: ProContract.RevisionTarget
    readonly operationID: string
  }) => Effect.Effect<ProContract.OperationReceipt>
  readonly principalAttest: (input: {
    readonly contractID: ProContract.ID
    readonly evidenceHash: string
    readonly expected: ProContract.RecognitionTarget
    readonly operationID: string
  }) => Effect.Effect<ProContract.OperationReceipt>
  readonly setRecognitionContext: (input: {
    readonly contractID: ProContract.ID
    readonly expected: ProContract.ContextTarget
    readonly profile: string
    readonly referenceHash: string
    readonly admitted: boolean
  }) => Effect.Effect<{ readonly context?: ProContract.RecognitionContext; readonly conflict?: string }>
  readonly due: (now: number) => Effect.Effect<ReadonlyArray<ProContractKernel.Contract>>
  readonly get: (id: ProContract.ID) => Effect.Effect<ContractView | undefined>
  readonly getAttestation: (id: ProContract.AttestationID) => Effect.Effect<ProContract.Attestation | undefined>
  readonly list: (scope?: string) => Effect.Effect<ReadonlyArray<ContractView>>
  readonly history: (input: {
    readonly contractID: ProContract.ID
    readonly after?: number
  }) => Effect.Effect<ReadonlyArray<HistoryEntry>>
  readonly quiet: (scope: string) => Effect.Effect<{
    readonly scope: string
    readonly quiet: boolean
    readonly frontier: number
    readonly ledgerHash: string
    readonly stateHash: string
    readonly outstanding: ReadonlyArray<ProContract.ID>
  }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContract") {}

// Trusted adapter checks run inside the same transaction as the command and its ledger entry.
const CommandGuard = Context.Reference<
  ((command: ProContractKernel.Command) => Effect.Effect<string | undefined>) | undefined
>("@opencode/ProContract/CommandGuard", { defaultValue: () => undefined })

export function withCommandGuard<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  check: (command: ProContractKernel.Command) => Effect.Effect<string | undefined>,
) {
  return Effect.gen(function* () {
    const parent = yield* CommandGuard
    return yield* effect.pipe(
      Effect.provideService(CommandGuard, (command) =>
        Effect.gen(function* () {
          const rejected = parent ? yield* parent(command) : undefined
          return rejected ?? (yield* check(command))
        }),
      ),
    )
  })
}

export function evidenceClaim(spec: ProContract.Spec) {
  return spec.evidence.claim ?? spec.goal
}

export function evaluationID(deliveryContractID: ProContract.ID, revision: number, evaluatorHash: string) {
  return ProContract.ID.make(`pct_eval_${Hash.sha256(JSON.stringify([deliveryContractID, revision, evaluatorHash]))}`)
}

export function normalizeSpec(spec: ProContract.Spec) {
  const canonical = ProContractKernel.canonicalSpec(spec)
  if (canonical.evidence.claim) return canonical
  return ProContract.Spec.make({ ...canonical, evidence: { ...canonical.evidence, claim: canonical.goal } })
}

export function defaultSpec(goal: string, now: number): ProContract.Spec {
  return ProContract.Spec.make({
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

export function info(
  contract: ProContractKernel.Contract & { readonly recognition?: ProContract.Recognition },
): ProContract.Info {
  return ProContract.Info.make({
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
    recognition: contract.recognition,
  })
}

const RecognitionAuthority = Context.Reference<
  ((command: ProContractKernel.Command) => Effect.Effect<string | undefined>) | undefined
>("@opencode/ProContract/RecognitionAuthority", { defaultValue: () => undefined })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const registrations = yield* ProContractRecognition.Service

    const execute = Effect.fn("ProContract.execute")(
      (command: ProContractKernel.Command, check?: Effect.Effect<string | undefined>) =>
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
                const state = {
                  contracts: Object.fromEntries(stored.map((row) => [row.data.id, row.data])),
                  attestations: attestation ? { [attestation.data.id]: attestation.data } : {},
                }
                const guard = yield* CommandGuard
                const authority = yield* RecognitionAuthority
                const principal = ["discharge", "challenge", "decide-revision"].includes(command.type)
                const rejected =
                  ((command.type === "discharge" && !command.attestation.evidenceHash) ||
                  (command.type === "challenge" && !command.challenge.evidenceHash)
                    ? "independent evidence hash is required"
                    : undefined) ??
                  (principal
                    ? authority
                      ? yield* authority(command)
                      : "exact recognition authority is required"
                    : undefined) ??
                  (guard ? yield* guard(command) : undefined) ??
                  (check ? yield* check : undefined)
                const decision =
                  rejected !== undefined
                    ? { type: "rejected" as const, reason: rejected || "command rejected without a reason" }
                    : undefined
                const result = decision
                  ? { state, decision, event: { command, decision } }
                  : ProContractKernel.transition(state, command)
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
                  .onConflictDoUpdate({
                    target: ProContractLedgerTable.id,
                    set: { head_seq: frontier, head_hash: hash },
                  })
                  .run()
                  .pipe(Effect.orDie)
                if (result.decision.type === "accepted" && current) {
                  const invalidated =
                    command.type === "challenge"
                      ? ProContractRecognition.affected(state, current.id)
                      : (command.type === "issue" && !state.contracts[current.id]) ||
                          command.type === "report-ready" ||
                          command.type === "resume" ||
                          command.type === "release" ||
                          // Even a subsequently rejected petition must not restore captured execution or evidence authority.
                          command.type === "petition-revision" ||
                          (command.type === "decide-revision" && command.accept)
                        ? new Set([current.id])
                        : new Set<string>()
                  yield* Effect.forEach(
                    [...invalidated],
                    (id) =>
                      Effect.gen(function* () {
                        const contract = result.state.contracts[id]
                        if (!contract) return
                        const previous = yield* db
                          .select()
                          .from(ProContractContextTable)
                          .where(eq(ProContractContextTable.contract_id, id))
                          .orderBy(desc(ProContractContextTable.version))
                          .get()
                          .pipe(Effect.orDie)
                        // Missing metadata on an existing duty must never silently downgrade a profile.
                        if (!previous && state.contracts[id]) return
                        const profile = previous?.data.profile ?? "native"
                        const context: ProContract.RecognitionContext = {
                          target: {
                            revision: contract.revision,
                            specHash: contract.specHash,
                            version: (previous?.version ?? 0) + 1,
                            phaseID: hash,
                            handoffID:
                              command.type === "report-ready" && contract.handoff
                                ? `pch_${hash}`
                                : command.type === "petition-revision"
                                  ? previous?.data.target.handoffID
                                  : undefined,
                          },
                          profile,
                          referenceHash: "none",
                          admitted: profile === "native",
                        }
                        yield* db
                          .insert(ProContractContextTable)
                          .values({ contract_id: id, version: context.target.version, data: context })
                          .run()
                          .pipe(Effect.orDie)
                      }),
                    { discard: true },
                  )
                }
                return { ...result, frontier, hash }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie),
    )

    let recognitionCache:
      | { readonly fingerprint: string; readonly history: ReturnType<typeof ProContractRecognition.recover> }
      | undefined

    // Views and their identities are derived from one database snapshot. Repeated executor
    // checks reuse replay only when ALL ledger and projection bytes still agree, not just the head.
    const views = () =>
      db
        .transaction(() =>
          Effect.gen(function* () {
            const rows = yield* db.select().from(ProContractTable).all().pipe(Effect.orDie)
            const contexts = yield* db
              .select()
              .from(ProContractContextTable)
              .orderBy(asc(ProContractContextTable.version))
              .all()
              .pipe(Effect.orDie)
            const events = yield* db
              .select()
              .from(ProContractEventTable)
              .orderBy(asc(ProContractEventTable.seq))
              .all()
              .pipe(Effect.orDie)
            const head = yield* db
              .select()
              .from(ProContractLedgerTable)
              .where(eq(ProContractLedgerTable.id, 1))
              .get()
              .pipe(Effect.orDie)
            const fingerprint = Hash.sha256(JSON.stringify([events, head, rows.map((row) => row.data)]))
            const history =
              recognitionCache?.fingerprint === fingerprint
                ? recognitionCache.history
                : ProContractRecognition.recover(
                    events,
                    head,
                    rows.map((row) => row.data),
                  )
            recognitionCache = { fingerprint, history }
            const byID = new Map(contexts.map((row) => [row.contract_id, row.data]))
            return rows.map((row) => ProContractRecognition.view(row.data, byID.get(row.id), history))
          }),
        )
        .pipe(Effect.orDie)

    const get = Effect.fn("ProContract.get")(function* (id: ProContract.ID) {
      return (yield* views()).find((contract) => contract.id === id)
    })

    const prior = (operationID: string, fingerprint: string) =>
      db
        .transaction(() =>
          Effect.gen(function* () {
            // Invalid operation identity is an admission error, with no fabricated ledger receipt.
            Schema.decodeUnknownSync(ProContract.OperationReceipt.fields.operationID)(operationID)
            const row = yield* db
              .select()
              .from(ProContractAttemptTable)
              .where(
                and(
                  eq(ProContractAttemptTable.operation_id, operationID),
                  eq(ProContractAttemptTable.fingerprint, fingerprint),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!row) return undefined
            const support = row.receipt.support
            return {
              ...row.receipt,
              replayed: true,
              support: support
                ? {
                    ...support,
                    valid: ProContractRecognition.validSupport(yield* views(), support),
                  }
                : undefined,
            } satisfies ProContract.OperationReceipt
          }),
        )
        .pipe(Effect.orDie)

    const operation = (
      input: { readonly operationID: string; readonly contractID: ProContract.ID },
      kind: string,
      fingerprint: string,
      run: (conflict: string | undefined) => Effect.Effect<Receipt>,
    ) =>
      db
        .transaction(
          () =>
            Effect.gen(function* () {
              const retry = yield* prior(input.operationID, fingerprint)
              if (retry) return retry
              const original = yield* db
                .select()
                .from(ProContractOperationTable)
                .where(eq(ProContractOperationTable.operation_id, input.operationID))
                .get()
                .pipe(Effect.orDie)
              const result = yield* run(original ? "operationID was already used for a different request" : undefined)
              const current =
                result.decision.type === "accepted" && result.event.command.type === "discharge"
                  ? yield* get(result.event.command.contractID)
                  : undefined
              const support =
                current?.attestationID && current.recognition.handoff
                  ? {
                      contractID: current.id,
                      attestationID: current.attestationID,
                      target: current.recognition.handoff,
                      valid: true,
                    }
                  : undefined
              const receipt: ProContract.OperationReceipt = {
                operationID: input.operationID,
                fingerprint,
                decision: result.decision,
                frontier: result.frontier,
                hash: result.hash,
                replayed: false,
                support: support
                  ? { ...support, valid: ProContractRecognition.validSupport(yield* views(), support) }
                  : undefined,
              }
              if (!original)
                yield* db
                  .insert(ProContractOperationTable)
                  .values({ operation_id: input.operationID, fingerprint })
                  .run()
                  .pipe(Effect.orDie)
              yield* db
                .insert(ProContractAttemptTable)
                .values({ operation_id: input.operationID, fingerprint, contract_id: input.contractID, kind, receipt })
                .run()
                .pipe(Effect.orDie)
              return receipt
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)

    const targetCheck = (contract: ContractView | undefined, expected: ProContract.RecognitionTarget) =>
      !expected ||
      !contract?.recognition.handoff ||
      !ProContractRecognition.same(contract.recognition.handoff, expected)
        ? "recognition target does not match the current handoff"
        : undefined

    const attestCommand = (input: {
      readonly contractID: ProContract.ID
      readonly operationID: string
      readonly expected: ProContract.RecognitionTarget
      readonly evidenceHash: string
    }): ProContractKernel.Command => ({
      type: "discharge",
      actor: "local-owner",
      contractID: input.contractID,
      attestation: {
        id: ProContract.AttestationID.make(
          `pca_${ProContractRecognition.fingerprint([input.operationID, input.contractID])}`,
        ),
        revision: input.expected.revision,
        specHash: input.expected.specHash,
        subjectHash: input.expected.subjectHash,
        evidenceHash: input.evidenceHash,
        verifierID: "local-owner",
        class: "principal",
      },
    })

    const issue = Effect.fn("ProContract.issue")(function* (input: {
      readonly id?: ProContract.ID
      readonly scope: string
      readonly spec: ProContract.Spec
      readonly executor: string
    }) {
      const id = input.id ?? ProContract.ID.create()
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
      return { ...receipt, contract: (yield* get(id))! }
    })

    const settleEvaluation: Interface["settleEvaluation"] = Effect.fn("ProContract.settleEvaluation")(
      function* (submitted) {
        const input = structuredClone(submitted)
        const report = input.report
        const fingerprint = ProContractRecognition.fingerprint({ ...input, kind: "evaluation", time: undefined })
        return yield* operation(input, "evaluation", fingerprint, (conflict) =>
          Effect.gen(function* () {
            const all = yield* views()
            const evaluation = all.find((contract) => contract.id === input.contractID)
            const delivery = all.find((contract) => contract.id === report.deliveryContractID)
            const rejectedCommand: ProContractKernel.Command = report.passed
              ? attestCommand({
                  ...input,
                  expected: {
                    revision: report.evaluation?.revision ?? 1,
                    specHash: report.evaluation?.specHash ?? "missing",
                    subjectHash: report.delivery?.subjectHash ?? "missing",
                    handoffID: "unavailable",
                    contextHash: "unavailable",
                  },
                })
              : {
                  type: "challenge",
                  actor: "local-owner",
                  contractID: report.deliveryContractID,
                  challenge: {
                    revision: report.delivery?.revision ?? 1,
                    subjectHash: report.delivery?.subjectHash ?? "missing",
                    evidenceHash: input.evidenceHash,
                    disclosure: report.disclosure,
                    summary: report.disclosure === "executor" ? report.summary : undefined,
                    time: input.time,
                  },
                }
            const reject = (reason: string) =>
              execute(rejectedCommand).pipe(Effect.provideService(RecognitionAuthority, () => Effect.succeed(reason)))
            const deliverySupport =
              report.delivery && report.deliveryAttestationID
                ? {
                    contractID: report.deliveryContractID,
                    attestationID: report.deliveryAttestationID,
                    target: report.delivery,
                    valid: true,
                  }
                : undefined
            const invalid =
              conflict ??
              (report.version !== 2 ? "evaluation report version 2 is required" : undefined) ??
              (!evaluation ||
              evaluation.id !==
                evaluationID(report.deliveryContractID, report.delivery.revision, report.evaluatorHash) ||
              evaluation.executor !== `external-evaluator:${report.evaluatorHash}` ||
              evaluation.spec.requires.length !== 1 ||
              evaluation.spec.requires[0]?.contractID !== report.deliveryContractID ||
              evaluation.spec.requires[0]?.revision !== report.delivery.revision
                ? "evaluation identity does not match report"
                : undefined) ??
              (!report.evaluation ||
              !evaluation?.recognition.context ||
              !ProContractRecognition.same(evaluation.recognition.context.target, report.evaluation)
                ? "evaluation context does not match report"
                : undefined) ??
              (evaluation?.recognition.context?.profile !== "native" ||
              !evaluation.recognition.context.admitted ||
              delivery?.recognition.context?.profile !== "native"
                ? "evaluation helper requires admitted native contexts"
                : undefined) ??
              (!deliverySupport || !ProContractRecognition.validSupport(all, deliverySupport)
                ? "delivery support does not match report"
                : undefined) ??
              (evaluation?.handoff || !["active", "dormant"].includes(evaluation?.status ?? "")
                ? "evaluation is not awaiting a fresh report"
                : undefined)
            if (invalid) return yield* reject(invalid)
            if (!evaluation) return yield* Effect.die("Validated evaluation is missing")
            if (!report.passed)
              return yield* execute(rejectedCommand).pipe(
                Effect.provideService(RecognitionAuthority, () => Effect.succeed(undefined)),
              )
            // A normal reducer/guard rejection must roll back intermediate ledger and context rows too.
            return yield* db
              .transaction(() =>
                Effect.gen(function* () {
                  const requireAccepted = (receipt: Receipt) =>
                    receipt.decision.type === "rejected"
                      ? Effect.fail({ _tag: "EvaluationRejected" as const, reason: receipt.decision.reason })
                      : Effect.succeed(receipt)
                  if (evaluation.status === "dormant")
                    yield* execute({
                      type: "activate",
                      actor: "institution",
                      contractID: evaluation.id,
                      revision: evaluation.revision,
                      time: input.time,
                    }).pipe(Effect.flatMap(requireAccepted))
                  yield* execute({
                    type: "report-ready",
                    actor: "institution",
                    contractID: evaluation.id,
                    revision: evaluation.revision,
                    summary:
                      report.disclosure === "sealed" ? "External evaluator accepted sealed evidence" : report.summary,
                    uncertainties: [],
                    subjectHash: report.delivery.subjectHash,
                    time: input.time,
                  }).pipe(Effect.flatMap(requireAccepted))
                  const handedOff = yield* get(evaluation.id)
                  if (!handedOff?.recognition.handoff)
                    return yield* Effect.fail({
                      _tag: "EvaluationRejected" as const,
                      reason: "evaluation handoff identity unavailable",
                    })
                  return yield* execute(attestCommand({ ...input, expected: handedOff.recognition.handoff })).pipe(
                    // This helper supports only the synchronous, built-in native verifier.
                    Effect.provideService(RecognitionAuthority, () =>
                      ProContractRecognition.native.validate({
                        contract: handedOff,
                        expected: handedOff.recognition.handoff!,
                        evidenceHash: input.evidenceHash,
                      }),
                    ),
                    Effect.flatMap(requireAccepted),
                  )
                }),
              )
              .pipe(
                Effect.catchTag("EvaluationRejected", (error) => reject(error.reason)),
                Effect.orDie,
              )
          }),
        )
      },
    )

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
          spec: ProContract.Spec.make({
            trigger: { type: "immediate" },
            goal: `Independently evaluate the exact handoff for: ${delivery.spec.goal}`,
            brief: `Evaluate ${delivery.id}@${delivery.revision} with evaluator ${input.evaluatorHash}. Delivery evidence alone does not settle this obligation.`,
            requires: [{ contractID: delivery.id, revision: delivery.revision }],
            authority: [],
            budget: { turns: 1, actions: 1, deadline: input.deadline },
            evidence: {
              type: "principal",
              claim: `Evaluator ${input.evaluatorHash} accepted the exact handoff from ${delivery.id}@${delivery.revision}.`,
            },
            resolution: { maxAttempts: 1, retryDelay: 0 },
          }),
        })
      }),
      settleEvaluation: settleEvaluation,
      release: (input) => execute({ type: "release", actor: "local-owner", ...input }),
      challenge: Effect.fn("ProContract.challenge")(function* (submitted) {
        const input = structuredClone(submitted)
        const fingerprint = ProContractRecognition.fingerprint({ ...input, kind: "challenge", time: undefined })
        return yield* operation(input, "challenge", fingerprint, (conflict) =>
          execute({
            type: "challenge",
            actor: "local-owner",
            contractID: input.contractID,
            challenge: {
              revision: input.expected.revision,
              subjectHash: input.expected.subjectHash,
              evidenceHash: input.evidenceHash,
              disclosure: input.disclosure,
              summary: input.summary,
              time: input.time,
            },
          }).pipe(
            Effect.provideService(RecognitionAuthority, () =>
              Effect.gen(function* () {
                return conflict ?? targetCheck(yield* get(input.contractID), input.expected)
              }),
            ),
          ),
        )
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
      decideRevision: Effect.fn("ProContract.decideRevision")(function* (submitted) {
        const input = structuredClone(submitted)
        const fingerprint = ProContractRecognition.fingerprint({ ...input, kind: "decide-revision" })
        return yield* operation(input, "decide-revision", fingerprint, (conflict) =>
          execute({
            type: "decide-revision",
            actor: "local-owner",
            contractID: input.contractID,
            accept: input.accept,
          }).pipe(
            Effect.provideService(RecognitionAuthority, () =>
              Effect.gen(function* () {
                const current = yield* get(input.contractID)
                return (
                  conflict ??
                  (!input.expected ||
                  !current?.recognition.pending ||
                  !ProContractRecognition.same(current.recognition.pending, input.expected)
                    ? "revision approval does not match the current petition"
                    : undefined)
                )
              }),
            ),
          ),
        )
      }),
      principalAttest: Effect.fn("ProContract.principalAttest")(function* (submitted) {
        const input = structuredClone(submitted)
        const fingerprint = ProContractRecognition.fingerprint({ ...input, kind: "attest" })
        const retry = yield* prior(input.operationID, fingerprint)
        if (retry) return retry
        const original = yield* db
          .select()
          .from(ProContractOperationTable)
          .where(eq(ProContractOperationTable.operation_id, input.operationID))
          .get()
          .pipe(Effect.orDie)
        if (original)
          return yield* operation(input, "attest", fingerprint, (conflict) =>
            execute(attestCommand(input)).pipe(
              Effect.provideService(RecognitionAuthority, () => Effect.succeed(conflict ?? "operationID conflict")),
            ),
          )
        const registry = (yield* ProContractRecognition.Validators) ?? registrations
        const before = yield* get(input.contractID)
        const context = before?.recognition.context
        const validator =
          context?.profile === "native"
            ? ProContractRecognition.native
            : context
              ? registry.get(context.profile)
              : undefined
        const validatorIdentity = validator?.identity
        const rejected =
          targetCheck(before, input.expected) ??
          (!context?.admitted
            ? "recognition context is not admitted"
            : !validator
              ? "recognition profile validator is unavailable"
              : undefined)
        const checked =
          rejected ??
          (before && validator
            ? yield* validator.validate({
                contract: structuredClone(before),
                expected: structuredClone(input.expected),
                evidenceHash: input.evidenceHash,
              })
            : "recognition context is unavailable")
        return yield* operation(input, "attest", fingerprint, (conflict) =>
          execute(attestCommand(input)).pipe(
            Effect.provideService(RecognitionAuthority, () =>
              Effect.gen(function* () {
                const current = yield* get(input.contractID)
                const profile = current?.recognition.context?.profile
                const active =
                  profile === "native" ? ProContractRecognition.native : profile ? registry.get(profile) : undefined
                return (
                  conflict ??
                  checked ??
                  targetCheck(current, input.expected) ??
                  (!current?.recognition.context?.admitted ? "recognition context is not admitted" : undefined) ??
                  (active !== validator || active?.identity !== validatorIdentity
                    ? "recognition validator changed during verification"
                    : undefined)
                )
              }),
            ),
          ),
        )
      }),
      setRecognitionContext: (input) =>
        db
          .transaction(
            () =>
              Effect.gen(function* () {
                const current = yield* get(input.contractID)
                const context = current?.recognition.context
                if (!current || !context || !ProContractRecognition.same(context.target, input.expected))
                  return { conflict: "recognition context changed" }
                if (current.status === "discharged" || current.status === "released")
                  return { conflict: "settled support must be withdrawn through challenge" }
                if (
                  !input.profile ||
                  !input.referenceHash ||
                  (input.profile !== "native" && input.admitted && !current.handoff)
                )
                  return { conflict: "admitted context requires a specific handoff and immutable references" }
                const next: ProContract.RecognitionContext = {
                  target: { ...context.target, version: context.target.version + 1 },
                  profile: input.profile,
                  referenceHash: input.referenceHash,
                  admitted: input.admitted,
                }
                yield* db
                  .insert(ProContractContextTable)
                  .values({ contract_id: current.id, version: next.target.version, data: next })
                  .run()
                  .pipe(Effect.orDie)
                return { context: next }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie),
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
        return (yield* views()).filter((contract) => !scope || contract.scope === scope)
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
                  .map((row) => ProContract.ID.make(row.id))
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

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, ProContractRecognition.node] })
