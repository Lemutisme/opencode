import { expect } from "bun:test"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Cause, Clock, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect"
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
import { ProContractDelivery } from "@opencode-ai/core/pro-contract/delivery"
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

const setup = Effect.fnUntraced(function* (
  materials: ReadonlyArray<string> = ["file.txt"],
  nodes?: NativeAdvisoryStore.Configuration["nodes"],
  retryDelay?: number,
) {
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
      ...(retryDelay === undefined ? {} : { resolution: { retryDelay } }),
    },
  }
  const configuration: NativeAdvisoryStore.Configuration = {
    nodes,
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

const nodeInvocation = Effect.fnUntraced(function* (
  test: Effect.Success<ReturnType<typeof setup>>,
  id: string,
  input: { summary: string; uncertainties: ReadonlyArray<string> } | { replay: ProContract.ReplayResult } = {
    summary: "Captured candidate is ready",
    uncertainties: ["Unverified generalization"],
  },
  busy = false,
) {
  const binding = (yield* test.bindings.get(test.input.id))!
  yield* test.sessions.create({ id: binding.sessionID, location: binding.location, model: binding.model })
  const messageID = SessionMessage.ID.create()
  yield* test.events.publish(SessionEvent.Step.Started, {
    sessionID: binding.sessionID,
    assistantMessageID: messageID,
    timestamp: yield* DateTime.now,
    agent: "build",
    model: binding.model,
  })
  const event = { sessionID: binding.sessionID, assistantMessageID: messageID, timestamp: yield* DateTime.now }
  for (const tool of [
    {
      callID: id,
      name: "replay" in input ? "contract_check" : "contract_report_ready",
      input: "replay" in input ? {} : input,
    },
    ...(busy ? [{ callID: `${id}-other`, name: "bash", input: { command: "tracked process" } }] : []),
  ]) {
    yield* test.events.publish(SessionEvent.Tool.Input.Started, { ...event, callID: tool.callID, name: tool.name })
    yield* test.events.publish(SessionEvent.Tool.Input.Ended, {
      ...event,
      callID: tool.callID,
      text: JSON.stringify(tool.input),
    })
    yield* test.events.publish(SessionEvent.Tool.Called, {
      ...event,
      callID: tool.callID,
      tool: tool.name,
      input: tool.input,
      provider: { executed: false },
    })
  }
  const node: ProContractDelivery.Node = {
    execution: ProContractOpenCode.execution(binding),
    call: { messageID, callID: id },
    ...("replay" in input
      ? { type: "check" as const, replay: input.replay }
      : { type: "submission" as const, ...input }),
  }
  return {
    node,
    finish: (callID = id) =>
      test.events.publish(SessionEvent.Tool.Success, {
        ...event,
        callID,
        structured: {},
        content: [],
        result: {},
        provider: { executed: false },
      }),
  }
})

const unavailableResume = Effect.fnUntraced(function* (
  test: Effect.Success<ReturnType<typeof setup>>,
  requestID: string,
) {
  yield* TestClock.adjust("4 seconds")
  yield* test.native.advance(requestID)
  yield* test.native.advance(requestID)
  const resumed = (yield* test.native.advance(requestID))!
  expect(resumed.phase).toBe("resumed")
  return (yield* test.bindings.claim(test.input.id, yield* Clock.currentTimeMillis))!
})

it.effect("persists explicit default nodes, inherits the researcher model and reports unresolved strength", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    const registration = (yield* test.state.registration(test.input.id))!
    expect(registration.configuration.nodes).toEqual({ version: 1, submission: true })
    expect(registration.strength).toMatchObject({
      status: "unconfirmed",
      reason: expect.stringContaining("could not be resolved"),
    })
    const check = yield* nodeInvocation(test, "default-check", { replay: passedCheck })
    expect(yield* test.native.handler.node!(check.node)).toBe("continue")
    expect(yield* test.state.list(test.input.id)).toHaveLength(0)
    expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
    const input = { ...test.input, id: ProContract.ID.create() }
    const issued = yield* test.native.issue(input, {
      ...test.configuration,
      reviewer: { ...test.configuration.reviewer, model: undefined },
    })
    expect(issued.review).toMatchObject({ available: true, strength: { status: "unconfirmed" } })
    expect((yield* test.state.registration(input.id))?.configuration.reviewer.model).toEqual(test.input.model)
  }),
)

