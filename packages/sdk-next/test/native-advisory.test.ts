import { expect } from "bun:test"
import path from "node:path"
import { Context, DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractActivity } from "@opencode-ai/core/pro-contract/activity"
import { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { ExecutionPermit } from "@opencode-ai/core/session/execution-permit"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Hash } from "@opencode-ai/core/util/hash"
import { testEffect } from "../../core/test/lib/effect"
import { NativeAdvisory } from "../src/native-advisory"
import { NativeAdvisoryMaterials } from "../src/native-advisory-materials"
import { NativeAdvisoryStore } from "../src/native-advisory-store"

const base: LayerNode.Replacements = [
  [Database.node, Database.layerFromPath(":memory:")],
  [SessionExecution.node, SessionExecution.noopLayer],
  [
    Global.node,
    Layer.effect(
      Global.Service,
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-advisory-unit-" })
        const paths = Object.fromEntries(
          ["data", "home", "config", "cache", "state", "tmp", "bin", "log", "repos"].map((name) => [
            name,
            path.join(directory, name),
          ]),
        )
        yield* Effect.forEach(Object.values(paths), (directory) => fs.makeDirectory(directory, { recursive: true }), {
          discard: true,
        })
        return Global.make(paths)
      }),
    ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node))),
  ],
]
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      NativeAdvisory.node,
      EventV2.node,
      NativeAdvisoryStore.node,
      ProContractOpenCode.node,
      ProContract.node,
      ProContractActivity.node,
      ProContractJob.node,
      SessionV2.node,
      SessionStore.node,
      ExecutionPermit.node,
      Global.node,
      FSUtil.node,
      Database.node,
      LocationServiceMap.node,
    ]),
    [...base, [LocationServiceMap.node, buildLocationServiceMap(base)]],
  ),
)

const setup = Effect.fnUntraced(function* (materials: ReadonlyArray<string> = ["file.txt"]) {
  const native = yield* NativeAdvisory.Service
  const bindings = yield* ProContractOpenCode.Service
  const contracts = yield* ProContract.Service
  const state = yield* NativeAdvisoryStore.Service
  const sessions = yield* SessionV2.Service
  const events = yield* EventV2.Service
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const directory = AbsolutePath.make(path.join(global.tmp, "candidate"))
  yield* fs.makeDirectory(directory, { recursive: true })
  yield* Effect.promise(async () => {
    for (const argv of [
      ["git", "init", "--initial-branch=dev"],
      [
        "git",
        "-c",
        "user.name=Native review test",
        "-c",
        "user.email=native-review@example.invalid",
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        "test: initialize snapshot source",
      ],
    ]) {
      const child = Bun.spawn(argv, { cwd: directory, stdout: "ignore", stderr: "pipe" })
      const error = await new Response(child.stderr).text()
      expect(await child.exited, error).toBe(0)
    }
  })
  yield* fs.writeFileString(path.join(directory, "file.txt"), "first captured bytes\n")
  const input = {
    id: ProContract.ID.create(),
    scope: "native-request-boundary",
    now: 0,
    location: { directory },
    model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test") },
    spec: {
      ...ProContract.defaultSpec("Inspect the material", 0),
      budget: { deadline: 120_000 },
      authority: ["filesystem.read", "filesystem.write", "process.execute"],
    },
  }
  const configuration: NativeAdvisoryStore.Configuration = {
    reviewer: {
      model: input.model,
      agent: AgentV2.defaultID,
      instructions: "Read the selected material and offer advice",
    },
    materials: materials.map((name) => RelativePath.make(name)),
    evidence: [],
    time: { operationMs: 3000, reviewMs: 1000, cleanupMs: 60_000, resumeMs: 10_000 },
  }
  const receipt = yield* native.issue(input, configuration)
  expect(receipt.review.available).toBe(true)
  yield* bindings.activate(input.id, 1, 0)
  const binding = (yield* bindings.claim(input.id, 0))!
  yield* sessions.create({ id: binding.sessionID, location: binding.location, model: binding.model })
  const messageID = SessionMessage.ID.create()
  yield* events.publish(SessionEvent.Step.Started, {
    sessionID: binding.sessionID,
    assistantMessageID: messageID,
    timestamp: yield* DateTime.now,
    agent: "build",
    model: input.model,
  })
  const tool = (
    callID: string,
    name = "contract_request",
    input: Record<string, unknown> = { kind: "review", payload: {} },
  ) =>
    Effect.gen(function* () {
      const event = {
        sessionID: binding.sessionID,
        assistantMessageID: messageID,
        timestamp: DateTime.makeUnsafe(0),
        callID,
      }
      yield* events.publish(SessionEvent.Tool.Input.Started, { ...event, name })
      yield* events.publish(SessionEvent.Tool.Input.Ended, { ...event, text: JSON.stringify(input) })
      yield* events.publish(SessionEvent.Tool.Called, { ...event, tool: name, input, provider: { executed: false } })
    })
  const finish = (callID: string) =>
    events.publish(SessionEvent.Tool.Success, {
      sessionID: binding.sessionID,
      assistantMessageID: messageID,
      timestamp: DateTime.makeUnsafe(0),
      callID,
      structured: {},
      content: [],
      result: {},
      provider: { executed: false },
    })
  yield* tool("review-1")
  const command = {
    execution: ProContractOpenCode.execution(binding),
    call: { messageID, callID: "review-1" },
    kind: "review",
    payload: {},
  }
  return {
    native,
    bindings,
    contracts,
    state,
    sessions,
    events,
    fs,
    directory,
    input,
    configuration,
    binding,
    command,
    tool,
    finish,
  }
})

