import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Schema, Scope } from "effect"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { ProContract } from "../src/pro-contract"
import { ProContractMethod } from "../src/pro-contract/method"
import { ProContractPolicy } from "../src/pro-contract/policy"
import { ProContractRun } from "../src/pro-contract/run"
import { ProContractVersion } from "../src/pro-contract/version"
import { AbsolutePath } from "../src/schema"
import { SessionExecution } from "../src/session/execution"
import { SessionExecutionLocal } from "../src/session/execution/local"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const emit = `const input = await Bun.stdin.json();
console.log(JSON.stringify({version:1,observations:[input.task.input],requests:[],artifacts:[]}));`

function fixture<A, E>(
  code: string,
  run: (context: {
    scope: string
    workspace: AbsolutePath
    versionHash: string
    versions: ReturnType<typeof ProContractVersion.make>
    now: number
    deadline: number
  }) => Effect.Effect<A, E, ProContractRun.Service | ProContract.Service | ProContractPolicy.Service | Scope.Scope>,
) {
  return Effect.gen(function* () {
    const temporary = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (temporary) => Effect.promise(() => temporary[Symbol.asyncDispose]()),
    )
    const data = path.join(temporary.path, "host", "data")
    const workspace = AbsolutePath.make(path.join(temporary.path, "workspace"))
    yield* Effect.promise(async () => {
      await mkdir(workspace)
      await Bun.write(path.join(temporary.path, "source", "workflow.ts"), code)
    })
    const versions = ProContractVersion.make({ directory: ProContractVersion.storePath(data) })
    const frozen = yield* Effect.promise(() =>
      versions.freeze({ directory: path.join(temporary.path, "source"), entrypoint: "workflow.ts" }),
    )
    const now = Date.now()
    return yield* run({
      scope: "ordinary-method",
      workspace,
      versionHash: frozen.versionHash,
      versions,
      now,
      deadline: now + 30_000,
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([ProContractRun.node, ProContract.node, ProContractPolicy.node]), [
          [Database.node, Database.layerFromPath(path.join(temporary.path, "host", "contract.db"))],
          [
            Global.node,
            Global.layerWith({
              data,
              config: path.join(temporary.path, "host", "config"),
              state: path.join(temporary.path, "host", "state"),
              cache: path.join(temporary.path, "host", "cache"),
            }),
          ],
          [SessionExecution.node, SessionExecutionLocal.node],
        ]),
      ),
    )
  })
}

test("method identity binds exact source and instructions, not the order of object fields", () => {
  const versionHash = Hash.sha256("frozen executable")
  const definition = { kind: "version-method-v1", versionHash, executionPolicy: "Read permitted input only." } as const
  expect(ProContractMethod.hash(definition)).toBe(
    ProContractMethod.hash({ executionPolicy: definition.executionPolicy, versionHash, kind: "version-method-v1" }),
  )
  expect(ProContractMethod.hash({ ...definition, versionHash: Hash.sha256("different executable") })).not.toBe(
    ProContractMethod.hash(definition),
  )
  expect(ProContractMethod.hash({ ...definition, executionPolicy: "Different instructions." })).not.toBe(
    ProContractMethod.hash(definition),
  )
})

it.live("an ordinary task executes under an explicit method grant without any benchmark or research policy", () =>
  fixture(emit, (context) =>
    Effect.gen(function* () {
      const runs = yield* ProContractRun.Service
      const contracts = yield* ProContract.Service
      const policies = yield* ProContractPolicy.Service
      const method = yield* runs.authorize({
        scope: context.scope,
        versionHash: context.versionHash,
        executionPolicy: "Produce only the requested ordinary report.",
        evidenceHash: Hash.sha256("User approved this frozen method, without a performance claim"),
        now: context.now,
      })
      const grant = (yield* contracts.get(method.contractID))!
      expect(grant.status).toBe("discharged")
      const definition = Schema.decodeUnknownSync(Schema.fromJsonString(ProContractMethod.Grant))(grant.spec.brief)
      expect(definition).toMatchObject({
        kind: "version-method-grant-v1",
        scope: context.scope,
        method: {
          kind: "version-method-v1",
          versionHash: context.versionHash,
          executionPolicy: "Produce only the requested ordinary report.",
        },
      })
      expect(method.subjectHash).toBe(ProContractMethod.hash(definition.method))
      expect(yield* policies.get(context.scope)).toBeUndefined()
      const duty = yield* runs.issue({
        scope: context.scope,
        method,
        task: { kind: "report", question: "What was observed?" },
        workspace: context.workspace,
        deadline: context.deadline,
        now: context.now,
      })
      expect(duty.spec.requires).toEqual([])
      expect(duty.spec.budget).toEqual({ deadline: context.deadline })
      const outcome = yield* runs.execute({ contractID: duty.id })
      expect(outcome.run.versionHash).toBe(context.versionHash)
      expect(outcome.run.result?.observations).toEqual([{ kind: "report", question: "What was observed?" }])
      expect(outcome.contract.status).toBe("verification")
      expect(outcome.contract.attestationID).toBeUndefined()
      expect(yield* policies.get(context.scope)).toBeUndefined()
      yield* contracts.principalAttest({
        contractID: duty.id,
        revision: duty.revision,
        specHash: duty.specHash,
        subjectHash: ProContractVersion.subjectHash(outcome.run),
        evidenceHash: Hash.sha256("Independent inspection accepts the ordinary report"),
      })
      expect((yield* contracts.get(duty.id))?.status).toBe("discharged")
      expect((yield* runs.get(duty.id)).runs).toEqual([outcome.run])
    }),
  ),
)

