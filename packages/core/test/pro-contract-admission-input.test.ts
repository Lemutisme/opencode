import { expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { ModelV2 } from "../src/model"
import { ProContract } from "../src/pro-contract"
import { ProContractActivity } from "../src/pro-contract/activity"
import { ProContractOpenCode } from "../src/pro-contract/open-code"
import { ProContractScheduler } from "../src/pro-contract/scheduler"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { SessionInputTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      ProContract.node,
      ProContractOpenCode.node,
      ProContractActivity.node,
      ProContractScheduler.node,
      SessionV2.node,
      EventV2.node,
    ]),
    [[SessionExecution.node, SessionExecution.noopLayer]],
  ),
)

const setup = Effect.gen(function* () {
  const bindings = yield* ProContractOpenCode.Service
  const contracts = yield* ProContract.Service
  const scheduler = yield* ProContractScheduler.Service
  const sessions = yield* SessionV2.Service
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const issued = yield* bindings.issue({
    id: ProContract.ID.create(),
    scope: "once-input",
    now: 0,
    location: { directory: AbsolutePath.make("/project") },
    model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test") },
    spec: {
      ...ProContract.defaultSpec("Original approved brief", 0),
      authority: ["filesystem.read", "filesystem.write", "process.execute"],
      budget: { deadline: 120_000 },
      resolution: { maxAttempts: 3, retryDelay: 10 },
    },
  })
  const id = issued.contract!.id
  const context = issued.contract!.recognition.context!.target
  const capabilities = ["read", "write", "process", "control"] as const
  yield* bindings.setAdmission({
    expected: issued.execution!,
    context,
    open: true,
    reason: "Initial native capability grant",
    capabilities,
  })
  yield* scheduler.runOnce()
  const before = (yield* bindings.get(id))!
  const execution = ProContractOpenCode.execution(before)
  yield* SessionInput.promoteNextQueued(database.db, events, before.sessionID)
  yield* bindings.reserveTurn(before.sessionID, 0, execution)
  yield* bindings.reserveAction(before.sessionID, 0, execution)
  const closed = (yield* bindings.setAdmission({
    expected: (yield* bindings.get(id))!,
    context,
    open: false,
    reason: "Owned pause",
    capabilities,
  })).binding!
  yield* bindings.sweep(new Set(), 0)
  const input: ProContractOpenCode.AdmissionInput = {
    text: "One independent opinion",
    delivery: "steer",
    once: { id: SessionMessage.ID.create(), sessionID: before.sessionID, context },
  }
  const reopen = () =>
    Effect.gen(function* () {
      const opened = yield* bindings.setAdmission({
        expected: (yield* bindings.get(id))!,
        context,
        open: true,
        reason: "Owned resume",
        session: "preserve",
        input,
        capabilities: ["read"],
      })
      expect(opened.conflict).toBeUndefined()
      return opened.binding!
    })
  return {
    bindings,
    contracts,
    scheduler,
    sessions,
    database,
    events,
    id,
    context,
    capabilities,
    before,
    closed,
    execution,
    input,
    reopen,
  }
})

it.effect("preserves the Session, capabilities, attempts and counters while advancing generation", () =>
  Effect.gen(function* () {
    const state = yield* setup
    const opened = yield* state.reopen()
    expect(opened).toMatchObject({
      sessionID: state.before.sessionID,
      attempts: 1,
      turnsUsed: 1,
      actionsUsed: 1,
      admission: { capabilities: state.capabilities, input: state.input },
    })
    expect(opened.admission!.version).toBeGreaterThan(state.closed.admission!.version)
    expect((yield* state.bindings.authorize(state.execution).pipe(Effect.exit))._tag).toBe("Failure")
    yield* state.scheduler.runOnce()
    const current = (yield* state.bindings.get(state.id))!
    expect(current).toMatchObject({
      sessionID: state.before.sessionID,
      generation: 2,
      attempts: 1,
      turnsUsed: 1,
      actionsUsed: 1,
    })
    const received = (yield* SessionInput.find(state.database.db, state.input.once!.id))!
    expect(received).toMatchObject({
      sessionID: current.sessionID,
      prompt: { text: state.input.text },
      delivery: "steer",
    })
    expect(received.promotedSeq).toBeUndefined()
    expect(
      (yield* state.sessions.context(current.sessionID)).filter((message) => message.type === "user"),
    ).toHaveLength(1)
    expect((yield* state.contracts.get(state.id))!.spec.budget).toEqual({ deadline: 120_000 })
  }),
)