it.effect("registers only new eligible native contracts without altering historical budgets or briefs", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    const global = yield* Global.Service
    const directories = yield* test.fs.readDirectory(path.join(global.data, "native-advisory"))
    const registration = (yield* test.state.registration(test.input.id))!
    const retry = yield* test.native.issue(test.input, {
      ...test.configuration,
      reviewer: { ...test.configuration.reviewer, instructions: "Changed instructions" },
    })
    expect(retry.review.available).toBe(true)
    expect(yield* test.state.registration(test.input.id)).toEqual(registration)
    for (const budget of [
      { deadline: 120_000, turns: 1000 },
      { deadline: 120_000, actions: 1000 },
    ]) {
      const input = { ...test.input, id: ProContract.ID.create(), spec: { ...test.input.spec, budget } }
      const issued = yield* test.native.issue(input, test.configuration)
      expect(issued.decision.type).toBe("accepted")
      expect(issued.review.available).toBe(false)
      expect(issued.contract!.spec).toEqual(input.spec)
      expect(yield* test.state.registration(input.id)).toBeUndefined()
    }
    const plain = { ...test.input, id: ProContract.ID.create() }
    yield* test.bindings.issue(plain)
    expect((yield* test.native.issue(plain, test.configuration)).review.available).toBe(false)
    expect(yield* test.state.registration(plain.id)).toBeUndefined()
    const unavailable = { ...test.input, id: ProContract.ID.create() }
    expect(
      (yield* test.native.issue(unavailable, {
        ...test.configuration,
        reviewer: { ...test.configuration.reviewer, agent: AgentV2.ID.make("missing-reviewer") },
      })).review.available,
    ).toBe(false)
    expect(yield* test.state.registration(unavailable.id)).toBeUndefined()
    expect(yield* test.fs.readDirectory(path.join(global.data, "native-advisory"))).toEqual(directories)
    expect(yield* test.fs.exists(registration.directory)).toBe(true)
  }),
)

it.effect("keeps malformed requests on unregistered contracts adapter-unavailable", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    const input = { ...test.input, id: ProContract.ID.create() }
    yield* test.bindings.issue(input)
    yield* test.bindings.activate(input.id, 1, 0)
    const binding = (yield* test.bindings.claim(input.id, 0))!
    const error = yield* test.native.handler.command!({
      ...test.command,
      execution: ProContractOpenCode.execution(binding),
      kind: "unsupported",
      payload: null,
    }).pipe(Effect.flip)
    expect(error).toMatchObject({ message: expect.stringContaining("adapter is unavailable") })
    expect(yield* test.state.list(input.id)).toHaveLength(0)
    expect(yield* test.bindings.get(input.id)).toEqual(binding)
  }),
)

