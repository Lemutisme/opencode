import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractDriver } from "@opencode-ai/core/pro-contract/driver"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ResearchCoordinator } from "../src/research/coordinator"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ResearchStore } from "../src/research/store"
import { ResearchModel } from "../src/research/model"
import { ResearchAdapters } from "../src/research/adapters"
import { testEffect } from "../../core/test/lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ResearchStore.node, ProContract.node, ProContractOpenCode.node, ProContractJob.node]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [
        ProContractDriver.node,
        Layer.succeed(ProContractDriver.Service, ProContractDriver.make([ResearchAdapters.driver])),
      ],
    ],
  ),
)
const prepare = Effect.gen(function* () {
  const state = yield* ResearchStore.Service
  const bindings = yield* ProContractOpenCode.Service
  const input = Schema.decodeUnknownSync(ResearchModel.Input)({
    id: ProContract.ID.create(),
    scope: "research-transaction",
    source: { directory: "/source" },
    model: { providerID: "test", id: "test" },
    spec: {
      ...ProContract.defaultSpec("Research", 0),
      authority: ["filesystem.read", "filesystem.write", "process.execute"],
      budget: { deadline: 120_000 },
    },
    manifest: {
      version: 1,
      requirements: ["Verify result"],
      include: [],
      dependencies: [],
      verification: {
        adapter: "node-test-tap:1",
        executable: "/usr/bin/node",
        executableHash: "a".repeat(64),
        tests: ["test.cjs"],
        harness: [{ path: "test.cjs", hash: "b".repeat(64) }],
        expectedTests: ["explicit"],
        minimumTests: 1,
        maximumSkipped: 0,
        timeout: 1000,
      },
      artifacts: [],
      reviewer: { model: { providerID: "test", id: "test" }, agent: "build", instructions: "Independent review" },
    },
  })
  const issued = yield* bindings.issue({
    id: input.id,
    scope: input.scope,
    spec: input.spec,
    location: input.source,
    model: input.model,
    driver: ResearchModel.profile,
    now: 0,
  })
  const run: ResearchModel.Run = {
    id: input.id,
    input,
    inputHash: "a".repeat(64),
    manifestHash: "b".repeat(64),
    sourceSnapshot: "subject",
    workspace: input.source,
    revision: issued.contract!.revision,
    specHash: issued.contract!.specHash,
    context: issued.contract!.recognition.context!.target,
    version: 0,
    generation: 1,
    owner: "host-a",
    leaseExpiresAt: 30_000,
    round: 1,
    reviewVersion: 1,
    stage: "verification",
    previous: [],
  }
  const saved = yield* state.save(undefined, run)
  const token: ResearchModel.Token = {
    id: run.id,
    owner: run.owner!,
    generation: run.generation,
    context: run.context,
    round: run.round,
    reviewVersion: run.reviewVersion,
  }
  return { state, saved, token }
})

