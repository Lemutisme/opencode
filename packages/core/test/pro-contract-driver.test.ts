import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { ProContract } from "../src/pro-contract"
import { ProContractDriver } from "../src/pro-contract/driver"
import { ProContractScheduler } from "../src/pro-contract/scheduler"
import { ProContractOpenCode } from "../src/pro-contract/open-code"
import { ProContractContextTable, ProContractOpenCodeSessionTable } from "../src/pro-contract/sql"
import { AbsolutePath } from "../src/schema"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionInput } from "../src/session/input"
import { SessionRunCoordinator } from "../src/session/run-coordinator"
import { testEffect } from "./lib/effect"

const waiting: ProContractDriver.Driver = {
  identity: "test-wait:1",
  activate: () => true,
  claim: () => true,
  heartbeat: () => true,
  outcome: () => ({ type: "wait" }),
}
const registrations = Layer.succeed(
  ProContractDriver.Service,
  ProContractDriver.make([
    waiting,
    { ...waiting, identity: "test-retry:1", outcome: () => ({ type: "retry", attempt: "same" }) },
    ...(["activate", "claim", "heartbeat", "outcome"] as const).map((operation) => ({
      ...waiting,
      identity: `test-failure-${operation}:1`,
      [operation]: () => {
        throw new Error("Host decision unavailable")
      },
    })),
  ]),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ProContractOpenCode.node,
      ProContract.node,
      Database.node,
      SessionV2.node,
      ProContractScheduler.node,
    ]),
    [
      [ProContractDriver.node, registrations],
      [
        SessionExecution.node,
        Layer.mock(SessionExecution.Service, {
          wake: () => Effect.void,
          active: Effect.succeed(new Set<SessionV2.ID>()),
          interrupt: () => Effect.void,
        }),
      ],
    ],
  ),
)

const input = (driver?: string) => ({
  id: ProContract.ID.create(),
  scope: "driver-lifecycle",
  driver,
  spec: {
    ...ProContract.defaultSpec("Explore the assigned direction", 0),
    budget: { deadline: 120_000 },
    resolution: { maxAttempts: 1, retryDelay: 10 },
  },
  location: { directory: AbsolutePath.make("/project") },
  model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test") },
  now: 0,
})

const setup = Effect.fnUntraced(function* (driver = waiting.identity) {
  const bindings = yield* ProContractOpenCode.Service
  const contracts = yield* ProContract.Service
  const issued = yield* bindings.issue(input(driver))
  expect(issued.decision.type).toBe("accepted")
  const id = issued.contract!.id
  const context = (yield* contracts.get(id))!.recognition.context!.target
  const admitted =
    driver === ProContractDriver.native.identity
      ? issued.execution!
      : (yield* bindings.setAdmission({
          expected: issued.execution!,
          context,
          open: true,
          reason: "Host inputs prepared",
        })).binding!
  yield* bindings.activate(id, 1, 0)
  const claimed = yield* bindings.claim(id, 0)
  expect(claimed).toBeDefined()
  return {
    bindings,
    contracts,
    id,
    issued,
    admitted,
    binding: claimed!,
    execution: ProContractOpenCode.execution(claimed!),
    context,
  }
})

const open = Effect.fnUntraced(function* (
  bindings: ProContractOpenCode.Interface,
  contracts: ProContract.Interface,
  id: ProContract.ID,
) {
  return yield* bindings.setAdmission({
    expected: (yield* bindings.get(id))!,
    context: (yield* contracts.get(id))!.recognition.context!.target,
    open: true,
    reason: "Next host-approved work",
  })
})

const secondOwner = Effect.fnUntraced(function* () {
  const database = yield* Database.Service
  const contracts = yield* ProContract.Service
  return Context.get(
    yield* Layer.build(
      Layer.fresh(
        AppNodeBuilder.build(ProContractOpenCode.node, [
          [Database.node, Layer.succeed(Database.Service, database)],
          [ProContract.node, Layer.succeed(ProContract.Service, contracts)],
          [ProContractDriver.node, registrations],
        ]),
      ),
    ),
    ProContractOpenCode.Service,
  )
})