for (const payload of [null, [], { instructions: "override" }, { materials: [] }, ""])
  it.effect(`rejects a nonempty or nonobject payload ${JSON.stringify(payload)} before admission`, () =>
    Effect.gen(function* () {
      const test = yield* setup()
      expect((yield* test.native.handler.command!({ ...test.command, payload }).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
      expect(yield* test.state.list(test.input.id)).toHaveLength(0)
    }),
  )

it.effect("leaves busy admission unchanged, reconciles exact retries and accepts completed same-batch tools", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.tool("other", "bash", { command: "tracked long process" })
    const first = yield* test.native.handler.command!(test.command)
    expect(first).toMatchObject({ reason: expect.stringContaining("no review is queued") })
    expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
    const record = (yield* test.state.list(test.input.id))[0]
    yield* test.fs.remove(path.join(test.directory, "file.txt"))
    expect(yield* test.native.handler.command!(test.command)).toEqual(first)
    expect((yield* test.state.list(test.input.id))[0]).toEqual(record)
    yield* test.fs.writeFileString(path.join(test.directory, "file.txt"), "first captured bytes\n")
    yield* test.finish("other")
    yield* test.finish("review-1")
    yield* test.tool("review-2")
    const accepted = yield* test.native.handler.command!({
      ...test.command,
      call: { ...test.command.call, callID: "review-2" },
    })
    expect(accepted).toMatchObject({ status: "accepted" })
    const closed = (yield* test.bindings.get(test.input.id))!
    expect(closed.admission?.open).toBe(false)
    expect(closed.admission!.version).toBe(1)
    expect((yield* test.native.handler.command!(test.command).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* test.bindings.get(test.input.id)).toEqual(closed)
  }),
)

it.effect("does not treat missing or foreign assistant messages as idle", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    const result = yield* test.native.handler.command!({
      ...test.command,
      call: { ...test.command.call, messageID: SessionMessage.ID.create() },
    })
    expect(result).toMatchObject({ status: "unavailable", reason: expect.stringContaining("Cannot verify") })
    expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
    const other = yield* test.sessions.create({ location: test.input.location, model: test.input.model })
    const messageID = SessionMessage.ID.create()
    yield* test.events.publish(SessionEvent.Step.Started, {
      sessionID: other.id,
      assistantMessageID: messageID,
      timestamp: yield* DateTime.now,
      agent: "build",
      model: test.input.model,
    })
    const foreign = yield* test.native.handler.command!({ ...test.command, call: { ...test.command.call, messageID } })
    expect(foreign).toMatchObject({ status: "unavailable" })
    expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
  }),
)

it.effect("rolls back both the request and real admission CAS if the atomic acceptance fails", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    const native = yield* NativeAdvisory.make.pipe(
      Effect.provideService(ProContractOpenCode.Service, {
        ...test.bindings,
        setAdmission: (input) =>
          test.bindings.setAdmission(input).pipe(Effect.as({ conflict: "Injected failure after the real CAS" })),
      }),
    )
    expect((yield* native.handler.command!(test.command).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
    expect(yield* test.state.list(test.input.id)).toHaveLength(0)
    const database = yield* Database.Service
    expect(test.state.db).toBe(database.db)
    const store = yield* SessionStore.Service
    expect((yield* store.message(test.command.call.messageID))?.sessionID).toBe(test.binding.sessionID)
  }),
)

it.effect("keeps prequery and post-pause snapshots distinct and commits immutable job coordinates", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.native.handler.command!(test.command)
    const accepted = (yield* test.state.list(test.input.id))[0]
    yield* test.fs.writeFileString(path.join(test.directory, "file.txt"), "changed after prequery\n")
    yield* test.native.advance(accepted.id)
    const captured = (yield* test.state.get(accepted.id))!
    expect(captured.prequery).toEqual(accepted.prequery)
    expect(captured.actual?.subjectHash).not.toBe(captured.prequery?.subjectHash)
    const prepared = (yield* test.native.advance(accepted.id))!
    expect(prepared.materials?.key).toBe(captured.actual!.key)
    expect(prepared.materials?.files[0].blob.hash).toBe(Hash.sha256("changed after prequery\n"))
    expect(prepared.job?.inputHash).toBe(prepared.materials?.hash)
    const jobs = yield* ProContractJob.Service
    const job = (yield* jobs.get(prepared.job!.id))!
    expect(yield* jobs.create(prepared.job!)).toEqual(job)
    expect(job.deadline).toBe(120_000)
    expect(prepared.pause!.stopAt).toBe(accepted.pause!.stopAt)
    const key = NativeAdvisoryMaterials.key(prepared.registration, prepared.actual!.subjectHash)
    expect(key).not.toBe(
      NativeAdvisoryMaterials.key(
        {
          ...prepared.registration,
          configuration: { ...prepared.registration.configuration, evidence: [{ hash: "a".repeat(64), bytes: 10 }] },
        },
        prepared.actual!.subjectHash,
      ),
    )
    expect(key).not.toBe(
      NativeAdvisoryMaterials.key(
        { ...prepared.registration, hash: "different-configuration" },
        prepared.actual!.subjectHash,
      ),
    )
    expect(key).not.toBe(
      NativeAdvisoryMaterials.key(
        { ...prepared.registration, context: { ...prepared.registration.context, version: 2 } },
        prepared.actual!.subjectHash,
      ),
    )
  }),
)

