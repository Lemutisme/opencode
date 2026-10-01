import { describe, expect } from "bun:test"
import { $ } from "bun"
import { watch } from "fs"
import path from "path"
import { eq } from "drizzle-orm"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AgentV2 } from "../src/agent"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { makeGlobalNode } from "../src/effect/app-node"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-services"
import { ModelV2 } from "../src/model"
import { PermissionV2 } from "../src/permission"
import { ProContract } from "../src/pro-contract"
import { ProContractOpenCode } from "../src/pro-contract/open-code"
import { ProContractDelivery } from "../src/pro-contract/delivery"
import { ProContractReplay } from "../src/pro-contract/replay"
import { ProContractOpenCodeTable } from "../src/pro-contract/sql"
import { ProjectV2 } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath, RelativePath } from "../src/schema"
import { SessionTable } from "../src/session/sql"
import { ToolRegistry } from "../src/tool/registry"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, ProContract.node, ProContractOpenCode.node, LocationServiceMap.node]),
  ),
)

const setup = Effect.fnUntraced(function* (spec?: ProContract.Spec, profile?: string) {
  const directory = yield* Effect.acquireRelease(Effect.promise(tmpdir), (directory) =>
    Effect.promise(() => directory[Symbol.asyncDispose]()),
  )
  const location = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
  const contracts = yield* ProContract.Service
  const bindings = yield* ProContractOpenCode.Service
  const database = yield* Database.Service
  const now = yield* Clock.currentTimeMillis
  const contractID = ProContract.ID.make("pct_control_fence")
  const model = ModelV2.Ref.make({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test") })
  yield* contracts.issue({
    id: contractID,
    scope: "control",
    spec: spec ?? ProContract.defaultSpec("Original goal", now),
    executor: "opencode",
  })
  yield* bindings.create({ contractID, revision: 1, location, model, nextActionAt: now })
  yield* contracts.activate(contractID, 1, now)
  if (profile) {
    const contract = (yield* contracts.get(contractID))!
    yield* contracts.setRecognitionContext({
      contractID,
      expected: contract.recognition.context!.target,
      profile,
      referenceHash: "a".repeat(64),
      admitted: false,
    })
  }
  const binding = yield* bindings.claim(contractID, now)
  if (!binding) return yield* Effect.die("Expected an execution")
  yield* database.db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id: binding.sessionID,
      project_id: ProjectV2.ID.global,
      directory: directory.path,
      slug: "control",
      title: "Control authorization",
      version: "test",
      model,
    })
    .run()
    .pipe(Effect.orDie)
  return {
    directory: directory.path,
    location,
    contracts,
    bindings,
    database,
    binding,
    execution: ProContractOpenCode.execution(binding),
  }
})

const calls: (ProContractDelivery.Request | Parameters<NonNullable<ProContractDelivery.Handler["command"]>>[0])[] = []
const metadata = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, ProContract.node, ProContractOpenCode.node, LocationServiceMap.node]),
    [
      [
        ProContractDelivery.node,
        Layer.succeed(ProContractDelivery.Service, {
          get: () => ({
            request: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
            command: (input) =>
              Effect.sync(() => {
                calls.push(input)
                return { captured: true }
              }),
          }),
        }),
      ],
    ],
  ),
)

metadata.effect("canonical host tools pass invocation identity separately from model payload", () =>
  Effect.gen(function* () {
    calls.length = 0
    const state = yield* setup(undefined, "test-call-metadata:1")
    yield* Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.materialize()
      for (const call of [
        {
          name: "contract_request",
          input: { kind: "test", payload: { call: { messageID: "forged", callID: "forged" } } },
        },
        { name: "contract_report_ready", input: { summary: "candidate", uncertainties: [] } },
      ]) {
        const result = yield* tools.settle({
          sessionID: state.binding.sessionID,
          ...toolIdentity,
          contractExecution: state.execution,
          call: { type: "tool-call", id: `actual-${call.name}`, ...call },
        })
        expect(result.result.type).not.toBe("error")
        expect(calls.at(-1)?.call).toEqual({
          messageID: toolIdentity.assistantMessageID,
          callID: `actual-${call.name}`,
        })
        expect(calls.at(-1)?.execution).toEqual(state.execution)
      }
      expect(calls).toHaveLength(2)
      yield* TestClock.adjust("31 seconds")
      const denied = yield* tools.settle({
        sessionID: state.binding.sessionID,
        ...toolIdentity,
        contractExecution: state.execution,
        call: { type: "tool-call", id: "late", name: "contract_request", input: { kind: "test", payload: {} } },
      })
      expect(denied.result.type).toBe("error")
      expect(calls).toHaveLength(2)
    }).pipe(Effect.provide(LocationServiceMap.Service.get(state.location)))
  }),
)

