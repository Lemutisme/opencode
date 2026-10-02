import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { hash, opposite, OTA, subject } from "./ota-rsi.js"
import type { Pair, Protocol } from "./ota-rsi.js"
import {
  Artifacts,
  continuationReport,
  recursiveEvidence,
  recursiveHandoff,
  recursiveSelections,
} from "./ota-supervisor.js"
import type { Job } from "./ota-supervisor.js"

type Fixture = { root: string; artifacts: Artifacts; seed: Pair; ota: OTA }
const fixtures: Fixture[] = []
afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture) => {
      fixture.ota.db.close()
      await rm(fixture.root, { recursive: true, force: true })
    }),
  )
})

async function fixture(width = 1, task = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ota-completion-"))
  const artifacts = new Artifacts(path.join(root, "objects"))
  const seed = { s: await put(artifacts, "s0"), h: await put(artifacts, "h0") }
  const protocol: Protocol = {
    trusted: hash("mechanical qualification authority, not model evidence"),
    scope: "mechanics",
    performanceRule: "task-pareto",
    expansion: { width },
    completion: { selections: 2, successorHandoff: true, stopOnRejection: true },
    tests: [{ id: "safety", total: 1 }],
    startupMs: 60_000,
    heartbeatMs: 60_000,
    probationMs: 1,
    ...(task
      ? {
          deployment: {
            kind: "task" as const,
            task: "frozen-task",
            started: Date.now(),
            deadline: Date.now() + 60_000,
            checkpoint: await put(artifacts, "initial public task workspace"),
          },
        }
      : {}),
  }
  const ota = new OTA(path.join(root, "ota.sqlite"), protocol, seed)
  const value = { root, artifacts, seed, ota }
  fixtures.push(value)
  return value
}

function put(artifacts: Artifacts, value: string) {
  return artifacts.put(new TextEncoder().encode(value))
}

function time(ota: OTA) {
  return Math.max(Date.now(), ota.read().clock + 1)
}

async function selection(
  fixture: Fixture,
  name: string,
  options?: { passed?: boolean; foreignProducer?: boolean; operator?: boolean },
) {
  const ota = fixture.ota
  const state = ota.begin(ota.read().revision, time(ota))
  const mutable = opposite(state.active.slot)
  const proposal = await put(fixture.artifacts, name + " source proposal")
  const materialized = await put(fixture.artifacts, name + " prepared release")
  const pair = { ...state.active.pair, [mutable]: materialized }
  const receipt = await put(
    fixture.artifacts,
    JSON.stringify({
      pair,
      proposal,
      materialized,
      ...(!options?.operator
        ? {
            producer: {
              pair: options?.foreignProducer ? fixture.seed : state.active.pair,
              job: state.job!.id,
              mutable,
              outcome: "handoff",
              ...(state.task ? { task: { id: state.task.id, checkpoint: state.task.checkpoint } } : {}),
            },
          }
        : {}),
    }),
  )
  ota.handedOff(state.revision, state.epoch, state.job!.id, time(ota))
  ota.settle(
    ota.read().revision,
    pair,
    {
      protocol: ota.digest,
      subject: subject(pair),
      job: state.job!.id,
      receipt,
      ...(state.task ? { checkpoint: state.task.checkpoint } : {}),
      rows: [{ id: "safety", total: 1, passed: options?.passed === false ? 0 : 1, valid: true }],
      baseline: { subject: subject(state.active.pair), rows: [{ id: "safety", total: 1, passed: 1, valid: true }] },
    },
    time(ota),
  )
  return { pair, proposal, materialized, receipt, job: state.job!.id }
}

async function successor(fixture: Fixture) {
  const state = fixture.ota.begin(fixture.ota.read().revision, time(fixture.ota))
  const job: Job = {
    id: state.job!.id,
    epoch: state.epoch,
    deadline: state.job!.deadline,
    slot: state.active.slot,
    mutable: opposite(state.active.slot),
    pair: await fixture.artifacts.pair(state.active.pair),
    memory: state.active.memory,
    output: path.join(fixture.root, "unused"),
    ...(state.job!.purpose ? { purpose: state.job!.purpose } : {}),
    ...(state.task ? { task: { id: state.task.id, checkpoint: state.task.checkpoint } } : {}),
  }
  return {
    job,
    proposal: await put(fixture.artifacts, "h2 source proposal"),
    prepared: await put(fixture.artifacts, "h2 prepared release"),
  }
}

test("an admitted seed and a probation-clearing heartbeat are not recursive selections", async () => {
  const f = await fixture()
  const next = await successor(f)
  f.ota.heartbeat(f.ota.read().revision, next.job.epoch, next.job.id, 1, time(f.ota))
  expect(f.ota.read().trial).toBe(false)
  expect(recursiveSelections(f.ota)).toMatchObject({ valid: true, selections: [] })
  await expect(recursiveHandoff(f.ota, f.artifacts, next.job, next.proposal, next.prepared)).rejects.toThrow(
    "selection target",
  )
})