for (const mode of ["legacy", "disabled"] as const)
  it.effect(`${mode} node policy retains voluntary review without an automatic pause`, () =>
    Effect.gen(function* () {
      const test = yield* setup(["file.txt"], { version: 1, submission: false })
      if (mode === "legacy") {
        const registration = (yield* test.state.registration(test.input.id))!
        // Restore the historical on-disk shape, rather than reconfiguring through issue().
        yield* test.state.db
          .update(NativeAdvisoryStore.RegistrationTable)
          .set({
            data: {
              ...registration,
              configuration: { ...registration.configuration, nodes: undefined },
              strength: undefined,
            },
          })
          .where(eq(NativeAdvisoryStore.RegistrationTable.contract_id, test.input.id))
          .run()
          .pipe(Effect.orDie)
      }
      const call = yield* nodeInvocation(test, "unarmed")
      expect(yield* test.native.handler.node!(call.node)).toBe("continue")
      expect(yield* test.state.list(test.input.id)).toHaveLength(0)
      expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
      expect(yield* test.native.handler.command!(test.command)).toMatchObject({ status: "accepted" })
    }),
  )

it.effect("busy submission skips do not consume a slot and an exact retry retains the original decision", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    const call = yield* nodeInvocation(test, "busy-submission", undefined, true)
    expect(yield* test.native.handler.node!(call.node)).toBe("continue")
    expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
    expect((yield* test.state.attempt(test.input.id, 1, 1))?.submission).toBeUndefined()
    const skipped = (yield* test.state.list(test.input.id))[0]
    yield* call.finish("busy-submission-other")
    expect(yield* test.native.handler.node!(call.node)).toBe("continue")
    expect(yield* test.state.get(skipped.id)).toEqual(skipped)
    const conflict = yield* test.native.handler.node!({
      ...call.node,
      type: "submission",
      summary: "Conflicting retry",
      uncertainties: [],
    }).pipe(Effect.flip)
    expect(conflict._tag).toBe("ProContractOpenCode.Unauthorized")
    expect(yield* test.state.get(skipped.id)).toEqual(skipped)
    const next = yield* nodeInvocation(test, "idle-submission")
    expect(yield* test.native.handler.node!(next.node)).toBe("intercept")
    expect((yield* test.state.attempt(test.input.id, 1, 1))?.submission).toBeDefined()
    expect(yield* test.bindings.get(test.input.id)).toMatchObject({
      admission: { open: false },
      actionsUsed: 0,
      turnsUsed: 0,
    })
  }),
)

for (const type of ["submission", "check"] as const)
  it.effect(`near-deadline ${type} skips before snapshot work and retains the opportunity`, () =>
    Effect.gen(function* () {
      const test = yield* setup(["file.txt"], { version: 1, submission: true, midcourse: { afterMs: 1 } })
      yield* test.state.observe(test.binding, 0)
      const paths: string[] = []
      const native = yield* NativeAdvisory.make.pipe(
        Effect.provideService(FSUtil.Service, {
          ...test.fs,
          realPath: (name) => Effect.sync(() => paths.push(name)).pipe(Effect.andThen(() => test.fs.realPath(name))),
        }),
      )
      for (const time of [20_000, 40_000, 50_000]) {
        yield* TestClock.setTime(time)
        yield* test.bindings.heartbeat(new Set([test.binding.sessionID]), time)
      }
      const before = yield* test.bindings.get(test.input.id)
      const call = yield* nodeInvocation(test, `late-${type}`, type === "check" ? { replay: passedCheck } : undefined)
      expect(yield* native.handler.node!(call.node)).toBe("continue")
      expect(paths).toHaveLength(0)
      expect(yield* test.bindings.get(test.input.id)).toEqual(before)
      expect((yield* test.state.attempt(test.input.id, 1, 1))?.submission).toBeUndefined()
      const skipped = (yield* test.state.list(test.input.id))[0]
      expect(skipped).toMatchObject({
        phase: "returned",
        outcome: { status: "not-started", reason: expect.stringContaining("Insufficient time") },
      })
      expect(skipped.prequery).toBeUndefined()
      expect(skipped.pause).toBeUndefined()
      expect((yield* test.contracts.get(test.input.id))?.spec.budget).toEqual({ deadline: 120_000 })
    }),
  )