it.live("an exact direct retry retains its admitted method and rejects changes to the task or grant", () =>
  fixture(emit, (context) =>
    Effect.gen(function* () {
      const runs = yield* ProContractRun.Service
      const grant = {
        id: ProContract.ID.create(),
        scope: context.scope,
        versionHash: context.versionHash,
        evidenceHash: Hash.sha256("Explicit authorization"),
        now: context.now,
      }
      const method = yield* runs.authorize(grant)
      expect(yield* runs.authorize({ ...grant, now: context.now + 1 })).toEqual(method)
      const input = {
        id: ProContract.ID.create(),
        scope: context.scope,
        method,
        task: "An ordinary task",
        workspace: context.workspace,
        deadline: context.deadline,
        now: context.now,
      }
      const duty = yield* runs.issue(input)
      const outcome = yield* runs.execute({ contractID: duty.id })
      expect(yield* runs.issue({ ...input, now: context.now + 2 })).toEqual(outcome.contract)
      const other = yield* runs.authorize({ ...grant, id: ProContract.ID.create() })
      const conflicts = [
        { ...input, task: "Different task" },
        { ...input, deadline: context.deadline + 1 },
        { ...input, method: other },
        { ...input, targetExecutable: context.versionHash },
      ]
      yield* Effect.forEach(conflicts, (conflict) =>
        runs.issue(conflict).pipe(
          Effect.exit,
          Effect.map((exit) => expect(Exit.isFailure(exit)).toBe(true)),
        ),
      )
      expect((yield* runs.get(duty.id)).runs).toEqual([outcome.run])
      expect((yield* runs.execute({ contractID: duty.id })).run).toEqual(outcome.run)
    }),
  ),
)