it.effect("delivers the fixed input after claim fails before inbox admission and promptID changes", () =>
  Effect.gen(function* () {
    const state = yield* setup
    const reopened = yield* state.reopen()
    const scheduler = Context.get(
      yield* Layer.build(
        Layer.fresh(
          AppNodeBuilder.build(ProContractScheduler.node, [
            [Database.node, Layer.succeed(Database.Service, state.database)],
            [ProContract.node, Layer.succeed(ProContract.Service, state.contracts)],
            [
              ProContractOpenCode.node,
              Layer.succeed(ProContractOpenCode.Service, {
                ...state.bindings,
                // Fail inside the real admission boundary after the scheduler has claimed
                // and entered dispatch, before SessionV2.prompt can commit an inbox row.
                admit: (execution) =>
                  state.bindings.admit(execution, Effect.die("Injected dispatch failure before inbox admission")),
              }),
            ],
            [SessionV2.node, Layer.succeed(SessionV2.Service, state.sessions)],
            [SessionExecution.node, SessionExecution.noopLayer],
          ]),
        ),
      ),
      ProContractScheduler.Service,
    )
    yield* scheduler.runOnce()
    expect(yield* state.bindings.get(state.id)).toMatchObject({ dispatched: false, generation: 2 })
    expect(yield* SessionInput.find(state.database.db, state.input.once!.id)).toBeUndefined()
    expect((yield* state.bindings.get(state.id))!.promptID).not.toBe(reopened.promptID)
    yield* TestClock.adjust("10 millis")
    yield* state.scheduler.runOnce()
    const current = (yield* state.bindings.get(state.id))!
    expect(current).toMatchObject({
      sessionID: state.before.sessionID,
      attempts: 1,
      generation: 3,
      turnsUsed: 1,
      actionsUsed: 1,
    })
    expect((yield* SessionInput.find(state.database.db, state.input.once!.id))?.prompt.text).toBe(state.input.text)
    expect(yield* SessionInput.find(state.database.db, current.promptID)).toBeUndefined()
  }),
)

it.effect("reuses an unpromoted input, then continues without cloning the promoted opinion", () =>
  Effect.gen(function* () {
    const state = yield* setup
    yield* state.reopen()
    yield* state.scheduler.runOnce()
    const first = (yield* SessionInput.find(state.database.db, state.input.once!.id))!
    for (const promoted of [false, true]) {
      if (promoted)
        yield* SessionInput.promoteSteers(state.database.db, state.events, state.before.sessionID, first.admittedSeq)
      const current = (yield* state.bindings.get(state.id))!
      yield* state.bindings.complete({
        execution: ProContractOpenCode.execution(current),
        outcome: { type: "dispatch-failed", reason: "Transient interruption" },
        now: 0,
      })
      yield* TestClock.adjust("10 millis")
      yield* state.scheduler.runOnce()
      const received = (yield* SessionInput.find(state.database.db, state.input.once!.id))!
      expect(received.admittedSeq).toBe(first.admittedSeq)
      expect(received.promotedSeq !== undefined).toBe(promoted)
      expect(
        (yield* state.database.db.select().from(SessionInputTable).all()).filter(
          (row) => row.session_id === state.before.sessionID,
        ),
      ).toHaveLength(promoted ? 3 : 2)
    }
    const messages = yield* state.sessions.context(state.before.sessionID)
    expect(messages.filter((message) => message.type === "user" && message.text === state.input.text)).toHaveLength(1)
    const current = (yield* state.bindings.get(state.id))!
    expect((yield* SessionInput.find(state.database.db, current.promptID))?.prompt.text).toBe(
      "Continue the approved task after a transient execution interruption.",
    )
  }),
)