it.effect("admission failure rolls back the node slot with the real CAS and records a skipped attempt", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    const native = yield* NativeAdvisory.make.pipe(
      Effect.provideService(ProContractOpenCode.Service, {
        ...test.bindings,
        setAdmission: (input) =>
          test.bindings.setAdmission(input).pipe(Effect.as({ conflict: "Injected node CAS rollback" })),
      }),
    )
    const call = yield* nodeInvocation(test, "failed-admission")
    expect(yield* native.handler.node!(call.node)).toBe("continue")
    expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
    expect((yield* test.state.attempt(test.input.id, 1, 1))?.submission).toBeUndefined()
    expect((yield* test.state.list(test.input.id))[0]).toMatchObject({
      phase: "returned",
      outcome: { status: "not-started", reason: expect.stringContaining("CAS rollback") },
    })
    const next = yield* nodeInvocation(test, "after-failure")
    expect(yield* test.native.handler.node!(next.node)).toBe("intercept")
  }),
)

for (const type of ["submission", "check"] as const)
  for (const phase of ["before", "after"] as const)
    it.effect(`${type} node defect ${phase} admission commit respects the real transaction boundary`, () =>
      Effect.gen(function* () {
        const test = yield* setup(["file.txt"], { version: 1, submission: true, midcourse: { afterMs: 1 } })
        yield* test.state.observe(test.binding, 0)
        yield* TestClock.setTime(1)
        const native = yield* NativeAdvisory.make.pipe(
          Effect.provideService(ProContractOpenCode.Service, {
            ...test.bindings,
            setAdmission: (input) =>
              test.bindings
                .setAdmission(input)
                .pipe(
                  Effect.tap(() =>
                    phase === "before"
                      ? test.state.db.run("SELECT * FROM injected_admission_failure").pipe(Effect.orDie)
                      : Effect.void,
                  ),
                ),
          }),
          Effect.provideService(NativeAdvisoryStore.Service, {
            ...test.state,
            atomic: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
              test.state
                .atomic(operation)
                .pipe(
                  Effect.tap((result) =>
                    phase === "after" &&
                    typeof result === "object" &&
                    result !== null &&
                    "phase" in result &&
                    result.phase === "accepted"
                      ? Effect.die(new Error("Injected defect after admission commit"))
                      : Effect.void,
                  ),
                ),
          }),
        )
        const call = yield* nodeInvocation(
          test,
          `defect-${phase}`,
          type === "check" ? { replay: passedCheck } : undefined,
        )
        const result = yield* native.handler.node!(call.node).pipe(Effect.exit)
        const request = (yield* test.state.list(test.input.id))[0]
        if (phase === "before") {
          expect(result).toEqual(Exit.succeed("continue"))
          expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
          expect((yield* test.state.attempt(test.input.id, 1, 1))?.submission).toBeUndefined()
          expect(request).toMatchObject({
            phase: "returned",
            outcome: { status: "not-started", reason: expect.stringContaining("injected_admission_failure") },
          })
          expect(request.pause).toBeUndefined()
          const next = yield* nodeInvocation(
            test,
            "after-defect",
            type === "check" ? { replay: passedCheck } : undefined,
          )
          expect(yield* test.native.handler.node!(next.node)).toBe("intercept")
          return
        }
        expect(Exit.isFailure(result) && Cause.hasFails(result.cause)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("ProContractOpenCode.Unauthorized")
        expect(request).toMatchObject({ phase: "accepted", trigger: { type }, attempt: 1 })
        expect((yield* test.bindings.get(test.input.id))?.admission?.open).toBe(false)
        expect((yield* test.state.attempt(test.input.id, 1, 1))?.submission).toBe(
          type === "submission" ? request.id : undefined,
        )
        const resumed = yield* unavailableResume(test, request.id)
        expect(resumed).toMatchObject({
          sessionID: test.binding.sessionID,
          attempts: 1,
          actionsUsed: 0,
          admission: { open: true },
        })
        expect(resumed.admission?.input?.text).toContain(
          type === "check" ? "contract_check passed: true" : "Delivery has not been recorded",
        )
        expect((yield* test.contracts.get(test.input.id))?.handoff).toBeUndefined()
      }),
    )

it.effect("a defect while recording a skipped node still leaves native execution open", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    const native = yield* NativeAdvisory.make.pipe(
      Effect.provideService(NativeAdvisoryStore.Service, {
        ...test.state,
        get: () => Effect.die(new Error("Injected persistent request store defect")),
      }),
    )
    const call = yield* nodeInvocation(test, "skip-store-defect")
    expect(yield* native.handler.node!(call.node)).toBe("continue")
    expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
    expect(yield* test.state.list(test.input.id)).toHaveLength(0)
    expect((yield* test.state.attempt(test.input.id, 1, 1))?.submission).toBeUndefined()
  }),
)

