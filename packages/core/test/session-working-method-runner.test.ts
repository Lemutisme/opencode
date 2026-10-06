import { expect, test } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Clock, DateTime, Effect, Fiber, Layer, Schema, Scope, Stream } from "effect"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { AgentV2 } from "../src/agent"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { ModelV2 } from "../src/model"
import { PermissionV2 } from "../src/permission"
import { ProContract } from "../src/pro-contract"
import { ProContractOpenCode } from "../src/pro-contract/open-code"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { Prompt } from "../src/session/prompt"
import { SessionProjector } from "../src/session/projector"
import { SessionRunner } from "../src/session/runner"
import { node } from "../src/session/runner/llm"
import { SessionRunnerModel } from "../src/session/runner/model"
import { SessionStore } from "../src/session/store"
import { SessionWorkingMethod } from "../src/session/working-method"
import { BashTool } from "../src/tool/bash"
import { ToolRegistry } from "../src/tool/registry"
import { WorkingMethodTool } from "../src/tool/working-method"
import { Hash } from "../src/util/hash"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

const model = ModelV2.Ref.make({ id: ModelV2.ID.make("fixed"), providerID: ProviderV2.ID.make("fixture") })
const observed = "2"
const change = "Check the smallest admissible inputs before encoding a strict lower bound."
const completed = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "answer" }),
  LLMEvent.textDelta({ id: "answer", text: "The method trial remains unverified." }),
  LLMEvent.textEnd({ id: "answer" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]
const call = (id: string, name: string, input: unknown) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id, name, input }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]
const Catalog = Schema.Struct({
  observations: Schema.Array(
    Schema.Struct({
      messageID: SessionMessage.ID,
      callID: Schema.optional(Schema.String),
      channel: Schema.String,
      block: Schema.Number,
      hash: Schema.String,
      excerpt: Schema.String,
    }),
  ),
})

function toolResult(request: LLMRequest, id: string) {
  const part = request.messages
    .flatMap((message) => message.content)
    .find((part) => part.type === "tool-result" && part.id === id)
  if (!part || part.type !== "tool-result" || part.result.type !== "text" || typeof part.result.value !== "string")
    throw new Error(`Missing text result: ${id}: ${JSON.stringify(part)}`)
  return part.result.value
}

function trial(request: LLMRequest) {
  const catalog = Schema.decodeUnknownSync(Schema.fromJsonString(Catalog))(toolResult(request, "catalog"))
  const evidence = catalog.observations.find(
    (item) => item.callID === "probe" && item.channel === "content" && item.block === 0,
  )
  if (!evidence) throw new Error("Real bash display was not indexed")
  expect(evidence.excerpt).toBe(observed)
  expect(evidence.hash).toBe(Hash.sha256(observed))
  return {
    action: "revise",
    expectedRevision: 0,
    condition: "A universal rule is contradicted by an observed boundary case.",
    previous: "Adding two positive integers always yields more than 2.",
    change,
    expectation: "Avoid excluding the smallest valid sum from the implementation.",
    reconsiderWhen: "A matched contrast shows that a different condition caused the discrepancy.",
    reason: "The recorded sum of 1 and 1 contradicts the strict bound; it does not establish all input behavior.",
    evidence: [{ ...evidence, quote: observed }],
  }
}

function learnedData(request: LLMRequest) {
  return request.messages.flatMap((message) =>
    message.content.flatMap((part) =>
      part.type === "text" && part.text.startsWith("Working method ") ? [{ role: message.role, text: part.text }] : [],
    ),
  )
}

