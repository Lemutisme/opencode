import { describe, expect } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProContractReplay } from "@opencode-ai/core/pro-contract/replay"
import { ProContractOpenCodeTable } from "@opencode-ai/core/pro-contract/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { ContractControlTools } from "@opencode-ai/core/tool/contract-control"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { WorkspaceID } from "@opencode-ai/schema/workspace-id"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const contractID = ProContract.ID.make("pct_control_fencing")
const location = { directory: AbsolutePath.make("/project") }
const model = Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") })
const spec = {
  ...ProContract.defaultSpec("Deliver the current candidate", 0),
  budget: { deadline: 120_000 },
  resolution: { maxAttempts: 3, retryDelay: 0 },
}
const replayPolicy = { checks: [{ argv: ["true"], timeout: 1_000, exit: 0 }], protected: [], artifacts: [] }
const controls = [
  { name: "contract_report_ready", input: { summary: "candidate complete", uncertainties: [] } },
  { name: "contract_report_blocked", input: { reason: "The prerequisite is unavailable" } },
  { name: "contract_propose_revision", input: { goal: "Deliver the approved revision", reason: "Clarify the target" } },
]
const stale = { type: "error", value: "Contract execution is no longer current for this Session" }

describe("Contract control fencing through ToolRegistry", () => {
  controls.forEach((control) => {
    it.effect(`rejects retired Session ${control.name} without mutating the obligation or counters`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup()
        yield* rotate(fixture.binding)
        const before = yield* state()

        const result = yield* settleTool(fixture.registry, {
          sessionID: fixture.binding.sessionID,
          ...toolIdentity,
          call: { ...control, type: "tool-call", id: "retired-control" },
        })

        expect(result.result).toEqual(stale)
        expect(yield* state()).toEqual(before)
      }).pipe(Effect.provide(controlLayer())),
    )

    it.effect(`allows current Session ${control.name} without charging an extra action`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup()
        const result = yield* settleTool(fixture.registry, {
          sessionID: fixture.binding.sessionID,
          ...toolIdentity,
          call: { ...control, type: "tool-call", id: "current-control" },
        })

        expect(result.output?.structured).toEqual({ recorded: true })
        expect((yield* state()).binding).toMatchObject({ turnsUsed: 1, actionsUsed: 0 })
      }).pipe(Effect.provide(controlLayer())),
    )
  })
  ;["another owner", "expired lease"].forEach((reason) => {
    it.effect(`rejects all controls under ${reason} without mutating the obligation or counters`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup()
        const database = yield* Database.Service
        const bindings = yield* ProContractOpenCode.Service
        if (reason === "expired lease") yield* TestClock.setTime(30_000)
        if (reason === "another owner") {
          const binding = yield* bindings.get(contractID)
          if (!binding) return yield* Effect.die("Execution binding is missing")
          yield* database.db
            .update(ProContractOpenCodeTable)
            .set({ data: { ...binding, leaseOwner: "a-different-runner" } })
            .where(eq(ProContractOpenCodeTable.contract_id, contractID))
            .run()
        }
        const before = yield* state()
        yield* Effect.forEach(controls, (control) =>
          Effect.gen(function* () {
            const result = yield* settleTool(fixture.registry, {
              sessionID: fixture.binding.sessionID,
              ...toolIdentity,
              call: { ...control, type: "tool-call", id: `unowned-${control.name}` },
            })
            expect(result.result).toEqual(stale)
            expect(yield* state()).toEqual(before)
          }),
        )
      }).pipe(Effect.provide(controlLayer())),
    )
  })

  it.effect("rejects the same Session after an executor-visible challenge changes the semantic attempt", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      const contracts = yield* ProContract.Service
      expect(
        (yield* settleTool(fixture.registry, {
          sessionID: fixture.binding.sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "handoff-a",
            name: "contract_report_ready",
            input: { summary: "candidate A", uncertainties: [] },
          },
        })).output?.structured,
      ).toEqual({ recorded: true })
      expect(
        (yield* contracts.challenge({
          contractID,
          revision: 1,
          subjectHash: "subject-current",
          evidenceHash: "counterexample",
          disclosure: "executor",
          summary: "Repair the actual failing behavior",
          time: 1,
        })).decision,
      ).toEqual({ type: "accepted" })
      yield* contracts.activate(contractID, 1, 1)
      const before = yield* state()
      expect(before.binding?.sessionID).toBe(fixture.binding.sessionID)

      const result = yield* settleTool(fixture.registry, {
        sessionID: fixture.binding.sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "stale-handoff-b",
          name: "contract_report_ready",
          input: { summary: "candidate B from stale attempt", uncertainties: [] },
        },
      })

      expect(result.result).toEqual(stale)
      expect(yield* state()).toEqual(before)
    }).pipe(Effect.provide(controlLayer())),
  )
  ;[Snapshot.ID.make("delayed-subject"), undefined].forEach((subject) => {
    it.effect(`fences ${subject ? "successful" : "unavailable"} snapshot completion after Session replacement`, () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<Snapshot.ID | undefined>()
        yield* Effect.gen(function* () {
          const fixture = yield* setup()
          const pending = yield* settleTool(fixture.registry, {
            sessionID: fixture.binding.sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "delayed-snapshot",
              name: "contract_report_ready",
              input: { summary: "delayed candidate", uncertainties: [] },
            },
          }).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* rotate(fixture.binding)
          const before = yield* state()
          yield* Deferred.succeed(finish, subject)

          expect((yield* Fiber.join(pending)).result).toEqual(stale)
          expect(yield* state()).toEqual(before)
        }).pipe(
          Effect.provide(
            controlLayer({
              capture: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
            }),
          ),
        )
      }),
    )
  })
  ;[false, true].forEach((unavailable) => {
    it.effect(
      `fences delayed ${unavailable ? "unavailable" : "successful"} replay without stale handoff or escalation`,
      () =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const finish = yield* Deferred.make<void>()
          yield* Effect.gen(function* () {
            const fixture = yield* setup({ ...spec, evidence: { ...spec.evidence, replay: replayPolicy } })
            const pending = yield* settleTool(fixture.registry, {
              sessionID: fixture.binding.sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "delayed-replay",
                name: "contract_report_ready",
                input: { summary: "delayed verified candidate", uncertainties: [] },
              },
            }).pipe(Effect.forkChild)
            yield* Deferred.await(started)
            yield* rotate(fixture.binding)
            const before = yield* state()
            expect(before.binding).toMatchObject({ actionsUsed: 1 })
            yield* Deferred.succeed(finish, undefined)

            expect((yield* Fiber.join(pending)).result).toEqual(stale)
            expect(yield* state()).toEqual(before)
          }).pipe(
            Effect.provide(
              controlLayer({
                verify: (input) =>
                  Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Deferred.await(finish)),
                    Effect.andThen(
                      unavailable
                        ? Effect.fail(new ProContractReplay.Unavailable({ message: "Replay infrastructure failed" }))
                        : verified(input),
                    ),
                  ),
              }),
            ),
          )
        }),
    )
  })

  it.effect("charges exactly the existing replay action for an accepted current handoff", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ ...spec, evidence: { ...spec.evidence, replay: replayPolicy } })
      const result = yield* settleTool(fixture.registry, {
        sessionID: fixture.binding.sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "current-replay",
          name: "contract_report_ready",
          input: { summary: "verified candidate", uncertainties: [] },
        },
      })

      expect(result.output?.structured).toEqual({ recorded: true })
      expect((yield* state()).binding).toMatchObject({ turnsUsed: 1, actionsUsed: 1 })
      expect((yield* state()).contract).toMatchObject({ status: "verification" })
    }).pipe(Effect.provide(controlLayer())),
  )

  it.effect(
    "does not persist a revision petition while waiting for principal approval or after Session replacement",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup()
        const agents = yield* AgentV2.Service
        const permissions = yield* PermissionV2.Service
        yield* agents.transform((draft) =>
          draft.update(AgentV2.defaultID, (agent) => {
            agent.permissions.push({ action: "contract_revision", resource: "*", effect: "ask" })
          }),
        )
        const before = yield* state()
        const pending = yield* settleTool(fixture.registry, {
          sessionID: fixture.binding.sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "late-revision-approval",
            name: "contract_propose_revision",
            input: { goal: "The approved replacement goal", reason: "Clarify the required outcome" },
          },
        }).pipe(Effect.forkChild)
        const requests = yield* Effect.yieldNow.pipe(
          Effect.andThen(permissions.list()),
          Effect.repeat({ while: (requests) => requests.length === 0, times: 1_000 }),
        )
        expect(requests).toHaveLength(1)
        expect(yield* state()).toEqual(before)
        yield* rotate(fixture.binding)
        const replaced = yield* state()
        yield* permissions.reply({ requestID: requests[0]!.id, reply: "once" })

        expect((yield* Fiber.join(pending)).result).toEqual(stale)
        expect(yield* state()).toEqual(replaced)
        expect((yield* state()).contract?.pendingRevision).toBeUndefined()
      }).pipe(Effect.provide(controlLayer())),
  )
  ;[
    { directory: AbsolutePath.make("/another-project") },
    { ...location, workspaceID: WorkspaceID.make("wrk_other") },
  ].forEach((wrong) => {
    it.effect(`rejects controls from a different ${"workspaceID" in wrong ? "workspace" : "directory"}`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup()
        const before = yield* state()
        const result = yield* settleTool(fixture.registry, {
          sessionID: fixture.binding.sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "wrong-location",
            name: "contract_report_ready",
            input: { summary: "candidate from another Location", uncertainties: [] },
          },
        })

        expect(result.result).toEqual(stale)
        expect(yield* state()).toEqual(before)
      }).pipe(Effect.provide(controlLayer({ location: wrong }))),
    )
  })
})