for (const mode of ["authorization-defect", "mixed-interrupt"] as const)
  it.effect(`node ${mode} propagates without a skipped request`, () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const native = yield* NativeAdvisory.make.pipe(
        Effect.provideService(NativeAdvisoryStore.Service, {
          ...test.state,
          get: () =>
            Effect.failCause(
              mode === "authorization-defect"
                ? Cause.die(new ProContractOpenCode.Unauthorized({ message: "Injected revoked authority" }))
                : Cause.combine(Cause.die(new Error("Injected interrupted defect")), Cause.interrupt()),
            ),
        }),
      )
      const call = yield* nodeInvocation(test, mode)
      const result = yield* native.handler.node!(call.node).pipe(Effect.exit)
      expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Cause.hasInterrupts(result.cause)).toBe(mode === "mixed-interrupt")
        expect(Cause.pretty(result.cause)).toContain(
          mode === "authorization-defect" ? "revoked authority" : "interrupted defect",
        )
      }
      expect(yield* test.state.list(test.input.id)).toHaveLength(0)
      expect(yield* test.bindings.get(test.input.id)).toEqual(test.binding)
    }),
  )

it.effect(
  "submission claims are archived as untrusted input and survive unavailable review without consuming actions",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const statement = { summary: "  Exact summary\nwith a second line", uncertainties: ["B", "A"] }
      const call = yield* nodeInvocation(test, "statement", statement)
      expect(yield* test.native.handler.node!(call.node)).toBe("intercept")
      const request = (yield* test.state.list(test.input.id))[0]
      yield* test.native.advance(request.id)
      const prepared = (yield* test.native.advance(request.id))!
      const material = JSON.parse(Buffer.from(yield* test.native.object(prepared.materials!.hash)).toString("utf8"))
      expect(material.executorStatement).toEqual({ trust: "untrusted-executor-statement", ...statement })
      expect(prepared.job?.prompt.text).toContain("untrusted executor claims")
      const plain = NativeAdvisoryMaterials.key(prepared.registration, prepared.actual!.subjectHash)
      const changed = NativeAdvisoryMaterials.key(prepared.registration, prepared.actual!.subjectHash, {
        type: "submission",
        statement: { ...statement, summary: "Different scientific claim" },
      })
      expect(prepared.actual!.key).not.toBe(plain)
      expect(prepared.actual!.key).not.toBe(changed)
      const resumed = yield* unavailableResume(test, request.id)
      expect(resumed).toMatchObject({ sessionID: test.binding.sessionID, attempts: 1, actionsUsed: 0, turnsUsed: 0 })
      expect(resumed.admission?.input?.text).toContain("Delivery has not been recorded")
      expect(resumed.admission?.input?.text).toContain(ProContractRecognition.canonical(statement))
      const next = yield* nodeInvocation(test, "unchanged-resubmission", statement)
      expect(yield* test.native.handler.node!(next.node)).toBe("continue")
    }),
)