describe("Contract control authorization", () => {
  ;["missing", "expired", "owner", "prompt", "reclaimed", "retired"].forEach((scenario) => {
    it.effect(`rejects ${scenario} execution without mutating duty or counters`, () =>
      Effect.gen(function* () {
        const state = yield* setup()
        if (scenario === "expired" || scenario === "reclaimed" || scenario === "retired") {
          if (scenario === "retired")
            yield* state.bindings.reserveTurn(state.binding.sessionID, yield* Clock.currentTimeMillis)
          yield* TestClock.adjust("31 seconds")
          if (scenario !== "expired") {
            const next = yield* state.bindings.claim(state.binding.contractID, yield* Clock.currentTimeMillis)
            expect(next?.sessionID === state.binding.sessionID).toBe(scenario === "reclaimed")
            expect(next?.generation).toBe(2)
          }
        }
        const before = yield* state.contracts.get(state.binding.contractID)
        const binding = yield* state.bindings.get(state.binding.contractID)
        yield* Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const materialized = yield* registry.materialize()
          const execution =
            scenario === "missing"
              ? undefined
              : scenario === "owner"
                ? { ...state.execution, owner: "another-process" }
                : scenario === "prompt"
                  ? { ...state.execution, promptID: toolIdentity.assistantMessageID }
                  : state.execution
          for (const call of [
            { name: "contract_report_ready", input: { summary: "done", uncertainties: [] } },
            { name: "contract_report_blocked", input: { reason: "blocked" } },
            { name: "contract_propose_revision", input: { goal: "Changed", reason: "change" } },
            { name: "contract_check", input: {} },
          ]) {
            const result = yield* materialized.settle({
              sessionID: state.binding.sessionID,
              ...toolIdentity,
              contractExecution: execution,
              call: { type: "tool-call", id: call.name, ...call },
            })
            expect(result.result.type).toBe("error")
          }
        }).pipe(Effect.provide(LocationServiceMap.Service.get(state.location)))
        expect(yield* state.contracts.get(state.binding.contractID)).toEqual(before)
        expect(yield* state.bindings.get(state.binding.contractID)).toEqual(binding)
      }),
    )
  })

  it.effect("commits a rejected guarded command to the ledger", () =>
    Effect.gen(function* () {
      const state = yield* setup()
      yield* state.bindings.complete({
        execution: ProContractOpenCode.execution(state.binding!),
        outcome: { type: "retryable-error", reason: "transport" },
        now: 0,
      })
      yield* TestClock.adjust("61 seconds")
      const next = yield* state.bindings.claim(state.binding.contractID, yield* Clock.currentTimeMillis)
      expect(next?.sessionID).toBe(state.binding.sessionID)
      const before = yield* state.contracts.get(state.binding.contractID)
      const receipt = yield* state.bindings.control(
        state.execution,
        state.contracts.reportBlocked({
          contractID: state.binding.contractID,
          revision: 1,
          reason: "late",
          time: yield* Clock.currentTimeMillis,
        }),
      )
      expect(receipt.decision).toMatchObject({ type: "rejected" })
      expect((yield* state.contracts.history({ contractID: state.binding.contractID })).at(-1)).toMatchObject({
        seq: receipt.frontier,
        command: { type: "report-blocked" },
        decision: receipt.decision,
      })
      expect(yield* state.contracts.get(state.binding.contractID)).toEqual(before)
      expect((yield* state.bindings.get(state.binding.contractID))?.actionsUsed).toBe(0)
    }),
  )

  it.effect("checks the transaction clock before spending a captured admission", () =>
    Effect.gen(function* () {
      const state = yield* setup()
      const captured = yield* Clock.currentTimeMillis
      yield* TestClock.adjust("31 seconds")
      expect(yield* state.bindings.reserveAction(state.binding.sessionID, captured, state.execution)).toBe(false)
      expect(yield* state.bindings.reserveTurn(state.binding.sessionID, captured, state.execution)).toBe(false)
      expect(yield* state.bindings.get(state.binding.contractID)).toMatchObject({ turnsUsed: 0, actionsUsed: 0 })
    }),
  )

  it.live("preserves an unresolved petition across database reopen for explicit external resolution", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(Effect.promise(tmpdir), (directory) =>
        Effect.promise(() => directory[Symbol.asyncDispose]()),
      )
      const ledger = AppNodeBuilder.build(ProContract.node, [
        [Database.node, Database.layerFromPath(path.join(directory.path, "contract.db"))],
      ])
      const pending = yield* Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const spec = ProContract.defaultSpec("Before restart", Date.now())
        const issued = yield* contracts.issue({ scope: "restart", spec, executor: "opencode" })
        if (!issued.contract) return yield* Effect.die("Missing Contract")
        const proposal = { ...issued.contract.spec, goal: "After restart" }
        const receipt = yield* contracts.petitionRevision({
          contractID: issued.contract.id,
          spec: proposal,
          reason: "awaiting an external decision",
        })
        return {
          contractID: issued.contract.id,
          expected: { revision: 1, specHash: ProContract.hashSpec(proposal), petition: receipt.frontier },
        }
      }).pipe(Effect.provide(ledger))
      yield* Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        expect((yield* contracts.get(pending.contractID))?.pendingRevision?.specHash).toBe(pending.expected.specHash)
        const receipt = yield* contracts.decideRevision({ operationID: "restart-decision", ...pending, accept: false })
        expect(receipt.decision.type).toBe("accepted")
        expect((yield* contracts.get(pending.contractID))?.pendingRevision).toBeUndefined()
      }).pipe(Effect.provide(ledger))
    }),
  )

  const revisions = ["approve-after-lease", "reject", "old-approve", "old-reject", "interrupt"]
  revisions.forEach((scenario) => {
    it.effect(`handles revision ${scenario} against the exact petition`, () =>
      Effect.gen(function* () {
        const state = yield* setup()
        yield* Effect.gen(function* () {
          const agents = yield* AgentV2.Service
          const registry = yield* ToolRegistry.Service
          const permissions = yield* PermissionV2.Service
          const events = yield* EventV2.Service
          yield* agents.transform((draft) =>
            draft.update(AgentV2.defaultID, (agent) => {
              agent.permissions.push({ action: "contract_revision", resource: "*", effect: "ask" })
            }),
          )
          const asked = yield* Deferred.make<PermissionV2.Request>()
          const unsubscribe = yield* events.listen((event) =>
            event.type === PermissionV2.Event.Asked.type
              ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
              : Effect.void,
          )
          yield* Effect.addFinalizer(() => unsubscribe)
          const materialized = yield* registry.materialize()
          const pending = yield* materialized
            .settle({
              sessionID: state.binding.sessionID,
              ...toolIdentity,
              contractExecution: state.execution,
              call: {
                type: "tool-call",
                id: "revision",
                name: "contract_propose_revision",
                input: { goal: "Revised goal", reason: "clarify" },
              },
            })
            .pipe(Effect.forkChild)
          const request = yield* Deferred.await(asked)
          const original = yield* state.contracts.get(state.binding.contractID)
          expect(original?.pendingRevision).toBeDefined()
          if (scenario === "interrupt") {
            yield* Fiber.interrupt(pending)
            expect((yield* state.contracts.get(state.binding.contractID))?.pendingRevision).toEqual(
              original?.pendingRevision,
            )
            expect(yield* permissions.list()).toHaveLength(1)
            yield* permissions.reply({ requestID: request.id, reply: "once" })
            while ((yield* state.contracts.get(state.binding.contractID))?.pendingRevision) yield* Effect.yieldNow
            expect((yield* state.contracts.get(state.binding.contractID))?.revision).toBe(2)
            return
          }
          if (scenario === "approve-after-lease") {
            const rejected = yield* state.contracts.petitionRevision({
              contractID: state.binding.contractID,
              spec: original!.pendingRevision!.spec,
              reason: "duplicate while pending",
            })
            expect(rejected.decision.type).toBe("rejected")
            yield* TestClock.adjust("31 seconds")
          }
          if (scenario.startsWith("old-")) {
            yield* state.contracts.decideRevision({
              operationID: crypto.randomUUID(),
              expected: (yield* state.contracts.get(state.binding.contractID))!.recognition.pending!,
              contractID: state.binding.contractID,
              accept: false,
            })
            yield* state.contracts.petitionRevision({
              contractID: state.binding.contractID,
              spec: original!.pendingRevision!.spec,
              reason: "same terms, new request",
            })
          }
          yield* permissions.reply({ requestID: request.id, reply: scenario.includes("reject") ? "reject" : "once" })
          if (scenario === "approve-after-lease") {
            while ((yield* state.contracts.get(state.binding.contractID))?.pendingRevision) yield* Effect.yieldNow
            const exit = yield* Fiber.await(pending)
            expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
            expect((yield* state.contracts.get(state.binding.contractID))?.revision).toBe(2)
            return
          }
          const result = yield* Fiber.join(pending)
          const current = yield* state.contracts.get(state.binding.contractID)
          if (scenario.startsWith("old-")) {
            expect(result.result).toMatchObject({
              type: "error",
              value: "revision approval does not match the current petition",
            })
            expect(current?.revision).toBe(1)
            expect(current?.pendingRevision?.reason).toBe("same terms, new request")
            expect(
              (yield* state.contracts.history({ contractID: state.binding.contractID })).at(-1)?.decision.type,
            ).toBe("rejected")
            return
          }
          expect(current?.pendingRevision).toBeUndefined()
          expect(current?.revision).toBe(scenario === "reject" ? 1 : 2)
          expect(result.result.type).toBe(scenario === "reject" ? "error" : "json")
          expect((yield* state.bindings.get(state.binding.contractID))?.actionsUsed).toBe(0)
        }).pipe(Effect.provide(LocationServiceMap.Service.get(state.location)))
      }),
    )
  })

  const replays = ["success", "failure", "unavailable", "timeout"]
  replays.forEach((outcome) => {
    it.live(
      `rejects a stale ${outcome} replay while retaining its action charge`,
      () =>
        Effect.gen(function* () {
          const gate = yield* Effect.acquireRelease(Effect.promise(tmpdir), (dir) =>
            Effect.promise(() => dir[Symbol.asyncDispose]()),
          )
          const started = Promise.withResolvers<void>()
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              watch(gate.path, (_event, name) => {
                if (name === "started") started.resolve()
              }),
            ),
            (watcher) => Effect.sync(() => watcher.close()),
          )
          const script = `const fs = require('fs'); const dir = process.argv[1]; const watcher = fs.watch(dir, (_, name) => { if (name === 'release') { watcher.close(); process.exit(${outcome === "failure" ? 1 : 0}); } }); fs.writeFileSync(dir + '/started', 'ready');`
          const base = ProContract.defaultSpec("Replay under an execution fence", yield* Clock.currentTimeMillis)
          const state = yield* setup({
            ...base,
            authority: ["filesystem.read", "process.execute"],
            evidence: {
              type: "principal",
              replay: {
                checks: [
                  {
                    argv: [process.execPath, "-e", script, gate.path],
                    timeout: outcome === "timeout" ? 2_000 : 10_000,
                    exit: 0,
                  },
                  ...(outcome === "unavailable"
                    ? [{ argv: [path.join(gate.path, "missing-program")], timeout: 1_000, exit: 0 }]
                    : []),
                ],
                protected: [],
                artifacts: [],
              },
            },
          })
          yield* Effect.promise(async () => {
            await Bun.write(path.join(state.directory, "candidate.txt"), "candidate")
            await $`git init`.cwd(state.directory).quiet()
            await $`git -c user.name=Test -c user.email=test@example.test -c commit.gpgsign=false add .`
              .cwd(state.directory)
              .quiet()
            await $`git -c user.name=Test -c user.email=test@example.test -c commit.gpgsign=false commit -m initial`
              .cwd(state.directory)
              .quiet()
          })
          yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const materialized = yield* registry.materialize()
            const work = yield* materialized
              .settle({
                sessionID: state.binding.sessionID,
                ...toolIdentity,
                contractExecution: state.execution,
                call: {
                  type: "tool-call",
                  id: "ready",
                  name: "contract_report_ready",
                  input: { summary: "done", uncertainties: [] },
                },
              })
              .pipe(Effect.forkChild)
            yield* Effect.promise(() => started.promise)
            const current = yield* state.bindings.get(state.binding.contractID)
            if (!current) return yield* Effect.die("Missing binding")
            yield* state.database.db
              .update(ProContractOpenCodeTable)
              .set({ data: { ...current, leaseExpiresAt: 0 } })
              .where(eq(ProContractOpenCodeTable.contract_id, current.contractID))
              .run()
              .pipe(Effect.orDie)
            const next = yield* state.bindings.claim(current.contractID, yield* Clock.currentTimeMillis)
            expect(next?.sessionID).not.toBe(current.sessionID)
            if (outcome !== "timeout") yield* Effect.promise(() => Bun.write(path.join(gate.path, "release"), "go"))
            const exit = yield* Fiber.await(work)
            expect(
              Exit.isFailure(exit) ? Cause.hasInterruptsOnly(exit.cause) : exit.value.result.type === "error",
            ).toBe(true)
            const contract = yield* state.contracts.get(current.contractID)
            expect(contract?.status).toBe("active")
            expect(contract?.handoff).toBeUndefined()
            expect(contract?.escalation).toBeUndefined()
            expect((yield* state.bindings.get(current.contractID))?.actionsUsed).toBe(1)
            if (outcome !== "failure" && Exit.isSuccess(exit))
              expect((yield* state.contracts.history({ contractID: current.contractID })).at(-1)?.decision.type).toBe(
                "rejected",
              )
          }).pipe(Effect.provide(LocationServiceMap.Service.get(state.location)))
        }),
      30_000,
    )
  })
})