for (const kind of ["missing", "directory"] as const)
  it.effect(`does not pause for ${kind} material and retains the exact unavailable receipt`, () =>
    Effect.gen(function* () {
      const test = yield* setup(kind === "missing" ? ["file.txt", "uncreated.txt"] : ["file.txt"])
      const file = path.join(test.directory, "file.txt")
      yield* test.fs.remove(file)
      if (kind === "directory") yield* test.fs.makeDirectory(file)
      const result = yield* test.native.handler.command!(test.command)
      expect(result).toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining(
          kind === "missing" ? "No approved review material files are present" : "contained regular file",
        ),
      })
      expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
      expect((yield* test.state.list(test.input.id))[0]).toMatchObject({ phase: "returned" })
      expect((yield* test.state.list(test.input.id))[0].pause).toBeUndefined()
      expect((yield* test.state.list(test.input.id))[0].job).toBeUndefined()
      if (kind === "directory") yield* test.fs.remove(file, { recursive: true })
      yield* test.fs.writeFileString(file, "restored material\n")
      expect(yield* test.native.handler.command!(test.command)).toEqual(result)
      expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
    }),
  )

it.effect("marks absent snapshot files without importing later live files and verifies their frozen absence", () =>
  Effect.gen(function* () {
    const test = yield* setup(["file.txt", "uncreated.txt"])
    yield* test.native.handler.command!(test.command)
    const request = (yield* test.state.list(test.input.id))[0]
    const captured = (yield* test.native.advance(request.id))!
    yield* test.fs.writeFileString(path.join(test.directory, "uncreated.txt"), "created after the actual snapshot\n")
    const prepared = (yield* test.native.advance(request.id))!
    expect(prepared.phase, prepared.outcome?.reason).toBe("job")
    expect(prepared.materials?.missing).toEqual(["uncreated.txt"])
    expect(prepared.materials?.files.map((file) => file.path)).toEqual(["file.txt"])
    expect(yield* test.fs.readJson(path.join(prepared.materials!.directory, "materials.json"))).toMatchObject({
      missing: ["uncreated.txt"],
      files: [{ path: "file.txt" }],
    })
    const materials = yield* NativeAdvisoryMaterials.make
    yield* materials.verify(prepared)
    expect((yield* materials.capture(prepared.registration)).key).not.toBe(captured.actual!.key)
    const missing = path.join(prepared.materials!.directory, "candidate", "uncreated.txt")
    expect(yield* test.fs.exists(missing)).toBe(false)
    yield* test.fs.writeFileString(missing, "unsealed late material\n")
    expect((yield* materials.verify(prepared).pipe(Effect.exit))._tag).toBe("Failure")
  }),
)

it.effect("rejects a dangling material symlink instead of treating it as an allowed missing file", () =>
  Effect.gen(function* () {
    const test = yield* setup(["file.txt", "uncreated.txt"])
    yield* test.fs.symlink("does-not-exist.txt", path.join(test.directory, "uncreated.txt"))
    expect(yield* test.native.handler.command!(test.command)).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("contained regular file"),
    })
    expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
    expect((yield* test.state.list(test.input.id))[0].pause).toBeUndefined()
  }),
)

it.effect("queries only unfinished work while preserving completed requests and their history", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.native.handler.command!(test.command)
    const request = (yield* test.state.list(test.input.id))[0]
    expect(yield* test.state.unfinished()).toEqual([request])
    yield* TestClock.adjust("4 seconds")
    const collected = (yield* test.native.advance(request.id))!
    expect(collected.phase).toBe("collected")
    expect(yield* test.state.unfinished()).toEqual([collected])
    yield* test.native.advance(request.id)
    const resumed = (yield* test.native.advance(request.id))!
    expect(resumed.phase).toBe("resumed")
    expect(yield* test.state.unfinished()).toEqual([])
    expect(yield* test.state.list(test.input.id)).toEqual([resumed])
    expect((yield* test.state.history(request.id)).at(0)).toEqual(request)
    expect((yield* test.state.history(request.id)).at(-1)).toEqual(resumed)
  }),
)