it.effect("renders deterministic multiline materials while retaining canonical identity", () =>
  Effect.gen(function* () {
    const test = yield* setup(["file.txt", "uncreated.txt"])
    const statement = { summary: '  Exact "summary", {with: [punctuation]}\n第二行\\path', uncertainties: ["B", "A"] }
    const call = yield* nodeInvocation(test, "formatted-materials", statement)
    expect(yield* test.native.handler.node!(call.node)).toBe("intercept")
    const request = (yield* test.state.list(test.input.id))[0]
    yield* test.native.advance(request.id)
    const prepared = (yield* test.native.advance(request.id))!
    const canonical = Buffer.from(yield* test.state.bytes(prepared.materials!.hash))
    const content: unknown = JSON.parse(canonical.toString("utf8"))
    const bytes = Buffer.from(yield* test.fs.readFile(path.join(prepared.materials!.directory, "materials.json")))
    expect(bytes.toString("utf8")).toBe(`${JSON.stringify(content, null, 2)}\n`)
    for (const field of ["executorStatement", "files", "missing", "evidence"])
      expect(bytes.toString("utf8")).toContain(`\n  "${field}":`)
    expect(content).toMatchObject({
      executorStatement: { trust: "untrusted-executor-statement", ...statement },
      files: [{ path: "file.txt" }],
      missing: ["uncreated.txt"],
      evidence: [],
    })
    expect(canonical.toString("utf8")).toBe(ProContractRecognition.canonical(content))
    expect(prepared.materials!.hash).toBe(Hash.sha256(canonical))
    expect(Hash.sha256(bytes)).not.toBe(prepared.materials!.hash)
    expect(prepared.job?.inputHash).toBe(prepared.materials!.hash)
    expect(prepared.materials!.key).toBe(prepared.actual!.key)
    const materials = yield* NativeAdvisoryMaterials.make
    yield* materials.verify(prepared)
    const repeated = yield* materials.prepare({ ...prepared, id: `${prepared.id}-repeated` })
    expect(Buffer.from(yield* test.fs.readFile(path.join(repeated.directory, "materials.json")))).toEqual(bytes)
    expect(repeated.hash).toBe(prepared.materials!.hash)
    expect(repeated.key).toBe(prepared.materials!.key)
    yield* materials.verify({ ...prepared, materials: repeated })
    expect(yield* test.state.get(prepared.id)).toEqual(prepared)
  }),
)

it.effect("verifies only exact multiline or legacy canonical materials bytes", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.native.handler.command!(test.command)
    const request = (yield* test.state.list(test.input.id))[0]
    yield* test.native.advance(request.id)
    const prepared = (yield* test.native.advance(request.id))!
    const materials = yield* NativeAdvisoryMaterials.make
    const file = path.join(prepared.materials!.directory, "materials.json")
    const canonical = Buffer.from(yield* test.state.bytes(prepared.materials!.hash)).toString("utf8")
    const rendered = `${JSON.stringify(JSON.parse(canonical), null, 2)}\n`
    yield* test.fs.chmod(file, 0o600)
    for (const content of [rendered, canonical]) {
      yield* test.fs.writeFileString(file, content)
      yield* materials.verify(prepared)
    }
    for (const variant of [
      { name: "leading whitespace", content: ` ${rendered}` },
      { name: "changed indentation", content: rendered.replace(/\n  /g, "\n\t") },
      { name: "CRLF", content: rendered.replace(/\n/g, "\r\n") },
      { name: "missing final newline", content: rendered.slice(0, -1) },
      { name: "extra final newline", content: `${rendered}\n` },
      { name: "newline on legacy text", content: `${canonical}\n` },
      { name: "changed content", content: rendered.replace('"version": 1', '"version": 2') },
      { name: "duplicate key", content: canonical.replace('"version":1', '"version":0,"version":1') },
    ]) {
      yield* test.fs.writeFileString(file, variant.content)
      expect(yield* materials.verify(prepared).pipe(Effect.flip), variant.name).toMatchObject({
        message: "Review materials copy is corrupt",
      })
    }
    yield* test.fs.writeFileString(file, rendered)
    yield* materials.verify(prepared)
    expect(yield* test.state.get(prepared.id)).toEqual(prepared)
  }),
)