const nodeCalls: ProContractDelivery.Node[] = []
const nodes = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, ProContract.node, ProContractOpenCode.node, LocationServiceMap.node]),
    [
      [
        ProContractDelivery.node,
        makeGlobalNode({
          service: ProContractDelivery.Service,
          deps: [ProContract.node, ProContractOpenCode.node],
          layer: Layer.effect(
            ProContractDelivery.Service,
            Effect.gen(function* () {
              const contracts = yield* ProContract.Service
              const bindings = yield* ProContractOpenCode.Service
              return {
                get: () => ({
                  request: () => Effect.void,
                  node: (input) =>
                    Effect.gen(function* () {
                      nodeCalls.push(structuredClone(input))
                      const contract = (yield* contracts.get(input.execution.contractID))!
                      const mode = contract.spec.goal
                      if (mode === "interrupt") return yield* Effect.interrupt
                      if (mode === "mixed-interrupt")
                        return yield* Effect.failCause(
                          Cause.combine(Cause.die(new Error("Fixture interrupted defect")), Cause.interrupt()),
                        )
                      if (mode === "unauthorized")
                        return yield* bindings
                          .authorize({ ...input.execution, generation: input.execution.generation + 1 })
                          .pipe(Effect.as("continue" as const))
                      if (mode === "closed-error" || mode === "closed-defect") {
                        const binding = (yield* bindings.get(contract.id))!
                        yield* bindings.setAdmission({
                          expected: binding,
                          context: contract.recognition.context!.target,
                          open: false,
                          reason: "Fixture committed pause before losing the return",
                        })
                      }
                      if (mode === "host-error" || mode === "closed-error")
                        return yield* new ProContractDelivery.Denied({ message: "Fixture callback failed" })
                      if (mode === "host-defect" || mode === "closed-defect")
                        return yield* Effect.die(new Error("Fixture callback defect"))
                      if (mode === "intercept") return "intercept" as const
                      // Exercise the read-only payload boundary against a misbehaving callback.
                      if (input.type === "submission")
                        (input.uncertainties as string[]).push("Callback must not add this")
                      if (input.type === "check")
                        (input.replay as { summary: string }).summary = "Callback must not replace replay"
                      return "continue" as const
                    }),
                }),
              }
            }),
          ),
        }),
      ],
    ],
  ),
)