for (const conflict of ["session", "text", "delivery"] as const)
  it.effect(`fails closed when the fixed message ID conflicts in ${conflict}`, () =>
    Effect.gen(function* () {
      const state = yield* setup
      yield* state.reopen()
      const claimed = (yield* state.bindings.claim(state.id, 0))!
      const session =
        conflict === "session"
          ? yield* state.sessions.create({ location: claimed.location, model: claimed.model })
          : yield* state.sessions.get(claimed.sessionID)
      const existing = yield* state.sessions.prompt({
        id: state.input.once!.id,
        sessionID: session.id,
        prompt: { text: conflict === "text" ? "Conflicting text" : state.input.text },
        delivery: conflict === "delivery" ? "queue" : "steer",
        resume: false,
      })
      yield* state.bindings.complete({
        execution: ProContractOpenCode.execution(claimed),
        outcome: { type: "dispatch-failed", reason: "Injected inbox conflict" },
        now: 0,
      })
      yield* TestClock.adjust("10 millis")
      yield* state.scheduler.runOnce()
      expect(yield* SessionInput.find(state.database.db, state.input.once!.id)).toEqual(existing)
      const current = (yield* state.bindings.get(state.id))!
      expect(current.dispatched).toBe(false)
      expect(yield* SessionInput.find(state.database.db, current.promptID)).toBeUndefined()
    }),
  )

it.effect("uses the original brief and native delivery on the next semantic attempt", () =>
  Effect.gen(function* () {
    const state = yield* setup
    yield* state.reopen()
    const claimed = (yield* state.bindings.claim(state.id, 0))!
    yield* state.bindings.reportBlocked(ProContractOpenCode.execution(claimed), "Original attempt blocked")
    yield* state.bindings.complete({
      execution: ProContractOpenCode.execution(claimed),
      outcome: { type: "blocked", reason: "Original attempt blocked" },
      now: 0,
    })
    yield* TestClock.adjust("10 millis")
    yield* state.scheduler.runOnce()
    const current = (yield* state.bindings.get(state.id))!
    expect(current.attempts).toBe(2)
    expect(current.sessionID).not.toBe(state.before.sessionID)
    const input = (yield* SessionInput.find(state.database.db, current.promptID))!
    expect(input.delivery).toBe("queue")
    expect(input.prompt.text).toContain("Original approved brief")
    expect(input.prompt.text).not.toContain(state.input.text)
    expect(yield* SessionInput.find(state.database.db, state.input.once!.id)).toBeUndefined()
  }),
)

it.effect("retains the historical default of a new Session with an untargeted input", () =>
  Effect.gen(function* () {
    const state = yield* setup
    const reopened = yield* state.bindings.setAdmission({
      expected: (yield* state.bindings.get(state.id))!,
      context: state.context,
      open: true,
      reason: "Historical host admission",
      input: { text: "Historical phase prompt", delivery: "steer" },
      capabilities: ["read"],
    })
    expect(reopened.binding!.sessionID).not.toBe(state.before.sessionID)
    expect(reopened.binding!.admission?.capabilities).toEqual(["read"])
    yield* state.scheduler.runOnce()
    const binding = (yield* state.bindings.get(state.id))!
    expect((yield* SessionInput.find(state.database.db, binding.promptID))?.prompt.text).toBe("Historical phase prompt")
  }),
)

for (const boundary of ["target", "activity", "revision", "deadline", "stale-cas"] as const)
  it.effect(`preserved admission still enforces ${boundary}`, () =>
    Effect.gen(function* () {
      const state = yield* setup
      const before = (yield* state.bindings.get(state.id))!
      if (boundary === "revision")
        yield* state.contracts.petitionRevision({
          contractID: state.id,
          spec: { ...(yield* state.contracts.get(state.id))!.spec, goal: "Different goal" },
          reason: "Pending decision",
        })
      if (boundary === "deadline") yield* TestClock.adjust("120 seconds")
      const open = state.bindings.setAdmission({
        expected: boundary === "stale-cas" ? state.closed : before,
        context: state.context,
        open: true,
        reason: "Preserve",
        session: "preserve",
        input:
          boundary === "target"
            ? { ...state.input, once: { ...state.input.once!, sessionID: SessionV2.ID.create() } }
            : state.input,
      })
      const activity = yield* ProContractActivity.Service
      const result = yield* boundary === "activity" ? activity.run(state.id, open) : open
      expect(result.binding).toBeUndefined()
      expect(result.conflict).toBeDefined()
      expect(yield* state.bindings.get(state.id)).toEqual(before)
    }),
  )
