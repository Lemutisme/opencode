export * as ProContractRun from "./run"

import { Cause, Context, Effect, Exit, Layer, Schedule, Schema } from "effect"
import { cp, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Model } from "@opencode-ai/schema/model"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { Global } from "../global"
import { ProContract } from "../pro-contract"
import { AbsolutePath } from "../schema"
import { Flock } from "../util/flock"
import { Hash } from "../util/hash"
import { ProContractOpenCode } from "./open-code"
import { ProContractPolicy } from "./policy"
import { ProContractVersion } from "./version"
import { ProContractReason } from "./reason"

export const View = Schema.Struct({
  versionHashes: Schema.Array(Schema.String),
  experimentIDs: Schema.Array(Schema.String),
  contractIDs: Schema.optional(Schema.Array(ProContract.ID)),
})

const Request = Schema.Struct({
  kind: Schema.Literal("version-run-v1"),
  scope: Schema.NonEmptyString,
  role: Schema.Literals(["incumbent", "research_executor"]),
  versionHash: Schema.String,
  bundleHash: Schema.String,
  executionPolicy: Schema.String,
  authorization: ProContract.ExecutionAuthorization,
  targetVersion: Schema.String,
  targetExecutable: Schema.optional(Schema.String),
  task: Schema.Json,
  view: View,
  workspace: AbsolutePath,
  model: Schema.optional(Model.Ref),
})

const Response = Schema.Struct({
  id: Schema.String,
  ...ProContractReason.Observation.fields,
})
const Journal = Schema.Struct({
  contractID: ProContract.ID,
  runs: Schema.Array(Schema.String),
  responses: Schema.Array(Response),
  reasoning: Schema.Array(Schema.Struct({ runID: Schema.String, id: Schema.String, contractID: ProContract.ID })),
})

export interface Interface {
  readonly issue: (input: {
    id?: ProContract.ID
    scope: string
    role: ProContractPolicy.Role
    task: Schema.Json
    workspace: AbsolutePath
    deadline: number
    targetVersion?: string
    view?: typeof View.Type
    model?: Model.Ref
    requires?: ReadonlyArray<ProContract.Requirement>
    now: number
  }) => Effect.Effect<ProContract.Contract>
  readonly execute: (input: { contractID: ProContract.ID; resume?: boolean }) => Effect.Effect<{
    contract: ProContract.Contract
    run: ProContractVersion.Record
  }>
  readonly get: (contractID: ProContract.ID) => Effect.Effect<{
    contract: ProContract.Contract
    runs: ProContractVersion.Record[]
    pending: string[]
    responses: ReadonlyArray<typeof Response.Type>
    reasoning: ReadonlyArray<(typeof Journal.Type.reasoning)[number]>
  }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractRun") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const contracts = yield* ProContract.Service
    const policies = yield* ProContractPolicy.Service
    const reasons = yield* ProContractReason.Service
    const global = yield* Global.Service
    const directory = ProContractVersion.storePath(global.data)
    const versions = ProContractVersion.make({ directory })
    const filename = (id: ProContract.ID) => path.join(directory, "contracts", Hash.sha256(id) + ".json")

