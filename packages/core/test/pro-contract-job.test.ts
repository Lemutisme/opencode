import { describe, expect } from "bun:test"
import { LLMEvent, Usage } from "@opencode-ai/llm"
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { eq } from "drizzle-orm"
import { AgentV2 } from "../src/agent"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { ModelV2 } from "../src/model"
import { ProContract } from "../src/pro-contract"
import { ProContractActivity } from "../src/pro-contract/activity"
import { ProContractDriver } from "../src/pro-contract/driver"
import { ProContractJob } from "../src/pro-contract/job"
import { ProContractOpenCode } from "../src/pro-contract/open-code"
import { ProContractJobTable, ProContractJobSessionTable } from "../src/pro-contract/sql"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { ExecutionPermit } from "../src/session/execution-permit"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { SessionTable } from "../src/session/sql"
import { Tool } from "../src/tool/tool"
import { Schema } from "effect"
import { testEffect } from "./lib/effect"

const driver: ProContractDriver.Driver = {
  identity: "job-test:1",
  activate: () => true,
  claim: () => true,
  heartbeat: () => true,
  outcome: () => ({ type: "wait" }),
}
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ProContractJob.node,
      ProContractOpenCode.node,
      ProContract.node,
      ProContractActivity.node,
      ExecutionPermit.node,
      SessionV2.node,
      Database.node,
    ]),
    [
      [ProContractDriver.node, Layer.succeed(ProContractDriver.Service, ProContractDriver.make([driver]))],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

const setup = Effect.fnUntraced(function* (budget: ProContract.Spec["budget"] = { deadline: 120_000 }) {
  const bindings = yield* ProContractOpenCode.Service
  const contracts = yield* ProContract.Service
  const jobs = yield* ProContractJob.Service
  const sessions = yield* SessionV2.Service
  const permits = yield* ExecutionPermit.Service
  const database = yield* Database.Service
  const issued = yield* bindings.issue({
    id: ProContract.ID.create(),
    scope: "job-test",
    driver: driver.identity,
    spec: { ...ProContract.defaultSpec("Review the assigned result", 0), budget },
    location: { directory: AbsolutePath.make("/project") },
    model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test") },
    now: 0,
  })
  const input: ProContractJob.Input = {
    id: crypto.randomUUID(),
    contractID: issued.contract!.id,
    context: (yield* contracts.get(issued.contract!.id))!.recognition.context!.target,
    driver: driver.identity,
    kind: "review",
    inputHash: "a".repeat(64),
    sessionID: SessionV2.ID.create(),
    promptID: SessionMessage.ID.create(),
    location: issued.execution!.location,
    model: issued.execution!.model,
    agent: AgentV2.ID.make("build"),
    prompt: { text: "Independently inspect the fixed material" },
  }
  return { bindings, contracts, jobs, sessions, permits, database, input, binding: issued.execution! }
})

const createSession = (sessions: SessionV2.Interface, input: ProContractJob.Input) =>
  sessions.create({ id: input.sessionID, location: input.location, model: input.model, agent: input.agent })

describe("Controlled Contract jobs", () => {
  it.effect("a rejected revision petition cannot restore captured worker or job execution", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      yield* s.bindings.setAdmission({ expected: s.binding, context: s.input.context, open: true, reason: "worker" })
      yield* s.bindings.activate(s.input.contractID, 1, 0)
      const root = (yield* s.bindings.claim(s.input.contractID, 0))!
      yield* s.sessions.create({ id: root.sessionID, location: root.location, model: root.model })
      const permit = yield* s.permits.capture(root.sessionID)
      yield* s.permits.tool(permit, "read")
      yield* s.database.db
        .transaction(() =>
          Effect.gen(function* () {
            const contract = (yield* s.contracts.get(s.input.contractID))!
            expect(
              (yield* s.contracts.petitionRevision({
                contractID: contract.id,
                spec: { ...contract.spec, goal: "Changed task" },
                reason: "External decision required",
              })).decision.type,
            ).toBe("accepted")
            expect(
              (yield* s.contracts.decideRevision({
                contractID: contract.id,
                accept: false,
                expected: (yield* s.contracts.get(contract.id))!.recognition.pending!,
                operationID: crypto.randomUUID(),
              })).decision.type,
            ).toBe("accepted")
          }),
        )
        .pipe(Effect.orDie)
      expect((yield* s.permits.tool(permit, "read").pipe(Effect.exit))._tag).toBe("Failure")
      expect(
        (yield* s.permits.run(permit, "provider", () => Effect.succeed("must not execute")).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      expect((yield* s.jobs.create(s.input).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* s.jobs.operations(s.input.contractID)).toHaveLength(0)
    }),
  )
  for (const budget of [
    { deadline: 120_000, turns: 10 },
    { deadline: 120_000, actions: 10 },
  ]) {
    it.effect(`rejects unsupported shared count ceilings ${JSON.stringify(budget)}`, () =>
      Effect.gen(function* () {
        const s = yield* setup(budget)
        expect((yield* s.jobs.create(s.input).pipe(Effect.flip)).message).toContain("deadline-only")
        expect(yield* s.jobs.forSession(s.input.sessionID)).toBeUndefined()
      }),
    )
  }
  it.effect("atomically reserves immutable job and Session identities without adopting the worker", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      const created = yield* s.jobs.create(s.input)
      expect(yield* s.jobs.create(s.input)).toEqual(created)
      expect((yield* s.jobs.create({ ...s.input, prompt: { text: "different input" } }).pipe(Effect.flip))._tag).toBe(
        "ExecutionDenied",
      )
      expect((yield* s.jobs.create({ ...s.input, id: crypto.randomUUID() }).pipe(Effect.flip))._tag).toBe(
        "ExecutionDenied",
      )
      expect((yield* s.bindings.get(s.input.contractID))?.sessionID).toBe(s.binding.sessionID)
      expect(yield* s.jobs.forSession(s.input.sessionID)).toEqual(created)
    }),
  )

  it.effect("rejects existing ordinary Sessions and conflicting public reservation creates", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      const ordinary = yield* s.sessions.create({ location: s.input.location })
      expect((yield* s.jobs.create({ ...s.input, sessionID: ordinary.id }).pipe(Effect.flip))._tag).toBe(
        "ExecutionDenied",
      )
      yield* s.jobs.create(s.input)
      const attempts = yield* Effect.all(
        [
          s.sessions.create({ id: s.input.sessionID, location: s.input.location }).pipe(Effect.exit),
          createSession(s.sessions, s.input).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      expect(attempts.map(Exit.isSuccess)).toEqual([false, true])
      expect((yield* s.sessions.get(s.input.sessionID)).model).toMatchObject({ ...s.input.model, variant: "default" })
      expect(
        (yield* s.sessions
          .create({
            id: s.input.sessionID,
            location: s.input.location,
            model: s.input.model,
            agent: AgentV2.ID.make("another"),
          })
          .pipe(Effect.flip))._tag,
      ).toBe("ExecutionDenied")
    }),
  )

  it.effect("closed admission leaves no inbox row and open admission accepts only the frozen prompt", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      yield* s.jobs.create(s.input)
      yield* createSession(s.sessions, s.input)
      const prompt = { id: s.input.promptID, sessionID: s.input.sessionID, prompt: s.input.prompt, resume: false }
      expect((yield* s.sessions.prompt(prompt).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
      expect(yield* SessionInput.find(s.database.db, s.input.promptID)).toBeUndefined()
      yield* s.jobs.start(s.input.id)
      const admitted = yield* s.sessions.prompt(prompt)
      expect(yield* s.sessions.prompt(prompt)).toEqual(admitted)
      expect((yield* s.sessions.prompt({ ...prompt, id: SessionMessage.ID.create() }).pipe(Effect.flip))._tag).toBe(
        "ExecutionDenied",
      )
      expect((yield* s.sessions.prompt({ ...prompt, delivery: "queue" }).pipe(Effect.flip))._tag).toBe(
        "ExecutionDenied",
      )
      yield* s.jobs.cancel(s.input.id, "cancel")
      expect((yield* s.sessions.prompt(prompt).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
      expect((yield* s.sessions.resume(s.input.sessionID).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
    }),
  )

  it.effect("a persistent marker fails closed when the job body is unavailable", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      yield* s.jobs.create(s.input)
      yield* createSession(s.sessions, s.input)
      yield* s.database.db
        .delete(ProContractJobTable)
        .where(eq(ProContractJobTable.id, s.input.id))
        .run()
        .pipe(Effect.orDie)
      expect((yield* s.jobs.forSession(s.input.sessionID).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
      expect((yield* s.permits.capture(s.input.sessionID).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
      expect(
        (yield* s.database.db
          .select()
          .from(ProContractJobSessionTable)
          .where(eq(ProContractJobSessionTable.session_id, s.input.sessionID))
          .get()
          .pipe(Effect.orDie))?.job_id,
      ).toBe(s.input.id)
    }),
  )

  it.effect("a reserved job fails closed when its Session marker is unavailable", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      yield* s.jobs.create(s.input)
      yield* createSession(s.sessions, s.input)
      yield* s.database.db
        .delete(ProContractJobSessionTable)
        .where(eq(ProContractJobSessionTable.session_id, s.input.sessionID))
        .run()
        .pipe(Effect.orDie)
      expect((yield* s.permits.capture(s.input.sessionID).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
      expect(
        (yield* s.sessions.prompt({ sessionID: s.input.sessionID, prompt: s.input.prompt }).pipe(Effect.flip))._tag,
      ).toBe("ExecutionDenied")
    }),
  )

  it.effect("foreign completion cannot release a cancelled owner's lease; expired audit keeps its partial usage", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      const other = Context.get(
        yield* Layer.build(
          Layer.fresh(
            AppNodeBuilder.build(ProContractJob.node, [
              [Database.node, Layer.succeed(Database.Service, s.database)],
              [ProContract.node, Layer.succeed(ProContract.Service, s.contracts)],
              [ProContractDriver.node, Layer.succeed(ProContractDriver.Service, ProContractDriver.make([driver]))],
            ]),
          ),
        ),
        ProContractJob.Service,
      )
      yield* s.jobs.create(s.input)
      yield* createSession(s.sessions, s.input)
      const started = yield* s.jobs.start(s.input.id)
      const permit = yield* s.permits.capture(s.input.sessionID)
      const operation = yield* s.jobs.begin(permit.source!, "provider")
      yield* s.jobs.observe(operation.id, LLMEvent.finish({ reason: "stop", usage: new Usage({ inputTokens: 13 }) }))
      const cancelled = yield* other.cancel(s.input.id, "foreign cancellation")
      yield* other.finish(ProContractJob.execution(cancelled), "interrupted")
      expect((yield* s.jobs.get(s.input.id))?.owner).toBe(started.owner)
      expect(
        (yield* s.bindings.setAdmission({
          expected: s.binding,
          context: s.input.context,
          open: true,
          reason: "lease still live",
        })).conflict,
      ).toBeDefined()
      expect((yield* other.audit(s.input.id).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
      yield* TestClock.adjust("31 seconds")
      expect(yield* other.audit(s.input.id)).toMatchObject({ status: "cancelled", owner: undefined })
      expect(yield* s.jobs.operations(s.input.contractID)).toMatchObject([
        {
          status: "unknown",
          usage: { state: "reported", value: { inputTokens: 13 } },
          usageEvents: [{ type: "finish" }],
        },
      ])
      yield* s.jobs.end(operation.id, "completed")
      expect((yield* s.jobs.operations(s.input.contractID))[0].status).toBe("unknown")
    }),
  )

  it.effect("direct canonical tool cleanup holds Activity through cancellation and lease expiry", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      const activity = yield* ProContractActivity.Service
      yield* s.jobs.create(s.input)
      yield* createSession(s.sessions, s.input)
      yield* s.jobs.start(s.input.id)
      const permit = yield* s.permits.capture(s.input.sessionID)
      const entered = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const tool = Tool.withCapability(
        Tool.make({
          description: "Read with asynchronous cleanup",
          input: Schema.Struct({}),
          output: Schema.Boolean,
          execute: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(release)))),
            ),
        }),
        "read",
      )
      const run = yield* Tool.settle(
        tool,
        { type: "tool-call", name: "read", id: "call", input: {} },
        {
          sessionID: s.input.sessionID,
          agent: s.input.agent,
          assistantMessageID: SessionMessage.ID.create(),
          toolCallID: "call",
          executionPermit: permit,
        },
      ).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      expect(activity.has(s.input.contractID)).toBe(true)
      yield* s.jobs.cancel(s.input.id, "stop direct leaf")
      yield* TestClock.adjust("1 second")
      yield* Deferred.await(cleaning)
      yield* TestClock.adjust("30 seconds")
      expect(
        (yield* s.bindings.setAdmission({
          expected: s.binding,
          context: s.input.context,
          open: true,
          reason: "cleanup blocked",
        })).conflict,
      ).toBeDefined()
      expect((yield* s.jobs.audit(s.input.id).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.await(run))._tag).toBe("Failure")
      expect(activity.has(s.input.contractID)).toBe(false)
      expect(yield* s.jobs.operations(s.input.contractID)).toMatchObject([{ kind: "tool", status: "interrupted" }])
    }),
  )

  it.effect("root takeover audits only the expired execution's running operations", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      yield* s.bindings.setAdmission({ expected: s.binding, context: s.input.context, open: true, reason: "worker" })
      yield* s.bindings.activate(s.input.contractID, 1, 0)
      const root = (yield* s.bindings.claim(s.input.contractID, 0))!
      yield* s.sessions.create({ id: root.sessionID, location: root.location, model: root.model })
      const permit = yield* s.permits.capture(root.sessionID)
      const first = yield* s.jobs.begin(permit.source!, "provider")
      yield* s.jobs.observe(first.id, LLMEvent.finish({ reason: "stop", usage: new Usage({ outputTokens: 5 }) }))
      yield* s.jobs.begin({ ...permit.source!, identity: "unrelated-identity" }, "provider")
      yield* TestClock.adjust("31 seconds")
      expect((yield* s.bindings.claim(s.input.contractID, 0))?.generation).toBe(root.generation! + 1)
      expect(yield* s.jobs.operations(s.input.contractID)).toMatchObject([
        { id: first.id, status: "unknown", usage: { value: { outputTokens: 5 } } },
        { status: "running" },
      ])
    }),
  )

  it.effect("sweep audits the original lease after revocation changes the current root identity", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      yield* s.bindings.setAdmission({ expected: s.binding, context: s.input.context, open: true, reason: "worker" })
      yield* s.bindings.activate(s.input.contractID, 1, 0)
      const root = (yield* s.bindings.claim(s.input.contractID, 0))!
      yield* s.sessions.create({ id: root.sessionID, location: root.location, model: root.model })
      const permit = yield* s.permits.capture(root.sessionID)
      yield* s.jobs.begin(permit.source!, "compaction")
      yield* s.bindings.setAdmission({
        expected: root,
        context: s.input.context,
        open: false,
        reason: "revoked before crash",
      })
      yield* TestClock.adjust("31 seconds")
      yield* s.bindings.sweep(new Set(), 0)
      expect((yield* s.bindings.get(s.input.contractID))?.dispatched).toBe(false)
      expect(yield* s.jobs.operations(s.input.contractID)).toMatchObject([{ kind: "compaction", status: "unknown" }])
    }),
  )

  it.effect("fixed Session coordinates and revert cannot be changed, including persisted tampering", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      yield* s.jobs.create(s.input)
      yield* createSession(s.sessions, s.input)
      yield* s.jobs.start(s.input.id)
      expect(
        (yield* s.sessions.switchAgent({ sessionID: s.input.sessionID, agent: "other" }).pipe(Effect.flip))._tag,
      ).toBe("ExecutionDenied")
      expect(
        (yield* s.sessions.switchModel({ sessionID: s.input.sessionID, model: s.input.model }).pipe(Effect.flip))._tag,
      ).toBe("ExecutionDenied")
      expect((yield* s.sessions.revert.clear(s.input.sessionID).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
      expect((yield* s.sessions.revert.commit(s.input.sessionID).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
      expect(
        (yield* s.sessions.revert
          .stage({ sessionID: s.input.sessionID, messageID: s.input.promptID })
          .pipe(Effect.flip))._tag,
      ).toBe("ExecutionDenied")
      yield* s.database.db
        .update(SessionTable)
        .set({ agent: "other" })
        .where(eq(SessionTable.id, s.input.sessionID))
        .run()
        .pipe(Effect.orDie)
      expect((yield* s.permits.capture(s.input.sessionID).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
    }),
  )

  it.effect("blocks both worker reentry and competing jobs through cancellation cleanup", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      yield* s.jobs.create(s.input)
      const job = yield* s.jobs.start(s.input.id)
      const opening = { expected: s.binding, context: s.input.context, open: true, reason: "worker reentry" }
      expect((yield* s.bindings.setAdmission(opening)).conflict).toBeDefined()
      yield* s.contracts.activate(s.input.contractID, 1, 0)
      expect(yield* s.bindings.claim(s.input.contractID, 0)).toBeUndefined()
      const next = {
        ...s.input,
        id: crypto.randomUUID(),
        sessionID: SessionV2.ID.create(),
        promptID: SessionMessage.ID.create(),
      }
      yield* s.jobs.create(next)
      expect((yield* s.jobs.start(next.id).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
      yield* s.jobs.cancel(job.input.id, "cleanup pending")
      expect((yield* s.bindings.setAdmission(opening)).conflict).toBeDefined()
      expect((yield* s.jobs.start(next.id).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
      yield* s.jobs.finish(ProContractJob.execution(job), "completed")
      expect((yield* s.jobs.get(job.input.id))?.status).toBe("cancelled")
      expect((yield* s.jobs.start(next.id)).status).toBe("open")
    }),
  )

  it.effect("holds a process-local cleanup barrier even after the original lease expires", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      const activity = yield* ProContractActivity.Service
      yield* s.jobs.create(s.input)
      yield* s.jobs.start(s.input.id)
      const entered = yield* Deferred.make<void>()
      const run = yield* activity
        .run(s.input.contractID, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* s.jobs.cancel(s.input.id, "cancelled")
      yield* TestClock.adjust("31 seconds")
      expect(
        (yield* s.bindings.setAdmission({
          expected: s.binding,
          context: s.input.context,
          open: true,
          reason: "cleanup still active",
        })).conflict,
      ).toBeDefined()
      yield* Fiber.interrupt(run)
      expect(
        (yield* s.bindings.setAdmission({
          expected: s.binding,
          context: s.input.context,
          open: true,
          reason: "cleanup ended",
        })).binding,
      ).toBeDefined()
    }),
  )

  it.effect("explicit zero-operation recovery increments identity and fences stale callbacks", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      yield* s.jobs.create(s.input)
      yield* createSession(s.sessions, s.input)
      const old = yield* s.jobs.start(s.input.id)
      const permit = yield* s.permits.capture(s.input.sessionID)
      yield* TestClock.adjust("31 seconds")
      const recovered = yield* s.jobs.recover(s.input.id)
      expect(recovered.generation).toBe(old.generation + 1)
      expect(recovered.deadline).toBe(120_000)
      expect((yield* s.permits.check(permit).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
      yield* s.jobs.finish(ProContractJob.execution(old), "completed")
      expect(yield* s.jobs.get(s.input.id)).toEqual(recovered)
      yield* s.jobs.finish(ProContractJob.execution(recovered), "completed")
      expect((yield* s.jobs.recover(s.input.id).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
    }),
  )

  it.effect("completed operation history also forbids replay if job completion was never committed", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      yield* s.jobs.create(s.input)
      yield* createSession(s.sessions, s.input)
      yield* s.jobs.start(s.input.id)
      const permit = yield* s.permits.capture(s.input.sessionID)
      const operation = yield* s.jobs.begin(permit.source!, "provider")
      yield* s.jobs.observe(operation.id, LLMEvent.finish({ reason: "stop", usage: new Usage({ outputTokens: 7 }) }))
      yield* s.jobs.end(operation.id, "completed")
      yield* TestClock.adjust("31 seconds")
      expect((yield* s.jobs.recover(s.input.id)).status).toBe("unknown")
      expect(yield* s.jobs.operations(s.input.contractID)).toMatchObject([
        { id: operation.id, status: "completed", usage: { state: "reported", value: { outputTokens: 7 } } },
      ])
      expect((yield* s.permits.capture(s.input.sessionID).pipe(Effect.flip))._tag).toBe("ExecutionDenied")
    }),
  )

  it.effect("operation history forbids crash replay and retains late partial usage", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      yield* s.jobs.create(s.input)
      yield* createSession(s.sessions, s.input)
      yield* s.jobs.start(s.input.id)
      const permit = yield* s.permits.capture(s.input.sessionID)
      const op = yield* s.jobs.begin(permit.source!, "provider")
      yield* s.jobs.observe(
        op.id,
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: new Usage({ outputTokens: 7 }) }),
      )
      expect((yield* s.jobs.operations(s.input.contractID))[0].usage).toEqual({
        state: "reported",
        value: { outputTokens: 7 },
      })
      yield* TestClock.adjust("31 seconds")
      expect((yield* s.jobs.recover(s.input.id)).status).toBe("unknown")
      yield* s.jobs.observe(op.id, LLMEvent.finish({ reason: "stop", usage: new Usage({ inputTokens: 9 }) }))
      yield* s.jobs.end(op.id, "completed")
      const saved = (yield* s.jobs.operations(s.input.contractID))[0]
      expect(saved.status).toBe("unknown")
      expect(saved.usageEvents).toHaveLength(2)
      expect(saved.usage.value?.outputTokens).toBeUndefined()
      expect((yield* s.jobs.get(s.input.id))?.status).toBe("unknown")
    }),
  )

  it.effect("canonical tools require trusted capture and reject same-name unmarked implementations", () =>
    Effect.gen(function* () {
      const s = yield* setup()
      yield* s.jobs.create(s.input)
      yield* createSession(s.sessions, s.input)
      yield* s.jobs.start(s.input.id)
      const permit = yield* s.permits.capture(s.input.sessionID)
      const calls: number[] = []
      const tool = Tool.make({
        description: "Application read replacement",
        input: Schema.Struct({}),
        output: Schema.Boolean,
        execute: () =>
          Effect.sync(() => {
            calls.push(1)
            return true
          }),
      })
      const call = { type: "tool-call" as const, name: "read", id: "call", input: {} }
      const context = {
        sessionID: s.input.sessionID,
        agent: s.input.agent,
        assistantMessageID: SessionMessage.ID.create(),
        toolCallID: call.id,
      }
      expect(
        (yield* Tool.settle(tool, call, context).pipe(
          Effect.updateContext((provided: Context.Context<never>) => Context.omit(ExecutionPermit.Service)(provided)),
          Effect.flip,
        )).message,
      ).toContain("service")
      expect((yield* Tool.settle(tool, call, context).pipe(Effect.flip)).message).toContain("permit")
      expect(
        (yield* Tool.settle(tool, call, { ...context, executionPermit: permit }).pipe(Effect.flip)).message,
      ).toContain("implementation")
      expect(calls).toHaveLength(0)
      expect((yield* s.permits.tool(permit, "write").pipe(Effect.flip))._tag).toBe("ExecutionDenied")
    }),
  )
})
