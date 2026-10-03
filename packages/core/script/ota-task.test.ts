import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { hash, opposite, OTA, SIX_HOURS, subject } from "./ota-rsi"
import type { Evidence, Protocol } from "./ota-rsi"

const roots: string[] = []
const databases: OTA[] = []
const seed = { s: hash("seed strategy"), h: hash("seed harness") }
const protocol: Protocol = {
  trusted: hash("host authority"),
  scope: "mechanics",
  performanceRule: "task-pareto",
  expansion: { width: 1 },
  deployment: { kind: "task", task: "task-a", started: 100, deadline: 10_000, checkpoint: hash("public task state") },
  tests: [{ id: "safety", total: 1 }],
  startupMs: 1000,
  heartbeatMs: 1000,
  probationMs: 1000,
}

afterEach(async () => {
  databases.splice(0).forEach((ota) => ota.db.close())
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture(policy = protocol) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ota-task-"))
  roots.push(root)
  const file = path.join(root, "ota.sqlite")
  const ota = new OTA(file, policy, seed)
  databases.push(ota)
  return { ota, file }
}

function continuation(ota: OTA, outcome: "revise" | "delivered" | "blocked" = "revise") {
  const now = Math.max(ota.read().clock + 10, ota.protocol.deployment?.started ?? 0)
  const begun = ota.read().job ? ota.read() : ota.begin(ota.read().revision, now)
  const handoff = {
    previous: begun.task!.checkpoint,
    checkpoint: hash(`task artifact ${begun.revision}`),
    receipt: hash(`host verification ${begun.revision}`),
    outcome,
  }
  const ready = ota.continuationReady(begun.revision, begun.epoch, begun.job!.id, now + 1)
  const state = ota.continued(ready.revision, begun.epoch, begun.job!.id, handoff, now + 2)
  return { begun, handoff, state }
}

function proposal(ota: OTA) {
  const now = ota.read().clock + 10
  const begun = ota.begin(ota.read().revision, now)
  const pair = { ...begun.active.pair, [opposite(begun.active.slot)]: hash(`proposal ${begun.revision}`) }
  const evidence: Evidence = {
    protocol: ota.digest,
    subject: subject(pair),
    job: begun.job!.id,
    receipt: hash(`evaluation ${begun.revision}`),
    ...(begun.task ? { checkpoint: begun.task.checkpoint } : {}),
    rows: [{ id: "safety", passed: 1, total: 1, valid: true }],
    baseline: { subject: subject(begun.active.pair), rows: [{ id: "safety", passed: 1, total: 1, valid: true }] },
  }
  ota.handedOff(begun.revision, begun.epoch, begun.job!.id, now + 1, hash("advisory proposer summary"))
  return { begun, pair, evidence }
}

describe("task-local RSI authority", () => {
  test.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid task revision schedule %s",
    (revisions) => {
      expect(
        () => new OTA(":memory:", { ...protocol, deployment: { ...protocol.deployment!, revisions } }, seed),
      ).toThrow("task revision schedule")
    },
  )

  test("a task revision schedule cannot be confused with recursive proposal completion", () => {
    expect(
      () =>
        new OTA(
          ":memory:",
          {
            ...protocol,
            deployment: { ...protocol.deployment!, revisions: 1 },
            completion: { selections: 1, successorHandoff: true, stopOnRejection: true },
          },
          seed,
        ),
    ).toThrow("recursive completion")
  })

  test("zero task revisions admits solving, not a forged revision handoff", async () => {
    const { ota } = await fixture({ ...protocol, deployment: { ...protocol.deployment!, revisions: 0 } })
    expect(ota.read().task!.revisions).toBe(0)
    const begun = ota.begin(0, 100)
    expect(begun.job).toMatchObject({ purpose: "continuation", allowRevise: false, deadline: 10_000 })
    expect(() => continuation(ota)).toThrow("revision schedule exhausted")
    // Failed revision validation is transactional; final task verification still works.
    const ready = ota.read()
    const completed = ota.continued(
      ready.revision,
      ready.epoch,
      ready.job!.id,
      {
        previous: ready.task!.checkpoint,
        checkpoint: hash("final output without adaptation"),
        receipt: hash("independent final grade"),
        outcome: "delivered",
      },
      ready.clock + 1,
    )
    expect(completed.task!.status).toBe("delivered")
    expect(completed.active.pair).toEqual(seed)
  })

  test.each(["selected", "qualification-rejected", "preparation-rejected"])(
    "%s spends one task revision then continues the same original task without another proposal",
    async (kind) => {
      const { ota, file } = await fixture({ ...protocol, deployment: { ...protocol.deployment!, revisions: 1 } })
      const first = continuation(ota)
      expect(first.begun.job!.allowRevise).toBe(true)
      const input = proposal(ota)
      expect(input.begun.job!.allowRevise).toBeUndefined()
      const before = ota.read()
      const state =
        kind === "preparation-rejected"
          ? ota.rejectPreparation(
              before.revision,
              input.pair,
              "build rejected",
              hash("build receipt"),
              before.clock + 1,
            )
          : ota.settle(
              before.revision,
              input.pair,
              {
                ...input.evidence,
                rows: [{ id: "safety", passed: kind === "selected" ? 1 : 0, total: 1, valid: true }],
              },
              before.clock + 1,
            )
      expect(state.task).toMatchObject({ revisions: 1, needsContinuation: true, checkpoint: first.handoff.checkpoint })
      expect(state.active.pair).toEqual(kind === "selected" ? input.pair : seed)
      expect(state.kernel.contracts[state.task!.contractID].status).toBe("active")
      const reopened = new OTA(file, ota.protocol, seed)
      databases.push(reopened)
      const next = reopened.begin(state.revision, state.clock + 1)
      expect(next.job).toMatchObject({ purpose: "continuation", allowRevise: false, deadline: 10_000 })
      const done = continuation(reopened, "delivered")
      expect(done.state.task).toMatchObject({ revisions: 1, status: "delivered" })
      expect(done.state.active.pair).toEqual(state.active.pair)
      expect(reopened.history().filter((row) => (row as { type: string }).type === "qualification")).toHaveLength(
        kind === "preparation-rejected" ? 0 : 1,
      )
    },
  )

  test("primary-improvement stopping cannot bypass task successor continuation", () => {
    expect(() => new OTA(":memory:", { ...protocol, stopOnPrimaryImprovement: true }, seed)).toThrow(
      "actual continuation",
    )
  })

  test.each([
    { task: " " },
    { started: -1 },
    { started: 100.5 },
    { deadline: 100 },
    { deadline: 99 },
    { deadline: 100.5 },
    { deadline: 100 + SIX_HOURS + 1 },
    { checkpoint: "not-a-content-identity" },
  ])("rejects invalid frozen task coordinates %j", async (changes) => {
    expect(
      () => new OTA(":memory:", { ...protocol, deployment: { ...protocol.deployment!, ...changes } }, seed),
    ).toThrow()
  })

  test("first executes the existing task before any source proposal", async () => {
    const { ota } = await fixture()
    expect(ota.read().task).toEqual({
      id: "task-a",
      contractID: expect.any(String),
      checkpoint: protocol.deployment!.checkpoint,
      needsContinuation: true,
      status: "open",
    })
    const contract = ota.read().kernel.contracts[ota.read().task!.contractID]
    expect(contract.status).toBe("active")
    expect(contract.scope).toBe(ota.digest)
    expect(contract.spec.budget).toEqual({ deadline: protocol.deployment!.deadline })
    expect(JSON.parse(contract.spec.brief!)).toEqual({
      protocol: ota.digest,
      task: "task-a",
      checkpoint: protocol.deployment!.checkpoint,
    })
    expect(() => ota.begin(0, 99)).toThrow("not started")
    const next = continuation(ota)
    expect(next.begun.job).toMatchObject({ purpose: "continuation", deadline: 10_000, phase: "running" })
    expect(next.begun.job!.source).toBeUndefined()
    expect(next.state.task).toMatchObject({
      checkpoint: next.handoff.checkpoint,
      needsContinuation: false,
      status: "open",
    })
    expect(next.state.job).toBeUndefined()
    expect(next.state.trial).toBe(false)
    expect(next.state.kernel.contracts[next.state.task!.contractID].status).toBe("active")
    expect(ota.history().at(-1)).toMatchObject({
      type: "task-continuation",
      details: { ...next.handoff, task: "task-a", pair: seed },
    })
    const proposed = proposal(ota)
    expect(proposed.begun.job!.purpose).toBeUndefined()
    expect(proposed.begun.job!.deadline).toBe(10_000)
    expect(proposed.begun.job!.source!.pair).toEqual(seed)
    expect(ota.read().active.memory.checkpoint).toBe(hash("advisory proposer summary"))
    expect(ota.read().task!.checkpoint).toBe(next.handoff.checkpoint)
  })

  test("each selected H or S must next continue the same task from its committed checkpoint", async () => {
    const { ota } = await fixture()
    const first = continuation(ota)
    const h = proposal(ota)
    const selected = ota.settle(ota.read().revision, h.pair, h.evidence, ota.read().clock + 1)
    expect(selected.task).toMatchObject({ id: "task-a", checkpoint: first.handoff.checkpoint, needsContinuation: true })
    expect(selected.trial).toBe(true)
    const second = continuation(ota)
    expect(second.begun.active.pair).toEqual(h.pair)
    expect(second.begun.job!.deadline).toBe(protocol.deployment!.deadline)
    expect(second.handoff.previous).toBe(first.handoff.checkpoint)
    expect(second.state.trial).toBe(false)
    const s = proposal(ota)
    const again = ota.settle(ota.read().revision, s.pair, s.evidence, ota.read().clock + 1)
    expect(again.active.slot).toBe("s")
    expect(again.active.pair.h).toBe(h.pair.h)
    const third = continuation(ota, "delivered")
    expect(third.begun.active.pair).toEqual(s.pair)
    expect(third.handoff.previous).toBe(second.handoff.checkpoint)
    expect(third.state.task!.status).toBe("delivered")
    const task = third.state.kernel.contracts[third.state.task!.contractID]
    expect(task.status).toBe("discharged")
    expect(task.handoff!.subjectHash).toBe(third.handoff.checkpoint)
    expect(third.state.kernel.attestations[task.attestationID!]).toMatchObject({
      contractID: third.state.task!.contractID,
      subjectHash: third.handoff.checkpoint,
      evidenceHash: third.handoff.receipt,
    })
  })

  test("a task handoff cannot be passed off as a source proposal", async () => {
    const { ota } = await fixture()
    const begun = ota.begin(0, 100)
    expect(() => ota.handedOff(begun.revision, begun.epoch, begun.job!.id, 101, hash("summary"))).toThrow(
      "continuation",
    )
    expect(ota.read()).toEqual(begun)
    expect(() => ota.rejectPreparation(begun.revision, seed, "not a patch", hash("receipt"), 101)).toThrow("proposal")
    expect(ota.read()).toEqual(begun)
  })

  test.each(["previous", "checkpoint", "receipt", "epoch", "lease"])(
    "rejects invalid continuation %s without advancing the public task state",
    async (kind) => {
      const { ota } = await fixture()
      const begun = ota.begin(0, 100)
      const handoff = {
        previous: kind === "previous" ? hash("another task") : begun.task!.checkpoint,
        checkpoint: kind === "checkpoint" ? "unsealed" : hash("next task state"),
        receipt: kind === "receipt" ? "unsealed" : hash("verification"),
        outcome: "revise" as const,
      }
      if (kind === "lease") {
        expect(() => ota.continuationReady(begun.revision, begun.epoch, begun.job!.id, 1100)).toThrow(
          "stop acknowledgement",
        )
        expect(ota.read()).toEqual(begun)
        return
      }
      const ready = ota.continuationReady(begun.revision, begun.epoch, begun.job!.id, 101)
      expect(() =>
        ota.continued(ready.revision, kind === "epoch" ? begun.epoch + 1 : begun.epoch, begun.job!.id, handoff, 102),
      ).toThrow()
      expect(ota.read()).toEqual(ready)
    },
  )

  test("ordinary proposal execution cannot advance the task checkpoint", async () => {
    const { ota } = await fixture()
    const first = continuation(ota)
    const begun = ota.begin(ota.read().revision, 200)
    expect(() => ota.continued(begun.revision, begun.epoch, begun.job!.id, first.handoff, 201)).toThrow("continuation")
    expect(ota.read()).toEqual(begun)
  })

  test("a live continuation cannot settle before acknowledged worker stop", async () => {
    const { ota } = await fixture()
    const begun = ota.begin(0, 100)
    expect(() =>
      ota.continued(
        begun.revision,
        begun.epoch,
        begun.job!.id,
        { previous: begun.task!.checkpoint, checkpoint: hash("new"), receipt: hash("grade"), outcome: "revise" },
        101,
      ),
    ).toThrow("handoff required")
    expect(ota.read()).toEqual(begun)
  })

  test("external continuation grading may exceed the stopped worker's heartbeat lease, never its deadline", async () => {
    const { ota } = await fixture()
    continuation(ota)
    const input = proposal(ota)
    ota.settle(ota.read().revision, input.pair, input.evidence, ota.read().clock + 1)
    const begun = ota.begin(ota.read().revision, 200)
    expect(begun.trial).toBe(true)
    const ready = ota.continuationReady(begun.revision, begun.epoch, begun.job!.id, 201)
    expect(ready.trial).toBe(true)
    expect(ready.job!.phase).toBe("evaluating")
    expect(ota.expired(ready, 2200)).toBe(false)
    const grade = {
      previous: ready.task!.checkpoint,
      checkpoint: hash("long verified task result"),
      receipt: hash("external grade completed without fake activity"),
      outcome: "revise" as const,
    }
    expect(() => ota.heartbeat(ready.revision, ready.epoch, ready.job!.id, 1, 2200)).toThrow("activity")
    expect(ota.read()).toEqual(ready)
    const completed = ota.continued(ready.revision, ready.epoch, ready.job!.id, grade, 2200)
    expect(completed.trial).toBe(false)
    expect(completed.task!.checkpoint).toBe(grade.checkpoint)
    expect(completed.active.pair).toEqual(input.pair)
    expect(ota.history().some((event) => (event as { type: string }).type === "activity")).toBe(false)
  })

  test("quiescent continuation cannot authorize a source proposal or be acknowledged twice", async () => {
    const { ota } = await fixture()
    const begun = ota.begin(0, 100)
    const ready = ota.continuationReady(begun.revision, begun.epoch, begun.job!.id, 101)
    expect(() => ota.continuationReady(ready.revision, ready.epoch, ready.job!.id, 102)).toThrow("acknowledgement")
    expect(() => ota.rejectPreparation(ready.revision, seed, "not a patch", hash("receipt"), 102)).toThrow(
      "source proposal",
    )
    expect(ota.read()).toEqual(ready)
  })

  test.each([undefined, hash("stale task snapshot")])(
    "evaluations must name the exact checkpoint: %s",
    async (checkpoint) => {
      const { ota } = await fixture()
      continuation(ota)
      const input = proposal(ota)
      const before = ota.read()
      expect(() =>
        ota.settle(before.revision, input.pair, { ...input.evidence, checkpoint }, before.clock + 1),
      ).toThrow("checkpoint")
      expect(ota.read()).toEqual(before)
      expect(ota.settle(before.revision, input.pair, input.evidence, before.clock + 1).active.pair).toEqual(input.pair)
    },
  )

  test.each(["preparation", "qualification"])("%s rejection preserves the committed task checkpoint", async (kind) => {
    const { ota } = await fixture()
    continuation(ota)
    const input = proposal(ota)
    const before = ota.read()
    const state =
      kind === "preparation"
        ? ota.rejectPreparation(before.revision, input.pair, "invalid source", hash("build evidence"), before.clock + 1)
        : ota.settle(
            before.revision,
            input.pair,
            { ...input.evidence, rows: [{ id: "safety", passed: 0, total: 1, valid: true }] },
            before.clock + 1,
          )
    expect(state.active.pair).toEqual(seed)
    expect(state.task).toEqual(before.task)
    expect(state.job).toBeUndefined()
    expect(ota.begin(state.revision, state.clock + 1).job!.deadline).toBe(10_000)
  })

  test.each(["delivered", "blocked"] as const)("a %s task admits no further execution", async (outcome) => {
    const { ota } = await fixture()
    const completed = continuation(ota, outcome)
    expect(completed.state.task!.status).toBe(outcome)
    expect(completed.state.kernel.contracts[completed.state.task!.contractID].status).toBe(
      outcome === "delivered" ? "discharged" : "escalated",
    )
    expect(() => ota.begin(completed.state.revision, 200)).toThrow("delivered or blocked")
    expect(ota.read()).toEqual(completed.state)
  })

  test.each(["cancelled", "recursive closure completed", "infrastructure failed"])(
    "stopping for %s escalates the unfinished original task instead of delivering it",
    async (reason) => {
      const { ota } = await fixture()
      const prior = continuation(ota)
      const stopped = ota.stop(prior.state.revision, reason, 500)
      const task = stopped.kernel.contracts[stopped.task!.contractID]
      expect(stopped.task!.status).toBe("blocked")
      expect(task.status).toBe("escalated")
      expect(task.attestationID).toBeUndefined()
      expect(task.escalation!.reason).toContain(reason)
      expect(stopped.task!.checkpoint).toBe(prior.handoff.checkpoint)
    },
  )

  test("stopping an already delivered task preserves its exact Kernel attestation", async () => {
    const { ota } = await fixture()
    const completed = continuation(ota, "delivered")
    const stopped = ota.stop(completed.state.revision, "task delivered", 500)
    expect(stopped.task!.status).toBe("delivered")
    expect(stopped.kernel).toEqual(completed.state.kernel)
  })

  test.each(["begin", "continuationReady", "continued", "settle", "rejectPreparation"])(
    "original task deadline gates %s directly",
    async (operation) => {
      const { ota } = await fixture()
      if (operation === "begin") {
        expect(() => ota.begin(0, 10_000)).toThrow("task deadline")
        expect(ota.read().revision).toBe(0)
        return
      }
      if (operation === "continuationReady") {
        const begun = ota.begin(0, 100)
        expect(() => ota.continuationReady(begun.revision, begun.epoch, begun.job!.id, 10_000)).toThrow("task deadline")
        expect(ota.read()).toEqual(begun)
        return
      }
      if (operation === "continued") {
        const begun = ota.begin(0, 100)
        const ready = ota.continuationReady(begun.revision, begun.epoch, begun.job!.id, 101)
        expect(() =>
          ota.continued(
            ready.revision,
            begun.epoch,
            begun.job!.id,
            {
              previous: begun.task!.checkpoint,
              checkpoint: hash("late output"),
              receipt: hash("late receipt"),
              outcome: "delivered",
            },
            10_000,
          ),
        ).toThrow("task deadline")
        expect(ota.read()).toEqual(ready)
        return
      }
      continuation(ota)
      const input = proposal(ota)
      const before = ota.read()
      expect(() =>
        operation === "settle"
          ? ota.settle(before.revision, input.pair, input.evidence, 10_000)
          : ota.rejectPreparation(before.revision, input.pair, "late build", hash("receipt"), 10_000),
      ).toThrow("task deadline")
      expect(ota.read()).toEqual(before)
    },
  )

  test("rollback resumes only the last committed task checkpoint, never an unacknowledged candidate output", async () => {
    const { ota } = await fixture()
    const first = continuation(ota)
    const input = proposal(ota)
    const selected = ota.settle(ota.read().revision, input.pair, input.evidence, ota.read().clock + 1)
    const running = ota.begin(selected.revision, 200)
    const rolled = ota.rollback(running.revision, "successor failed", 201)
    expect(rolled.active.pair).toEqual(seed)
    expect(rolled.task).toMatchObject({ checkpoint: first.handoff.checkpoint, needsContinuation: true })
    expect(rolled.job).toMatchObject({ purpose: "continuation", deadline: running.job!.deadline, phase: "running" })
    expect(rolled.job!.source).toBeUndefined()
    expect(rolled.kernel.contracts[selected.active.support!].status).toBe("escalated")
    expect(continuation(ota).handoff.previous).toBe(first.handoff.checkpoint)
  })

  test("rollback of a proposer restores task continuation without changing the task's committed output", async () => {
    const { ota } = await fixture()
    continuation(ota)
    const input = proposal(ota)
    ota.settle(ota.read().revision, input.pair, input.evidence, ota.read().clock + 1)
    const second = continuation(ota)
    const running = ota.begin(ota.read().revision, 200)
    expect(running.job!.source).toBeDefined()
    const rolled = ota.rollback(running.revision, "proposer failed", 201)
    expect(rolled.task!.checkpoint).toBe(second.handoff.checkpoint)
    expect(rolled.job!.purpose).toBe("continuation")
    expect(rolled.job!.source).toBeUndefined()
    expect(rolled.job!.deadline).toBe(protocol.deployment!.deadline)
  })

  test("an expired task can withdraw a failed successor but cannot receive a fresh allowance", async () => {
    const { ota } = await fixture()
    continuation(ota)
    const input = proposal(ota)
    ota.settle(ota.read().revision, input.pair, input.evidence, ota.read().clock + 1)
    const rolled = ota.rollback(ota.read().revision, "late withdrawal", 10_000)
    expect(rolled.active.pair).toEqual(seed)
    expect(rolled.task!.needsContinuation).toBe(true)
    expect(() => ota.begin(rolled.revision, 10_001)).toThrow("task deadline")
  })

  test("task-local admission is isolated from the campaign default and cannot export its evidence", async () => {
    const local = await fixture()
    const global = await fixture({ ...protocol, deployment: undefined })
    const globalBefore = global.ota.read()
    continuation(local.ota)
    const input = proposal(local.ota)
    local.ota.settle(local.ota.read().revision, input.pair, input.evidence, local.ota.read().clock + 1)
    expect(global.ota.read()).toEqual(globalBefore)
    expect(global.ota.digest).not.toBe(local.ota.digest)
    const globalInput = proposal(global.ota)
    expect(() =>
      global.ota.settle(
        global.ota.read().revision,
        globalInput.pair,
        {
          ...globalInput.evidence,
          checkpoint: input.evidence.checkpoint,
        },
        global.ota.read().clock + 1,
      ),
    ).toThrow("task evidence")
    expect(global.ota.read().active.pair).toEqual(seed)
  })

  test("task scope, deadline and committed state survive reopening and cannot be relabeled", async () => {
    const { ota, file } = await fixture()
    continuation(ota)
    const next = new OTA(file, protocol, seed)
    databases.push(next)
    expect(next.read()).toEqual(ota.read())
    const begun = next.begin(next.read().revision, 200)
    expect(begun.job!.deadline).toBe(protocol.deployment!.deadline)
    expect(() => new OTA(file, { ...protocol, deployment: undefined }, seed)).toThrow("protocol or seed changed")
    expect(() => new OTA(file, { ...protocol, deployment: { ...protocol.deployment!, task: "task-b" } }, seed)).toThrow(
      "protocol or seed changed",
    )
    expect(
      () => new OTA(file, { ...protocol, deployment: { ...protocol.deployment!, deadline: 11_000 } }, seed),
    ).toThrow("protocol or seed changed")
    expect(
      () => new OTA(file, { ...protocol, deployment: { ...protocol.deployment!, checkpoint: hash("other") } }, seed),
    ).toThrow("protocol or seed changed")
  })
})

describe("finite RSI completion protocol", () => {
  test.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid selection count %s",
    (selections) => {
      expect(
        () =>
          new OTA(
            ":memory:",
            { ...protocol, completion: { selections, successorHandoff: true, stopOnRejection: true } },
            seed,
          ),
      ).toThrow("finite completion")
    },
  )

  test.each(["lineage", "primary"])("requires explicit lineage and one stop policy: %s", (kind) => {
    expect(
      () =>
        new OTA(
          ":memory:",
          {
            ...protocol,
            completion: { selections: 2, successorHandoff: true, stopOnRejection: true },
            ...(kind === "lineage" ? { expansion: undefined } : { stopOnPrimaryImprovement: true }),
          },
          seed,
        ),
    ).toThrow("finite completion")
  })

  test("admits an explicit finite policy without changing legacy admission", async () => {
    const { ota } = await fixture({
      ...protocol,
      deployment: undefined,
      completion: { selections: 2, successorHandoff: true, stopOnRejection: true },
    })
    const begun = ota.begin(0, 100)
    expect(begun.task).toBeUndefined()
    expect(begun.job!.purpose).toBeUndefined()
    expect(begun.job!.deadline).toBe(100 + SIX_HOURS)
  })
})
