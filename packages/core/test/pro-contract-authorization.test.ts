import { describe, expect } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ContractControlTools } from "@opencode-ai/core/tool/contract-control"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { Model } from "@opencode-ai/schema/model"
import { ExecutionAuthorization } from "@opencode-ai/schema/pro-contract"
import { Provider } from "@opencode-ai/schema/provider"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { tmpdir } from "./fixture/tmpdir"
import { settleTool, toolIdentity } from "./lib/tool"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, ProContract.node, ProContractOpenCode.node])))
const input = {
  id: ProContract.ID.make("pct_authorized_task"),
  scope: "authorization",
  spec: {
    ...ProContract.defaultSpec("Deliver an independently verified result", 0),
    budget: { deadline: 6 * 60 * 60 * 1_000 },
  },
  location: { directory: AbsolutePath.make("/project") },
  model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
  executionPolicy: "Use the independently authorized working method",
  now: 0,
}

// These helpers exercise the actual ledger; authorization is a discharged ordinary Contract.
const discharge = Effect.fnUntraced(function* (contractID: ProContract.ID, subjectHash: string) {
  const contracts = yield* ProContract.Service
  const contract = yield* contracts.get(contractID)
  if (!contract) return yield* Effect.die("Contract is missing")
  expect(
    (yield* contracts.reportReady({
      contractID,
      revision: contract.revision,
      summary: "Frozen artifact ready for independent review",
      uncertainties: [],
      subjectHash,
      time: 1,
    })).decision,
  ).toEqual({ type: "accepted" })
  const receipt = yield* contracts.principalAttest({
    contractID,
    revision: contract.revision,
    specHash: contract.specHash,
    subjectHash,
    evidenceHash: `independent-evidence:${subjectHash}`,
  })
  expect(receipt.decision).toEqual({ type: "accepted" })
  const attestationID = receipt.state.contracts[contractID]?.attestationID
  if (!attestationID) return yield* Effect.die("Independent attestation is missing")
  return { contractID, revision: contract.revision, specHash: contract.specHash, subjectHash, attestationID }
})

const authorize = Effect.fnUntraced(function* (id = ProContract.ID.make("pct_execution_grant")) {
  const contracts = yield* ProContract.Service
  yield* contracts.issue({
    id,
    scope: input.scope,
    spec: { ...input.spec, goal: "Authorize this working method to execute tasks" },
    executor: "independent-principal",
  })
  yield* contracts.activate(id, 1, 0)
  return yield* discharge(id, `frozen-method:${id}`)
})

const revoke = Effect.fnUntraced(function* (authorization: ExecutionAuthorization) {
  const contracts = yield* ProContract.Service
  expect(
    (yield* contracts.challenge({
      contractID: authorization.contractID,
      revision: authorization.revision,
      subjectHash: authorization.subjectHash,
      evidenceHash: "execution-authorization-withdrawn",
      disclosure: "executor",
      summary: "Do not start or continue this working method",
      time: 2,
    })).decision,
  ).toEqual({ type: "accepted" })
})

const running = Effect.fnUntraced(function* (authorization: ExecutionAuthorization) {
  const contracts = yield* ProContract.Service
  const bindings = yield* ProContractOpenCode.Service
  expect((yield* bindings.issue({ ...input, authorization })).decision).toEqual({ type: "accepted" })
  expect((yield* contracts.activate(input.id, 1, 0)).decision).toEqual({ type: "accepted" })
  const binding = yield* bindings.claim(input.id, 0)
  if (!binding) return yield* Effect.die("Authorized execution was not claimed")
  return binding
})