// Only provider decisions are scripted. The shell, permission checks, tool registry,
// durable admission, event projection, method ledger and runner are the real implementations.
function layer(directory: string, stream: LLMClientShape["stream"]) {
  return AppNodeBuilder.build(
    LayerNode.group([
      node,
      Database.node,
      EventV2.node,
      AgentV2.node,
      PermissionV2.node,
      ToolRegistry.node,
      BashTool.node,
      WorkingMethodTool.node,
      SessionWorkingMethod.node,
      SessionStore.node,
      ProContract.node,
      ProContractOpenCode.node,
      SessionV2.node,
      SessionProjector.node,
    ]),
    [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
      [
        Global.node,
        Global.layerWith({
          data: path.join(directory, ".data"),
          home: directory,
          config: path.join(directory, ".config"),
        }),
      ],
      [SessionExecution.node, SessionExecution.noopLayer],
      [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
      [
        SessionRunnerModel.node,
        SessionRunnerModel.layerWith(() => Effect.succeed(Model.make({ id: "fixed", provider: "fixture", route }))),
      ],
      [
        LayerNodePlatform.llmClient,
        Layer.succeed(
          LLMClient.Service,
          LLMClient.Service.of({
            prepare: () => Effect.die("No external provider in this fixture"),
            generate: () => Effect.die("No external provider in this fixture"),
            stream,
          }),
        ),
      ],
    ],
  )
}

type Services =
  | Database.Service
  | EventV2.Service
  | AgentV2.Service
  | PermissionV2.Service
  | SessionV2.Service
  | SessionRunner.Service
  | SessionStore.Service
  | SessionWorkingMethod.Service
  | ProContract.Service
  | ProContractOpenCode.Service

async function run<A, E>(
  body: (directory: string, requests: LLMRequest[]) => Effect.Effect<A, E, Services | Scope.Scope>,
  script: (request: LLMRequest, index: number) => LLMEvent[] = learningScript,
) {
  await using directory = await tmpdir()
  const requests: LLMRequest[] = []
  return await Effect.runPromise(
    body(directory.path, requests).pipe(
      Effect.provide(
        layer(directory.path, (request) => {
          requests.push(request)
          return Stream.fromIterable(script(request, requests.length - 1))
        }),
      ),
      Effect.scoped,
    ),
  )
}

function learningScript(request: LLMRequest, index: number) {
  if (index === 0) return call("probe", "bash", { command: `printf '%s' "$((1 + 1))"` })
  if (index === 1) return call("catalog", "working_method", { action: "read" })
  if (index === 2) return call("learn", "working_method", trial(request))
  return completed
}

function setup(directory: string, mode?: "execution" | "reason") {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const sessions = yield* SessionV2.Service
    const agents = yield* AgentV2.Service
    const contracts = yield* ProContract.Service
    const bindings = yield* ProContractOpenCode.Service
    const now = yield* Clock.currentTimeMillis
    const ref = { directory: AbsolutePath.make(directory) }
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* agents.transform((editor) =>
      editor.update(AgentV2.defaultID, (agent) => {
        agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
      }),
    )
    if (mode) {
      const contractID = ProContract.ID.create()
      const spec = ProContract.Spec.make({
        ...ProContract.defaultSpec("Check the arithmetic boundary without claiming independent acceptance.", now),
        authority: mode === "reason" ? [] : ["process.execute"],
        budget: { deadline: now + 60_000 },
      })
      yield* bindings.issue({
        id: contractID,
        scope: "working-method-runner",
        spec,
        location: ref,
        model,
        ...(mode === "reason" ? { mode } : {}),
        now,
      })
      yield* contracts.activate(contractID, 1, now)
      const binding = yield* bindings.claim(contractID, now)
      if (!binding) return yield* Effect.die("Expected a claimed execution")
      yield* sessions.create({ id: binding.sessionID, location: ref, model })
      yield* sessions.prompt({
        id: binding.promptID,
        sessionID: binding.sessionID,
        resume: false,
        prompt: Prompt.make({ text: spec.goal }),
      })
      return { sessionID: binding.sessionID, contractID, spec }
    }
    const session = yield* sessions.create({ location: ref, model })
    yield* sessions.prompt({
      sessionID: session.id,
      resume: false,
      prompt: Prompt.make({ text: "Inspect the real feedback and conditionally revise your method." }),
    })
    return { sessionID: session.id, contractID: undefined, spec: undefined }
  })
}

