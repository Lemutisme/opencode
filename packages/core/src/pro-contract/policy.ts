export * as ProContractPolicy from "./policy"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { lstat, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { Global } from "../global"
import { ProContract } from "../pro-contract"
import { AbsolutePath } from "../schema"
import { Hash } from "../util/hash"
import { ProContractPromotion } from "./promotion"
import { ProContractVersion } from "./version"
import { ProContractExport } from "./export"
import { ProContractPolicyTable } from "./policy.sql"
import { ProContractOpenCodeTable, ProContractTable } from "./sql"

const TextBundle = {
  solver: Schema.NonEmptyString,
  generator: Schema.NonEmptyString,
}
export const Bundle = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), ...TextBundle }),
  Schema.Struct({ version: Schema.Literal(2), ...TextBundle, versionHash: ProContractPromotion.Digest }),
])
export type Bundle = typeof Bundle.Type
export type Role = "incumbent" | "research_executor"
export type RoleInput = Role | "solver" | "generator"
export type Selection = {
  contractID: ProContract.ID
  revision: number
  subjectHash: string
  specHash?: string
  attestationID?: ProContract.AttestationID
  bundle: Bundle
  bundleHash: string
  // Missing only on historical, shared grants; reading them never rewrites the ledger.
  role?: Role
}
export const Generation = Schema.Struct({
  contractID: ProContract.ID,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  subjectHash: Schema.NonEmptyString,
  runID: Schema.optional(Schema.String),
})
export type CandidateInput = {
  scope: string
  expectedRevision: number
  bundle: Bundle
  generation: typeof Generation.Type
  targetVersion?: string
  now: number
}
export const Qualification = Schema.Struct({
  evidenceHash: ProContractPromotion.Digest,
  runID: Schema.optional(Schema.String),
})
export type Qualification = typeof Qualification.Type
export const Experiment = Schema.Struct({
  id: ProContractPromotion.Digest,
  source: Schema.Struct({
    contractID: ProContract.ID,
    revision: Schema.Int.check(Schema.isGreaterThan(0)),
    runID: Schema.optional(Schema.String),
  }),
  executorHash: ProContractPromotion.Digest,
  targetVersion: ProContractPromotion.Digest,
  question: Schema.NonEmptyString,
  hypothesis: Schema.NonEmptyString,
  intervention: Schema.NonEmptyString,
  observations: Schema.Array(Schema.NonEmptyString),
  conclusion: Schema.NonEmptyString,
  outcome: Schema.Literals(["supported", "unsupported", "inconclusive", "failed"]),
  evidenceHash: ProContractPromotion.Digest,
  budget: Schema.Struct({
    deadline: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    startedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    finishedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  candidateHash: Schema.optional(ProContractPromotion.Digest),
})
export type Experiment = typeof Experiment.Type
export type Version = {
  bundle: Bundle
  bundleHash: string
  generations: {
    handoff: typeof Generation.Type
    executorHash: string
    targetVersion: string
  }[]
}
export type LegacyState = {
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
export type State = LegacyState & {
  version: 2
  roles: Record<Role, number>
  transitions: { role: Role; selection: number; revision: number }[]
  versions: Version[]
  experiments: Experiment[]
}
export type Bound = {
  executionPolicy: string
  authorization: ProContract.ExecutionAuthorization
  versionHash?: string
  identity: { scope: string; revision: number; bundleHash: string; role: Role }
}

const Proposal = Schema.Struct({
  kind: Schema.Literal("policy-promotion-v1"),
  scope: Schema.NonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  protocolHash: ProContractPromotion.Digest,
  baselineHash: ProContractPromotion.Digest,
  baselineSupport: Schema.optional(
    Schema.Struct({ contractID: ProContract.ID, revision: Schema.Int, subjectHash: Schema.NonEmptyString }),
  ),
  candidateHash: ProContractPromotion.Digest,
  bundle: Bundle,
  generation: Generation,
  executorHash: Schema.optional(ProContractPromotion.Digest),
  targetVersion: Schema.optional(ProContractPromotion.Digest),
})

export interface Interface {
  readonly authorize: (input: {
    scope: string
    protocol: ProContractPromotion.Protocol
    bundle: Bundle
    now: number
  }) => Effect.Effect<State>
  readonly get: (scope: string) => Effect.Effect<State | undefined>
  readonly bind: (input: { scope: string; role: RoleInput }) => Effect.Effect<Bound>
  readonly archiveCandidate: (input: CandidateInput) => Effect.Effect<State>
  readonly propose: (input: CandidateInput) => Effect.Effect<ProContract.Contract>
  readonly settle: (input: {
    contractID: ProContract.ID
    evidence: ProContractPromotion.Evidence
    now: number
  }) => Effect.Effect<{
    state: State
    decision: ReturnType<typeof ProContractPromotion.qualify>
    contract: ProContract.Contract
  }>
  readonly selectResearch: (input: {
    scope: string
    expectedRevision: number
    bundleHash: string
    qualification?: Qualification
    now: number
  }) => Effect.Effect<State>
  readonly recordExperiment: (input: {
    scope: string
    expectedRevision: number
    experiment: Experiment
  }) => Effect.Effect<State>
  readonly completeResearch: (input: {
    scope: string
    expectedRevision: number
    generation: typeof Generation.Type
    experiment: Experiment
    now: number
  }) => Effect.Effect<{ state: State; contract: ProContract.Contract }>
  readonly view: (input: {
    scope: string
    versionHashes: readonly string[]
    experimentIDs: readonly string[]
  }) => Effect.Effect<{ versions: Version[]; experiments: Experiment[] }>
  readonly rollback: (input: {
    scope: string
    expectedRevision: number
    role?: RoleInput
    now: number
  }) => Effect.Effect<State>
  readonly revoke: (input: {
    scope: string
    expectedRevision: number
    evidenceHash: string
    role?: RoleInput
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
    const global = yield* Global.Service
    const versions = ProContractVersion.make({ directory: ProContractVersion.storePath(global.data) })

    const get = Effect.fn("ProContractPolicy.get")(function* (scope: string) {
      const row = yield* database.db
        .select()
        .from(ProContractPolicyTable)
        .where(eq(ProContractPolicyTable.scope, scope))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      const state = currentState(row.data)
      if ("version" in row.data) return state
      // Project historical proposals too: rejected and unfinished candidates remain research material.
      const proposals = yield* database.db
        .select({ data: ProContractTable.data })
        .from(ProContractTable)
        .where(eq(ProContractTable.scope, scope))
        .all()
        .pipe(Effect.orDie)
      return {
        ...state,
        versions: proposals
          .flatMap((item) => {
            const proposal = Schema.decodeUnknownOption(Schema.fromJsonString(Proposal))(item.data.spec.brief)
            if (item.data.executor !== "policy-authority" || proposal._tag === "None") return []
            return [proposal.value]
          })
          .reduce((archive, proposal) => {
            const prior = archive.find((item) => item.bundleHash === proposal.candidateHash)
            const version: Version = {
              bundle: proposal.bundle,
              bundleHash: proposal.candidateHash,
              generations: [
                ...(prior?.generations ?? []),
                {
                  handoff: proposal.generation,
                  executorHash: proposal.executorHash ?? proposal.baselineHash,
                  targetVersion: proposal.targetVersion ?? proposal.baselineHash,
                },
              ],
            }
            return prior
              ? archive.map((item) => (item.bundleHash === version.bundleHash ? version : item))
              : [...archive, version]
          }, state.versions),
      }
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

    const requireAdmissible = Effect.fnUntraced(function* (state: State, bundleHash: string, role: Role) {
      const withdrawn = yield* Effect.findFirst(
        state.history.filter(
          (selection) => selection.bundleHash === bundleHash && (!selection.role || selection.role === role),
        ),
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
              // A revoked role does not prevent independent archival or changes to the other role.
              yield* Effect.forEach(["incumbent", "research_executor"] as const, (role) =>
                Effect.gen(function* () {
                  if (prior && prior.roles[role] === next.roles[role]) return
                  const selected = next.history[next.roles[role]]
                  const support = yield* tx
                    .select({ data: ProContractTable.data })
                    .from(ProContractTable)
                    .where(eq(ProContractTable.id, selected.contractID))
                    .get()
                    .pipe(Effect.orDie)
                  if (!standing(support?.data, selected))
                    return yield* Effect.die(new Error("Policy support changed before selection"))
                }),
              )
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
            uncertainties: [
              "Acceptance is limited to this exact subject and evidence; it does not authorize other roles.",
            ],
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

    const researchGrant = Effect.fnUntraced(function* (
      scope: string,
      protocolHash: string,
      version: Version,
      now: number,
      qualification?: Qualification,
    ) {
      const brief = JSON.stringify({
        kind: "policy-research-use-v1",
        scope,
        protocolHash,
        bundleHash: version.bundleHash,
        ...(qualification ? { qualification } : {}),
      })
      const id = ProContract.ID.make(`pct_policy_research_${Hash.sha256(brief)}`)
      const existing = yield* contracts.get(id)
      const issued = yield* contracts.issue({
        id,
        scope,
        executor: "policy-authority",
        spec: existing?.spec ?? {
          ...ProContract.defaultSpec(
            "Authorize research use only; neither deployment nor better research ability is claimed",
            now,
          ),
          brief,
          requires: [],
          authority: [],
          resolution: { maxAttempts: 1, retryDelay: 0 },
        },
      })
      requireAccepted(issued)
      const support = yield* attest(
        issued.contract!,
        version.bundleHash,
        qualification?.evidenceHash ?? Hash.sha256(brief),
        now,
      )
      return {
        contractID: support.id,
        revision: support.revision,
        subjectHash: version.bundleHash,
        specHash: support.specHash,
        attestationID: support.attestationID,
        bundle: version.bundle,
        bundleHash: version.bundleHash,
        role: "research_executor" as const,
      }
    })

    const researcher = Effect.fnUntraced(function* (state: State, contractID: ProContract.ID, runID?: string) {
      const contract = yield* contracts.get(contractID)
      if (contract?.executor.startsWith("version:")) {
        if (!runID) return yield* Effect.die(new Error("Executable research requires the actual run identity"))
        const brief = Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({
              kind: Schema.Literal("version-run-v1"),
              versionHash: ProContractPromotion.Digest,
              bundleHash: ProContractPromotion.Digest,
              role: Schema.Literal("research_executor"),
              authorization: ProContract.ExecutionAuthorization,
              targetVersion: ProContractPromotion.Digest,
              targetExecutable: Schema.optional(ProContractPromotion.Digest),
            }),
          ),
        )(contract.spec.brief)
        const selected = state.history.find(
          (selection) =>
            (!selection.role || selection.role === "research_executor") &&
            selection.bundleHash === brief.bundleHash &&
            selection.bundle.version === 2 &&
            selection.bundle.versionHash === brief.versionHash &&
            selection.contractID === brief.authorization.contractID &&
            selection.revision === brief.authorization.revision &&
            selection.subjectHash === brief.authorization.subjectHash &&
            (!selection.specHash || selection.specHash === brief.authorization.specHash) &&
            (!selection.attestationID || selection.attestationID === brief.authorization.attestationID),
        )
        const target = state.versions.find((version) => version.bundleHash === brief.targetVersion)
        if (!target || (target.bundle.version === 2 ? target.bundle.versionHash : undefined) !== brief.targetExecutable)
          return yield* Effect.die(new Error("Research target source differs from the archived target version"))
        const run = yield* Effect.promise(() => versions.read(runID))
        const request = Schema.decodeUnknownSync(
          Schema.Struct({
            versionHash: ProContractPromotion.Digest,
            targetVersion: Schema.optional(ProContractPromotion.Digest),
            task: Schema.Json,
            deadline: Schema.Int,
          }),
        )(yield* Effect.promise(() => versions.request(runID)))
        const task = Schema.decodeUnknownSync(
          Schema.Struct({ contractID: ProContract.ID, revision: Schema.Int, specHash: Schema.NonEmptyString }),
        )(request.task)
        if (
          !selected ||
          contract.executor !== `version:${brief.versionHash}` ||
          run.versionHash !== brief.versionHash ||
          request.versionHash !== brief.versionHash ||
          task.contractID !== contract.id ||
          task.revision !== contract.revision ||
          task.specHash !== contract.specHash ||
          request.targetVersion !== brief.targetExecutable ||
          run.targetVersion !== brief.targetExecutable
        )
          return yield* Effect.die(new Error("Executable research provenance differs from the frozen Contract and run"))
        return { selection: selected, run, deadline: request.deadline, targetVersion: brief.targetVersion }
      }
      const binding = yield* database.db
        .select({ data: ProContractOpenCodeTable.data })
        .from(ProContractOpenCodeTable)
        .where(eq(ProContractOpenCodeTable.contract_id, contractID))
        .get()
        .pipe(Effect.orDie)
      const selected = state.history.find((selection) => {
        if (selection.bundle.version !== 1) return false
        if (selection.role && selection.role !== "research_executor") return false
        if (binding?.data.executionPolicy !== selection.bundle.generator) return false
        const authorization = binding.data.authorization
        if (authorization)
          return (
            authorization.contractID === selection.contractID &&
            authorization.revision === selection.revision &&
            authorization.subjectHash === selection.subjectHash &&
            (!selection.specHash || authorization.specHash === selection.specHash) &&
            (!selection.attestationID || authorization.attestationID === selection.attestationID)
          )
        // Only historical grants accept the historical evidence/permission conflation.
        return (
          !selection.role &&
          contract?.spec.requires.some(
            (requirement) =>
              requirement.contractID === selection.contractID && requirement.revision === selection.revision,
          )
        )
      })
      if (!selected)
        return yield* Effect.die(new Error("Research execution has no exact authorized researcher provenance"))
      return { selection: selected, run: undefined, deadline: contract?.spec.budget.deadline, targetVersion: undefined }
    })

    const recordExperiment = Effect.fnUntraced(function* (state: State, input: Experiment) {
      const experiment = Schema.decodeUnknownSync(Experiment, { onExcessProperty: "error" })(input)
      const prior = state.experiments.find((item) => item.id === experiment.id)
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(experiment))
          return yield* Effect.die(new Error("Conflicting research experiment retry"))
        return state
      }
      const source = yield* contracts.get(experiment.source.contractID)
      if (!source || source.revision !== experiment.source.revision)
        return yield* Effect.die(new Error("Research experiment source revision changed"))
      const execution = yield* researcher(state, source.id, experiment.source.runID)
      if (
        execution.selection.bundleHash !== experiment.executorHash ||
        !state.versions.some((version) => version.bundleHash === experiment.targetVersion) ||
        (experiment.candidateHash && !state.versions.some((version) => version.bundleHash === experiment.candidateHash))
      )
        return yield* Effect.die(new Error("Research experiment versions do not match the archive and execution"))
      if (
        execution.run &&
        (execution.targetVersion !== experiment.targetVersion ||
          execution.run.startedAt !== experiment.budget.startedAt ||
          execution.run.completedAt !== experiment.budget.finishedAt ||
          execution.deadline !== experiment.budget.deadline)
      )
        return yield* Effect.die(new Error("Research accounting differs from the immutable executable run"))
      if (experiment.budget.startedAt > experiment.budget.finishedAt)
        return yield* Effect.die(new Error("Invalid research accounting interval"))
      return yield* commit(state, {
        ...state,
        revision: state.revision + 1,
        experiments: [...state.experiments, experiment],
      })
    })

    const validateCandidate = Effect.fnUntraced(function* (request: CandidateInput) {
      const state = yield* requireState(request.scope, request.expectedRevision)
      const candidateHash = hashBundle(request.bundle)
      const generation = yield* contracts.get(request.generation.contractID)
      if (
        !generation ||
        !["verification", "discharged"].includes(generation.status) ||
        generation.revision !== request.generation.revision ||
        generation.handoff?.subjectHash !== request.generation.subjectHash
      )
        return yield* Effect.die(new Error("Candidate generation is not an exact frozen research handoff"))
      const execution = yield* researcher(state, generation.id, request.generation.runID)
      const executor = execution.selection
      if (
        execution.run &&
        (execution.run.status !== "completed" ||
          ProContractVersion.subjectHash(execution.run) !== request.generation.subjectHash)
      )
        return yield* Effect.die(new Error("Candidate generation must name the exact completed handoff run"))
      const targetVersion = request.targetVersion ?? executor.bundleHash
      if (!state.versions.some((version) => version.bundleHash === targetVersion))
        return yield* Effect.die(new Error("Unknown research target version"))
      if (execution.run) {
        const run = execution.run
        if (execution.targetVersion !== targetVersion)
          return yield* Effect.die(new Error("Research target differs from the frozen executable run"))
        const directory = yield* Effect.promise(() => versions.artifactDirectory(run.id))
        const file = path.join(directory, "strategy.json")
        const info = yield* Effect.promise(() => lstat(file))
        if (!info.isFile() || info.size > 1024 * 1024)
          return yield* Effect.die(new Error("Generated strategy.json must be a bounded regular file"))
        const generated = Schema.decodeUnknownSync(Schema.fromJsonString(Bundle))(
          yield* Effect.promise(() => Bun.file(file).text()),
          { onExcessProperty: "error" },
        )
        if (
          request.bundle.version !== 2 ||
          generated.solver !== request.bundle.solver ||
          generated.generator !== request.bundle.generator ||
          (generated.version === 2 && generated.versionHash !== request.bundle.versionHash)
        )
          return yield* Effect.die(new Error("Candidate policy text differs from actual executable generation"))
        const manifest = yield* Effect.promise(() =>
          versions.inspect(request.bundle.version === 2 ? request.bundle.versionHash : ""),
        )
        if (generated.version === 1 && manifest.config !== null)
          return yield* Effect.die(
            new Error("Non-default candidate configuration must be committed by the generated versionHash"),
          )
        yield* Effect.promise(() =>
          versions.candidate(run.id, request.bundle.version === 2 ? request.bundle.versionHash : ""),
        )
      }
      if (!execution.run)
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
              if (generated.version === 2)
                yield* Effect.promise(() => versions.source(generated.versionHash, path.join(directory, "candidate")))
            }),
          (temporary) => Effect.promise(() => rm(temporary, { recursive: true, force: true })),
        )
      return { state, candidateHash, executor, targetVersion }
    })

    const archive = Effect.fnUntraced(function* (
      state: State,
      bundle: Bundle,
      provenance: Version["generations"][number],
    ) {
      const current = yield* contracts.get(provenance.handoff.contractID)
      if (
        !current ||
        !["verification", "discharged"].includes(current.status) ||
        current.revision !== provenance.handoff.revision ||
        current.handoff?.subjectHash !== provenance.handoff.subjectHash
      )
        return yield* Effect.die(new Error("Generation handoff changed before archival admission"))
      const bundleHash = hashBundle(bundle)
      const archived = state.versions.find((version) => version.bundleHash === bundleHash)
      if (
        archived?.generations.some(
          (item) =>
            item.handoff.contractID === provenance.handoff.contractID &&
            item.handoff.revision === provenance.handoff.revision &&
            item.handoff.subjectHash === provenance.handoff.subjectHash &&
            item.handoff.runID === provenance.handoff.runID,
        )
      )
        return state
      const version = { bundle, bundleHash, generations: [...(archived?.generations ?? []), provenance] }
      return yield* commit(state, {
        ...state,
        versions: archived
          ? state.versions.map((item) => (item.bundleHash === bundleHash ? version : item))
          : [...state.versions, version],
      })
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
                const research = yield* researchGrant(
                  request.scope,
                  protocolHash,
                  {
                    bundle: request.bundle,
                    bundleHash,
                    generations: [],
                  },
                  request.now,
                )
                return yield* commit(undefined, {
                  version: 2,
                  roles: { incumbent: 0, research_executor: 1 },
                  transitions: [
                    { role: "incumbent", selection: 0, revision: 1 },
                    { role: "research_executor", selection: 1, revision: 1 },
                  ],
                  versions: [{ bundle: request.bundle, bundleHash, generations: [] }],
                  experiments: [],
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
                      specHash: support.specHash,
                      attestationID: support.attestationID,
                      bundle: request.bundle,
                      bundleHash,
                      role: "incumbent",
                    },
                    research,
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
        const role = roleName(input.role)
        const state = yield* requireState(input.scope)
        const selected = yield* requireStanding(state.history[state.roles[role]])
        const support = (yield* contracts.get(selected.contractID))!
        return {
          executionPolicy: selected.bundle[role === "incumbent" ? "solver" : "generator"],
          authorization: {
            contractID: support.id,
            revision: support.revision,
            specHash: support.specHash,
            subjectHash: selected.subjectHash,
            attestationID: support.attestationID!,
          },
          ...(selected.bundle.version === 2 ? { versionHash: selected.bundle.versionHash } : {}),
          identity: { scope: state.scope, revision: state.revision, bundleHash: selected.bundleHash, role },
        }
      }),
      archiveCandidate: Effect.fn("ProContractPolicy.archiveCandidate")(function* (input) {
        const request = structuredClone(input)
        const candidate = yield* validateCandidate(request)
        return yield* database.db
          .transaction(
            () =>
              Effect.gen(function* () {
                const state = yield* requireState(request.scope, request.expectedRevision)
                return yield* archive(state, request.bundle, {
                  handoff: request.generation,
                  executorHash: candidate.executor.bundleHash,
                  targetVersion: candidate.targetVersion,
                })
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      propose: Effect.fn("ProContractPolicy.propose")(function* (input) {
        const request = structuredClone(input)
        const candidate = yield* validateCandidate(request)
        const selected = yield* requireStanding(candidate.state.history[candidate.state.selected])
        if (candidate.candidateHash === selected.bundleHash)
          return yield* Effect.die(new Error("Candidate is identical to the selected policy"))
        return yield* database.db
          .transaction(
            () =>
              Effect.gen(function* () {
                const currentState = yield* requireState(request.scope, request.expectedRevision)
                yield* requireStanding(selected)
                yield* requireAdmissible(currentState, candidate.candidateHash, "incumbent")
                const proposal = Proposal.make({
                  kind: "policy-promotion-v1",
                  scope: request.scope,
                  expectedRevision: request.expectedRevision,
                  protocolHash: currentState.protocolHash,
                  baselineHash: selected.bundleHash,
                  baselineSupport: {
                    contractID: selected.contractID,
                    revision: selected.revision,
                    subjectHash: selected.subjectHash,
                  },
                  candidateHash: candidate.candidateHash,
                  bundle: request.bundle,
                  generation: request.generation,
                  executorHash: candidate.executor.bundleHash,
                  targetVersion: candidate.targetVersion,
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
                yield* archive(currentState, request.bundle, {
                  handoff: request.generation,
                  executorHash: candidate.executor.bundleHash,
                  targetVersion: candidate.targetVersion,
                })
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
                  state.history[state.selected].bundleHash !== proposal.baselineHash ||
                  (proposal.baselineSupport
                    ? state.history[state.selected].contractID !== proposal.baselineSupport.contractID ||
                      state.history[state.selected].revision !== proposal.baselineSupport.revision ||
                      state.history[state.selected].subjectHash !== proposal.baselineSupport.subjectHash
                    : state.revision !== proposal.expectedRevision)
                )
                  return yield* Effect.die(new Error("Policy proposal baseline is no longer selected"))
                yield* requireStanding(state.history[state.selected])
                // A direct challenge of historical support need not change the
                // selection revision. Recheck live standing under this lock.
                yield* requireAdmissible(state, proposal.candidateHash, "incumbent")
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
                    specHash: support.specHash,
                    attestationID: support.attestationID,
                    bundle: proposal.bundle,
                    bundleHash: proposal.candidateHash,
                    role: "incumbent" as const,
                  },
                ]
                const next = yield* commit(state, {
                  ...state,
                  revision: state.revision + 1,
                  selected: history.length - 1,
                  roles: { ...state.roles, incumbent: history.length - 1 },
                  transitions: [
                    ...state.transitions,
                    { role: "incumbent", selection: history.length - 1, revision: state.revision + 1 },
                  ],
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
      selectResearch: Effect.fn("ProContractPolicy.selectResearch")(function* (input) {
        const request = structuredClone(input)
        return yield* database.db
          .transaction(
            () =>
              Effect.gen(function* () {
                const state = yield* requireState(request.scope, request.expectedRevision)
                const version = state.versions.find((item) => item.bundleHash === request.bundleHash)
                if (!version) return yield* Effect.die(new Error("Research version is not archived"))
                const qualification = request.qualification
                  ? Schema.decodeUnknownSync(Qualification, { onExcessProperty: "error" })(request.qualification)
                  : undefined
                if (qualification && version.bundle.version === 2) {
                  if (!qualification.runID)
                    return yield* Effect.die(new Error("Executable research qualification needs an actual startup run"))
                  const run = yield* Effect.promise(() => versions.read(qualification.runID!))
                  const input = Schema.decodeUnknownSync(
                    Schema.Struct({
                      versionHash: ProContractPromotion.Digest,
                      task: Schema.Struct({ purpose: Schema.Literal("qualification") }),
                    }),
                  )(yield* Effect.promise(() => versions.request(qualification.runID!)))
                  if (
                    run.status !== "completed" ||
                    run.versionHash !== version.bundle.versionHash ||
                    input.versionHash !== version.bundle.versionHash ||
                    ProContractVersion.subjectHash(run) !== qualification.evidenceHash
                  )
                    return yield* Effect.die(
                      new Error("Research qualification does not identify a completed run of the exact candidate"),
                    )
                  yield* Effect.promise(() =>
                    versions.inspect(version.bundle.version === 2 ? version.bundle.versionHash : ""),
                  )
                  yield* Effect.promise(() => versions.artifactDirectory(run.id))
                }
                if (qualification?.runID && version.bundle.version === 1)
                  return yield* Effect.die(new Error("A text policy cannot claim executable qualification"))
                const qualified =
                  qualification !== undefined ||
                  state.history.some((item) => item.bundleHash === version.bundleHash) ||
                  state.evaluations.some(
                    (item) => item.evidence.candidateHash === version.bundleHash && item.decision.safety,
                  )
                if (!qualified)
                  return yield* Effect.die(
                    new Error("Research use requires independent safety qualification, not deployment improvement"),
                  )
                yield* requireAdmissible(state, version.bundleHash, "research_executor")
                const existing = state.history.findIndex(
                  (item) => item.bundleHash === version.bundleHash && item.role === "research_executor",
                )
                const grant =
                  existing >= 0
                    ? state.history[existing]
                    : yield* researchGrant(state.scope, state.protocolHash, version, request.now, qualification)
                yield* requireStanding(grant)
                if (existing >= 0 && qualification) {
                  const support = (yield* contracts.get(grant.contractID))!
                  const attestation = yield* contracts.getAttestation(support.attestationID!)
                  if (attestation?.evidenceHash !== qualification.evidenceHash)
                    return yield* Effect.die(
                      new Error("A research grant is immutable; selecting it cannot replace its evidence"),
                    )
                }
                const index = existing >= 0 ? existing : state.history.length
                if (state.roles.research_executor === index) return state
                return yield* commit(state, {
                  ...state,
                  revision: state.revision + 1,
                  roles: { ...state.roles, research_executor: index },
                  transitions: [
                    ...state.transitions,
                    { role: "research_executor", selection: index, revision: state.revision + 1 },
                  ],
                  history: existing >= 0 ? state.history : [...state.history, grant],
                })
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      recordExperiment: Effect.fn("ProContractPolicy.recordExperiment")(function* (input) {
        const request = structuredClone(input)
        return yield* database.db
          .transaction(
            () =>
              Effect.gen(function* () {
                const state = yield* requireState(request.scope, request.expectedRevision)
                return yield* recordExperiment(state, request.experiment)
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      completeResearch: Effect.fn("ProContractPolicy.completeResearch")(function* (input) {
        const request = structuredClone(input)
        return yield* database.db
          .transaction(
            () =>
              Effect.gen(function* () {
                const state = yield* requireState(request.scope, request.expectedRevision)
                const contract = yield* contracts.get(request.generation.contractID)
                if (
                  !contract ||
                  !["verification", "discharged"].includes(contract.status) ||
                  contract.revision !== request.generation.revision ||
                  contract.handoff?.subjectHash !== request.generation.subjectHash ||
                  request.experiment.source.contractID !== contract.id ||
                  request.experiment.source.revision !== contract.revision ||
                  request.experiment.source.runID !== request.generation.runID
                )
                  return yield* Effect.die(new Error("Research completion does not match the frozen report"))
                const execution = yield* researcher(state, contract.id, request.generation.runID)
                if (
                  execution.run &&
                  (execution.run.status !== "completed" ||
                    ProContractVersion.subjectHash(execution.run) !== request.generation.subjectHash)
                )
                  return yield* Effect.die(new Error("Research completion must name the exact completed handoff run"))
                const next = yield* recordExperiment(state, request.experiment)
                const accepted = yield* attest(
                  contract,
                  request.generation.subjectHash,
                  request.experiment.evidenceHash,
                  request.now,
                )
                return { state: next, contract: accepted }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      view: Effect.fn("ProContractPolicy.view")(function* (input) {
        const state = yield* requireState(input.scope)
        // Confirmation measurements never enter this research-facing projection.
        const versions = input.versionHashes.map((hash) => {
          const version = state.versions.find((item) => item.bundleHash === hash)
          if (!version) throw new Error("Requested research version is not archived")
          return version
        })
        const experiments = input.experimentIDs.map((id) => {
          const experiment = state.experiments.find((item) => item.id === id)
          if (!experiment) throw new Error("Requested research experiment is not archived")
          return experiment
        })
        return { versions, experiments }
      }),
      rollback: Effect.fn("ProContractPolicy.rollback")(function* (input) {
        const request = structuredClone(input)
        return yield* database.db
          .transaction(
            () =>
              Effect.gen(function* () {
                const state = yield* requireState(request.scope, request.expectedRevision)
                const role = roleName(request.role ?? "incumbent")
                const transitions = state.transitions
                  .filter((entry) => entry.role === role)
                  .slice(0, -1)
                  .reverse()
                const candidates = transitions.length
                  ? transitions.map((entry) => entry.selection)
                  : state.history[state.roles[role]].role
                    ? []
                    : state.history
                        .slice(0, state.roles[role])
                        .map((_, index) => index)
                        .reverse()
                const previous = yield* Effect.findFirst(
                  candidates.filter((index) => index !== state.roles[role]),
                  (index) =>
                    contracts
                      .get(state.history[index].contractID)
                      .pipe(Effect.map((contract) => standing(contract, state.history[index]))),
                )
                if (previous._tag === "None")
                  return yield* Effect.die(new Error("No previously authorized policy retains standing"))
                return yield* commit(state, {
                  ...state,
                  revision: state.revision + 1,
                  selected: role === "incumbent" ? previous.value : state.selected,
                  roles: { ...state.roles, [role]: previous.value },
                  transitions: [
                    ...state.transitions,
                    { role, selection: previous.value, revision: state.revision + 1 },
                  ],
                })
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      revoke: Effect.fn("ProContractPolicy.revoke")(function* (input) {
        const request = structuredClone(input)
        return yield* database.db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const state = yield* requireState(request.scope, request.expectedRevision)
                const selected = state.history[state.roles[roleName(request.role ?? "incumbent")]]
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
                // Withdrawal fences execution authorization, not independent result evidence.
                // Keep this role visible until an explicit authorized rollback.
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

function roleName(role: RoleInput): Role {
  if (role === "solver" || role === "incumbent") return "incumbent"
  if (role === "generator" || role === "research_executor") return "research_executor"
  throw new Error("Unknown policy role")
}

function currentState(state: State | LegacyState): State {
  if ("version" in state && state.version === 2)
    return {
      ...state,
      transitions: state.transitions ?? [
        { role: "incumbent", selection: state.roles.incumbent, revision: state.revision },
        { role: "research_executor", selection: state.roles.research_executor, revision: state.revision },
      ],
    }
  return {
    ...state,
    version: 2,
    roles: { incumbent: state.selected, research_executor: state.selected },
    transitions: [
      { role: "incumbent", selection: state.selected, revision: state.revision },
      { role: "research_executor", selection: state.selected, revision: state.revision },
    ],
    versions: state.history
      .filter((item, index) => state.history.findIndex((other) => other.bundleHash === item.bundleHash) === index)
      .map((item) => ({ bundle: item.bundle, bundleHash: item.bundleHash, generations: [] })),
    experiments: [],
  }
}

function standing(contract: ProContract.Contract | undefined, selection: Selection) {
  return (
    contract?.status === "discharged" &&
    !contract.pendingRevision &&
    !!contract.attestationID &&
    contract.revision === selection.revision &&
    contract.handoff?.subjectHash === selection.subjectHash &&
    (!selection.specHash || contract.specHash === selection.specHash) &&
    (!selection.attestationID || contract.attestationID === selection.attestationID)
  )
}

function requireAccepted(receipt: ProContract.Receipt) {
  if (receipt.decision.type === "rejected") throw new Error(receipt.decision.reason)
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, ProContract.node, ProContractExport.node, Global.node],
})