describe("Research durable transaction boundary", () => {
  it.effect("a proposed then rejected external revision permanently invalidates the old plan between polls", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare
      const contracts = yield* ProContract.Service
      const coordinator = yield* ResearchCoordinator.make
      const plan = Schema.decodeUnknownSync(ResearchModel.Plan)({
        version: 1,
        agreement: {
          revision: prepared.saved.revision,
          specHash: prepared.saved.specHash,
          manifestHash: prepared.saved.manifestHash,
        },
        scope: "within_task",
        question: "Question",
        hypothesis: "Hypothesis",
        baseline: "Baseline",
        implementation: "Implementation",
        method: "Method",
        controls: "Controls",
        data: "Data",
        evaluation: "Internal criteria do not lower acceptance",
        uncertainties: "Uncertain",
        protected: [],
      })
      yield* prepared.state.save(prepared.saved, {
        ...prepared.saved,
        input: { ...prepared.saved.input, planning: true },
        plan: {
          value: plan,
          hash: "a".repeat(64),
          approved: true,
        },
      })
      yield* coordinator.guard(prepared.token)
      yield* prepared.state.atomic(
        Effect.gen(function* () {
          const contract = (yield* contracts.get(prepared.saved.id))!
          expect(
            (yield* contracts.petitionRevision({
              contractID: contract.id,
              spec: { ...contract.spec, goal: "Outside task" },
              reason: "Request external decision",
            })).decision.type,
          ).toBe("accepted")
          const pending = (yield* contracts.get(contract.id))!
          expect(
            (yield* contracts.decideRevision({
              contractID: contract.id,
              accept: false,
              expected: pending.recognition.pending!,
              operationID: crypto.randomUUID(),
            })).decision.type,
          ).toBe("accepted")
        }),
      )
      const current = (yield* contracts.get(prepared.saved.id))!
      expect(current.pendingRevision).toBeUndefined()
      expect(current.specHash).toBe(prepared.saved.specHash)
      expect(current.recognition.context!.target.version).toBeGreaterThan(prepared.saved.context.version)
      expect((yield* coordinator.guard(prepared.token).pipe(Effect.exit))._tag).toBe("Failure")
    }),
  )
  it.effect("rolls back root issuance, run and immutable events together", () =>
    Effect.gen(function* () {
      const state = yield* ResearchStore.Service
      const contracts = yield* ProContract.Service
      const ids: ProContract.ID[] = []
      const result = yield* state
        .atomic(
          prepare.pipe(
            Effect.flatMap((created) => {
              ids.push(created.saved.id)
              return Effect.fail(new ResearchModel.Denied({ message: "Abort after all writes" }))
            }),
          ),
        )
        .pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(yield* contracts.get(ids[0])).toBeUndefined()
      expect(yield* state.get(ids[0])).toBeUndefined()
      expect(yield* state.history(ids[0])).toHaveLength(0)
    }),
  )
  it.effect("rejects stale versions without adding a misleading history row", () =>
    Effect.gen(function* () {
      const { state, saved } = yield* prepare
      yield* state.save(saved, { ...saved, reason: "First change" })
      expect((yield* state.save(saved, { ...saved, reason: "Lost update" }).pipe(Effect.exit))._tag).toBe("Failure")
      expect((yield* state.get(saved.id))?.reason).toBe("First change")
      expect(yield* state.history(saved.id)).toHaveLength(2)
    }),
  )
  it.effect("rejects an expired owner even before another coordinator claims", () =>
    Effect.gen(function* () {
      const { state, token } = yield* prepare
      yield* TestClock.adjust("31 seconds")
      expect((yield* state.assert(token).pipe(Effect.exit))._tag).toBe("Failure")
    }),
  )
  for (const changed of ["generation", "context", "round", "reviewVersion"] as const)
    it.effect(`fences late work after a ${changed} change`, () =>
      Effect.gen(function* () {
        const { state, saved, token } = yield* prepare
        const next =
          changed === "context"
            ? { ...saved, context: { ...saved.context, version: saved.context.version + 1 } }
            : { ...saved, [changed]: saved[changed] + 1 }
        yield* state.save(saved, next)
        const result = yield* state
          .atomic(
            Effect.gen(function* () {
              const current = yield* state.assert(token, "verification")
              return yield* state.save(current, { ...current, stage: "unavailable", reason: "Stale callback" })
            }),
          )
          .pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect((yield* state.get(saved.id))?.stage).toBe("verification")
      }),
    )
  for (const change of ["lease", "generation", "context"] as const) {
    it.effect(`blocks actual prepared job start after coordinator ${change} changes`, () =>
      Effect.gen(function* () {
        const prepared = yield* prepare
        const jobs = yield* ProContractJob.Service
        const coordinator = yield* ResearchCoordinator.make
        const job = yield* jobs.create({
          id: crypto.randomUUID(),
          kind: "verify",
          contractID: prepared.saved.id,
          context: prepared.saved.context,
          driver: ResearchModel.profile,
          inputHash: "f".repeat(64),
          sessionID: SessionV2.ID.create(),
          promptID: SessionMessage.ID.create(),
          location: prepared.saved.workspace,
          model: prepared.saved.input.model,
          agent: AgentV2.defaultID,
          prompt: { text: "Run fixed verification" },
          verification: { subjectHash: "subject", policy: ResearchAdapters.policy(prepared.saved.input.manifest) },
        })
        if (change === "lease") yield* TestClock.adjust("31 seconds")
        if (change === "generation")
          yield* prepared.state.save(prepared.saved, { ...prepared.saved, generation: 2, owner: "host-b" })
        if (change === "context") {
          const contracts = yield* ProContract.Service
          yield* contracts.setRecognitionContext({
            contractID: prepared.saved.id,
            expected: prepared.saved.context,
            profile: ResearchModel.profile,
            referenceHash: "e".repeat(64),
            admitted: false,
          })
        }
        expect(
          (yield* coordinator.commit(prepared.token, "verification", () => jobs.start(job.input.id)).pipe(Effect.exit))
            ._tag,
        ).toBe("Failure")
        expect((yield* jobs.get(job.input.id))?.status).toBe("prepared")
        expect(yield* jobs.operations(prepared.saved.id)).toHaveLength(0)
      }),
    )
  }
})