it.live("accepting a report about a method hash does not authorize executing that method", () =>
  fixture(emit, (context) =>
    Effect.gen(function* () {
      const runs = yield* ProContractRun.Service
      const contracts = yield* ProContract.Service
      const subjectHash = ProContractMethod.hash({
        kind: "version-method-v1",
        versionHash: context.versionHash,
        executionPolicy: "",
      })
      const issued = yield* contracts.issue({
        scope: context.scope,
        executor: "report-author",
        spec: ProContract.defaultSpec("Describe a method without authorizing it", context.now),
      })
      const report = issued.contract!
      yield* contracts.activate(report.id, report.revision, context.now)
      yield* contracts.reportReady({
        contractID: report.id,
        revision: report.revision,
        subjectHash,
        summary: "A report whose subject happens to have the method hash",
        uncertainties: [],
        time: context.now,
      })
      yield* contracts.principalAttest({
        contractID: report.id,
        revision: report.revision,
        specHash: report.specHash,
        subjectHash,
        evidenceHash: Hash.sha256("Accept the report, not execution of its subject"),
      })
      const accepted = (yield* contracts.get(report.id))!
      expect(accepted.status).toBe("discharged")
      const id = ProContract.ID.create()
      expect(
        Exit.isFailure(
          yield* runs
            .issue({
              id,
              scope: context.scope,
              method: {
                contractID: accepted.id,
                revision: accepted.revision,
                specHash: accepted.specHash,
                subjectHash,
                attestationID: accepted.attestationID!,
              },
              task: "This execution has not been authorized",
              workspace: context.workspace,
              deadline: context.deadline,
              now: context.now,
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* contracts.get(id)).toBeUndefined()
      expect(yield* contracts.get(report.id)).toEqual(accepted)
    }),
  ),
)

it.live("direct admission rejects forged grants, another scope, and mixed method or role selectors", () =>
  fixture(emit, (context) =>
    Effect.gen(function* () {
      const runs = yield* ProContractRun.Service
      const contracts = yield* ProContract.Service
      const method = yield* runs.authorize({
        scope: context.scope,
        versionHash: context.versionHash,
        evidenceHash: Hash.sha256("Approve an exact executable for this scope only"),
        now: context.now,
      })
      const input = {
        scope: context.scope,
        method,
        task: "An ordinary task",
        workspace: context.workspace,
        deadline: context.deadline,
        now: context.now,
      }
      const conflicts = [
        { ...input, scope: "another-scope" },
        { ...input, method: { ...method, revision: method.revision + 1 } },
        { ...input, method: { ...method, specHash: Hash.sha256("forged specification") } },
        { ...input, method: { ...method, subjectHash: Hash.sha256("another method") } },
        { ...input, method: { ...method, attestationID: ProContract.AttestationID.make("pca_forged") } },
        { ...input, role: "incumbent" as const },
        { ...input, targetVersion: Hash.sha256("archive bundle") },
        { ...input, view: { versionHashes: [Hash.sha256("unavailable archive")], experimentIDs: [] } },
      ]
      yield* Effect.forEach(conflicts, (conflict) =>
        Effect.gen(function* () {
          const id = ProContract.ID.create()
          // Exercise the host admission boundary even for combinations excluded by TypeScript.
          const invalid = { ...conflict, id } as Parameters<ProContractRun.Interface["issue"]>[0]
          expect(Exit.isFailure(yield* runs.issue(invalid).pipe(Effect.exit))).toBe(true)
          expect(yield* contracts.get(id)).toBeUndefined()
        }),
      )
      expect((yield* runs.issue(input)).executor).toBe(`version:${context.versionHash}`)
    }),
  ),
)

it.live("withdrawn method permission prevents future work without erasing independently accepted output", () =>
  fixture(emit, (context) =>
    Effect.gen(function* () {
      const runs = yield* ProContractRun.Service
      const contracts = yield* ProContract.Service
      const method = yield* runs.authorize({
        scope: context.scope,
        versionHash: context.versionHash,
        evidenceHash: Hash.sha256("Initial permission to execute"),
        now: context.now,
      })
      const input = {
        scope: context.scope,
        method,
        task: "Produce a result with independent evidence",
        workspace: context.workspace,
        deadline: context.deadline,
        now: context.now,
      }
      const duty = yield* runs.issue(input)
      const future = yield* runs.issue({ ...input, task: "Still outstanding" })
      const outcome = yield* runs.execute({ contractID: duty.id })
      yield* contracts.principalAttest({
        contractID: duty.id,
        revision: duty.revision,
        specHash: duty.specHash,
        subjectHash: ProContractVersion.subjectHash(outcome.run),
        evidenceHash: Hash.sha256("Independent result evidence, not reputation of the method"),
      })
      const accepted = (yield* contracts.get(duty.id))!
      expect(accepted.spec.requires).toEqual([])
      const withdrawal = yield* contracts.challenge({
        contractID: method.contractID,
        revision: method.revision,
        subjectHash: method.subjectHash,
        evidenceHash: Hash.sha256("Withdraw this execution permission, not the independent result"),
        disclosure: "sealed",
        time: Date.now(),
      })
      expect(withdrawal.decision.type).toBe("accepted")
      expect(yield* contracts.get(duty.id)).toEqual(accepted)
      expect((yield* runs.execute({ contractID: duty.id })).run).toEqual(outcome.run)
      expect(Exit.isFailure(yield* runs.execute({ contractID: future.id }).pipe(Effect.exit))).toBe(true)
      expect((yield* runs.get(future.id)).runs).toEqual([])
      expect(Exit.isFailure(yield* runs.issue(input).pipe(Effect.exit))).toBe(true)
      expect(yield* contracts.getAttestation(accepted.attestationID!)).toBeDefined()
    }),
  ),
)

it.live(
  "an ordinary task's frozen source can become the next executor only through an explicit exact-source grant",
  () =>
    fixture(
      `await Bun.write("ordinary-output/workflow.ts", ${JSON.stringify(emit)});
     console.log(JSON.stringify({version:1,observations:["Delivered reusable source as ordinary work"],requests:[],artifacts:["ordinary-output"]}));`,
      (context) =>
        Effect.gen(function* () {
          const runs = yield* ProContractRun.Service
          const contracts = yield* ProContract.Service
          const policies = yield* ProContractPolicy.Service
          const method = yield* runs.authorize({
            scope: context.scope,
            versionHash: context.versionHash,
            evidenceHash: Hash.sha256("User approved source-producing ordinary work"),
            now: context.now,
          })
          const duty = yield* runs.issue({
            scope: context.scope,
            method,
            task: { deliverable: "Reusable report program" },
            workspace: context.workspace,
            deadline: context.deadline,
            now: context.now,
          })
          const produced = yield* runs.execute({ contractID: duty.id })
          expect(produced.contract.status).toBe("verification")
          expect(produced.contract.attestationID).toBeUndefined()
          const successor = yield* Effect.promise(async () =>
            context.versions.freeze({
              directory: path.join(await context.versions.artifactDirectory(produced.run.id), "ordinary-output"),
              entrypoint: "workflow.ts",
            }),
          )
          expect(successor.versionHash).not.toBe(context.versionHash)
          const source = {
            contractID: duty.id,
            revision: duty.revision,
            specHash: duty.specHash,
            subjectHash: ProContractVersion.subjectHash(produced.run),
            runID: produced.run.id,
            artifact: "ordinary-output",
          }
          const input = {
            scope: context.scope,
            versionHash: successor.versionHash,
            source,
            evidenceHash: Hash.sha256("Independent source inspection permits this exact successor"),
            now: Date.now(),
          }
          const conflicts = [
            { ...input, source: { ...source, specHash: Hash.sha256("another task") } },
            { ...input, source: { ...source, subjectHash: Hash.sha256("another result") } },
            { ...input, source: { ...source, runID: crypto.randomUUID() } },
            { ...input, source: { ...source, artifact: "missing-source" } },
            { ...input, versionHash: context.versionHash },
          ]
          yield* Effect.forEach(conflicts, (conflict) =>
            Effect.gen(function* () {
              const id = ProContract.ID.create()
              expect(Exit.isFailure(yield* runs.authorize({ ...conflict, id }).pipe(Effect.exit))).toBe(true)
              expect(yield* contracts.get(id)).toBeUndefined()
            }),
          )
          const nextMethod = yield* runs.authorize(input)
          const grant = (yield* contracts.get(nextMethod.contractID))!
          expect(
            Schema.decodeUnknownSync(Schema.fromJsonString(ProContractMethod.Grant))(grant.spec.brief).source,
          ).toEqual(source)
          expect(grant.spec.requires).toEqual([])
          const next = yield* runs.issue({
            scope: context.scope,
            method: nextMethod,
            task: { deliverable: "Report from the new ordinary executor" },
            workspace: context.workspace,
            deadline: context.deadline,
            now: Date.now(),
          })
          const result = yield* runs.execute({ contractID: next.id })
          expect(result.run.versionHash).toBe(successor.versionHash)
          expect(result.run.result?.observations).toEqual([{ deliverable: "Report from the new ordinary executor" }])
          expect(result.contract.status).toBe("verification")
          expect(yield* policies.get(context.scope)).toBeUndefined()
          expect((yield* runs.get(duty.id)).runs).toEqual([produced.run])
          expect((yield* contracts.get(duty.id))?.handoff).toEqual(produced.contract.handoff)

          yield* contracts.principalAttest({
            contractID: duty.id,
            revision: duty.revision,
            specHash: duty.specHash,
            subjectHash: source.subjectHash,
            evidenceHash: Hash.sha256("Initial acceptance of the source-producing task"),
          })
          const challenged = yield* contracts.challenge({
            contractID: duty.id,
            revision: duty.revision,
            subjectHash: source.subjectHash,
            evidenceHash: Hash.sha256("The original delivery no longer satisfies its own task"),
            disclosure: "sealed",
            time: Date.now(),
          })
          expect(challenged.decision.type).toBe("accepted")
          expect((yield* contracts.get(duty.id))?.handoff).toBeUndefined()
          expect(yield* runs.authorize(input)).toEqual(nextMethod)
          expect(
            Exit.isFailure(yield* runs.authorize({ ...input, id: ProContract.ID.create() }).pipe(Effect.exit)),
          ).toBe(true)
          // Provenance is not a claim that the successor's own authorization relies on its ancestor's acceptance.
          expect(yield* contracts.get(nextMethod.contractID)).toEqual(grant)
          const continuing = yield* runs.issue({
            scope: context.scope,
            method: nextMethod,
            task: "Continue independently authorized ordinary work",
            workspace: context.workspace,
            deadline: context.deadline,
            now: Date.now(),
          })
          const continued = yield* runs.execute({ contractID: continuing.id })
          expect(continued.run.versionHash).toBe(successor.versionHash)
          expect(continued.run.result?.observations).toEqual(["Continue independently authorized ordinary work"])
          expect((yield* runs.get(duty.id)).runs).toEqual([produced.run])
        }),
    ),
)