it.effect(
  "prepares and verifies review material through a symlinked data directory while rejecting material symlinks",
  () =>
    Effect.gen(function* () {
      const global = yield* Global.Service
      const fs = yield* FSUtil.Service
      const directory = path.join(global.tmp, "real-data")
      yield* fs.rename(global.data, directory)
      yield* fs.symlink(directory, global.data)
      const test = yield* setup()
      yield* test.native.handler.command!(test.command)
      const request = (yield* test.state.list(test.input.id))[0]
      yield* test.native.advance(request.id)
      const prepared = (yield* test.native.advance(request.id))!
      expect(prepared.phase, prepared.outcome?.reason).toBe("job")
      expect(prepared.registration.directory).toBe(yield* fs.realPath(prepared.registration.directory))
      const materials = yield* NativeAdvisoryMaterials.make
      yield* materials.verify(prepared)
      const file = path.join(prepared.materials!.directory, "candidate", "file.txt")
      const target = path.join(global.tmp, "material-copy.txt")
      yield* fs.writeFile(target, yield* fs.readFile(file))
      yield* fs.remove(file)
      yield* fs.symlink(target, file)
      expect((yield* materials.verify(prepared).pipe(Effect.exit))._tag).toBe("Failure")
    }),
)

it.effect("does not pause near the deadline or extend time on an exact retry", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    for (const time of [20_000, 40_000, 60_000]) {
      yield* TestClock.setTime(time)
      yield* test.bindings.heartbeat(new Set([test.binding.sessionID]), time)
    }
    const before = yield* test.bindings.get(test.input.id)
    const result = yield* test.native.handler.command!(test.command)
    expect(result).toMatchObject({ status: "not-started" })
    expect(yield* test.bindings.get(test.input.id)).toEqual(before)
    const request = (yield* test.state.list(test.input.id))[0]
    yield* TestClock.adjust("1 second")
    expect(yield* test.native.handler.command!(test.command)).toEqual(result)
    expect(yield* test.state.get(request.id)).toEqual(request)
  }),
)

it.effect("cancels a prepared job if the second time check fails and preserves the original Session", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.native.handler.command!(test.command)
    const accepted = (yield* test.state.list(test.input.id))[0]
    yield* test.native.advance(accepted.id)
    const prepared = (yield* test.native.advance(accepted.id))!
    yield* TestClock.adjust("3 seconds")
    const captured = (yield* test.native.advance(accepted.id))!
    expect(captured.outcome?.status).toBe("not-started")
    const jobs = yield* ProContractJob.Service
    expect(yield* jobs.get(prepared.job!.id)).toMatchObject({ status: "cancelled", generation: 0, deadline: 120_000 })
    yield* test.native.advance(accepted.id)
    const resumed = (yield* test.native.advance(accepted.id))!
    expect(resumed).toMatchObject({ phase: "resumed", resumedSessionID: test.binding.sessionID })
    expect(resumed.pause!.stopAt).toBe(accepted.pause!.stopAt)
    expect(resumed.delivery!.input.text).toContain("not-started")
    expect((yield* test.contracts.get(test.input.id))!.spec.budget).toEqual({ deadline: 120_000 })
  }),
)

for (const boundary of ["foreign-close", "capabilities", "pending-revision", "cancelled", "deadline"] as const)
  it.effect(`recovery never reopens after ${boundary}`, () =>
    Effect.gen(function* () {
      const test = yield* setup()
      yield* test.native.handler.command!(test.command)
      const request = (yield* test.state.list(test.input.id))[0]
      yield* test.native.advance(request.id)
      const prepared = (yield* test.native.advance(request.id))!
      if (boundary === "foreign-close" || boundary === "capabilities")
        yield* test.bindings.setAdmission({
          expected: (yield* test.bindings.get(test.input.id))!,
          context: request.registration.context,
          open: false,
          reason: boundary === "foreign-close" ? "Unrelated issuer pause" : request.pause!.reason,
          capabilities: boundary === "capabilities" ? ["read"] : undefined,
        })
      if (boundary === "pending-revision")
        expect(
          (yield* test.contracts.petitionRevision({
            contractID: test.input.id,
            spec: { ...test.input.spec, goal: "Changed authority" },
            reason: "Issuer decision needed",
          })).decision.type,
        ).toBe("accepted")
      if (boundary === "cancelled")
        expect(
          (yield* test.contracts.release({ contractID: test.input.id, reason: "Issuer cancelled this work" })).decision
            .type,
        ).toBe("accepted")
      if (boundary === "deadline") yield* TestClock.setTime(120_000)
      const before = yield* test.bindings.get(test.input.id)
      const returned = (yield* test.native.advance(request.id))!
      expect(returned.phase).toBe("returned")
      expect(returned.resumedAt).toBeUndefined()
      expect(yield* test.bindings.get(test.input.id)).toEqual(before)
      const jobs = yield* ProContractJob.Service
      expect(yield* jobs.get(prepared.job!.id)).toMatchObject({ status: "cancelled", generation: 0, deadline: 120_000 })
    }),
  )