function compact(sessionID: SessionV2.ID) {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    const messageID = SessionMessage.ID.create()
    const timestamp = yield* DateTime.now
    yield* events.publish(SessionEvent.Compaction.Started, { sessionID, messageID, timestamp, reason: "manual" })
    yield* events.publish(SessionEvent.Compaction.Ended, {
      sessionID,
      messageID,
      timestamp,
      reason: "manual",
      text: "Continue the original task. This summary deliberately omits the method trial and its witness.",
      recent: "",
    })
  })
}

test("native feedback becomes a conditional assistant-owned trial on the next provider turn", () =>
  run((directory, requests) =>
    Effect.gen(function* () {
      const session = yield* setup(directory)
      const runner = yield* SessionRunner.Service
      const methods = yield* SessionWorkingMethod.Service
      const sessions = yield* SessionV2.Service
      yield* runner.run({ sessionID: session.sessionID, force: true })
      expect(requests).toHaveLength(4)
      expect(requests.every((request) => request.tools.some((tool) => tool.name === "working_method"))).toBe(true)
      expect(requests.slice(0, 3).flatMap(learnedData)).toEqual([])
      expect(learnedData(requests[3])).toEqual([{ role: "assistant", text: expect.stringContaining(change) }])
      expect(requests.flatMap((request) => request.system.map((part) => part.text)).join("\n")).not.toContain(change)
      const view = yield* methods.view(session.sessionID)
      expect(view).toMatchObject({ revision: 1, status: "trial-unverified", totalActive: 1 })
      expect(view.active[0].input).toMatchObject({
        change,
        expectation: expect.any(String),
        reconsiderWhen: expect.any(String),
      })
      expect(view.active[0].observations).toMatchObject([{ channel: "content", hash: Hash.sha256(observed) }])
      const messages = yield* sessions.messages({ sessionID: session.sessionID })
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool",
              id: "probe",
              state: expect.objectContaining({
                status: "completed",
                content: [
                  { type: "text", text: observed },
                  { type: "text", text: "Command exited with code 0." },
                ],
              }),
            }),
          ]),
        }),
      )
      expect(JSON.stringify(messages)).not.toContain("Working method trial data")
    }),
  ))

test("compaction and explicit resume reload trials; retraction removes the active clause without erasing its archive", () =>
  run(
    (directory, requests) =>
      Effect.gen(function* () {
        const session = yield* setup(directory)
        const runner = yield* SessionRunner.Service
        const methods = yield* SessionWorkingMethod.Service
        const store = yield* SessionStore.Service
        const database = yield* Database.Service
        yield* runner.run({ sessionID: session.sessionID, force: true })
        yield* compact(session.sessionID)
        yield* runner.run({ sessionID: session.sessionID, force: true })
        expect(learnedData(requests[4])).toEqual([{ role: "assistant", text: expect.stringContaining(change) }])
        expect(
          requests[4].messages.some((message) =>
            message.content.some((part) => part.type === "tool-result" && part.id === "probe"),
          ),
        ).toBe(false)
        const restored = SessionWorkingMethod.make(path.join(directory, ".data", "working-method"), store, database.db)
        expect(yield* restored.view(session.sessionID)).toMatchObject({ revision: 2, active: [], totalActive: 0 })
        expect(learnedData(requests[5])).toEqual([{ role: "assistant", text: expect.stringContaining('"active":[]') }])
        expect(learnedData(requests[5])[0].text).not.toContain(change)
        expect(toolResult(requests[6], "archive")).toContain(change)
        expect(toolResult(requests[6], "archive")).toContain('"revision":1')
        expect(learnedData(requests[6])[0].text).not.toContain(change)
        expect(yield* methods.view(session.sessionID)).toMatchObject({ revision: 2, active: [] })
      }),
    (request, index) => {
      if (index < 4) return learningScript(request, index)
      if (index === 4)
        return call("retract", "working_method", {
          action: "retract",
          expectedRevision: 1,
          replaces: 1,
          reason: "The condition did not justify another experiment; withdraw rather than silently retain it.",
        })
      if (index === 5) return call("archive", "working_method", { action: "read", revision: 1 })
      return completed
    },
  ))