test("two qualified producer links still need the actual successor's useful handoff", async () => {
  const f = await fixture()
  const h1 = await selection(f, "h1")
  const s1 = await selection(f, "s1")
  const next = await successor(f)
  f.ota.heartbeat(f.ota.read().revision, next.job.epoch, next.job.id, 1, time(f.ota))
  expect(f.ota.read().trial).toBe(false)
  expect(recursiveSelections(f.ota).selections.map((value) => value.pair)).toEqual([h1.pair, s1.pair])
  await expect(recursiveHandoff(f.ota, f.artifacts, next.job, next.proposal, next.prepared)).rejects.toThrow(
    "active successor handoff",
  )
  f.ota.handedOff(f.ota.read().revision, next.job.epoch, next.job.id, time(f.ota))
  const before = f.ota.read()
  const proof = await recursiveHandoff(f.ota, f.artifacts, next.job, next.proposal, next.prepared)
  expect(proof.pair).toEqual(s1.pair)
  expect(proof.inactive).toEqual({ s: s1.pair.s, h: next.prepared })
  expect(proof.selections.map((value) => value.proposal)).toEqual([h1.proposal, s1.proposal])
  expect(proof).toMatchObject({ evaluated: false, promoted: false, proposal: next.proposal, prepared: next.prepared })
  expect(f.ota.read()).toEqual(before)
  expect(f.ota.read().lineage).toHaveLength(2)
})

test("a prepared proposal from a stale producer cannot close the recursive chain", async () => {
  const f = await fixture()
  await selection(f, "h1")
  await selection(f, "s1")
  const next = await successor(f)
  f.ota.handedOff(f.ota.read().revision, next.job.epoch, next.job.id, time(f.ota))
  await expect(
    recursiveHandoff(
      f.ota,
      f.artifacts,
      { ...next.job, pair: await f.artifacts.pair(f.seed) },
      next.proposal,
      next.prepared,
    ),
  ).rejects.toThrow("active successor handoff")
  await expect(
    recursiveHandoff(f.ota, f.artifacts, { ...next.job, id: "prior-job" }, next.proposal, next.prepared),
  ).rejects.toThrow("active successor handoff")
  await expect(
    recursiveHandoff(f.ota, f.artifacts, { ...next.job, purpose: "continuation" }, next.proposal, next.prepared),
  ).rejects.toThrow("active successor handoff")
})

test("an unchanged final release is not a useful prepared successor proposal", async () => {
  const f = await fixture()
  await selection(f, "h1")
  await selection(f, "s1")
  const next = await successor(f)
  f.ota.handedOff(f.ota.read().revision, next.job.epoch, next.job.id, time(f.ota))
  await expect(
    recursiveHandoff(f.ota, f.artifacts, next.job, next.proposal, f.ota.read().active.pair.h),
  ).rejects.toThrow("new prepared proposal")
})

test("a later epoch caused by rollback does not count as a successful recursive generation", async () => {
  const f = await fixture()
  await selection(f, "h1")
  const next = await successor(f)
  const state = f.ota.rollback(f.ota.read().revision, "successor boot failure", time(f.ota))
  expect(state.epoch).toBe(3)
  expect(state.trial).toBe(false)
  expect(state.job!.deadline).toBe(next.job.deadline)
  expect(recursiveSelections(f.ota)).toMatchObject({ valid: false, reason: "successor health was withdrawn" })
  await expect(recursiveEvidence(f.ota, f.artifacts)).rejects.toThrow("health was withdrawn")
})

test("selected tree descendants count qualified producers, never inactive source ancestry", async () => {
  const f = await fixture(2)
  await selection(f, "rejected sibling 1", { passed: false })
  await selection(f, "rejected sibling 2", { passed: false })
  const h1 = await selection(f, "selected descendant")
  const s1 = await selection(f, "selected strategy")
  expect(f.ota.read().lineage).toHaveLength(4)
  const proof = await recursiveEvidence(f.ota, f.artifacts)
  expect(proof.map((value) => value.root)).toEqual([f.seed, h1.pair])
  expect(proof.map((value) => value.pair)).toEqual([h1.pair, s1.pair])
})

test("operator or foreign-producer receipts cannot certify live recursive execution", async () => {
  const operator = await fixture()
  await selection(operator, "external release", { operator: true })
  expect(recursiveSelections(operator.ota).valid).toBe(true)
  await expect(recursiveEvidence(operator.ota, operator.artifacts)).rejects.toThrow("sealed producer handoff")
  const foreign = await fixture()
  await selection(foreign, "h1")
  await selection(foreign, "s1", { foreignProducer: true })
  await expect(recursiveEvidence(foreign.ota, foreign.artifacts)).rejects.toThrow("sealed producer handoff")
})

test("the completion proof rehashes the selected source proposal and prepared release", async () => {
  const f = await fixture()
  const h1 = await selection(f, "h1")
  const file = await f.artifacts.get(h1.proposal)
  await chmod(file, 0o600)
  await Bun.write(file, "modified source proposal after selection")
  await expect(recursiveEvidence(f.ota, f.artifacts)).rejects.toThrow("artifact changed")
})