it.effect("root activity prevents retirement, capture and reopening even after the operation stop time", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.native.handler.command!(test.command)
    const request = (yield* test.state.list(test.input.id))[0]
    const before = yield* test.bindings.get(test.input.id)
    const activity = yield* ProContractActivity.Service
    yield* TestClock.adjust("4 seconds")
    expect(yield* activity.run(test.input.id, test.native.advance(request.id))).toMatchObject({
      phase: "accepted",
      reason: expect.stringContaining("root cleanup remains unconfirmed"),
    })
    expect(yield* test.bindings.get(test.input.id)).toEqual(before)
    expect((yield* test.native.advance(request.id))!.outcome?.status).toBe("not-started")
    yield* test.native.advance(request.id)
    expect((yield* test.native.advance(request.id))!.resumedSessionID).toBe(test.binding.sessionID)
  }),
)

it.effect("material validation cannot extend the operation deadline or start a reviewer late", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.native.handler.command!(test.command)
    const request = (yield* test.state.list(test.input.id))[0]
    yield* test.native.advance(request.id)
    const prepared = (yield* test.native.advance(request.id))!
    const native = yield* NativeAdvisory.make.pipe(
      Effect.provideService(NativeAdvisoryStore.Service, {
        ...test.state,
        bytes: (hash) => test.state.bytes(hash).pipe(Effect.tap(() => TestClock.setTime(2_500))),
      }),
    )
    const result = (yield* native.advance(request.id))!
    expect(result.outcome?.status).toBe("not-started")
    const jobs = yield* ProContractJob.Service
    expect(yield* jobs.get(prepared.job!.id)).toMatchObject({ status: "cancelled", generation: 0 })
    expect(result.pause?.stopAt).toBe(request.pause!.stopAt)
  }),
)

it.effect("retains the not-started outcome across failed prepared-job cleanup and later reconciliation", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.native.handler.command!(test.command)
    const request = (yield* test.state.list(test.input.id))[0]
    yield* test.native.advance(request.id)
    const prepared = (yield* test.native.advance(request.id))!
    const jobs = yield* ProContractJob.Service
    const native = yield* NativeAdvisory.make.pipe(
      Effect.provideService(ProContractJob.Service, {
        ...jobs,
        cancel: () => Effect.fail(new ProContractJob.Denied({ message: "Injected cancellation interruption" })),
      }),
    )
    yield* TestClock.adjust("3 seconds")
    const stopped = (yield* native.advance(request.id))!
    expect(stopped).toMatchObject({ phase: "job", recovering: true, outcome: { status: "not-started" } })
    expect(yield* jobs.get(prepared.job!.id)).toMatchObject({ status: "prepared", generation: 0 })
    const collected = (yield* test.native.advance(request.id))!
    expect(collected.outcome).toMatchObject({ status: "not-started", jobStatus: "cancelled" })
    yield* test.native.advance(request.id)
    const resumed = (yield* test.native.advance(request.id))!
    expect(resumed).toMatchObject({ phase: "resumed", resumedSessionID: test.binding.sessionID })
    expect(resumed.delivery?.input.text).toContain("not-started")
  }),
)