for (const mode of [undefined, "execution"] as const)
  test(`denied automatic method visibility (${mode ?? "unbound"}) never reads its ambient ledger`, () =>
    run((directory, requests) =>
      Effect.gen(function* () {
        const session = yield* setup(directory, mode)
        const runner = yield* SessionRunner.Service
        const agents = yield* AgentV2.Service
        yield* runner.run({ sessionID: session.sessionID, force: true })
        yield* compact(session.sessionID)
        yield* agents.transform((editor) =>
          editor.update(AgentV2.defaultID, (agent) => {
            agent.permissions = [
              { action: "*", resource: "*", effect: "allow" },
              { action: "working_method", resource: "*", effect: "deny" },
            ]
          }),
        )
        // Corruption makes an accidental ambient ledger read observable as runner failure.
        yield* Effect.promise(() =>
          Bun.write(
            path.join(directory, ".data", "working-method", Hash.sha256(session.sessionID) + ".json"),
            "NOT A LEDGER",
          ),
        )
        yield* runner.run({ sessionID: session.sessionID, force: true })
        expect(requests).toHaveLength(5)
        if (!mode) expect(requests[4].tools.some((tool) => tool.name === "working_method")).toBe(false)
        expect(learnedData(requests[4])).toEqual([])
        expect(JSON.stringify(requests[4])).not.toContain(change)
      }),
    ))

test("declining a real working-method permission request halts without creating trial state", () =>
  run(
    (directory, requests) =>
      Effect.gen(function* () {
        const session = yield* setup(directory)
        const agents = yield* AgentV2.Service
        const permission = yield* PermissionV2.Service
        const runner = yield* SessionRunner.Service
        const methods = yield* SessionWorkingMethod.Service
        yield* agents.transform((editor) =>
          editor.update(AgentV2.defaultID, (agent) => {
            agent.permissions = [
              { action: "*", resource: "*", effect: "allow" },
              { action: "working_method", resource: "*", effect: "ask" },
            ]
          }),
        )
        const running = yield* runner.run({ sessionID: session.sessionID, force: true }).pipe(Effect.forkChild)
        while ((yield* permission.forSession(session.sessionID)).length === 0) yield* Effect.yieldNow
        const pending = yield* permission.forSession(session.sessionID)
        expect(pending[0]).toMatchObject({
          action: "working_method",
          resources: [session.sessionID],
          source: { type: "tool", callID: "declined" },
        })
        yield* permission.reply({ requestID: pending[0].id, reply: "reject" })
        yield* Fiber.await(running)
        expect(requests).toHaveLength(1)
        expect(yield* methods.view(session.sessionID)).toMatchObject({ revision: 0, active: [] })
        expect(learnedData(requests[0])).toEqual([])
      }),
    () => call("declined", "working_method", { action: "read" }),
  ))

test("advertising an ask-gated tool does not disclose a prior trial before approval", () =>
  run(
    (directory, requests) =>
      Effect.gen(function* () {
        const session = yield* setup(directory)
        const agents = yield* AgentV2.Service
        const permission = yield* PermissionV2.Service
        const runner = yield* SessionRunner.Service
        const methods = yield* SessionWorkingMethod.Service
        yield* runner.run({ sessionID: session.sessionID, force: true })
        yield* compact(session.sessionID)
        yield* agents.transform((editor) =>
          editor.update(AgentV2.defaultID, (agent) => {
            agent.permissions = [
              { action: "*", resource: "*", effect: "allow" },
              { action: "working_method", resource: "*", effect: "ask" },
            ]
          }),
        )
        const running = yield* runner.run({ sessionID: session.sessionID, force: true }).pipe(Effect.forkChild)
        while ((yield* permission.forSession(session.sessionID)).length === 0) yield* Effect.yieldNow
        const pending = yield* permission.forSession(session.sessionID)
        yield* permission.reply({ requestID: pending[0].id, reply: "reject" })
        yield* Fiber.await(running)
        expect(requests).toHaveLength(5)
        expect(requests[4].tools.some((tool) => tool.name === "working_method")).toBe(true)
        expect(learnedData(requests[4])).toEqual([])
        expect(JSON.stringify(requests[4])).not.toContain(change)
        expect(yield* methods.view(session.sessionID)).toMatchObject({ revision: 1, totalActive: 1 })
      }),
    (request, index) =>
      index < 4 ? learningScript(request, index) : call("declined", "working_method", { action: "read" }),
  ))