describe("ProContract execution authorization is not result evidence", () => {
  it.effect("pins complete authorization coordinates outside the obligation identity", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const authorization = yield* authorize()
      const binding = yield* running(authorization)

      expect(binding.authorization).toEqual(authorization)
      expect(yield* contracts.get(input.id)).toMatchObject({
        specHash: ProContract.hashSpec(input.spec),
        spec: { requires: [] },
      })
      expect(yield* bindings.current(binding.sessionID, 1)).toMatchObject({ binding })
      expect(yield* bindings.reserveTurn(binding.sessionID, 1)).toBe(true)
      expect(yield* bindings.reserveAction(binding.sessionID, 1)).toBe(true)
    }),
  )

  it.effect("retains an independently accepted result when its execution method loses authorization", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const authorization = yield* authorize()
      const binding = yield* running(authorization)
      const accepted = yield* discharge(input.id, "independently-verified-result")
      const result = yield* contracts.get(input.id)
      const history = yield* contracts.history({ contractID: input.id })

      yield* revoke(authorization)
      yield* bindings.heartbeat(new Set([binding.sessionID]), 3)
      yield* bindings.reconcile(3)
      expect(yield* bindings.reserveTurn(binding.sessionID, 3)).toBe(false)
      expect(yield* bindings.reserveAction(binding.sessionID, 3)).toBe(false)
      expect(yield* bindings.current(binding.sessionID, 3)).toBeUndefined()
      expect(yield* bindings.claim(input.id, 3)).toBeUndefined()
      expect(yield* contracts.get(input.id)).toEqual(result)
      expect(yield* contracts.history({ contractID: input.id })).toEqual(history)
      expect(yield* contracts.getAttestation(accepted.attestationID)).toMatchObject({
        subjectHash: "independently-verified-result",
        evidenceHash: "independent-evidence:independently-verified-result",
      })
    }),
  )
  ;(["reserveTurn", "reserveAction"] as const).forEach((operation) => {
    it.effect(`${operation} fences and escalates active work after authorization is withdrawn`, () =>
      Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const authorization = yield* authorize()
        const binding = yield* running(authorization)
        expect(yield* bindings.reserveTurn(binding.sessionID, 1)).toBe(true)
        expect(yield* bindings.reserveAction(binding.sessionID, 1)).toBe(true)
        yield* revoke(authorization)

        expect(yield* bindings[operation](binding.sessionID, 3)).toBe(false)
        expect(yield* contracts.get(input.id)).toMatchObject({ status: "escalated" })
        expect((yield* contracts.get(input.id))?.escalation?.reason).toContain("authorization")
        expect(yield* bindings.get(input.id)).toMatchObject({ turnsUsed: 1, actionsUsed: 1 })
        expect(yield* bindings.current(binding.sessionID, 3)).toBeUndefined()
      }),
    )
  })

  it.effect("rechecks authorization before an asynchronous operation can publish its result", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const database = yield* Database.Service
      const authorization = yield* authorize()
      const binding = yield* running(authorization)
      expect(yield* bindings.current(binding.sessionID, 1)).toBeDefined()

      yield* revoke(authorization)
      // This is the public ownership seam used by control tools after their external await.
      const current = yield* database.db.transaction(() => bindings.current(binding.sessionID, 3), {
        behavior: "immediate",
      })
      expect(current).toBeUndefined()
      expect((yield* contracts.get(input.id))?.handoff).toBeUndefined()
      expect(
        (yield* contracts.history({ contractID: input.id })).some((entry) => entry.command.type === "report-ready"),
      ).toBe(false)
    }),
  )

  it.effect("will not renew a revoked execution lease", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const authorization = yield* authorize()
      const binding = yield* running(authorization)
      yield* revoke(authorization)

      yield* bindings.heartbeat(new Set([binding.sessionID]), 20_000)
      expect((yield* bindings.get(input.id))?.leaseExpiresAt ?? 0).toBeLessThanOrEqual(binding.leaseExpiresAt!)
      expect(yield* contracts.get(input.id)).toMatchObject({ status: "escalated" })
      expect(yield* bindings.current(binding.sessionID, 20_001)).toBeUndefined()
    }),
  )
  ;(["dormant", "active", "verification"] as const).forEach((status) => {
    it.effect(`reconciles lost authorization for ${status} responsibility without losing the obligation`, () =>
      Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const authorization = yield* authorize()
        const admitted = yield* bindings.issue({ ...input, authorization })
        if (status !== "dormant") {
          yield* contracts.activate(input.id, 1, 0)
          yield* bindings.claim(input.id, 0)
        }
        if (status === "verification")
          yield* contracts.reportReady({
            contractID: input.id,
            revision: 1,
            summary: "Candidate needs independent verification",
            uncertainties: [],
            subjectHash: "not-yet-accepted",
            time: 1,
          })
        yield* revoke(authorization)
        yield* bindings.reconcile(3)

        expect(yield* contracts.get(input.id)).toMatchObject({ status: "escalated", revision: 1, spec: input.spec })
        expect(yield* bindings.get(input.id)).toMatchObject({
          sessionID: admitted.execution!.sessionID,
          authorization,
        })
        expect(yield* contracts.quiet(input.scope)).toMatchObject({
          quiet: false,
          outstanding: expect.arrayContaining([input.id]),
        })
        expect(yield* bindings.claim(input.id, 3)).toBeUndefined()
      }),
    )
  })

  it.effect("does not reopen a released obligation when execution authorization is withdrawn", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const authorization = yield* authorize()
      yield* running(authorization)
      yield* contracts.release({ contractID: input.id, reason: "The principal cancelled this task" })
      const released = yield* contracts.get(input.id)
      yield* revoke(authorization)
      yield* bindings.reconcile(3)
      expect(yield* contracts.get(input.id)).toEqual(released)
    }),
  )

  it.effect("still reopens a result when a genuine evidentiary dependency is refuted", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const authorization = yield* authorize()
      const evidence = yield* authorize(ProContract.ID.make("pct_result_support"))
      yield* bindings.issue({
        ...input,
        authorization,
        spec: { ...input.spec, requires: [{ contractID: evidence.contractID, revision: evidence.revision }] },
      })
      yield* contracts.activate(input.id, 1, 0)
      const accepted = yield* discharge(input.id, "dependent-result")
      yield* revoke(evidence)

      expect(yield* contracts.get(input.id)).toMatchObject({
        status: "escalated",
        escalation: { reason: `Dependency support lost: ${evidence.contractID}` },
      })
      expect((yield* contracts.get(input.id))?.attestationID).toBeUndefined()
      expect(yield* contracts.getAttestation(accepted.attestationID)).toBeDefined()
      expect(yield* contracts.get(authorization.contractID)).toMatchObject({ status: "discharged" })
    }),
  )

  it.effect("rejects a revoked authorization before a first execution claim", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const authorization = yield* authorize()
      const admitted = yield* bindings.issue({ ...input, authorization })
      yield* contracts.activate(input.id, 1, 0)
      yield* revoke(authorization)

      expect(yield* bindings.claim(input.id, 3)).toBeUndefined()
      expect(yield* contracts.get(input.id)).toMatchObject({ status: "escalated" })
      expect(yield* bindings.get(input.id)).toMatchObject({
        sessionID: admitted.execution!.sessionID,
        attempts: 0,
        turnsUsed: 0,
        actionsUsed: 0,
      })
    }),
  )

  it.effect("keeps an existing execution pinned when another method is independently authorized", () =>
    Effect.gen(function* () {
      const bindings = yield* ProContractOpenCode.Service
      const authorization = yield* authorize()
      const binding = yield* running(authorization)
      const successor = yield* authorize(ProContract.ID.make("pct_successor_authorization"))
      const next = yield* bindings.issue({
        ...input,
        id: ProContract.ID.make("pct_next_task"),
        authorization: successor,
      })

      expect(next.execution?.authorization).toEqual(successor)
      expect(yield* bindings.get(input.id)).toMatchObject({ authorization, sessionID: binding.sessionID })
      expect(yield* bindings.reserveTurn(binding.sessionID, 1)).toBe(true)
      yield* revoke(successor)
      expect(yield* bindings.reserveAction(binding.sessionID, 3)).toBe(true)
    }),
  )
})