it.effect(
  "startup-style reconciliation waits for a foreign root lease, then uses native sweep and a replacement Session",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      yield* test.native.handler.command!(test.command)
      const request = (yield* test.state.list(test.input.id))[0]
      yield* test.state.save(request, { ...request, recovering: true, resume: "replace" })
      const database = yield* Database.Service
      const bindings = Context.get(
        yield* Layer.build(
          Layer.fresh(
            AppNodeBuilder.build(ProContractOpenCode.node, [
              [Database.node, Layer.succeed(Database.Service, database)],
              [ProContract.node, Layer.succeed(ProContract.Service, test.contracts)],
            ]),
          ),
        ),
        ProContractOpenCode.Service,
      )
      const native = yield* NativeAdvisory.make.pipe(Effect.provideService(ProContractOpenCode.Service, bindings))
      expect(bindings.owner).not.toBe(test.bindings.owner)
      const before = yield* bindings.get(test.input.id)
      expect((yield* native.advance(request.id))!.phase).toBe("accepted")
      expect(yield* bindings.get(test.input.id)).toEqual(before)
      yield* TestClock.adjust("31 seconds")
      expect((yield* native.advance(request.id))!.phase).toBe("collected")
      const resumed = (yield* native.advance(request.id))!
      expect(resumed.phase).toBe("resumed")
      expect(resumed.resumedSessionID).not.toBe(test.binding.sessionID)
      expect(resumed.delivery).toBeUndefined()
      expect((yield* bindings.get(test.input.id))!.admission?.input).toBeUndefined()
      expect((yield* test.contracts.get(test.input.id))!.spec.budget).toEqual({ deadline: 120_000 })
    }),
)

it.effect("does not confuse a cancelled job or an expired wait with completed in-process cleanup", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.native.handler.command!(test.command)
    const request = (yield* test.state.list(test.input.id))[0]
    yield* test.native.advance(request.id)
    const prepared = (yield* test.native.advance(request.id))!
    const jobs = yield* ProContractJob.Service
    yield* jobs.start(prepared.job!.id)
    yield* test.state.save(prepared, { ...prepared, recovering: true, resume: "preserve" })
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const activity = yield* ProContractActivity.Service
    const running = yield* activity
      .run(test.input.id, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
      .pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const advancing = yield* test.native.advance(request.id).pipe(Effect.forkChild)
    yield* TestClock.adjust("31 seconds")
    const waiting = (yield* Fiber.join(advancing))!
    expect(waiting.reason).toContain("cleanup")
    expect(waiting.phase).toBe("job")
    expect((yield* test.bindings.get(test.input.id))!.admission?.open).toBe(false)
    expect(yield* jobs.get(prepared.job!.id)).toMatchObject({
      status: "cancelled",
      generation: 1,
      owner: expect.any(String),
    })
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(running)
    yield* test.native.advance(request.id)
    yield* test.native.advance(request.id)
    const resumed = (yield* test.native.advance(request.id))!
    expect(resumed).toMatchObject({ phase: "resumed", resumedSessionID: test.binding.sessionID })
    expect((yield* jobs.get(prepared.job!.id))!.owner).toBeUndefined()
  }),
)

for (const conflict of ["text", "delivery", "context", "reason"] as const)
  it.effect(`does not reconcile a reopen by fixed message ID alone when ${conflict} differs`, () =>
    Effect.gen(function* () {
      const test = yield* setup()
      yield* test.native.handler.command!(test.command)
      const request = (yield* test.state.list(test.input.id))[0]
      yield* TestClock.adjust("4 seconds")
      yield* test.native.advance(request.id)
      const collected = (yield* test.native.advance(request.id))!
      const delivery = collected.delivery!
      // A real competing reopen owns the binding. Alter only the host's expected
      // input in the context case, where Core correctly rejects a mismatched target.
      if (conflict === "context")
        yield* test.state.save(collected, {
          ...collected,
          delivery: {
            ...delivery,
            input: {
              ...delivery.input,
              once: { ...delivery.input.once!, context: { ...delivery.input.once!.context, version: 100 } },
            },
          },
        })
      const restored = yield* test.bindings.setAdmission({
        expected: (yield* test.bindings.get(test.input.id))!,
        context: request.registration.context,
        open: true,
        session: "preserve",
        reason: conflict === "reason" ? "Different owner reason" : delivery.reason,
        input: {
          ...delivery.input,
          ...(conflict === "text" ? { text: "Different opinion" } : {}),
          ...(conflict === "delivery" ? { delivery: "queue" as const } : {}),
        },
      })
      expect(restored.binding).toBeDefined()
      const result = (yield* test.native.advance(request.id))!
      expect(result.phase).toBe("returned")
      expect(result.resumedAt).toBeUndefined()
      expect(yield* test.bindings.get(test.input.id)).toEqual(restored.binding)
    }),
  )