it.effect("the same attempt keeps its consumed slot across Session rotation and a native new attempt rearms it", () =>
  Effect.gen(function* () {
    const test = yield* setup(["file.txt"], undefined, 1)
    const call = yield* nodeInvocation(test, "first-attempt")
    expect(yield* test.native.handler.node!(call.node)).toBe("intercept")
    const request = (yield* test.state.list(test.input.id))[0]
    const resumed = yield* unavailableResume(test, request.id)
    yield* test.bindings.reserveTurn(
      resumed.sessionID,
      yield* Clock.currentTimeMillis,
      ProContractOpenCode.execution(resumed),
    )
    yield* TestClock.adjust("31 seconds")
    const rotated = (yield* test.bindings.claim(test.input.id, yield* Clock.currentTimeMillis))!
    expect(rotated.sessionID).not.toBe(resumed.sessionID)
    expect(rotated.attempts).toBe(1)
    const sameAttempt = yield* nodeInvocation(test, "rotated-session")
    expect(yield* test.native.handler.node!(sameAttempt.node)).toBe("continue")
    yield* test.bindings.complete({
      execution: ProContractOpenCode.execution(rotated),
      outcome: { type: "completed", reason: "Native Session ended without handoff" },
      now: yield* Clock.currentTimeMillis,
    })
    yield* TestClock.adjust(test.input.spec.resolution.retryDelay)
    const next = (yield* test.bindings.claim(test.input.id, yield* Clock.currentTimeMillis))!
    expect(next.attempts).toBe(2)
    const newAttempt = yield* nodeInvocation(test, "new-attempt")
    expect(yield* test.native.handler.node!(newAttempt.node)).toBe("intercept")
    expect((yield* test.state.attempt(test.input.id, 1, 1))?.submission).toBe(request.id)
    expect((yield* test.state.attempt(test.input.id, 1, 2))?.submission).not.toBe(request.id)
  }),
)

const passedCheck: ProContract.ReplayResult = {
  passed: true,
  policyHash: "approved-policy",
  subjectHash: "checked-snapshot",
  evidenceHash: "retained-evidence",
  summary: "Approved replay passed",
}

it.effect(
  "midcourse timing survives host reconstruction, ignores failed admission, and resets on accepted unavailable review",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(["file.txt"], { version: 1, submission: false, midcourse: { afterMs: 10_000 } })
      const first = yield* nodeInvocation(test, "early-check", { replay: passedCheck })
      expect(yield* test.native.handler.node!(first.node)).toBe("continue")
      expect((yield* test.state.attempt(test.input.id, 1, 1))?.startedAt).toBe(0)
      yield* TestClock.adjust("10 seconds")
      const busy = yield* nodeInvocation(test, "busy-check", { replay: passedCheck }, true)
      expect(yield* test.native.handler.node!(busy.node)).toBe("continue")
      expect(yield* test.state.latestAccepted(test.input.id)).toBeUndefined()
      const restarted = yield* NativeAdvisory.make
      const due = yield* nodeInvocation(test, "due-check", { replay: passedCheck })
      expect(yield* restarted.handler.node!(due.node)).toBe("intercept")
      const accepted = (yield* test.state.latestAccepted(test.input.id))!
      expect(accepted.createdAt).toBe(10_000)
      expect((yield* test.state.attempt(test.input.id, 1, 1))?.startedAt).toBe(0)
      const resumed = yield* unavailableResume(test, accepted.id)
      expect(resumed.admission?.input?.text).toContain("contract_check passed: true")
      expect(resumed.admission?.input?.text).toContain(passedCheck.evidenceHash)
      yield* test.fs.writeFileString(path.join(test.directory, "file.txt"), "changed candidate")
      const early = yield* nodeInvocation(test, "changed-but-early", { replay: passedCheck })
      expect(yield* test.native.handler.node!(early.node)).toBe("continue")
      yield* TestClock.adjust("6 seconds")
      const changed = yield* nodeInvocation(test, "changed-and-due", { replay: passedCheck })
      expect(yield* test.native.handler.node!(changed.node)).toBe("intercept")
      expect((yield* test.state.latestAccepted(test.input.id))?.createdAt).toBe(20_000)
    }),
)