describe("ProContract execution authorization admission", () => {
  it.effect("reconciles exact retries without changing the pinned execution", () =>
    Effect.gen(function* () {
      const bindings = yield* ProContractOpenCode.Service
      const authorization = yield* authorize()
      const admitted = yield* bindings.issue({ ...input, authorization })
      const retried = yield* bindings.issue({ ...input, authorization: { ...authorization }, now: 100 })
      expect(retried.decision).toEqual({ type: "accepted" })
      expect(retried.execution).toEqual(admitted.execution)
    }),
  )
  ;(["changed", "removed"] as const).forEach((kind) => {
    it.effect(`rejects an exact obligation retry with ${kind} execution authorization`, () =>
      Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const authorization = yield* authorize()
        const successor = yield* authorize(ProContract.ID.make("pct_alternative_grant"))
        const admitted = yield* bindings.issue({ ...input, authorization })
        const history = yield* contracts.history({ contractID: input.id })

        const retried = yield* bindings.issue({ ...input, authorization: kind === "removed" ? undefined : successor })
        expect(retried.decision).toEqual({ type: "rejected", reason: "OpenCode execution binding does not match" })
        expect(yield* bindings.get(input.id)).toEqual(admitted.execution)
        expect(yield* contracts.history({ contractID: input.id })).toEqual(history)
      }),
    )
  })

  it.effect("does not mint a new execution on an exact retry after authorization revocation", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const authorization = yield* authorize()
      const admitted = yield* bindings.issue({ ...input, authorization })
      yield* revoke(authorization)
      const history = yield* contracts.history({ contractID: input.id })

      const retried = yield* bindings.issue({ ...input, authorization, now: 3 })
      expect(retried.decision.type).toBe("rejected")
      expect(retried.execution).toBeUndefined()
      expect(yield* bindings.get(input.id)).toEqual(admitted.execution)
      expect(yield* contracts.history({ contractID: input.id })).toEqual(history)
    }),
  )
  ;(["contractID", "revision", "specHash", "subjectHash", "attestationID"] as const).forEach((coordinate) => {
    it.effect(`rejects a grant with the wrong ${coordinate} before creating responsibility or execution`, () =>
      Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const authorization = yield* authorize()
        const changed = {
          ...authorization,
          ...(coordinate === "contractID" ? { contractID: ProContract.ID.make("pct_unknown_grant") } : {}),
          ...(coordinate === "revision" ? { revision: authorization.revision + 1 } : {}),
          ...(coordinate === "specHash" ? { specHash: "different-specification" } : {}),
          ...(coordinate === "subjectHash" ? { subjectHash: "different-frozen-method" } : {}),
          ...(coordinate === "attestationID" ? { attestationID: ProContract.AttestationID.make("pca_unrelated") } : {}),
        }
        const rejected = yield* bindings.issue({ ...input, authorization: changed })

        expect(rejected.decision.type).toBe("rejected")
        expect(rejected.execution).toBeUndefined()
        expect(yield* contracts.get(input.id)).toBeUndefined()
        expect(yield* bindings.get(input.id)).toBeUndefined()
        expect(yield* contracts.history({ contractID: input.id })).toEqual([])
      }),
    )
  })

  it.effect("does not treat a replacement attestation for the same source as the original authorization", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const authorization = yield* authorize()
      const binding = yield* running(authorization)
      yield* revoke(authorization)
      yield* contracts.activate(authorization.contractID, authorization.revision, 3)
      const replacement = yield* discharge(authorization.contractID, authorization.subjectHash)
      expect(replacement.attestationID).not.toBe(authorization.attestationID)

      expect(yield* bindings.current(binding.sessionID, 4)).toBeUndefined()
      expect(yield* bindings.reserveTurn(binding.sessionID, 4)).toBe(false)
      const admitted = yield* bindings.issue({
        ...input,
        id: ProContract.ID.make("pct_fresh_grant_task"),
        authorization: replacement,
      })
      expect(admitted.decision).toEqual({ type: "accepted" })
      expect(admitted.execution?.authorization).toEqual(replacement)
    }),
  )

  it.effect("direct create cannot replace or strip an existing authorization", () =>
    Effect.gen(function* () {
      const bindings = yield* ProContractOpenCode.Service
      const authorization = yield* authorize()
      const successor = yield* authorize(ProContract.ID.make("pct_replacement_grant"))
      const admitted = yield* bindings.issue({ ...input, authorization })
      const create = {
        contractID: input.id,
        revision: 1,
        location: input.location,
        model: input.model,
        executionPolicy: input.executionPolicy,
        nextActionAt: 0,
      }
      expect(Exit.isFailure(yield* bindings.create({ ...create, authorization: successor }).pipe(Effect.exit))).toBe(
        true,
      )
      expect(Exit.isFailure(yield* bindings.create(create).pipe(Effect.exit))).toBe(true)
      expect(yield* bindings.get(input.id)).toEqual(admitted.execution)
      expect(yield* bindings.create({ ...create, authorization })).toEqual(admitted.execution!)
    }),
  )

  it.effect("direct create refuses withdrawn authority without inserting a binding", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const authorization = yield* authorize()
      yield* contracts.issue({ id: input.id, scope: input.scope, spec: input.spec, executor: "opencode" })
      yield* revoke(authorization)
      const created = yield* bindings
        .create({
          contractID: input.id,
          revision: 1,
          location: input.location,
          model: input.model,
          authorization,
          nextActionAt: 0,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(created)).toBe(true)
      expect(yield* bindings.get(input.id)).toBeUndefined()
      expect(yield* contracts.get(input.id)).toMatchObject({ status: "dormant" })
    }),
  )
})

