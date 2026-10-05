import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ProContract.node, ProContractOpenCode.node])))
const contractID = ProContract.ID.make("pct_deadline")
const deadline = 6 * 60 * 60 * 1_000
const spec = {
  ...ProContract.defaultSpec("Deliver within the original deadline", 0),
  budget: { deadline },
  resolution: { maxAttempts: 3, retryDelay: 0 },
}
const input = {
  id: contractID,
  scope: "deadline-only",
  spec,
  location: { directory: AbsolutePath.make("/project") },
  model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
  now: 0,
}

describe("ProContract deadline-only execution", () => {
  it.effect(
    "meters actual reservations beyond 1,000 provider turns and 10,000 tool actions without a count ceiling",
    () =>
      Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const issued = yield* bindings.issue(input)
        expect(issued.decision).toEqual({ type: "accepted" })
        yield* contracts.activate(contractID, 1, 0)
        const binding = yield* bindings.claim(contractID, 0)
        if (!binding) return yield* Effect.die("Initial execution was not claimed")

        const turns = yield* Effect.forEach(Array.from({ length: 1_001 }), () =>
          bindings.reserveTurn(binding.sessionID, 1),
        )
        const actions = yield* Effect.forEach(Array.from({ length: 10_001 }), () =>
          bindings.reserveAction(binding.sessionID, 1),
        )

        expect(turns.every(Boolean)).toBe(true)
        expect(actions.every(Boolean)).toBe(true)
        expect(yield* bindings.get(contractID)).toMatchObject({ turnsUsed: 1_001, actionsUsed: 10_001 })
        expect(yield* contracts.get(contractID)).toMatchObject({ status: "active" })
        expect((yield* contracts.get(contractID))?.spec.budget).toEqual({ deadline })
      }),
    30_000,
  )

  it.effect("preserves the original deadline and cumulative accounting across continuation, retry and recovery", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      yield* bindings.issue(input)
      yield* contracts.activate(contractID, 1, 0)
      const first = yield* bindings.claim(contractID, 0)
      if (!first) return yield* Effect.die("Initial execution was not claimed")
      expect(yield* bindings.reserveTurn(first.sessionID, 1)).toBe(true)
      expect(yield* bindings.reserveAction(first.sessionID, 1)).toBe(true)

      yield* bindings.reschedule({
        contractID,
        revision: 1,
        promptID: first.promptID,
        reason: "Continue unfinished work",
        now: 2,
        attempt: "same",
      })
      const continued = yield* bindings.claim(contractID, 2)
      if (!continued) return yield* Effect.die("Continuation was not claimed")
      expect(continued).toMatchObject({ sessionID: first.sessionID, attempts: 1, turnsUsed: 1, actionsUsed: 1 })
      expect(continued.promptID).not.toBe(first.promptID)

      yield* bindings.reschedule({
        contractID,
        revision: 1,
        promptID: continued.promptID,
        reason: "Retry the task",
        now: 3,
        attempt: "new",
      })
      const retried = yield* bindings.claim(contractID, 3)
      if (!retried) return yield* Effect.die("Retry was not claimed")
      expect(retried.sessionID).not.toBe(first.sessionID)
      expect(retried).toMatchObject({ attempts: 2, turnsUsed: 1, actionsUsed: 1 })
      expect(yield* bindings.reserveTurn(first.sessionID, 4)).toBe(false)
      expect(yield* bindings.reserveAction(first.sessionID, 4)).toBe(false)
      expect(yield* bindings.reserveTurn(retried.sessionID, 4)).toBe(true)
      expect(yield* bindings.reserveAction(retried.sessionID, 4)).toBe(true)

      const recovered = yield* bindings.claim(contractID, 30_003)
      if (!recovered) return yield* Effect.die("Expired execution lease was not recovered")
      expect(recovered.sessionID).not.toBe(retried.sessionID)
      expect(recovered).toMatchObject({ attempts: 2, turnsUsed: 2, actionsUsed: 2 })
      expect(yield* bindings.reserveTurn(retried.sessionID, 30_004)).toBe(false)
      expect(yield* bindings.reserveAction(retried.sessionID, 30_004)).toBe(false)
      expect(yield* bindings.reserveTurn(recovered.sessionID, 30_004)).toBe(true)
      expect(yield* bindings.reserveAction(recovered.sessionID, 30_004)).toBe(true)
      expect(yield* bindings.get(contractID)).toMatchObject({ turnsUsed: 3, actionsUsed: 3 })
      expect((yield* contracts.get(contractID))?.spec.budget).toEqual({ deadline })

      yield* bindings.heartbeat(new Set([recovered.sessionID]), deadline - 1)
      expect(yield* bindings.get(contractID)).toMatchObject({ leaseExpiresAt: deadline, nextActionAt: deadline })
      expect(yield* bindings.reserveTurn(recovered.sessionID, deadline - 1)).toBe(true)
      expect(yield* bindings.reserveAction(recovered.sessionID, deadline - 1)).toBe(true)
      expect(yield* bindings.reserveTurn(recovered.sessionID, deadline)).toBe(false)
      expect(yield* bindings.reserveAction(recovered.sessionID, deadline)).toBe(false)
      expect(yield* bindings.claim(contractID, deadline)).toBeUndefined()
      expect(yield* bindings.get(contractID)).toMatchObject({ turnsUsed: 4, actionsUsed: 4 })
      expect((yield* contracts.get(contractID))?.spec.budget).toEqual({ deadline })
    }),
  )

  it.effect("rejects work exactly at the absolute deadline without extending it on admission retry", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const issued = yield* bindings.issue(input)
      const retried = yield* bindings.issue({ ...input, now: deadline - 1 })
      expect(retried.decision).toEqual({ type: "accepted" })
      expect(retried.execution).toEqual(issued.execution)
      yield* contracts.activate(contractID, 1, deadline - 1)
      const binding = yield* bindings.claim(contractID, deadline - 1)
      if (!binding) return yield* Effect.die("Execution before the deadline was not claimed")

      expect(binding.leaseExpiresAt).toBe(deadline)
      expect(yield* bindings.reserveTurn(binding.sessionID, deadline - 1)).toBe(true)
      expect(yield* bindings.reserveAction(binding.sessionID, deadline - 1)).toBe(true)
      expect(yield* bindings.reserveTurn(binding.sessionID, deadline)).toBe(false)
      expect(yield* bindings.reserveAction(binding.sessionID, deadline)).toBe(false)
      expect(yield* bindings.reserveTurn(binding.sessionID, deadline + 1)).toBe(false)
      expect(yield* bindings.reserveAction(binding.sessionID, deadline + 1)).toBe(false)
      expect(yield* bindings.claim(contractID, deadline)).toBeUndefined()
      expect(yield* bindings.get(contractID)).toMatchObject({ turnsUsed: 1, actionsUsed: 1 })
      expect((yield* contracts.get(contractID))?.spec.budget).toEqual({ deadline })
    }),
  )

  it.effect("fences stale same-Session work after a visible challenge even before the next claim", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      yield* bindings.issue(input)
      yield* contracts.activate(contractID, 1, 0)
      const binding = yield* bindings.claim(contractID, 0)
      if (!binding) return yield* Effect.die("Execution was not claimed")
      expect(yield* bindings.reserveTurn(binding.sessionID, 1)).toBe(true)
      yield* contracts.reportReady({
        contractID,
        revision: 1,
        summary: "Candidate A",
        uncertainties: [],
        subjectHash: "candidate-a",
        time: 1,
      })
      yield* contracts.challenge({
        contractID,
        revision: 1,
        subjectHash: "candidate-a",
        evidenceHash: "counterexample-a",
        disclosure: "executor",
        summary: "Candidate A is incomplete",
        time: 2,
      })
      yield* contracts.activate(contractID, 1, 3)
      const history = yield* contracts.history({ contractID })

      expect(yield* bindings.current(binding.sessionID, 3)).toBeUndefined()
      expect(yield* bindings.reserveAction(binding.sessionID, 3)).toBe(false)
      expect(yield* bindings.reserveTurn(binding.sessionID, 3)).toBe(false)
      expect(yield* bindings.get(contractID)).toMatchObject({ turnsUsed: 1, actionsUsed: 0 })
      expect(yield* contracts.history({ contractID })).toEqual(history)
      expect((yield* contracts.get(contractID))?.challenge?.evidenceHash).toBe("counterexample-a")
    }),
  )

  it.effect("diagnoses an expired execution by the original deadline instead of an infrastructure failure", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      yield* bindings.issue(input)
      yield* contracts.activate(contractID, 1, 0)
      const binding = yield* bindings.claim(contractID, 0)
      if (!binding) return yield* Effect.die("Execution was not claimed")
      yield* bindings.reschedule({
        contractID,
        revision: 1,
        promptID: binding.promptID,
        reason: "OpenCode execution failed",
        now: deadline,
        attempt: "same",
      })
      expect(yield* contracts.get(contractID)).toMatchObject({
        status: "escalated",
        escalation: { reason: "OpenCode deadline exhausted", time: deadline },
        spec: { budget: { deadline } },
      })
      expect(yield* bindings.get(contractID)).toMatchObject({ turnsUsed: 0, actionsUsed: 0 })
    }),
  )
  ;(["turn", "action"] as const).forEach((kind) => {
    it.effect(`still enforces an explicit finite ${kind} cap when the other counter is uncapped`, () =>
      Effect.gen(function* () {
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        yield* bindings.issue({
          ...input,
          spec: { ...spec, budget: kind === "turn" ? { turns: 2, deadline } : { actions: 2, deadline } },
        })
        yield* contracts.activate(contractID, 1, 0)
        const binding = yield* bindings.claim(contractID, 0)
        if (!binding) return yield* Effect.die("Count-limited execution was not claimed")
        const capped = kind === "turn" ? bindings.reserveTurn : bindings.reserveAction
        const uncapped = kind === "turn" ? bindings.reserveAction : bindings.reserveTurn

        expect(yield* capped(binding.sessionID, 1)).toBe(true)
        expect(yield* capped(binding.sessionID, 1)).toBe(true)
        expect(yield* uncapped(binding.sessionID, 1)).toBe(true)
        expect(yield* uncapped(binding.sessionID, 1)).toBe(true)
        expect(yield* uncapped(binding.sessionID, 1)).toBe(true)
        expect(yield* capped(binding.sessionID, 1)).toBe(false)
        expect(yield* bindings.get(contractID)).toMatchObject(
          kind === "turn" ? { turnsUsed: 2, actionsUsed: 3 } : { turnsUsed: 3, actionsUsed: 2 },
        )
        expect(yield* contracts.get(contractID)).toMatchObject({
          status: "escalated",
          escalation: { reason: `OpenCode ${kind} budget exhausted`, time: 1 },
        })
      }),
    )
  })
})