test("selection and producer proofs survive reopening without a shadow completion counter", async () => {
  const f = await fixture()
  await selection(f, "h1")
  await selection(f, "s1")
  const reopened = new OTA(path.join(f.root, "ota.sqlite"), f.ota.protocol, f.seed)
  try {
    expect(recursiveSelections(reopened)).toEqual(recursiveSelections(f.ota))
    expect(await recursiveEvidence(reopened, f.artifacts)).toEqual(await recursiveEvidence(f.ota, f.artifacts))
  } finally {
    reopened.db.close()
  }
})

test("task-local recursive completion proves each checkpoint-bound producer without delivering the original task", async () => {
  const f = await fixture(1, true)
  const continueTask = async () => {
    const state = f.ota.begin(f.ota.read().revision, time(f.ota))
    expect(state.job!.purpose).toBe("continuation")
    const ready = f.ota.continuationReady(state.revision, state.epoch, state.job!.id, time(f.ota))
    f.ota.continued(
      ready.revision,
      ready.epoch,
      ready.job!.id,
      {
        previous: state.task!.checkpoint,
        checkpoint: await put(f.artifacts, `public task checkpoint from ${state.job!.id}`),
        receipt: await put(f.artifacts, `external task evidence from ${state.job!.id}`),
        outcome: "revise",
      },
      time(f.ota),
    )
  }
  await continueTask()
  const first = f.ota.read().task!.checkpoint
  await selection(f, "h1")
  await continueTask()
  const second = f.ota.read().task!.checkpoint
  await selection(f, "s1")
  await continueTask()
  const next = await successor(f)
  f.ota.handedOff(f.ota.read().revision, next.job.epoch, next.job.id, time(f.ota))
  const proof = await recursiveHandoff(f.ota, f.artifacts, next.job, next.proposal, next.prepared)
  expect(proof.selections.map((value) => value.checkpoint)).toEqual([first, second])
  expect(proof.producer.task!.checkpoint).toBe(f.ota.read().task!.checkpoint)
  const stopped = f.ota.stop(f.ota.read().revision, "recursive closure completed", time(f.ota))
  expect(stopped.task!.status).toBe("blocked")
  expect(stopped.kernel.contracts[stopped.task!.contractID].status).toBe("escalated")
  expect(stopped.kernel.contracts[stopped.task!.contractID].attestationID).toBeUndefined()
  expect(proof.selections.every((value) => stopped.kernel.contracts[value.support].status === "discharged")).toBe(true)
})

test.each(["cancel", "deadline"])(
  "continuation grading observes %s, drains its real child and discards a late report",
  async (mode) => {
    const f = await fixture()
    const acknowledgement = { stopped: false }
    const cancel = path.join(f.root, "CANCEL")
    await expect(
      continuationReport(
        { deadline: Date.now() + (mode === "deadline" ? 100 : 60_000) },
        {
          continuation: async (signal) => {
            const child = Bun.spawn(["python3", "-I", "-c", "import time; time.sleep(30)"], {
              stdout: "ignore",
              stderr: "ignore",
            })
            const stop = () => child.kill()
            signal.addEventListener("abort", stop, { once: true })
            if (mode === "cancel") await Bun.write(cancel, "cancel while the grader is active")
            await child.exited
            signal.removeEventListener("abort", stop)
            acknowledgement.stopped = true
            return { previous: hash("old"), checkpoint: hash("late"), receipt: hash("receipt"), outcome: "revise" }
          },
        },
        () => Bun.file(cancel).exists(),
      ),
    ).rejects.toThrow("cancelled or original deadline")
    expect(acknowledgement.stopped).toBe(true)
    expect(f.ota.read().revision).toBe(0)
  },
)

test("an on-time trusted continuation report is returned without inventing a task settlement", async () => {
  const f = await fixture()
  const report = {
    previous: hash("old checkpoint"),
    checkpoint: hash("new checkpoint"),
    receipt: hash("trusted grade"),
    outcome: "revise" as const,
  }
  expect(
    await continuationReport(
      { deadline: Date.now() + 60_000 },
      {
        continuation: async () => {
          const child = Bun.spawn(["python3", "-I", "-c", "print('host grader finished')"], {
            stdout: "ignore",
            stderr: "ignore",
          })
          expect(await child.exited).toBe(0)
          return report
        },
      },
      () => Bun.file(path.join(f.root, "CANCEL")).exists(),
    ),
  ).toEqual(report)
  expect(f.ota.read().revision).toBe(0)
})

test("an expired task cannot start continuation grading", async () => {
  const f = await fixture()
  const called = { value: false }
  await expect(
    continuationReport(
      { deadline: Date.now() - 1 },
      {
        continuation: async () => {
          called.value = true
          throw new Error("late grading was admitted")
        },
      },
      () => Bun.file(path.join(f.root, "CANCEL")).exists(),
    ),
  ).rejects.toThrow("original deadline")
  expect(called.value).toBe(false)
})