it.effect("freezes admission before waiting for a write transaction and observes its committed withdrawal", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const contracts = yield* ProContract.Service
    const bindings = yield* ProContractOpenCode.Service
    const authorization = yield* authorize()
    const successor = yield* authorize(ProContract.ID.make("pct_valid_replacement"))
    const locked = yield* Deferred.make<void>()
    const unlock = yield* Deferred.make<void>()
    const holder = yield* database.db
      .transaction(
        () =>
          Effect.gen(function* () {
            yield* revoke(authorization)
            yield* Deferred.succeed(locked, undefined)
            yield* Deferred.await(unlock)
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(locked)

    const captured: ExecutionAuthorization[] = []
    const request = { ...input, authorization }
    // A getter marks exactly when the caller's mutable input has been copied, without stubbing storage.
    Object.defineProperty(request, "authorization", {
      enumerable: true,
      configurable: true,
      get: () => {
        captured.push(authorization)
        return authorization
      },
    })
    const pending = yield* bindings.issue(request).pipe(Effect.forkChild)
    yield* Effect.yieldNow.pipe(Effect.repeat({ while: () => captured.length === 0, times: 1_000 }))
    expect(captured).toHaveLength(1)
    Object.defineProperty(request, "authorization", { enumerable: true, value: successor })
    request.spec = { ...request.spec, goal: "Changed while the admission transaction was queued" }
    yield* Deferred.succeed(unlock, undefined)
    yield* Fiber.join(holder)
    const afterWithdrawal = yield* contracts.quiet(input.scope)

    const rejected = yield* Fiber.join(pending)
    expect(rejected.decision).toEqual({
      type: "rejected",
      reason: "OpenCode execution authorization is no longer current",
    })
    expect(rejected.execution).toBeUndefined()
    expect(yield* contracts.get(input.id)).toBeUndefined()
    expect(yield* bindings.get(input.id)).toBeUndefined()
    expect(yield* contracts.history({ contractID: input.id })).toEqual([])
    expect(yield* contracts.quiet(input.scope)).toEqual(afterWithdrawal)
  }),
)

testEffect(Layer.empty).effect(
  "fences a real asynchronous revision approval after its execution authorization is revoked",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
      )
      const location = { directory: AbsolutePath.make(directory.path) }
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const agents = yield* AgentV2.Service
        const permissions = yield* PermissionV2.Service
        const registry = yield* ToolRegistry.Service
        const authorization = yield* authorize()
        yield* bindings.issue({ ...input, authorization, location })
        yield* contracts.activate(input.id, 1, 0)
        const binding = yield* bindings.claim(input.id, 0)
        if (!binding) return yield* Effect.die("Authorized execution was not claimed")
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
            title: "Authorization fence during principal approval",
            version: "test",
            model: input.model,
          })
          .run()
        yield* agents.transform((draft) =>
          draft.update(AgentV2.defaultID, (agent) => {
            agent.permissions.push({ action: "contract_revision", resource: "*", effect: "ask" })
          }),
        )
        const pending = yield* settleTool(registry, {
          sessionID: binding.sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "late-authorized-revision",
            name: "contract_propose_revision",
            input: { goal: "Requested revised goal", reason: "The executor found an ambiguity" },
          },
        }).pipe(Effect.forkChild)
        const requests = yield* Effect.yieldNow.pipe(
          Effect.andThen(permissions.list()),
          Effect.repeat({ while: (requests) => requests.length === 0, times: 1_000 }),
        )
        expect(requests).toHaveLength(1)
        yield* revoke(authorization)
        const before = yield* contracts.get(input.id)
        const history = yield* contracts.history({ contractID: input.id })
        const execution = yield* bindings.get(input.id)
        yield* permissions.reply({ requestID: requests[0]!.id, reply: "once" })

        expect((yield* Fiber.join(pending)).result).toEqual({
          type: "error",
          value: "Contract execution is no longer current for this Session",
        })
        expect(yield* contracts.get(input.id)).toEqual(before)
        expect(yield* contracts.history({ contractID: input.id })).toEqual(history)
        expect(yield* bindings.get(input.id)).toEqual(execution)
        expect((yield* contracts.get(input.id))?.pendingRevision).toBeUndefined()
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
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
                  ...location,
                  project: { id: Project.ID.global, directory: location.directory },
                }),
              ],
              [Global.node, Global.layerWith({ data: directory.path })],
            ],
          ),
        ),
      )
    }),
)

