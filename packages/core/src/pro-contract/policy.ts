export * as ProContractPolicy from "./policy"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { lstat, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { ProContract } from "../pro-contract"
import { AbsolutePath } from "../schema"
import { Hash } from "../util/hash"
import { ProContractPromotion } from "./promotion"
import { ProContractExport } from "./export"
import { ProContractPolicyTable } from "./policy.sql"
import { ProContractOpenCodeTable, ProContractTable } from "./sql"

export const Bundle = Schema.Struct({
  version: Schema.Literal(1),
  solver: Schema.NonEmptyString,
  generator: Schema.NonEmptyString,
})
export type Bundle = typeof Bundle.Type
export type Role = "solver" | "generator"
export type Selection = {
  contractID: ProContract.ID
  revision: number
  subjectHash: string
  bundle: Bundle
  bundleHash: string
}
export type State = {
  scope: string
  revision: number
  protocol: ProContractPromotion.Protocol
  protocolHash: string
  selected: number
  history: Selection[]
  retainedFull: string[]
  evaluations: {
    contractID: ProContract.ID
    evidence: ProContractPromotion.Evidence
    decision: ReturnType<typeof ProContractPromotion.qualify>
  }[]
}
export type Bound = {
  executionPolicy: string
  requirement: ProContract.Requirement
  identity: { scope: string; revision: number; bundleHash: string; role: Role }
}

export const Generation = Schema.Struct({
  contractID: ProContract.ID,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  subjectHash: Schema.NonEmptyString,
})
const Proposal = Schema.Struct({
  kind: Schema.Literal("policy-promotion-v1"),
  scope: Schema.NonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  protocolHash: ProContractPromotion.Digest,
  baselineHash: ProContractPromotion.Digest,
  candidateHash: ProContractPromotion.Digest,
  bundle: Bundle,
  generation: Generation,
})

export interface Interface {
  readonly authorize: (input: {
    scope: string
    protocol: ProContractPromotion.Protocol
    bundle: Bundle
    now: number
  }) => Effect.Effect<State>
  readonly get: (scope: string) => Effect.Effect<State | undefined>
  readonly bind: (input: { scope: string; role: Role }) => Effect.Effect<Bound>
  readonly propose: (input: {
    scope: string
    expectedRevision: number
    bundle: Bundle
    generation: typeof Generation.Type
    now: number
  }) => Effect.Effect<ProContract.Contract>
  readonly settle: (input: {
    contractID: ProContract.ID
    evidence: ProContractPromotion.Evidence
    now: number
  }) => Effect.Effect<{
    state: State
    decision: ReturnType<typeof ProContractPromotion.qualify>
    contract: ProContract.Contract
  }>
  readonly rollback: (input: { scope: string; expectedRevision: number; now: number }) => Effect.Effect<State>
  readonly revoke: (input: {
    scope: string
    expectedRevision: number
    evidenceHash: string
    now: number
  }) => Effect.Effect<State>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractPolicy") {}

export function hashBundle(input: Bundle) {
  const bundle = Schema.decodeUnknownSync(Bundle)(input, { onExcessProperty: "error" })
  if (
    [bundle.solver, bundle.generator].some(
      (text) => !text.trim() || text.includes("\0") || new TextEncoder().encode(text).length > 65_536,
    )
  )
    throw new Error("Policy text must be nonempty UTF-8, without NUL, and at most 64 KiB")
  return Hash.sha256(JSON.stringify(bundle))
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const contracts = yield* ProContract.Service
    const exports = yield* ProContractExport.Service

    const get = Effect.fn("ProContractPolicy.get")(function* (scope: string) {
      const row = yield* database.db
        .select()
        .from(ProContractPolicyTable)
        .where(eq(ProContractPolicyTable.scope, scope))
        .get()
        .pipe(Effect.orDie)
      return row?.data
    })

    const requireState = Effect.fnUntraced(function* (scope: string, revision?: number) {
      const state = yield* get(scope)
      if (!state) return yield* Effect.die(new Error("Policy scope has not been authorized"))
      if (revision !== undefined && state.revision !== revision)
        return yield* Effect.die(new Error("Stale policy selection revision"))
      return state
    })

    const requireStanding = Effect.fnUntraced(function* (selection: Selection) {
      const contract = yield* contracts.get(selection.contractID)
      if (!standing(contract, selection))
        return yield* Effect.die(new Error("Selected policy support was withdrawn; explicitly roll back before use"))
      return selection
    })

    const requireAdmissible = Effect.fnUntraced(function* (state: State, bundleHash: string) {
      const withdrawn = yield* Effect.findFirst(
        state.history.filter((selection) => selection.bundleHash === bundleHash),
        (selection) =>
          contracts.get(selection.contractID).pipe(Effect.map((contract) => !standing(contract, selection))),
      )
      if (withdrawn._tag === "Some")
        return yield* Effect.die(new Error("Withdrawn policy content requires a separately authorized frozen scope"))
    })

    // Nested Contract operations join this connection's transaction context.
    // The ordinary ledger and selected pointer therefore commit together.
    const commit = Effect.fnUntraced(function* (prior: State | undefined, next: State) {
      return yield* database.db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select()
                .from(ProContractPolicyTable)
                .where(eq(ProContractPolicyTable.scope, next.scope))
                .get()
                .pipe(Effect.orDie)
              if (current?.data.revision !== prior?.revision)
                return yield* Effect.die(new Error("Stale policy selection revision"))
              const selected = next.history[next.selected]
              const support = yield* tx
                .select({ data: ProContractTable.data })
                .from(ProContractTable)
                .where(eq(ProContractTable.id, selected.contractID))
                .get()
                .pipe(Effect.orDie)
              if (!standing(support?.data, selected))
                return yield* Effect.die(new Error("Policy support changed before selection"))
              yield* tx
                .insert(ProContractPolicyTable)
                .values({ scope: next.scope, data: next })
                .onConflictDoUpdate({ target: ProContractPolicyTable.scope, set: { data: next } })
                .run()
                .pipe(Effect.orDie)
              return next
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const attest = Effect.fnUntraced(function* (
      contract: ProContract.Contract,
      subjectHash: string,
      evidenceHash: string,
      now: number,
    ) {
      if (contract.status === "discharged") {
        const attestation = contract.attestationID ? yield* contracts.getAttestation(contract.attestationID) : undefined
        if (contract.handoff?.subjectHash !== subjectHash || attestation?.evidenceHash !== evidenceHash)
          return yield* Effect.die(new Error("Conflicting policy settlement retry"))
        return contract
      }
      const activated =
        contract.status === "dormant" ? yield* contracts.activate(contract.id, contract.revision, now) : undefined
      if (activated) requireAccepted(activated)
      const current = (yield* contracts.get(contract.id))!
      if (current.status === "active")
        requireAccepted(
          yield* contracts.reportReady({
            contractID: current.id,
            revision: current.revision,
            subjectHash,
            summary: current.spec.goal,
            uncertainties: ["Authorization is scoped to the frozen external protocol, not universal improvement."],
            time: now,
          }),
        )
      const ready = (yield* contracts.get(contract.id))!
      if (ready.handoff?.subjectHash !== subjectHash)
        return yield* Effect.die(new Error("Policy handoff identity changed"))
      requireAccepted(
        yield* contracts.principalAttest({
          contractID: ready.id,
          revision: ready.revision,
          specHash: ready.specHash,
          subjectHash,
          evidenceHash,
        }),
      )
      return (yield* contracts.get(contract.id))!
    })

    return Service.of({
      get,
      authorize: Effect.fn("ProContractPolicy.authorize")(function* (input) {
        const request = structuredClone(input)
        return yield* database.db
          .transaction(
            () =>
              Effect.gen(function* () {
                const protocol = ProContractPromotion.requireProtocol(request.protocol)
                const protocolHash = ProContractPromotion.hashProtocol(protocol)
                const bundleHash = hashBundle(request.bundle)
                if (!request.scope.trim()) return yield* Effect.die(new Error("Policy scope is empty"))
                const prior = yield* get(request.scope)
                if (prior) {
                  if (prior.protocolHash !== protocolHash || prior.history[0].bundleHash !== bundleHash)
                    return yield* Effect.die(
                      new Error("Frozen policy scope or authorized seed changed; create a new scope"),
                    )
                  return prior
                }
                const id = ProContract.ID.make(
                  `pct_policy_seed_${Hash.sha256(JSON.stringify([request.scope, protocolHash, bundleHash]))}`,
                )
                const existing = yield* contracts.get(id)
                const issued = yield* contracts.issue({
                  id,
                  scope: request.scope,
                  executor: "policy-authority",
                  spec: existing?.spec ?? {
                    ...ProContract.defaultSpec(
                      "Explicitly authorize this initial policy; no performance improvement is claimed",
                      request.now,
                    ),
                    brief: JSON.stringify({ kind: "policy-seed-v1", protocolHash, bundleHash }),
                    authority: [],
                    resolution: { maxAttempts: 1, retryDelay: 0 },
                  },
                })
                requireAccepted(issued)
                const support = yield* attest(
                  issued.contract!,
                  bundleHash,
                  Hash.sha256(
                    JSON.stringify({ authorization: "seed", scope: request.scope, protocolHash, bundleHash }),
                  ),
                  request.now,
                )
                return yield* commit(undefined, {
                  scope: request.scope,
                  revision: 1,
                  protocol,
                  protocolHash,
                  selected: 0,
                  history: [
                    {
                      contractID: support.id,
                      revision: support.revision,
                      subjectHash: bundleHash,
                      bundle: request.bundle,
                      bundleHash,
                    },
                  ],
                  retainedFull: [],
                  evaluations: [],
                })
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      bind: Effect.fn("ProContractPolicy.bind")(function* (input) {
        if (input.role !== "solver" && input.role !== "generator")
          return yield* Effect.die(new Error("Unknown policy role"))
        const state = yield* requireState(input.scope)
        const selected = yield* requireStanding(state.history[state.selected])
        return {
          executionPolicy: selected.bundle[input.role],
          requirement: { contractID: selected.contractID, revision: selected.revision },
          identity: { scope: state.scope, revision: state.revision, bundleHash: selected.bundleHash, role: input.role },
        }
      }),
      propose: Effect.fn("ProContractPolicy.propose")(function* (input) {
        const request = structuredClone(input)
        const state = yield* requireState(request.scope, request.expectedRevision)
        const selected = yield* requireStanding(state.history[state.selected])
        const candidateHash = hashBundle(request.bundle)
        if (candidateHash === selected.bundleHash)
          return yield* Effect.die(new Error("Candidate is identical to the selected policy"))
        yield* requireAdmissible(state, candidateHash)
        const generation = yield* contracts.get(request.generation.contractID)
        const binding = yield* database.db
          .select({ data: ProContractOpenCodeTable.data })
          .from(ProContractOpenCodeTable)
          .where(eq(ProContractOpenCodeTable.contract_id, request.generation.contractID))
          .get()
          .pipe(Effect.orDie)
        if (
          !generation ||
          !["verification", "discharged"].includes(generation.status) ||
          generation.revision !== request.generation.revision ||
          generation.handoff?.subjectHash !== request.generation.subjectHash ||
          binding?.data.executionPolicy !== selected.bundle.generator ||
          !generation.spec.requires.some(
            (requirement) =>
              requirement.contractID === selected.contractID && requirement.revision === selected.revision,
          )
        )
          return yield* Effect.die(
            new Error("Candidate generation is not an exact handoff using the selected generator"),
          )
        yield* Effect.acquireUseRelease(
          Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-policy-"))),
          (temporary) =>
            Effect.gen(function* () {
              const directory = AbsolutePath.make(path.join(temporary, "subject"))
              const exported = yield* exports.materialize({ contractID: generation.id, directory }).pipe(Effect.orDie)
              if (exported.subjectHash !== request.generation.subjectHash)
                return yield* Effect.die(new Error("Generation handoff changed during export"))
              const file = path.join(directory, "strategy.json")
              const info = yield* Effect.promise(() => lstat(file))
              if (!info.isFile() || info.size > 1024 * 1024)
                return yield* Effect.die(new Error("Generated strategy.json must be a bounded regular file"))
              const generated = Schema.decodeUnknownSync(Schema.fromJsonString(Bundle))(
                yield* Effect.promise(() => Bun.file(file).text()),
                { onExcessProperty: "error" },
              )
              if (hashBundle(generated) !== candidateHash)
                return yield* Effect.die(new Error("Candidate Bundle differs from frozen generation strategy.json"))
            }),
          (temporary) => Effect.promise(() => rm(temporary, { recursive: true, force: true })),
        )
        return yield* database.db
          .transaction(
            () =>
              Effect.gen(function* () {
                yield* requireState(request.scope, request.expectedRevision)
                yield* requireStanding(selected)
                yield* requireAdmissible(state, candidateHash)
                const current = yield* contracts.get(generation.id)
                if (
                  !current ||
                  !["verification", "discharged"].includes(current.status) ||
                  current.revision !== request.generation.revision ||
                  current.handoff?.subjectHash !== request.generation.subjectHash
                )
                  return yield* Effect.die(new Error("Generation handoff changed before proposal admission"))
                const proposal = Proposal.make({
                  kind: "policy-promotion-v1",
                  scope: request.scope,
                  expectedRevision: request.expectedRevision,
                  protocolHash: state.protocolHash,
                  baselineHash: selected.bundleHash,
                  candidateHash,
                  bundle: request.bundle,
                  generation: request.generation,
                })
                const brief = JSON.stringify(proposal)
                const id = ProContract.ID.make(`pct_policy_${Hash.sha256(brief)}`)
                const existing = yield* contracts.get(id)
                const receipt = yield* contracts.issue({
                  id,
                  scope: request.scope,
                  executor: "policy-authority",
                  spec: existing?.spec ?? {
                    ...ProContract.defaultSpec(
                      "Authorize this exact policy under the frozen task-pareto evaluation protocol",
                      request.now,
                    ),
                    brief,
                    // Generation is provenance, not evidence of improvement. A qualified
                    // successor does not depend on the continuing health of its producer.
                    requires: [],
                    authority: [],
                    resolution: { maxAttempts: 1, retryDelay: 0 },
                  },
                })
                requireAccepted(receipt)
                return receipt.contract!
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      settle: Effect.fn("ProContractPolicy.settle")(function* (input) {
        const request = structuredClone(input)
        const evidence = Schema.decodeUnknownSync(ProContractPromotion.Evidence, { onExcessProperty: "error" })(
          request.evidence,
        )
        return yield* database.db
          .transaction(
            () =>
              Effect.gen(function* () {
                const contract = yield* contracts.get(request.contractID)
                if (!contract || contract.executor !== "policy-authority")
                  return yield* Effect.die(new Error("Policy proposal Contract not found"))
                const proposal = Schema.decodeUnknownSync(Schema.fromJsonString(Proposal))(contract.spec.brief)
                const state = yield* requireState(proposal.scope)
                if (
                  state.protocolHash !== proposal.protocolHash ||
                  evidence.protocolHash !== proposal.protocolHash ||
                  evidence.candidateHash !== proposal.candidateHash ||
                  evidence.baselineHash !== proposal.baselineHash
                )
                  return yield* Effect.die(new Error("Evidence differs from the frozen policy proposal"))
                const evidenceHash = Hash.sha256(JSON.stringify(evidence))
                const prior = state.evaluations.find((item) => item.contractID === contract.id)
                if (prior) {
                  if (Hash.sha256(JSON.stringify(prior.evidence)) !== evidenceHash)
                    return yield* Effect.die(new Error("Conflicting policy settlement retry"))
                  return { state, decision: prior.decision, contract }
                }
                if (
                  state.revision !== proposal.expectedRevision ||
                  state.history[state.selected].bundleHash !== proposal.baselineHash
                )
                  return yield* Effect.die(new Error("Policy proposal baseline is no longer selected"))
                yield* requireStanding(state.history[state.selected])
                // A direct challenge of historical support need not change the
                // selection revision. Recheck live standing under this lock.
                yield* requireAdmissible(state, proposal.candidateHash)
                const decision = ProContractPromotion.qualify(state.protocol, evidence, state.retainedFull)
                const evaluations = [...state.evaluations, { contractID: contract.id, evidence, decision }]
                const retainedFull = decision.safety
                  ? [
                      ...new Set([
                        ...state.retainedFull,
                        ...decision.baselineFull,
                        ...(decision.eligible ? decision.full : []),
                      ]),
                    ]
                  : state.retainedFull
                if (!decision.eligible) {
                  requireAccepted(
                    yield* contracts.escalate({
                      contractID: contract.id,
                      revision: contract.revision,
                      reason: `Frozen task-pareto gate rejected evidence ${evidenceHash}`,
                      time: request.now,
                    }),
                  )
                  const next = yield* commit(state, {
                    ...state,
                    revision: state.revision + 1,
                    retainedFull,
                    evaluations,
                  })
                  return { state: next, decision, contract: (yield* contracts.get(contract.id))! }
                }
                const support = yield* attest(contract, proposal.candidateHash, evidenceHash, request.now)
                const history = [
                  ...state.history,
                  {
                    contractID: support.id,
                    revision: support.revision,
                    subjectHash: proposal.candidateHash,
                    bundle: proposal.bundle,
                    bundleHash: proposal.candidateHash,
                  },
                ]
                const next = yield* commit(state, {
                  ...state,
                  revision: state.revision + 1,
                  selected: history.length - 1,
                  history,
                  retainedFull,
                  evaluations,
                })
                return { state: next, decision, contract: support }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      rollback: Effect.fn("ProContractPolicy.rollback")(function* (input) {
        const request = structuredClone(input)
        const state = yield* requireState(request.scope, request.expectedRevision)
        const previous = yield* Effect.findFirst(
          state.history
            .slice(0, state.selected)
            .map((selection, index) => ({ selection, index }))
            .reverse(),
          (entry) =>
            contracts
              .get(entry.selection.contractID)
              .pipe(Effect.map((contract) => standing(contract, entry.selection))),
        )
        if (previous._tag === "None")
          return yield* Effect.die(new Error("No previously authorized policy retains standing"))
        return yield* commit(state, { ...state, revision: state.revision + 1, selected: previous.value.index })
      }),
      revoke: Effect.fn("ProContractPolicy.revoke")(function* (input) {
        const request = structuredClone(input)
        return yield* database.db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const state = yield* requireState(request.scope, request.expectedRevision)
                const selected = state.history[state.selected]
                requireAccepted(
                  yield* contracts.challenge({
                    contractID: selected.contractID,
                    revision: selected.revision,
                    subjectHash: selected.subjectHash,
                    evidenceHash: request.evidenceHash,
                    disclosure: "sealed",
                    time: request.now,
                  }),
                )
                // The ordinary challenge closes dependent running Contracts immediately.
                // Keep the selected pointer visible until an explicit authorized rollback.
                const next = { ...state, revision: state.revision + 1 }
                yield* tx
                  .update(ProContractPolicyTable)
                  .set({ data: next })
                  .where(eq(ProContractPolicyTable.scope, state.scope))
                  .run()
                  .pipe(Effect.orDie)
                return next
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
    })
  }),
)

function standing(contract: ProContract.Contract | undefined, selection: Selection) {
  return (
    contract?.status === "discharged" &&
    contract.revision === selection.revision &&
    contract.handoff?.subjectHash === selection.subjectHash
  )
}

function requireAccepted(receipt: ProContract.Receipt) {
  if (receipt.decision.type === "rejected") throw new Error(receipt.decision.reason)
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, ProContract.node, ProContractExport.node],
})