function controlLayer(
  input: {
    capture?: Snapshot.Interface["capture"]
    verify?: ProContractReplay.Interface["verify"]
    location?: Location.Ref
  } = {},
) {
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      AgentV2.node,
      PermissionV2.node,
      ProContract.node,
      ProContractOpenCode.node,
      ToolRegistry.node,
      ContractControlTools.node,
    ]),
    [
      [
        Location.node,
        Layer.succeed(Location.Service, {
          ...(input.location ?? location),
          project: { id: Project.ID.global, directory: location.directory },
        }),
      ],
      [
        Snapshot.node,
        Layer.mock(Snapshot.Service, {
          capture: input.capture ?? (() => Effect.succeed(Snapshot.ID.make("subject-current"))),
        }),
      ],
      [
        ProContractReplay.node,
        Layer.succeed(ProContractReplay.Service, { verify: input.verify ?? verified, read: () => Effect.succeed([]) }),
      ],
    ],
  )
}

function setup(terms: ProContract.Spec = spec) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const contracts = yield* ProContract.Service
    const bindings = yield* ProContractOpenCode.Service
    const agents = yield* AgentV2.Service
    const registry = yield* ToolRegistry.Service
    yield* bindings.issue({ id: contractID, scope: "control-fencing", spec: terms, location, model, now: 0 })
    yield* contracts.activate(contractID, 1, 0)
    const binding = yield* bindings.claim(contractID, 0)
    if (!binding) return yield* Effect.die("Initial execution was not claimed")
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
    yield* database.db
      .insert(SessionTable)
      .values({
        id: binding.sessionID,
        project_id: Project.ID.global,
        slug: binding.sessionID,
        directory: location.directory,
        title: "Contract control fencing",
        version: "test",
        model,
      })
      .run()
    yield* agents.transform((draft) =>
      draft.update(AgentV2.defaultID, (agent) => {
        agent.permissions.push({ action: "contract_revision", resource: "*", effect: "allow" })
      }),
    )
    expect(yield* bindings.reserveTurn(binding.sessionID, 0)).toBe(true)
    return { binding, registry }
  })
}

function rotate(first: ProContractOpenCode.Binding) {
  return Effect.gen(function* () {
    const bindings = yield* ProContractOpenCode.Service
    yield* TestClock.setTime(30_001)
    const second = yield* bindings.claim(contractID, 30_001)
    if (!second) return yield* Effect.die("Replacement execution was not claimed")
    expect(second.sessionID).not.toBe(first.sessionID)
    return second
  })
}

function state() {
  return Effect.gen(function* () {
    const contracts = yield* ProContract.Service
    const bindings = yield* ProContractOpenCode.Service
    return {
      contract: yield* contracts.get(contractID),
      binding: yield* bindings.get(contractID),
      history: yield* contracts.history({ contractID }),
    }
  })
}

function verified(input: Parameters<ProContractReplay.Interface["verify"]>[0]) {
  return Effect.succeed({
    policyHash: ProContract.hashReplay(input.policy),
    subjectHash: input.subjectHash,
    evidenceHash: "replay-evidence",
    passed: true,
    summary: "Frozen replay passed",
  })
}