    const journal = Effect.fnUntraced(function* (contractID: ProContract.ID) {
      const file = Bun.file(filename(contractID))
      if (!(yield* Effect.promise(() => file.exists())))
        return { contractID, runs: [], responses: [], reasoning: [] } satisfies typeof Journal.Type
      const result = Schema.decodeUnknownSync(Schema.fromJsonString(Journal))(yield* Effect.promise(() => file.text()))
      if (result.contractID !== contractID) return yield* Effect.die("Version run journal names another Contract")
      return result
    })
    const save = Effect.fnUntraced(function* (value: typeof Journal.Type) {
      yield* Effect.promise(async () => {
        await mkdir(path.dirname(filename(value.contractID)), { recursive: true, mode: 0o700 })
        const pending = filename(value.contractID) + ".pending"
        await Bun.write(pending, JSON.stringify(value))
        await rename(pending, filename(value.contractID))
      })
    })
    const requireContract = Effect.fnUntraced(function* (id: ProContract.ID) {
      const contract = yield* contracts.get(id)
      if (!contract || !contract.executor.startsWith("version:")) return yield* Effect.die("Version Contract not found")
      const request = Schema.decodeUnknownSync(Schema.fromJsonString(Request))(contract.spec.brief)
      if (contract.executor !== `version:${request.versionHash}` || contract.scope !== request.scope)
        return yield* Effect.die("Version Contract execution identity changed")
      return { contract, request }
    })
    const inspect = Effect.fnUntraced(function* (contractID: ProContract.ID) {
      const current = yield* requireContract(contractID)
      const recorded = yield* journal(contractID)
      const outcomes = yield* Effect.forEach(recorded.runs, (id) =>
        Effect.promise(async () => {
          if (
            !(await Bun.file(path.join(directory, "runs", id, "result.json")).exists()) ||
            !(await Bun.file(path.join(directory, "runs", id, "result.sha256")).exists())
          )
            return { id }
          const run = await versions.read(id)
          const envelope = Schema.decodeUnknownSync(
            Schema.Struct({
              task: Schema.Struct({ contractID: ProContract.ID, revision: Schema.Number, specHash: Schema.String }),
            }),
          )(await versions.request(id))
          if (
            run.versionHash !== current.request.versionHash ||
            envelope.task.contractID !== contractID ||
            envelope.task.revision !== current.contract.revision ||
            envelope.task.specHash !== current.contract.specHash
          )
            throw new Error("Run receipt differs from the frozen Contract")
          return { id, run }
        }),
      )
      return {
        contract: current.contract,
        runs: outcomes.flatMap((item) => (item.run ? [item.run] : [])),
        pending: outcomes.filter((item) => !item.run).map((item) => item.id),
        responses: recorded.responses,
        reasoning: recorded.reasoning,
      }
    })

    const executable = Effect.fnUntraced(function* (contractID: ProContract.ID) {
      const current = yield* requireContract(contractID)
      const support = yield* contracts.get(current.request.authorization.contractID)
      if (
        current.contract.status !== "active" ||
        current.contract.pendingRevision !== undefined ||
        !ProContractOpenCode.authorizationMatches(support, current.request.authorization) ||
        Date.now() >= current.contract.spec.budget.deadline
      )
        return yield* Effect.die("Version execution is no longer authorized at the original deadline")
      return current
    })