it.effect("midcourse skips the previous accepted snapshot and a failed check without resetting its clock", () =>
  Effect.gen(function* () {
    const test = yield* setup(["file.txt"], { version: 1, submission: false, midcourse: { afterMs: 100 } })
    yield* test.native.handler.command!(test.command)
    const accepted = (yield* test.state.latestAccepted(test.input.id))!
    yield* unavailableResume(test, accepted.id)
    const same = yield* nodeInvocation(test, "same-snapshot", { replay: passedCheck })
    expect(yield* test.native.handler.node!(same.node)).toBe("continue")
    expect((yield* test.state.latestAccepted(test.input.id))?.id).toBe(accepted.id)
    yield* test.fs.writeFileString(path.join(test.directory, "file.txt"), "new material")
    const failed = yield* nodeInvocation(test, "failed-check", { replay: { ...passedCheck, passed: false } })
    expect(yield* test.native.handler.node!(failed.node)).toBe("continue")
    const changed = yield* nodeInvocation(test, "new-snapshot", { replay: passedCheck })
    expect(yield* test.native.handler.node!(changed.node)).toBe("intercept")
  }),
)

it.effect("native nodes propagate expired execution authority without creating a skipped request", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    const call = yield* nodeInvocation(test, "expired")
    yield* TestClock.adjust("31 seconds")
    const error = yield* test.native.handler.node!(call.node).pipe(Effect.flip)
    expect(error._tag).toBe("ProContractOpenCode.Unauthorized")
    expect(yield* test.state.list(test.input.id)).toHaveLength(0)
  }),
)

it.effect("attempt scans observe only active unexpired contracts with a still-valid registration", () =>
  Effect.gen(function* () {
    const test = yield* setup(["file.txt"], { version: 1, submission: true, midcourse: { afterMs: 100 } })
    const excluded: ProContract.ID[] = []
    for (const mode of ["released", "pending-revision", "expired", "context-changed"] as const) {
      const input = {
        ...test.input,
        id: ProContract.ID.create(),
        spec: { ...test.input.spec, budget: { deadline: mode === "expired" ? 500 : 120_000 } },
      }
      expect((yield* test.native.issue(input, test.configuration)).review.available).toBe(true)
      yield* test.bindings.activate(input.id, 1, 0)
      expect((yield* test.bindings.claim(input.id, 0))?.attempts).toBe(1)
      if (mode === "released")
        expect((yield* test.contracts.release({ contractID: input.id, reason: "Issuer released" })).decision.type).toBe(
          "accepted",
        )
      if (mode === "pending-revision")
        expect(
          (yield* test.contracts.petitionRevision({
            contractID: input.id,
            spec: { ...input.spec, goal: "Pending revised task" },
            reason: "Await issuer decision",
          })).decision.type,
        ).toBe("accepted")
      if (mode === "context-changed") {
        expect(
          (yield* test.contracts.escalate({
            contractID: input.id,
            revision: 1,
            reason: "Issuer intervention",
            time: 0,
          })).decision.type,
        ).toBe("accepted")
        expect((yield* test.contracts.resume(input.id)).decision.type).toBe("accepted")
        yield* test.bindings.activate(input.id, 1, 0)
        expect((yield* test.contracts.get(input.id))?.status).toBe("active")
        expect((yield* test.contracts.get(input.id))?.recognition.context?.target).not.toEqual(
          (yield* test.state.registration(input.id))?.context,
        )
      }
      excluded.push(input.id)
    }
    yield* TestClock.setTime(1_000)
    const observed: ProContract.ID[] = []
    const scans: number[] = []
    const scanned = yield* Deferred.make<void>()
    const native = yield* NativeAdvisory.make.pipe(
      Effect.provideService(NativeAdvisoryStore.Service, {
        ...test.state,
        observe: (binding, now) =>
          Effect.sync(() => observed.push(binding.contractID)).pipe(
            Effect.andThen(() => test.state.observe(binding, now)),
          ),
        unfinished: () =>
          test.state.unfinished().pipe(
            Effect.tap(() => {
              scans.push(scans.length)
              // Startup reconciles once; the next read is after the first attempt scan.
              return scans.length === 2 ? Deferred.succeed(scanned, undefined) : Effect.void
            }),
          ),
      }),
    )
    yield* native.start()
    yield* Deferred.await(scanned)
    expect(observed).toEqual([test.input.id])
    expect(yield* test.state.attempt(test.input.id, 1, 1)).toMatchObject({ startedAt: 1_000 })
    for (const id of excluded) expect(yield* test.state.attempt(id, 1, 1)).toBeUndefined()
  }),
)