describe("host-owned native reasoning bindings", () => {
  it.effect("pins manual ownership across retries and excludes it from ordinary dispatch", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const authorization = yield* authorize()
      const admitted = yield* bindings.issue({ ...input, authorization, mode: "reason" })
      expect(admitted.decision).toEqual({ type: "accepted" })
      expect(admitted.execution?.mode).toBe("reason")
      expect((yield* bindings.issue({ ...input, authorization })).decision).toEqual({
        type: "rejected",
        reason: "OpenCode execution binding does not match",
      })
      yield* contracts.activate(input.id, 1, 0)
      expect(yield* bindings.due(0)).toEqual([])
      const claimed = yield* bindings.claim(input.id, 0)
      expect(claimed?.attempts).toBe(1)
      if (!claimed) return yield* Effect.die("Native reasoning was not claimed")
      expect(yield* bindings.reserveTurn(claimed.sessionID, 1)).toBe(true)
      expect(yield* bindings.reserveTurn(claimed.sessionID, 2)).toBe(false)
      expect(yield* bindings.claim(input.id, 30_001)).toBeUndefined()
      expect(yield* bindings.get(input.id)).toEqual({ ...claimed, turnsUsed: 1 })
      expect((yield* contracts.get(input.id))?.spec.budget).toEqual(input.spec.budget)
      expect(yield* bindings.due(input.spec.budget.deadline)).toEqual([{ ...claimed, turnsUsed: 1 }])
    }),
  )

  it.effect("escalates interrupted native work instead of scheduling an automatic retry", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const authorization = yield* authorize()
      yield* bindings.issue({ ...input, authorization, mode: "reason" })
      yield* contracts.activate(input.id, 1, 0)
      const binding = yield* bindings.claim(input.id, 0)
      if (!binding) return yield* Effect.die("Native reasoning was not claimed")
      yield* bindings.reserveTurn(binding.sessionID, 1)
      yield* bindings.reschedule({
        contractID: input.id,
        revision: 1,
        promptID: binding.promptID,
        reason: "Provider transport interrupted",
        now: 2,
        attempt: "same",
      })
      expect(yield* contracts.get(input.id)).toMatchObject({
        status: "escalated",
        escalation: { reason: "Native reasoning interrupted; automatic replay is forbidden" },
        spec: { budget: input.spec.budget },
      })
      expect(yield* bindings.get(input.id)).toMatchObject({
        sessionID: binding.sessionID,
        attempts: 1,
        turnsUsed: 1,
        actionsUsed: 0,
      })
      expect(yield* bindings.due(3)).toEqual([])
      expect(yield* bindings.claim(input.id, 3)).toBeUndefined()
    }),
  )
})