test("an unavailable optional ledger is explicit assistant data and cannot erase or stop the task", () =>
  run((directory, requests) =>
    Effect.gen(function* () {
      const session = yield* setup(directory, "execution")
      const runner = yield* SessionRunner.Service
      const contracts = yield* ProContract.Service
      yield* runner.run({ sessionID: session.sessionID, force: true })
      const filename = path.join(directory, ".data", "working-method", Hash.sha256(session.sessionID) + ".json")
      const retained = yield* Effect.promise(() => Bun.file(filename).text())
      yield* compact(session.sessionID)
      yield* Effect.promise(() => Bun.write(filename, "CORRUPT OPTIONAL LEDGER"))
      yield* runner.run({ sessionID: session.sessionID, force: true })
      expect(requests).toHaveLength(5)
      expect(learnedData(requests[4])).toEqual([
        { role: "assistant", text: expect.stringContaining("Working method data is unavailable") },
      ])
      expect(learnedData(requests[4])[0].text).toContain("not an empty or retracted history")
      expect(learnedData(requests[4])[0].text).not.toContain("CORRUPT")
      expect(learnedData(requests[4])[0].text).not.toContain(filename)
      expect(learnedData(requests[4])[0].text).not.toContain(change)
      expect(requests[4].system.map((part) => part.text).join("\n")).not.toContain("Working method data is unavailable")
      expect(yield* Effect.promise(() => Bun.file(filename).text())).toBe("CORRUPT OPTIONAL LEDGER")
      expect(yield* contracts.get(session.contractID!)).toMatchObject({
        status: "active",
        revision: 1,
        spec: session.spec,
      })
      // Restoring the retained bytes restores the trial; the read failure did not rewrite history.
      yield* Effect.promise(() => Bun.write(filename, retained))
      yield* runner.run({ sessionID: session.sessionID, force: true })
      expect(requests).toHaveLength(6)
      expect(learnedData(requests[5])).toEqual([{ role: "assistant", text: expect.stringContaining(change) }])
    }),
  ))

test("a durably admitted user correction can ground a trial without fabricating tool evidence", () =>
  run(
    (directory, requests) =>
      Effect.gen(function* () {
        const session = yield* setup(directory)
        const runner = yield* SessionRunner.Service
        const sessions = yield* SessionV2.Service
        const methods = yield* SessionWorkingMethod.Service
        yield* runner.run({ sessionID: session.sessionID, force: true })
        yield* sessions.prompt({
          sessionID: session.sessionID,
          resume: false,
          prompt: Prompt.make({ text: "Correction: report percentages with two decimal places, not whole numbers." }),
        })
        yield* runner.run({ sessionID: session.sessionID, force: true })
        expect(requests).toHaveLength(4)
        expect(toolResult(requests[2], "catalog")).toContain("user-feedback-statement-not-independent-verification")
        expect(learnedData(requests[3])).toEqual([
          { role: "assistant", text: expect.stringContaining("format it to two decimal places") },
        ])
        const view = yield* methods.view(session.sessionID)
        expect(view).toMatchObject({ revision: 1, totalActive: 1, status: "trial-unverified" })
        expect(view.active[0].input).toMatchObject({ evidence: [{ channel: "user", quote: "two decimal places" }] })
        if (view.active[0].input.action !== "revise") throw new Error("Expected a revision")
        expect(view.active[0].input.evidence[0].callID).toBeUndefined()
        expect(requests.flatMap((request) => request.system.map((part) => part.text)).join("\n")).not.toContain(
          "format it to two decimal places",
        )
      }),
    (request, index) => {
      if (index === 1) return call("catalog", "working_method", { action: "read" })
      if (index === 2) {
        const catalog = Schema.decodeUnknownSync(Schema.fromJsonString(Catalog))(toolResult(request, "catalog"))
        const evidence = catalog.observations.find(
          (item) => item.channel === "user" && item.excerpt.startsWith("Correction:"),
        )
        if (!evidence) throw new Error("The admitted user correction was not indexed")
        expect(evidence.callID).toBeUndefined()
        return call("learn-user", "working_method", {
          action: "revise",
          expectedRevision: 0,
          condition: "Formatting percentages under this user's current precision requirement.",
          previous: "Round percentages to whole numbers.",
          change: "Before delivering a percentage, format it to two decimal places.",
          expectation: "The next reported percentage has the requested precision.",
          reconsiderWhen: "The user changes precision or the input does not support a numeric percentage.",
          reason: "An explicit correction changes the working presentation rule, not the acceptance authority.",
          evidence: [{ ...evidence, quote: "two decimal places" }],
        })
      }
      return completed
    },
  ))