    return Service.of({
      get: inspect,
      issue: Effect.fn("ProContractRun.issue")(function* (input) {
        const request = structuredClone(input)
        if (!Number.isSafeInteger(request.deadline)) return yield* Effect.die("An absolute deadline is required")
        const workspace = yield* Effect.promise(() => realpath(request.workspace))
        const protectedPaths = yield* Effect.promise(() =>
          Promise.all(
            [global.data, global.config, global.state, global.cache].map((location) =>
              realpath(location).catch((error: unknown) => {
                if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
                  return path.resolve(location)
                throw error
              }),
            ),
          ),
        )
        if (protectedPaths.some((protectedPath) => overlaps(workspace, protectedPath)))
          return yield* Effect.die("Workspace must not overlap protected host storage")
        request.workspace = AbsolutePath.make(workspace)
        return yield* database.db
          .transaction(
            () =>
              Effect.gen(function* () {
                // A retry adopts the original version, even after either role changes.
                if (request.id && (yield* contracts.get(request.id))) {
                  const prior = yield* requireContract(request.id)
                  if (
                    prior.request.scope !== request.scope ||
                    prior.request.role !== request.role ||
                    prior.request.workspace !== request.workspace ||
                    prior.contract.spec.budget.deadline !== request.deadline ||
                    (request.targetVersion !== undefined && prior.request.targetVersion !== request.targetVersion) ||
                    JSON.stringify(prior.request.task) !== JSON.stringify(request.task) ||
                    JSON.stringify(prior.request.view) !==
                      JSON.stringify(request.view ?? { versionHashes: [], experimentIDs: [] }) ||
                    JSON.stringify(prior.request.model) !== JSON.stringify(request.model) ||
                    JSON.stringify(prior.contract.spec.requires) !== JSON.stringify(request.requires ?? [])
                  )
                    return yield* Effect.die("Version run retry differs from its immutable execution binding")
                  return prior.contract
                }
                if (request.deadline <= request.now) return yield* Effect.die("A future absolute deadline is required")
                const selected = yield* policies.bind({ scope: request.scope, role: request.role })
                if (!selected.versionHash) return yield* Effect.die("Selected strategy has no executable version")
                yield* Effect.promise(() => versions.inspect(selected.versionHash!))
                const targetVersion = request.targetVersion ?? selected.identity.bundleHash
                const target = yield* policies.view({
                  scope: request.scope,
                  versionHashes: [targetVersion],
                  experimentIDs: [],
                })
                const bundle = target.versions.find((version) => version.bundleHash === targetVersion)?.bundle
                if (!bundle) return yield* Effect.die("Research target is not in the authorized version archive")
                const view = request.view ?? { versionHashes: [], experimentIDs: [] }
                yield* policies.view({ scope: request.scope, ...view })
                yield* Effect.forEach(view.contractIDs ?? [], (id) =>
                  contracts
                    .get(id)
                    .pipe(
                      Effect.flatMap((contract) =>
                        contract ? Effect.void : Effect.die("Permitted Contract view names a missing duty"),
                      ),
                    ),
                )
                const frozen = Request.make({
                  kind: "version-run-v1",
                  scope: request.scope,
                  role: request.role,
                  versionHash: selected.versionHash,
                  bundleHash: selected.identity.bundleHash,
                  executionPolicy: selected.executionPolicy,
                  authorization: selected.authorization,
                  targetVersion,
                  targetExecutable: bundle.version === 2 ? bundle.versionHash : undefined,
                  task: request.task,
                  view,
                  workspace: request.workspace,
                  model: request.model,
                })
                const existing = request.id ? yield* contracts.get(request.id) : undefined
                if (
                  existing &&
                  (existing.spec.brief !== JSON.stringify(frozen) || existing.spec.budget.deadline !== request.deadline)
                )
                  return yield* Effect.die("Version run retry differs from its immutable execution binding")
                const receipt = yield* contracts.issue({
                  id: request.id,
                  scope: request.scope,
                  executor: `version:${selected.versionHash}`,
                  spec: existing?.spec ?? {
                    ...ProContract.defaultSpec(
                      `Execute the authorized task: ${JSON.stringify(request.task)}`,
                      request.now,
                    ),
                    brief: JSON.stringify(frozen),
                    authority: [],
                    budget: { deadline: request.deadline },
                    requires: request.requires ?? [],
                  },
                })
                accepted(receipt)
                return receipt.contract!
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      execute: Effect.fn("ProContractRun.execute")(function* (input) {
        yield* Flock.effect(`version:${input.contractID}`, { dir: path.join(directory, "locks"), timeoutMs: 5_000 })
        const original = yield* requireContract(input.contractID)
        const history = yield* inspect(input.contractID)
        if (["verification", "discharged", "released"].includes(original.contract.status)) {
          const last = history.runs.at(-1)
          if (!last) return yield* Effect.die("Closed version Contract has no retained run")
          return { contract: original.contract, run: last }
        }
        const unresolved = history.reasoning.filter(
          (entry) => !history.responses.some((response) => response.id === entry.id),
        )
        if ((history.pending.length || unresolved.length) && !input.resume) {
          yield* contracts.escalate({
            contractID: input.contractID,
            revision: original.contract.revision,
            reason: "Interrupted version invocation retained; explicit recovery required",
            time: Date.now(),
          })
          return yield* Effect.die("Interrupted invocation requires explicit resume; no automatic replay")
        }
        yield* database.db
          .transaction(
            () =>
              Effect.gen(function* () {
                const current = yield* requireContract(input.contractID)
                const support = yield* contracts.get(current.request.authorization.contractID)
                if (!ProContractOpenCode.authorizationMatches(support, current.request.authorization))
                  return yield* Effect.die("Version execution authorization was withdrawn")
                if (Date.now() >= current.contract.spec.budget.deadline)
                  return yield* Effect.die("Original version execution deadline exhausted")
                if (current.contract.status === "escalated") {
                  if (!input.resume) return yield* Effect.die("Version execution requires explicit resume")
                  accepted(yield* contracts.resume(input.contractID))
                }
                const ready = (yield* contracts.get(input.contractID))!
                if (ready.status === "dormant")
                  accepted(yield* contracts.activate(ready.id, ready.revision, Date.now()))
                if ((yield* contracts.get(input.contractID))?.status !== "active")
                  return yield* Effect.die("Version Contract is not executable")
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)

        return yield* Effect.gen(function* () {
          const settlement = { started: false }
          const maintain = Effect.gen(function* () {
            if (settlement.started) return
            const current = yield* executable(input.contractID)
            if (
              current.contract.revision !== original.contract.revision ||
              current.contract.specHash !== original.contract.specHash
            )
              return yield* Effect.die("Version Contract changed during execution")
          }).pipe(Effect.repeat(Schedule.spaced("100 millis")), Effect.andThen(Effect.never))
          const work = Effect.gen(function* () {
            // The method, not this host, decides whether to request another reasoning observation.
            // Every process invocation and native request is durably named before it starts.
            while (true) {
              const current = yield* executable(input.contractID)
              const recorded = yield* journal(input.contractID)
              const previous = yield* inspect(input.contractID)
              const archive = yield* policies.view({ scope: current.request.scope, ...current.request.view })
              const permitted = yield* Effect.forEach(current.request.view.contractIDs ?? [], (id) =>
                contracts.get(id).pipe(Effect.map((contract) => (contract ? ProContract.info(contract) : null))),
              )
              const id = crypto.randomUUID()
              yield* save({ ...recorded, runs: [...recorded.runs, id] })
              const run = yield* Effect.acquireUseRelease(
                Effect.promise(async () => {
                  const inputs = await Promise.all(
                    recorded.runs.map(async (id) => {
                      const workspace = await versions.input(id)
                      if (workspace?.complete) {
                        const envelope = Schema.decodeUnknownSync(
                          Schema.Struct({
                            versionHash: Schema.String,
                            targetVersion: Schema.optional(Schema.String),
                            task: Schema.Struct({
                              contractID: ProContract.ID,
                              revision: Schema.Number,
                              specHash: Schema.String,
                            }),
                          }),
                        )(await versions.request(id))
                        if (
                          envelope.versionHash !== current.request.versionHash ||
                          envelope.targetVersion !== current.request.targetExecutable ||
                          envelope.task.contractID !== current.contract.id ||
                          envelope.task.revision !== current.contract.revision ||
                          envelope.task.specHash !== current.contract.specHash
                        )
                          throw new Error("Captured input belongs to another frozen execution")
                      }
                      return { id, workspace }
                    }),
                  )
                  const source = inputs.find((item) => item.workspace?.complete)?.id
                  const inputDirectory = source
                    ? await versions.inputDirectory(source)
                    : await realpath(current.request.workspace)
                  if (!source && inputDirectory !== current.request.workspace)
                    throw new Error("Workspace identity changed")
                  const temporary = await mkdtemp(path.join(os.tmpdir(), "opencode-version-input-"))
                  const workspace = source ? path.join(temporary, "workspace") : current.request.workspace
                  if (source)
                    await cp(inputDirectory, workspace, {
                      recursive: true,
                      dereference: false,
                      errorOnExist: true,
                      force: false,
                    }).catch(async (error: unknown) => {
                      await rm(temporary, { recursive: true, force: true })
                      throw error
                    })
                  const stop = new AbortController()
                  const promise = versions.run({
                    id,
                    versionHash: current.request.versionHash,
                    targetVersion: current.request.targetExecutable,
                    task: {
                      contractID: current.contract.id,
                      revision: current.contract.revision,
                      specHash: current.contract.specHash,
                      input: current.request.task,
                    },
                    // Host DTOs contain optional undefined fields; the candidate sees their JSON wire form.
                    view: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
                      JSON.stringify({
                        archive,
                        contracts: permitted,
                        previous: [
                          ...previous.runs.map((item) => ({
                            id: item.id,
                            status: item.status,
                            subjectHash: ProContractVersion.subjectHash(item),
                            error: item.error ?? null,
                            observations: item.result?.observations ?? [],
                          })),
                          ...previous.pending.map((id) => ({
                            id,
                            status: "unknown",
                            subjectHash: null,
                            error: "Prior invocation has no verified final receipt",
                            observations: [],
                          })),
                        ],
                        responses: recorded.responses,
                        unresolvedReasoning: previous.reasoning.filter(
                          (item) => !recorded.responses.some((response) => response.id === item.id),
                        ),
                      }),
                    ),
                    workspace,
                    deadline: current.contract.spec.budget.deadline,
                    signal: stop.signal,
                  })
                  return { temporary, stop, promise }
                }),
                (running) =>
                  Effect.promise((signal) => {
                    const cancel = () => running.stop.abort()
                    signal.addEventListener("abort", cancel, { once: true })
                    if (signal.aborted) cancel()
                    return running.promise.finally(() => signal.removeEventListener("abort", cancel))
                  }),
                (running) =>
                  Effect.promise(async () => {
                    running.stop.abort()
                    await running.promise.catch(() => undefined)
                    await rm(running.temporary, { recursive: true, force: true })
                  }),
              )
              const requests =
                run.result?.requests.filter(
                  (item) =>
                    typeof item === "object" &&
                    item !== null &&
                    !Array.isArray(item) &&
                    "type" in item &&
                    item.type === "reason",
                ) ?? []
              if (run.status === "completed" && requests.length && !current.request.model)
                return yield* Effect.die("Workflow requested native reasoning without an explicit model grant")
              if (run.status === "completed" && current.request.model && requests.length) {
                yield* Effect.forEach(requests, (raw) =>
                  Effect.gen(function* () {
                    const request = Schema.decodeUnknownSync(
                      Schema.Struct({
                        type: Schema.Literal("reason"),
                        id: Schema.NonEmptyString,
                        prompt: Schema.NonEmptyString,
                      }),
                    )(raw, { onExcessProperty: "error" })
                    const saved = yield* journal(input.contractID)
                    if (saved.responses.some((item) => item.id === request.id))
                      return yield* Effect.die("Workflow requested an already available reasoning observation")
                    const childID = ProContract.ID.make(
                      `pct_reason_${Hash.sha256(JSON.stringify([input.contractID, request.id]))}`,
                    )
                    if (!saved.reasoning.some((item) => item.id === request.id))
                      yield* save({
                        ...saved,
                        reasoning: [...saved.reasoning, { runID: id, id: request.id, contractID: childID }],
                      })
                    yield* executable(input.contractID)
                    const location = path.join(directory, "reason-workspaces", Hash.sha256(childID))
                    yield* Effect.promise(() => mkdir(location, { recursive: true, mode: 0o700 }))
                    const response = yield* reasons
                      .run({
                        id: childID,
                        scope: current.request.scope,
                        model: current.request.model!,
                        authorization: current.request.authorization,
                        prompt: request.prompt,
                        deadline: current.contract.spec.budget.deadline,
                        location: { directory: AbsolutePath.make(location) },
                        executionPolicy: current.request.executionPolicy,
                      })
                      .pipe(Effect.orDie)
                    const latest = yield* journal(input.contractID)
                    yield* save({
                      ...latest,
                      responses: [
                        ...latest.responses,
                        {
                          id: request.id,
                          ...response,
                        },
                      ],
                    })
                  }),
                )
                continue
              }
              settlement.started = true
              yield* database.db
                .transaction(
                  () =>
                    Effect.gen(function* () {
                      const latest = yield* contracts.get(input.contractID)
                      if (latest?.status !== "active" || latest.revision !== current.contract.revision) return
                      const support = yield* contracts.get(current.request.authorization.contractID)
                      const allowed = ProContractOpenCode.authorizationMatches(support, current.request.authorization)
                      if (run.status !== "completed" || !allowed || Date.now() >= latest.spec.budget.deadline) {
                        accepted(
                          yield* contracts.escalate({
                            contractID: latest.id,
                            revision: latest.revision,
                            reason: !allowed
                              ? "Version execution authorization withdrawn"
                              : Date.now() >= latest.spec.budget.deadline
                                ? "Original version execution deadline exhausted"
                                : `Version execution ${run.status}: ${run.error ?? "inspect retained run receipt"}`,
                            time: Date.now(),
                          }),
                        )
                        return
                      }
                      accepted(
                        yield* contracts.reportReady({
                          contractID: latest.id,
                          revision: latest.revision,
                          subjectHash: ProContractVersion.subjectHash(run),
                          summary: "Frozen executable task artifacts and observations are ready for independent review",
                          uncertainties: [
                            "Candidate observations and requests are not acceptance or deployment authority.",
                          ],
                          time: Date.now(),
                        }),
                      )
                    }),
                  { behavior: "immediate" },
                )
                .pipe(Effect.orDie)
              return { contract: (yield* contracts.get(input.contractID))!, run }
            }
          })
          return yield* work.pipe(Effect.raceFirst(maintain))
        }).pipe(
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) return Effect.void
            return Effect.gen(function* () {
              const current = yield* contracts.get(input.contractID)
              if (current?.status !== "active" || current.revision !== original.contract.revision) return
              yield* contracts.escalate({
                contractID: current.id,
                revision: current.revision,
                reason: `Version execution interrupted or failed: ${Cause.pretty(exit.cause).slice(0, 1500)}`,
                time: Date.now(),
              })
            })
          }),
        )
      }, Effect.scoped),
    })
  }),
)

function accepted(receipt: ProContract.Receipt) {
  if (receipt.decision.type === "rejected") throw new Error(receipt.decision.reason)
}

function overlaps(left: string, right: string) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, Global.node, ProContract.node, ProContractPolicy.node, ProContractReason.node],
})