for (const name of ["contract_report_ready", "contract_check"] as const)
  for (const mode of [
    "intercept",
    "continue",
    "host-error",
    "host-defect",
    "closed-error",
    "closed-defect",
    "unauthorized",
    "interrupt",
    "mixed-interrupt",
  ] as const)
    nodes.live(`native ${name} node ${mode} preserves tool ordering and execution authority`, () =>
      Effect.gen(function* () {
        nodeCalls.length = 0
        const base = ProContract.defaultSpec(mode, yield* Clock.currentTimeMillis)
        const state = yield* setup({
          ...base,
          budget: { deadline: base.budget.deadline },
          authority: ["filesystem.read", "process.execute"],
          evidence: {
            type: "principal",
            replay: {
              checks: [{ argv: [process.execPath, "-e", "process.stdout.write('verified')"], timeout: 5000, exit: 0 }],
              protected: [],
              artifacts: [RelativePath.make("candidate.txt")],
            },
          },
        })
        yield* Effect.promise(async () => {
          await Bun.write(path.join(state.directory, "candidate.txt"), "unchanged candidate")
          await $`git init`.cwd(state.directory).quiet()
        })
        yield* Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const materialized = yield* registry.materialize()
          const input = { summary: "Original submission", uncertainties: ["Original uncertainty"] }
          const exit = yield* materialized
            .settle({
              sessionID: state.binding.sessionID,
              ...toolIdentity,
              contractExecution: state.execution,
              call: { type: "tool-call", id: "native-node", name, input: name === "contract_check" ? {} : input },
            })
            .pipe(Effect.exit)
          expect(nodeCalls).toHaveLength(1)
          expect(nodeCalls[0].call).toEqual({ messageID: toolIdentity.assistantMessageID, callID: "native-node" })
          expect(nodeCalls[0].execution).toEqual(state.execution)
          const current = (yield* state.contracts.get(state.binding.contractID))!
          const binding = (yield* state.bindings.get(state.binding.contractID))!
          if (mode === "interrupt") {
            expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          }
          if (mode === "mixed-interrupt") {
            expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && Cause.hasDies(exit.cause)).toBe(true)
          }
          if (mode === "closed-error" || mode === "closed-defect" || mode === "unauthorized") {
            expect(Exit.isSuccess(exit) && exit.value.result.type === "error").toBe(true)
          }
          const continued = mode === "continue" || mode === "host-error" || mode === "host-defect"
          const delivered = name === "contract_report_ready" && continued
          expect(current.handoff !== undefined).toBe(delivered)
          expect(binding.actionsUsed).toBe(name === "contract_check" || delivered ? 1 : 0)
          expect(binding.turnsUsed).toBe(0)
          if (delivered) {
            expect(current.handoff).toMatchObject({ ...input, replay: { passed: true } })
            expect(input.uncertainties).toEqual(["Original uncertainty"])
          }
          if (Exit.isSuccess(exit) && (continued || mode === "intercept")) {
            expect(exit.value.result.type).not.toBe("error")
            const text = JSON.stringify(exit.value.output)
            if (mode === "intercept") expect(text).toContain("execution will pause")
            expect(text).not.toContain("Callback must not")
          }
          if (name === "contract_check") {
            expect(nodeCalls[0]).toMatchObject({ type: "check", replay: { passed: true } })
            const call = nodeCalls[0]
            if (call.type !== "check") return yield* Effect.die("Missing check result")
            const verifier = yield* ProContractReplay.Service
            const recorded = yield* verifier.read({ contractID: current.id, evidenceHash: call.replay.evidenceHash })
            expect(recorded).toHaveLength(1)
            expect(recorded[0].receipt.execution).toBe("completed")
          }
        }).pipe(Effect.provide(LocationServiceMap.Service.get(state.location)))
      }),
    )

nodes.effect("historical delivery profiles do not invoke the native node hook", () =>
  Effect.gen(function* () {
    nodeCalls.length = 0
    const state = yield* setup(undefined, "historical-required-profile")
    yield* Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const materialized = yield* registry.materialize()
      const result = yield* materialized.settle({
        sessionID: state.binding.sessionID,
        ...toolIdentity,
        contractExecution: state.execution,
        call: {
          type: "tool-call",
          id: "required-delivery",
          name: "contract_report_ready",
          input: { summary: "Original", uncertainties: [] },
        },
      })
      expect(result.result.type).not.toBe("error")
      expect(nodeCalls).toHaveLength(0)
    }).pipe(Effect.provide(LocationServiceMap.Service.get(state.location)))
  }),
)
