import { describe, expect } from "bun:test"
import { Clock, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractDriver } from "@opencode-ai/core/pro-contract/driver"
import { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { ProContractObservation } from "@opencode-ai/core/pro-contract/observation"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ResearchAdapters } from "../src/research/adapters"
import { ResearchAdvisoryControl } from "../src/research/advisory-control"
import { ResearchAdvisoryProtocol } from "../src/research/advisory-protocol"
import { ResearchFeedbackEvidence } from "../src/research/feedback-evidence"
import { ResearchModel } from "../src/research/model"
import { ResearchStore } from "../src/research/store"
import { testEffect } from "../../core/test/lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ResearchStore.node,
      ProContract.node,
      ProContractOpenCode.node,
      ProContractJob.node,
      ProContractObservation.node,
      SessionStore.node,
      FSUtil.node,
    ]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [
        ProContractDriver.node,
        Layer.succeed(
          ProContractDriver.Service,
          ProContractDriver.make([ResearchAdapters.driver, ResearchAdapters.plannedDriver]),
        ),
      ],
    ],
  ),
)
const setup = Effect.fnUntraced(function* (planning = false) {
  const store = yield* ResearchStore.Service
  const contracts = yield* ProContract.Service
  const bindings = yield* ProContractOpenCode.Service
  const input = Schema.decodeUnknownSync(ResearchModel.Input)({
    id: ProContract.ID.create(),
    scope: "advisory-call",
    planning,
    source: { directory: "/source" },
    model: { providerID: "test", id: "test" },
    spec: {
      ...ProContract.defaultSpec("Research", 0),
      authority: ["filesystem.read", "filesystem.write", "process.execute"],
      budget: { deadline: 120_000 },
    },
    manifest: {
      version: 1,
      reviewPolicy: { version: 3, plan: "advisory", delivery: "advisory" },
      requirements: ["Verify result"],
      include: ["input.txt"],
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
    driver: planning ? ResearchModel.plannedProfile : ResearchModel.profile,
    now: 0,
  })
  yield* contracts.activate(input.id, 1, 0)
  const manifestHash = yield* store.put(input.manifest)
  const context = (yield* contracts.setRecognitionContext({
    contractID: input.id,
    expected: issued.contract!.recognition.context!.target,
    profile: planning ? ResearchModel.plannedProfile : ResearchModel.profile,
    referenceHash: manifestHash,
    admitted: false,
  })).context!.target
  yield* bindings.setAdmission({
    expected: (yield* bindings.get(input.id))!,
    context,
    open: true,
    reason: "Authorized fixture",
    capabilities: ["read", "write", "control"],
  })
  const binding = (yield* bindings.claim(input.id, 0))!
  expect(binding).toBeTruthy()
  const run: ResearchModel.Run = {
    id: input.id,
    input,
    inputHash: yield* store.put(input),
    manifestHash,
    sourceSnapshot: "source",
    workspace: input.source,
    revision: 1,
    specHash: issued.contract!.specHash,
    context,
    version: 0,
    generation: 0,
    round: 1,
    reviewVersion: 1,
    stage: "execution",
    previous: [],
  }
  yield* store.save(undefined, run)
  const execution = ProContractOpenCode.execution(binding)
  const command = (callID: string, kind: string, payload: unknown, messageID = "msg_advisory_test") =>
    ResearchAdvisoryControl.command({
      execution,
      call: { messageID: SessionMessage.ID.make(messageID), callID },
      kind,
      payload,
    })
  const view = (yield* command("view", "research_view", {})) as { view: string }
  return { store, contracts, bindings, execution, run: (yield* store.get(input.id))!, view, command }
})

const prepare = setup()

describe("Advisory invocation, view and execution identity", () => {
  it.effect("durable exact retry differs from a new call with the same content", () =>
    Effect.gen(function* () {
      const s = yield* prepare
      const payload = { view: s.view.view, reason: "A brief reason, without a repair lifecycle" }
      const first = yield* s.command("note", "review_response", payload)
      const saved = yield* s.store.get(s.run.id)
      expect(yield* s.command("note", "review_response", payload)).toEqual(first)
      expect(yield* s.store.get(s.run.id)).toEqual(saved)
      expect(yield* s.command("note", "review_response", { ...payload, reason: "changed" })).toMatchObject({
        accepted: false,
        error: { code: "call_conflict" },
      })
      expect(yield* s.command("note", "research_view", {})).toMatchObject({
        accepted: false,
        error: { code: "call_conflict" },
      })
      expect(yield* s.store.get(s.run.id)).toEqual(saved)
      expect(yield* s.command("note-new", "review_response", payload)).toMatchObject({ accepted: true })
      expect(yield* s.command("note", "review_response", payload, "msg_another_turn")).toMatchObject({ accepted: true })
      const current = (yield* s.store.get(s.run.id))!
      expect(current.advisoryRecords).toHaveLength(3)
      expect(yield* ResearchFeedbackEvidence.advisoryRecords(current)).toHaveLength(3)
      expect(current.advisoryView?.id).toBe(s.view.view)
      expect(yield* s.store.commands(s.run.id)).toHaveLength(4)
      expect(yield* s.store.commandConflicts(s.run.id)).toHaveLength(2)
    }),
  )
  it.effect("protocol rejection leaves run unchanged and correction needs a new invocation", () =>
    Effect.gen(function* () {
      const s = yield* prepare
      expect(yield* s.command("bad", "review_response", { view: s.view.view, outcomeHash: "invented" })).toMatchObject({
        accepted: false,
      })
      expect(yield* s.store.get(s.run.id)).toEqual(s.run)
      expect(yield* s.command("bad", "review_response", { view: s.view.view, reason: "fixed syntax" })).toMatchObject({
        accepted: false,
        error: { code: "call_conflict" },
      })
      expect(
        yield* s.command("corrected", "review_response", { view: s.view.view, reason: "fixed syntax" }),
      ).toMatchObject({ accepted: true })
      const invalid = { view: s.view.view, reason: "cross-review target", target: { review: "r99", finding: "F1" } }
      expect(yield* s.command("target", "review_response", invalid)).toMatchObject({
        accepted: false,
        error: { code: "unknown_reference" },
      })
    }),
  )
  it.effect("a changed material view cannot silently bind an old call to the new candidate", () =>
    Effect.gen(function* () {
      const s = yield* prepare
      const changed = yield* s.store.save(s.run, { ...s.run, subjectHash: "changed candidate" })
      expect(ResearchAdvisoryProtocol.basis(changed)).not.toBe(s.run.advisoryView!.basis)
      expect(yield* s.command("stale", "review_response", { view: s.view.view, reason: "old view" })).toMatchObject({
        accepted: false,
        error: { code: "stale_view" },
      })
      expect(yield* s.store.get(s.run.id)).toEqual(changed)
      const fresh = (yield* s.command("new-view", "research_view", {})) as { view: string }
      expect(fresh.view).not.toBe(s.view.view)
      expect(
        yield* s.command("new-note", "review_response", { view: fresh.view, reason: "newly selected" }),
      ).toMatchObject({ accepted: true })
    }),
  )
  it.effect("closing admission or expiration cannot be bypassed to replay a receipt", () =>
    Effect.gen(function* () {
      const s = yield* prepare
      yield* s.bindings.setAdmission({
        expected: (yield* s.bindings.get(s.run.id))!,
        context: s.run.context,
        open: false,
        reason: "Closed",
      })
      expect((yield* s.command("view", "research_view", {}).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* s.store.commands(s.run.id)).toHaveLength(1)
      yield* TestClock.adjust("121 seconds")
      expect((yield* s.command("fresh", "research_view", {}).pipe(Effect.exit))._tag).toBe("Failure")
      expect((yield* Clock.currentTimeMillis) > s.run.input.spec.budget.deadline).toBe(true)
    }),
  )
  it.effect("receipt and state share rollback, including an appended note", () =>
    Effect.gen(function* () {
      const s = yield* prepare
      const before = yield* s.store.commands(s.run.id)
      const exit = yield* s.store
        .atomic(
          Effect.gen(function* () {
            yield* s.command("aborted", "review_response", { view: s.view.view, reason: "rollback" })
            return yield* new ResearchModel.Denied({ message: "abort enclosing transaction" })
          }),
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(yield* s.store.get(s.run.id)).toEqual(s.run)
      expect(yield* s.store.commands(s.run.id)).toEqual(before)
    }),
  )
})

it.effect("slow input observation allows another writer and rechecks authority after I/O", () =>
  Effect.gen(function* () {
    const s = yield* setup(true)
    const fs = yield* FSUtil.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const read = yield* s
      .command("inspect", "inspect_inputs", { view: s.view.view, paths: ["input.txt"] })
      .pipe(
        Effect.provideService(FSUtil.Service, {
          ...fs,
          realPath: (name) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(fs.realPath(name)),
            ),
        }),
        Effect.forkChild,
      )
    yield* Deferred.await(entered)
    // This writer must finish before the blocked filesystem operation is released.
    yield* s.bindings.heartbeat(new Set([s.execution.sessionID]), 1)
    yield* s.bindings.setAdmission({
      expected: (yield* s.bindings.get(s.run.id))!,
      context: s.run.context,
      open: false,
      reason: "Revoked while reading",
    })
    yield* Deferred.succeed(release, undefined)
    expect((yield* Fiber.join(read).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* s.store.get(s.run.id)).toEqual(s.run)
    expect(yield* s.store.commands(s.run.id)).toHaveLength(1)
  }),
)