describe("Contract driver lifecycle", () => {
  for (const remote of [false, true])
    it.effect(
      `rotates a revoked native Session after ${remote ? "remote expiry" : "local cleanup"} without a new attempt`,
      () =>
        Effect.gen(function* () {
          const state = yield* setup(ProContractDriver.native.identity)
          expect(yield* state.bindings.reserveTurn(state.binding.sessionID, 0, state.execution)).toBe(true)
          const contract = (yield* state.contracts.get(state.id))!
          expect(
            (yield* state.contracts.petitionRevision({
              contractID: state.id,
              spec: { ...contract.spec, goal: "Requested change" },
              reason: "External decision",
            })).decision.type,
          ).toBe("accepted")
          expect(
            (yield* state.contracts.decideRevision({
              contractID: state.id,
              expected: (yield* state.contracts.get(state.id))!.recognition.pending!,
              operationID: crypto.randomUUID(),
              accept: false,
            })).decision.type,
          ).toBe("accepted")
          const successor = remote ? yield* secondOwner() : state.bindings
          if (remote) yield* TestClock.adjust("31 seconds")
          yield* successor.sweep(new Set(), 0)
          expect((yield* successor.get(state.id))!.dispatched).toBe(false)
          const next = (yield* successor.claim(state.id, 0))!
          expect(next).toBeDefined()
          expect(next.sessionID).not.toBe(state.binding.sessionID)
          expect(next.promptID).not.toBe(state.binding.promptID)
          expect(next).toMatchObject({ attempts: 1, generation: 2, turnsUsed: 1, actionsUsed: 0 })
          expect(next.context!.version).toBeGreaterThan(state.context.version)
          expect((yield* state.bindings.authorize(state.execution).pipe(Effect.exit))._tag).toBe("Failure")
          expect((yield* successor.authorize(ProContractOpenCode.execution(next))).spec.budget.deadline).toBe(120_000)
        }),
    )

  test("requires a complete, unique driver and freezes registry entries", () => {
    expect(() => ProContractDriver.make([ProContractDriver.native])).toThrow()
    expect(() => ProContractDriver.make([waiting, waiting])).toThrow()
    expect(() =>
      ProContractDriver.make([{ ...waiting, heartbeat: undefined } as unknown as ProContractDriver.Driver]),
    ).toThrow()
    const registry = ProContractDriver.make([waiting])
    expect(registry.get("test-wait:2")).toBeUndefined()
    expect(Object.isFrozen(registry.get(waiting.identity))).toBe(true)
  })

  it.effect("rejects an unavailable driver without creating a runnable duty", () =>
    Effect.gen(function* () {
      const bindings = yield* ProContractOpenCode.Service
      const contracts = yield* ProContract.Service
      const request = input("research:1")
      expect((yield* bindings.issue(request)).decision).toMatchObject({ type: "rejected" })
      expect(yield* contracts.get(request.id)).toBeUndefined()
      expect(yield* bindings.get(request.id)).toBeUndefined()
      expect((yield* contracts.history({ contractID: request.id }))[0].decision.type).toBe("rejected")
    }),
  )

  it.effect("rolls back the entire issue if the binding insert fails", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const request = input(waiting.identity)
      yield* database.db
        .run(
          "CREATE TRIGGER reject_binding BEFORE INSERT ON pro_contract_opencode BEGIN SELECT RAISE(ABORT, 'injected binding write failure'); END",
        )
        .pipe(Effect.orDie)
      expect(Exit.isFailure(yield* bindings.issue(request).pipe(Effect.exit))).toBe(true)
      expect(yield* contracts.get(request.id)).toBeUndefined()
      expect(yield* bindings.get(request.id)).toBeUndefined()
      expect(yield* contracts.history({ contractID: request.id })).toEqual([])
      expect(yield* database.db.select().from(ProContractContextTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* database.db.select().from(ProContractOpenCodeSessionTable).all().pipe(Effect.orDie)).toEqual([])
      yield* database.db.run("DROP TRIGGER reject_binding").pipe(Effect.orDie)
      const accepted = yield* bindings.issue(request)
      expect(accepted.execution).toMatchObject({ driver: waiting.identity, admission: { open: false, version: 0 } })
      yield* bindings.activate(request.id, 1, 0)
      expect((yield* contracts.get(request.id))?.status).toBe("dormant")
      expect(yield* bindings.claim(request.id, 0)).toBeUndefined()
    }),
  )

  it.effect("checks issue retries inside the command transaction and preserves closed admission", () =>
    Effect.gen(function* () {
      const bindings = yield* ProContractOpenCode.Service
      const contracts = yield* ProContract.Service
      const request = input(waiting.identity)
      const original = yield* bindings.issue(request)
      const duplicate = yield* bindings.issue(request)
      expect(duplicate.execution).toEqual(original.execution)
      expect((yield* bindings.issue({ ...request, driver: ProContractDriver.native.identity })).decision.type).toBe(
        "rejected",
      )
      expect(
        (yield* bindings.issue({ ...request, location: { directory: AbsolutePath.make("/other") } })).decision.type,
      ).toBe("rejected")
      expect((yield* contracts.history({ contractID: request.id })).map((event) => event.decision.type)).toEqual([
        "accepted",
        "accepted",
        "rejected",
        "rejected",
      ])
      expect(yield* bindings.get(request.id)).toEqual(original.execution)
    }),
  )

  it.effect("repeats normal waits with maxAttempts one and cumulative accounting", () =>
    Effect.gen(function* () {
      const state = yield* setup()
      yield* Effect.forEach([1, 2, 3, 4], (index) =>
        Effect.gen(function* () {
          const binding = (yield* state.bindings.get(state.id))!
          const identity = ProContractOpenCode.execution(binding)
          expect(yield* state.bindings.reserveTurn(binding.sessionID, 0, identity)).toBe(true)
          expect(yield* state.bindings.reserveAction(binding.sessionID, 0, identity)).toBe(true)
          yield* state.bindings.complete({
            execution: identity,
            outcome: { type: "completed", reason: "Awaiting host review" },
            now: 0,
          })
          expect(yield* state.bindings.get(state.id)).toMatchObject({
            attempts: 1,
            turnsUsed: index,
            actionsUsed: index,
            dispatched: false,
            admission: { open: false },
          })
          expect(yield* state.bindings.claim(state.id, 0)).toBeUndefined()
          const reopened = (yield* open(state.bindings, state.contracts, state.id)).binding!
          expect(reopened.sessionID).not.toBe(binding.sessionID)
          expect(reopened.promptID).not.toBe(binding.promptID)
          expect(yield* state.bindings.claim(state.id, 0)).toMatchObject({ attempts: 1 })
        }),
      )
      expect(yield* state.contracts.get(state.id)).toMatchObject({
        status: "active",
        spec: { budget: { deadline: 120_000 } },
      })
      expect((yield* state.contracts.get(state.id))!.blocked).toBeUndefined()
    }),
  )

  it.effect("does not revive an expired lease through heartbeat", () =>
    Effect.gen(function* () {
      const state = yield* setup()
      yield* TestClock.setTime(30_001)
      yield* state.bindings.heartbeat(new Set([state.binding.sessionID]), 0)
      expect((yield* state.bindings.get(state.id))!.leaseExpiresAt).toBe(30_000)
      const next = yield* state.bindings.claim(state.id, 0)
      expect(next).toMatchObject({ generation: 2, attempts: 1 })
      expect(next!.leaseExpiresAt).toBe(60_001)
    }),
  )

  it.effect("ignores stale completion and terminal error after zero-work same-Session takeover", () =>
    Effect.gen(function* () {
      const state = yield* setup()
      const successor = yield* secondOwner()
      expect(successor.owner).not.toBe(state.bindings.owner)
      yield* TestClock.setTime(30_001)
      const current = yield* successor.claim(state.id, 0)
      expect(current).toMatchObject({
        sessionID: state.binding.sessionID,
        promptID: state.binding.promptID,
        generation: 2,
      })
      const ledger = yield* state.contracts.history({ contractID: state.id })
      yield* Effect.forEach(["completed", "terminal-error", "dispatch-failed", "interrupted"] as const, (type) =>
        state.bindings.complete({ execution: state.execution, outcome: { type, reason: "old drain" }, now: 0 }),
      )
      expect(yield* successor.get(state.id)).toEqual(current)
      expect(yield* state.contracts.history({ contractID: state.id })).toEqual(ledger)
    }),
  )

  it.effect("restores the full task after Session creation but before first prompt admission", () =>
    Effect.gen(function* () {
      const state = yield* setup(ProContractDriver.native.identity)
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      const scheduler = yield* ProContractScheduler.Service
      yield* sessions.create({
        id: state.binding.sessionID,
        location: state.binding.location,
        model: state.binding.model,
      })
      expect(yield* SessionInput.find(database.db, state.binding.promptID)).toBeUndefined()
      yield* TestClock.setTime(30_001)
      yield* scheduler.runOnce()
      const recovered = (yield* state.bindings.get(state.id))!
      expect(recovered).toMatchObject({
        sessionID: state.binding.sessionID,
        promptID: state.binding.promptID,
        generation: 2,
        attempts: 1,
      })
      expect((yield* SessionInput.find(database.db, recovered.promptID))?.prompt.text).toContain(
        state.issued.contract!.spec.goal,
      )
      expect((yield* SessionInput.find(database.db, recovered.promptID))?.prompt.text).toContain(
        "contract_report_ready",
      )
    }),
  )

  it.effect("restores task material for a new empty Session with inherited usage", () =>
    Effect.gen(function* () {
      const state = yield* setup(ProContractDriver.native.identity)
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      const scheduler = yield* ProContractScheduler.Service
      expect(yield* state.bindings.reserveTurn(state.binding.sessionID, 0)).toBe(true)
      yield* state.bindings.setAdmission({
        expected: (yield* state.bindings.get(state.id))!,
        context: state.context,
        open: false,
        reason: "Normal wait",
      })
      yield* state.bindings.complete({
        execution: state.execution,
        outcome: { type: "completed", reason: "Waiting" },
        now: 0,
      })
      const opened = (yield* open(state.bindings, state.contracts, state.id)).binding!
      const claimed = (yield* state.bindings.claim(state.id, 0))!
      yield* sessions.create({ id: opened.sessionID, location: opened.location, model: opened.model })
      yield* state.bindings.complete({
        execution: ProContractOpenCode.execution(claimed),
        outcome: { type: "dispatch-failed", reason: "Admission transport failed" },
        now: 0,
      })
      yield* TestClock.setTime(10)
      yield* scheduler.runOnce()
      const recovered = (yield* state.bindings.get(state.id))!
      expect(recovered).toMatchObject({ sessionID: opened.sessionID, turnsUsed: 1, attempts: 1 })
      expect((yield* SessionInput.find(database.db, recovered.promptID))?.prompt.text).toContain(
        state.issued.contract!.spec.goal,
      )
    }),
  )

  it.effect("holds closing admission across dispatch and rejects its delayed durable prompt", () =>
    Effect.gen(function* () {
      const state = yield* setup()
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      yield* sessions.create({
        id: state.binding.sessionID,
        location: state.binding.location,
        model: state.binding.model,
      })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const dispatch = yield* state.bindings
        .dispatch(
          state.execution,
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return yield* state.bindings.admit(
              state.execution,
              sessions.prompt({
                id: state.binding.promptID,
                sessionID: state.binding.sessionID,
                prompt: { text: "Old dispatch" },
                delivery: "queue",
                resume: false,
              }),
            )
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const closed = yield* state.bindings.setAdmission({
        expected: state.binding,
        context: state.context,
        open: false,
        reason: "Review barrier",
      })
      expect(closed.binding?.dispatched).toBe(true)
      yield* state.bindings.sweep(new Set(), 0)
      expect((yield* open(state.bindings, state.contracts, state.id)).conflict).toBeDefined()
      yield* TestClock.setTime(30_001)
      expect(yield* state.bindings.claim(state.id, 30_001)).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(dispatch)).toBeUndefined()
      expect(yield* SessionInput.find(database.db, state.binding.promptID)).toBeUndefined()
      yield* state.bindings.sweep(new Set(), 30_001)
      expect((yield* open(state.bindings, state.contracts, state.id)).binding?.sessionID).not.toBe(
        state.binding.sessionID,
      )
    }),
  )

  it.effect("binds admitted authority to ContextTarget after issuer resume", () =>
    Effect.gen(function* () {
      const state = yield* setup()
      yield* state.contracts.escalate({ contractID: state.id, revision: 1, reason: "issuer review", time: 1 })
      yield* state.contracts.resume(state.id)
      const target = (yield* state.contracts.get(state.id))!.recognition.context!.target
      expect(target).not.toEqual(state.context)
      yield* state.bindings.activate(state.id, 1, 1)
      expect((yield* state.contracts.get(state.id))!.status).toBe("dormant")
      expect(yield* state.bindings.reserveTurn(state.binding.sessionID, 1, state.execution)).toBe(false)
      yield* state.bindings.heartbeat(new Set([state.binding.sessionID]), 1)
      expect((yield* state.bindings.get(state.id))!.leaseExpiresAt).toBe(state.binding.leaseExpiresAt)
      yield* state.bindings.sweep(new Set(), 1)
      expect(
        (yield* state.bindings.setAdmission({
          expected: (yield* state.bindings.get(state.id))!,
          context: state.context,
          open: true,
          reason: "Stale approval",
        })).conflict,
      ).toBeDefined()
      expect((yield* open(state.bindings, state.contracts, state.id)).binding?.admission?.context).toEqual(target)
    }),
  )

  it.effect("records blocked intent without retiring a tool's in-flight lease", () =>
    Effect.gen(function* () {
      const state = yield* setup()
      expect((yield* state.bindings.reportBlocked(state.execution, "External input unavailable")).decision.type).toBe(
        "accepted",
      )
      const pending = (yield* state.bindings.get(state.id))!
      expect(pending).toMatchObject({
        dispatched: true,
        leaseOwner: state.bindings.owner,
        attempts: 1,
        pendingOutcome: { decision: { type: "wait" } },
      })
      expect((yield* open(state.bindings, state.contracts, state.id)).conflict).toBeDefined()
      expect(yield* state.bindings.reserveAction(pending.sessionID, 0, state.execution)).toBe(false)
      yield* state.bindings.complete({
        execution: state.execution,
        outcome: { type: "terminal-error", reason: "Generic callback must not overwrite intent" },
        now: 0,
      })
      expect(yield* state.bindings.get(state.id)).toMatchObject({
        dispatched: false,
        attempts: 1,
        admission: { open: false },
      })
      expect((yield* state.contracts.get(state.id))!.status).toBe("active")
      expect((yield* state.bindings.get(state.id))!.pendingOutcome).toBeUndefined()
    }),
  )

  it.effect("honors the driver's same-attempt blocked retry", () =>
    Effect.gen(function* () {
      const state = yield* setup("test-retry:1")
      expect(yield* state.bindings.reserveTurn(state.binding.sessionID, 0, state.execution)).toBe(true)
      yield* state.bindings.reportBlocked(state.execution, "Retry a recoverable dependency")
      yield* state.bindings.complete({
        execution: state.execution,
        outcome: { type: "completed", reason: "drain ended" },
        now: 0,
      })
      expect(yield* state.bindings.claim(state.id, 9)).toBeUndefined()
      const next = yield* state.bindings.claim(state.id, 10)
      expect(next).toMatchObject({ attempts: 1, turnsUsed: 1, actionsUsed: 0, generation: 2 })
      expect((yield* state.contracts.get(state.id))!.status).toBe("active")
      expect(next!.sessionID).toBe(state.binding.sessionID)
    }),
  )

  for (const operation of ["activate", "claim", "heartbeat", "outcome"] as const) {
    it.effect(`durably closes admission after a driver ${operation} defect`, () =>
      Effect.gen(function* () {
        const bindings = yield* ProContractOpenCode.Service
        const contracts = yield* ProContract.Service
        const request = input(`test-failure-${operation}:1`)
        const issued = yield* bindings.issue(request)
        yield* open(bindings, contracts, request.id)
        yield* bindings.activate(request.id, 1, 0)
        const claimed = yield* bindings.claim(request.id, 0)
        if (operation === "heartbeat") yield* bindings.heartbeat(new Set([claimed!.sessionID]), 1)
        if (operation === "outcome")
          yield* bindings.complete({
            execution: ProContractOpenCode.execution(claimed!),
            outcome: { type: "completed", reason: "Work done" },
            now: 1,
          })
        expect(yield* bindings.get(request.id)).toMatchObject({
          admission: { open: false, reason: expect.stringContaining(operation) },
        })
        yield* TestClock.setTime(30_001)
        yield* bindings.sweep(new Set(), 0)
        expect(yield* bindings.claim(request.id, 0)).toBeUndefined()
        expect((yield* contracts.get(request.id))!.spec.budget).toEqual(issued.contract!.spec.budget)
        yield* TestClock.setTime(120_000)
        yield* bindings.sweep(new Set(), 0)
        expect((yield* contracts.get(request.id))!.status).toBe("escalated")
      }),
    )
  }

  it.effect("consumes native blocked retry exactly once after recovery", () =>
    Effect.gen(function* () {
      const state = yield* setup(ProContractDriver.native.identity)
      yield* state.bindings.reportBlocked(state.execution, "Blocked at attempt limit")
      const successor = yield* secondOwner()
      yield* successor.sweep(new Set(), 29_999)
      expect((yield* successor.get(state.id))!.dispatched).toBe(true)
      yield* TestClock.setTime(30_001)
      yield* successor.sweep(new Set(), 0)
      expect((yield* state.contracts.get(state.id))!.status).toBe("escalated")
      expect((yield* successor.get(state.id))!.pendingOutcome).toBeUndefined()
      const events = yield* state.contracts.history({ contractID: state.id })
      yield* successor.sweep(new Set(), 30_002)
      expect(yield* state.contracts.history({ contractID: state.id })).toEqual(events)
    }),
  )

  it.effect("retains a started drain's lease when dispatch is interrupted after wake", () =>
    Effect.gen(function* () {
      const state = yield* setup(ProContractDriver.native.identity)
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      yield* state.bindings.complete({
        execution: state.execution,
        outcome: { type: "retryable-error", reason: "Schedule a transport retry" },
        now: 0,
      })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const coordinator = yield* SessionRunCoordinator.make({
        drain: (id: ProContractOpenCode.Binding["sessionID"]) =>
          Effect.gen(function* () {
            const binding = (yield* state.bindings.forSession(id))!
            yield* state.bindings.dispatch(
              ProContractOpenCode.execution(binding),
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              }),
            )
          }),
      })
      const scheduler = Context.get(
        yield* Layer.build(
          Layer.fresh(
            AppNodeBuilder.build(ProContractScheduler.node, [
              [Database.node, Layer.succeed(Database.Service, database)],
              [ProContract.node, Layer.succeed(ProContract.Service, state.contracts)],
              [ProContractOpenCode.node, Layer.succeed(ProContractOpenCode.Service, state.bindings)],
              [
                SessionV2.node,
                Layer.succeed(SessionV2.Service, {
                  ...sessions,
                  active: coordinator.active,
                  interrupt: coordinator.interrupt,
                }),
              ],
              [
                SessionExecution.node,
                Layer.succeed(SessionExecution.Service, {
                  active: coordinator.active,
                  interrupt: coordinator.interrupt,
                  resume: coordinator.run,
                  // Cancel dispatch after the independent coordinator owns work.
                  wake: (id) =>
                    coordinator
                      .wake(id)
                      .pipe(Effect.andThen(Deferred.await(entered)), Effect.andThen(Effect.interrupt)),
                }),
              ],
            ]),
          ),
        ),
        ProContractScheduler.Service,
      )
      yield* TestClock.setTime(10)
      expect(Exit.isFailure(yield* scheduler.runOnce().pipe(Effect.exit))).toBe(true)
      const current = (yield* state.bindings.get(state.id))!
      expect(current).toMatchObject({ dispatched: true, generation: 2, leaseOwner: state.bindings.owner })
      expect((yield* coordinator.active).has(current.sessionID)).toBe(true)
      const successor = yield* secondOwner()
      yield* TestClock.setTime(20)
      expect(yield* successor.claim(state.id, 20)).toBeUndefined()
      yield* coordinator.interrupt(current.sessionID)
    }),
  )

  it.effect("builds dispatch material from the context actually claimed after issuer resume", () =>
    Effect.gen(function* () {
      const bindings = yield* ProContractOpenCode.Service
      const contracts = yield* ProContract.Service
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      const request = input(ProContractDriver.native.identity)
      yield* bindings.issue({
        ...request,
        spec: { ...request.spec, resolution: { maxAttempts: 3, retryDelay: 10 } },
      })
      yield* bindings.activate(request.id, 1, 0)
      const previous = (yield* bindings.claim(request.id, 0))!
      yield* bindings.complete({
        execution: ProContractOpenCode.execution(previous),
        outcome: { type: "retryable-error", reason: "Schedule a transport retry" },
        now: 0,
      })
      const scheduler = Context.get(
        yield* Layer.build(
          Layer.fresh(
            AppNodeBuilder.build(ProContractScheduler.node, [
              [Database.node, Layer.succeed(Database.Service, database)],
              [ProContract.node, Layer.succeed(ProContract.Service, contracts)],
              [SessionV2.node, Layer.succeed(SessionV2.Service, sessions)],
              [
                SessionExecution.node,
                Layer.mock(SessionExecution.Service, {
                  active: Effect.succeed(new Set<ProContractOpenCode.Binding["sessionID"]>()),
                  wake: () => Effect.void,
                  interrupt: () => Effect.void,
                }),
              ],
              [
                ProContractOpenCode.node,
                Layer.succeed(ProContractOpenCode.Service, {
                  ...bindings,
                  // Order a real phase transition after candidate selection but
                  // before claim, so an earlier Contract snapshot is obsolete.
                  claim: (id, now) =>
                    Effect.gen(function* () {
                      yield* contracts.escalate({
                        contractID: id,
                        revision: 1,
                        reason: "New phase must repair an unavailable fixture",
                        time: now,
                      })
                      yield* contracts.resume(id)
                      yield* bindings.activate(id, 1, now)
                      return yield* bindings.claim(id, now)
                    }),
                }),
              ],
            ]),
          ),
        ),
        ProContractScheduler.Service,
      )
      yield* TestClock.setTime(10)
      yield* scheduler.runOnce()
      const current = (yield* bindings.get(request.id))!
      expect(current).toMatchObject({ revision: 1, generation: 2, attempts: 2 })
      expect(current.context).not.toEqual(previous.context)
      expect(current.context).toEqual((yield* contracts.get(request.id))!.recognition.context!.target)
      expect((yield* SessionInput.find(database.db, current.promptID))?.prompt.text).toContain(
        "New phase must repair an unavailable fixture",
      )
    }),
  )

  it.effect("honors the original deadline while closed with a revision pending", () =>
    Effect.gen(function* () {
      const state = yield* setup()
      yield* state.bindings.setAdmission({
        expected: state.binding,
        context: state.context,
        open: false,
        reason: "Waiting",
      })
      yield* state.contracts.petitionRevision({
        contractID: state.id,
        spec: { ...state.issued.contract!.spec, goal: "Amended goal" },
        reason: "Need owner decision",
      })
      yield* TestClock.setTime(120_000)
      expect(yield* state.bindings.sweep(new Set([state.binding.sessionID]), 0)).toContain(state.binding.sessionID)
      expect(yield* state.contracts.get(state.id)).toMatchObject({
        status: "escalated",
        pendingRevision: { reason: "Need owner decision" },
        escalation: { time: 120_000 },
      })
      expect(yield* state.bindings.claim(state.id, 120_000)).toBeUndefined()
    }),
  )
})