test("reason mode has no tools and does not inspect ambient method files", () =>
  run(
    (directory, requests) =>
      Effect.gen(function* () {
        const session = yield* setup(directory, "reason")
        const runner = yield* SessionRunner.Service
        const bindings = yield* ProContractOpenCode.Service
        const contracts = yield* ProContract.Service
        yield* Effect.promise(() => mkdir(path.join(directory, ".data", "working-method"), { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            path.join(directory, ".data", "working-method", Hash.sha256(session.sessionID) + ".json"),
            "PRIVATE_AMBIENT_METHOD_INVALID_LEDGER",
          ),
        )
        yield* runner.run({ sessionID: session.sessionID, force: true })
        yield* runner.run({ sessionID: session.sessionID, force: true })
        expect(requests).toHaveLength(1)
        expect(requests[0].tools).toEqual([])
        expect(requests[0].toolChoice).toMatchObject({ type: "none" })
        expect(requests[0].messages).toHaveLength(1)
        expect(requests[0].messages[0]).toMatchObject({
          role: "user",
          content: [{ type: "text", text: session.spec!.goal }],
        })
        expect(JSON.stringify(requests[0])).not.toContain("PRIVATE_AMBIENT")
        expect(learnedData(requests[0])).toEqual([])
        expect(yield* bindings.get(session.contractID!)).toMatchObject({
          mode: "reason",
          turnsUsed: 1,
          actionsUsed: 0,
          model,
        })
        expect((yield* contracts.get(session.contractID!))?.spec).toEqual(session.spec)
      }),
    () => completed,
  ))

test("method revision cannot change the bound Contract deadline, model, authority or acceptance", () =>
  run((directory, requests) =>
    Effect.gen(function* () {
      const session = yield* setup(directory, "execution")
      const runner = yield* SessionRunner.Service
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const agents = yield* AgentV2.Service
      const methods = yield* SessionWorkingMethod.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.defaultID, (agent) => {
          agent.steps = 1
        }),
      )
      yield* runner.run({ sessionID: session.sessionID, force: true })
      expect(requests).toHaveLength(4)
      expect(yield* methods.view(session.sessionID)).toMatchObject({ revision: 1, totalActive: 1 })
      const contract = yield* contracts.get(session.contractID!)
      expect(contract).toMatchObject({ status: "active", revision: 1, spec: session.spec })
      expect(contract?.spec.budget).toEqual({ deadline: session.spec!.budget.deadline })
      expect(contract?.attestationID).toBeUndefined()
      expect(yield* bindings.get(session.contractID!)).toMatchObject({ model, turnsUsed: 4, actionsUsed: 3 })
      expect(requests.map((request) => String(request.model.id))).toEqual(["fixed", "fixed", "fixed", "fixed"])
      expect(requests.flatMap((request) => request.system.map((part) => part.text)).join("\n")).not.toContain(change)
    }),
  ))
