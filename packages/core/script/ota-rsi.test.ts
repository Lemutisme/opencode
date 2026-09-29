import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { hash, OTA, qualify, SIX_HOURS, subject } from "./ota-rsi.js"
import type { Evidence, Pair, Protocol } from "./ota-rsi.js"

const temporary: string[] = []
const databases: OTA[] = []
afterEach(async () => {
  databases.splice(0).forEach((ota) => ota.db.close())
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const seed = { s: hash("strategy0"), h: hash("harness0") }
const protocol: Protocol = {
  trusted: hash("fixed kernel/runtime/driver/evaluator"),
  scope: "mechanics",
  minimumMeanGainBps: 200,
  tests: [
    { id: "kernel", total: 50 },
    { id: "task/a", total: 200 },
    { id: "task/b", total: 200 },
  ],
  startupMs: 1_000,
  heartbeatMs: 500,
  probationMs: 1_000,
}

async function fixture(policy = protocol) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ota-rsi-"))
  temporary.push(directory)
  const file = path.join(directory, "authority.sqlite")
  const ota = new OTA(file, policy, seed)
  databases.push(ota)
  return { ota, file }
}

function proposal(ota: OTA, now = 100, checkpoint?: string) {
  const begun = ota.begin(ota.read().revision, now)
  ota.handedOff(begun.revision, begun.epoch, begun.job!.id, now + 1, checkpoint)
  const pair = { ...begun.active.pair, [begun.active.slot === "s" ? "h" : "s"]: hash(`next-${begun.epoch}`) }
  const evidence: Evidence = {
    protocol: ota.digest,
    subject: subject(pair),
    job: begun.job!.id,
    receipt: hash("host evaluation and accounting"),
    rows: ota.protocol.tests.map((test) => ({ id: test.id, total: test.total, passed: test.total, valid: true })),
    baseline: {
      subject: subject(begun.active.pair),
      rows: ota.protocol.tests.map((test) => ({ id: test.id, total: test.total, passed: test.total, valid: true })),
    },
  }
  return { pair, evidence }
}

describe("fixed Kernel OTA authority", () => {
  test("memory lineage rolls back to the sealed parent, never the migrated trial", async () => {
    const { ota } = await fixture()
    const input = proposal(ota, 100, hash("sealed memory"))
    ota.settle(ota.read().revision, input.pair, input.evidence, 102)
    expect(ota.read().active.memory).toEqual({ id: "e2", parent: "e1", origin: hash("sealed memory") })
    ota.rollback(ota.read().revision, "bad migration", 103)
    expect(ota.read().active.memory).toEqual({ id: "e3", parent: "e1", origin: hash("sealed memory") })
  })

  test("a rejected build retains the active partition and permits another proposal, without inventing scores", async () => {
    const { ota } = await fixture()
    const input = proposal(ota)
    const rejected = ota.rejectPreparation(ota.read().revision, input.pair, "syntax error", hash("build log"), 102)
    expect(rejected.active.pair).toEqual(seed)
    expect(rejected.epoch).toBe(1)
    expect(Object.values(rejected.kernel.contracts)[0].status).toBe("escalated")
    expect(ota.history().at(-1)).toMatchObject({ details: { performanceEvaluated: false } })
    expect(ota.begin(rejected.revision, 103).job).toBeDefined()
  })
  test("S changes only H, then H changes only S; qualification and switch are atomic", async () => {
    const { ota } = await fixture()
    const h = proposal(ota)
    const switched = ota.settle(ota.read().revision, h.pair, h.evidence, 102)
    expect(switched.active.slot).toBe("h")
    expect(switched.active.pair.s).toBe(seed.s)
    expect(switched.trial).toBe(true)
    expect(switched.kernel.contracts[switched.active.support!].status).toBe("discharged")
    const s = proposal(ota, 200)
    const again = ota.settle(ota.read().revision, s.pair, s.evidence, 202)
    expect(again.active.slot).toBe("s")
    expect(again.active.pair.h).toBe(h.pair.h)
    expect(Object.keys(again.kernel.attestations)).toHaveLength(2)
  })

  test("even 99.5% SAFETY pass does not switch; failed evidence remains negative", async () => {
    const { ota } = await fixture()
    const input = proposal(ota)
    input.evidence.rows[1].passed = 199
    const result = ota.settle(ota.read().revision, input.pair, input.evidence, 102)
    expect(result.active).toMatchObject({ slot: "s", pair: seed })
    expect(Object.values(result.kernel.contracts)[0].status).toBe("escalated")
    expect(result.job).toBeUndefined()
  })

  test.each(["missing", "duplicate", "foreign", "denominator", "rounded", "extra", "job"])(
    "rejects %s evidence without changing active state",
    async (kind) => {
      const { ota } = await fixture()
      const input = proposal(ota)
      if (kind === "missing") input.evidence.rows.pop()
      if (kind === "duplicate") input.evidence.rows[2] = input.evidence.rows[1]
      if (kind === "foreign") input.evidence.subject = hash("another pair")
      if (kind === "denominator") input.evidence.rows[1].total = 199
      if (kind === "rounded") input.evidence.rows[1].passed = 199.999
      if (kind === "extra") input.evidence.rows.push({ id: "invented", total: 1, passed: 1, valid: true })
      if (kind === "job") input.evidence.job = "stale-job"
      const before = ota.read()
      expect(() => ota.settle(before.revision, input.pair, input.evidence, 102)).toThrow()
      expect(ota.read()).toEqual(before)
    },
  )

  test("invalid evaluator run cannot authorize promotion", async () => {
    const { ota } = await fixture()
    const input = proposal(ota)
    input.evidence.rows[2].valid = false
    expect(() => ota.settle(ota.read().revision, input.pair, input.evidence, 102)).toThrow("incomplete")
    expect(ota.read().active.pair).toEqual(seed)
  })

  test.each(["active", "both", "neither"])("rejects mutation of %s partitions", async (kind) => {
    const { ota } = await fixture()
    const input = proposal(ota)
    const pair: Pair = kind === "neither" ? seed : { s: hash("changed"), h: kind === "both" ? input.pair.h : seed.h }
    input.evidence.subject = subject(pair)
    expect(() => ota.settle(ota.read().revision, pair, input.evidence, 102)).toThrow("inactive")
  })

  test("boot timeout rolls back the exact pair, challenges standing, and preserves attestation", async () => {
    const { ota } = await fixture()
    const input = proposal(ota)
    const accepted = ota.settle(ota.read().revision, input.pair, input.evidence, 102)
    const running = ota.begin(accepted.revision, 200)
    expect(ota.expired(running, 1_199)).toBe(false)
    expect(ota.expired(running, 1_200)).toBe(true)
    const result = ota.rollback(running.revision, "no progress", 1_200)
    expect(result.active.pair).toEqual(seed)
    expect(result.active.slot).toBe("s")
    expect(result.job!.deadline).toBe(running.job!.deadline)
    expect(result.kernel.contracts[accepted.active.support!].status).toBe("escalated")
    expect(Object.keys(result.kernel.attestations)).toHaveLength(1)
    expect(result.epoch).toBeGreaterThan(running.epoch)
    expect(() => ota.heartbeat(result.revision, running.epoch, running.job!.id, 999, 1_201)).toThrow("stale")
  })

  test("repeated activity cannot keep a dead lease alive", async () => {
    const { ota } = await fixture()
    const begun = ota.begin(0, 100)
    const first = ota.heartbeat(begun.revision, begun.epoch, begun.job!.id, 3, 110)
    expect(() => ota.heartbeat(first.revision, first.epoch, first.job!.id, 3, 120)).toThrow("replayed")
    expect(() => ota.heartbeat(first.revision, first.epoch, first.job!.id, 4, 610)).toThrow("lease")
    expect(ota.expired(first, 610)).toBe(true)
  })

  test("healthy probation does not disable later watchdog rollback", async () => {
    const { ota } = await fixture()
    const input = proposal(ota)
    ota.settle(ota.read().revision, input.pair, input.evidence, 102)
    const begun = ota.begin(ota.read().revision, 200)
    ;[300, 700, 1_100, 1_500].forEach((now, sequence) => {
      ota.heartbeat(ota.read().revision, begun.epoch, begun.job!.id, sequence, now)
    })
    expect(ota.read().trial).toBe(false)
    expect(ota.expired(ota.read(), 2_000)).toBe(true)
    expect(ota.rollback(ota.read().revision, "late hang", 2_000).active.pair).toEqual(seed)
  })

  test("original deadline and backwards-clock guards survive restart", async () => {
    const { ota, file } = await fixture()
    const state = ota.begin(0, 100)
    const reopened = new OTA(file, protocol, seed)
    databases.push(reopened)
    expect(reopened.read().job!.deadline).toBe(100 + SIX_HOURS)
    expect(() => reopened.heartbeat(state.revision, state.epoch, state.job!.id, 0, 99)).toThrow("backwards")
    expect(() => reopened.handedOff(state.revision, state.epoch, state.job!.id, 100 + SIX_HOURS)).toThrow("deadline")
  })

  test("two connections cannot commit against the same revision", async () => {
    const { ota, file } = await fixture()
    const peer = new OTA(file, protocol, seed)
    databases.push(peer)
    ota.begin(0, 100)
    expect(() => peer.begin(0, 100)).toThrow("stale supervisor")
    expect(peer.history()).toHaveLength(2)
  })

  test("fixed protocol cannot be changed across restart or through object mutation", async () => {
    const { ota, file } = await fixture()
    expect(() => new OTA(file, { ...protocol, minimumMeanGainBps: 100 }, seed)).toThrow("protocol or seed changed")
    expect(() => new OTA(file, { ...protocol, tests: protocol.tests.slice(0, 1) }, seed)).toThrow(
      "protocol or seed changed",
    )
    ota.protocol.heartbeatMs += 1
    expect(() => ota.begin(0, 100)).toThrow("protocol changed")
  })

  test("idle/evaluation is not a dead worker; cancellation persists", async () => {
    const { ota } = await fixture()
    expect(ota.expired(ota.read(), 1_000_000)).toBe(false)
    proposal(ota)
    expect(ota.expired(ota.read(), 1_000_000)).toBe(false)
    ota.stop(ota.read().revision, "cancelled", 102)
    expect(() => ota.begin(ota.read().revision, 103)).toThrow("cancelled")
  })

  test("quarantined failed pair cannot immediately ping-pong back into service", async () => {
    const { ota } = await fixture()
    const input = proposal(ota)
    ota.settle(ota.read().revision, input.pair, input.evidence, 102)
    ota.rollback(ota.read().revision, "failed boot", 103)
    const retry = proposal(ota, 200)
    expect(() =>
      ota.settle(ota.read().revision, input.pair, { ...retry.evidence, subject: subject(input.pair) }, 202),
    ).toThrow("quarantined")
  })
})

describe("OTA full-pass-first performance gate", () => {
  const performance: Protocol = {
    ...protocol,
    scope: "performance",
    tests: [
      protocol.tests[0],
      ...(["development", "confirmation"] as const).flatMap((panel) =>
        ["0", "1"].map((replicate) => ({
          id: `${panel}/${replicate}`,
          total: 200,
          performance: { panel, task: "task", replicate },
        })),
      ),
    ],
  }

  const pareto: Protocol = { ...performance, performanceRule: "task-pareto", minimumMeanGainBps: undefined }

  test("task-pareto accepts exact positive growth even below one basis point and with a tied confirmation panel", async () => {
    const { ota } = await fixture({
      ...pareto,
      tests: pareto.tests.map((test) => (test.performance ? { ...test, total: 1_000_000_000 } : test)),
    })
    const input = proposal(ota)
    input.evidence.baseline.rows.slice(1).forEach((row) => {
      row.passed = 500_000_000
    })
    input.evidence.rows.slice(1).forEach((row) => {
      row.passed = 500_000_000
    })
    input.evidence.rows[1].passed += 1
    const decision = qualify(ota.protocol, ota.digest, input.pair, input.evidence)
    expect(decision.eligible).toBe(true)
    expect(decision.primaryImproved).toBe(false)
    expect(decision.panels[0].meanGainExact).toEqual(["1", "2000000000"])
    expect(decision.panels[1].improved).toBe(false)
    expect(ota.settle(ota.read().revision, input.pair, input.evidence, 102).active.slot).toBe("h")
  })

  test.each([150, 200])("task-pareto rejects all ties, including all-full panels (%i)", async (passed) => {
    const { ota } = await fixture(pareto)
    const input = proposal(ota)
    input.evidence.baseline.rows.slice(1).forEach((row) => {
      row.passed = passed
    })
    input.evidence.rows.slice(1).forEach((row) => {
      row.passed = passed
    })
    expect(ota.settle(ota.read().revision, input.pair, input.evidence, 102).active.pair).toEqual(seed)
  })

  test.each([180, 200])(
    "task-pareto cannot hide a task decline with another task's gain or new full pass (%i)",
    async (passed) => {
      const { ota } = await fixture({
        ...pareto,
        tests: pareto.tests.flatMap((test) =>
          test.performance
            ? [test, { ...test, id: test.id + "/other", performance: { ...test.performance, task: "other" } }]
            : [test],
        ),
      })
      const input = proposal(ota)
      input.evidence.baseline.rows.slice(1).forEach((row) => {
        row.passed = 150
      })
      input.evidence.rows.slice(1).forEach((row) => {
        row.passed = row.id.endsWith("/other") ? passed : 149
      })
      const decision = qualify(ota.protocol, ota.digest, input.pair, input.evidence)
      expect(decision.panels.every((panel) => panel.meanGain > 0)).toBe(true)
      expect(decision.panels[0].regressed).toEqual(["development:task"])
      expect(decision.eligible).toBe(false)
      expect(decision.primaryImproved).toBe(false)
      expect(ota.settle(ota.read().revision, input.pair, input.evidence, 102).active.pair).toEqual(seed)
    },
  )

  test("task-pareto compares each task's replicate mean, not individual stochastic replicates", async () => {
    const { ota } = await fixture(pareto)
    const input = proposal(ota)
    input.evidence.baseline.rows.slice(1).forEach((row) => {
      row.passed = 150
    })
    input.evidence.rows.slice(1).forEach((row) => {
      row.passed = row.id.endsWith("/0") ? 149 : 153
    })
    expect(qualify(ota.protocol, ota.digest, input.pair, input.evidence).eligible).toBe(true)
  })

  test.each(["safety", "retained-full", "required-full", "invalid"])(
    "task-pareto retains the %s guard",
    async (kind) => {
      const { ota } = await fixture({ ...pareto, requiredFull: kind === "required-full" ? ["development:task"] : [] })
      const input = proposal(ota)
      input.evidence.baseline.rows.slice(1).forEach((row) => {
        row.passed = 150
      })
      input.evidence.rows.slice(1).forEach((row) => {
        row.passed = 190
      })
      if (kind === "safety") input.evidence.rows[0].passed -= 1
      if (kind === "invalid") {
        input.evidence.rows[1].valid = false
        expect(() => qualify(ota.protocol, ota.digest, input.pair, input.evidence)).toThrow("incomplete")
        return
      }
      expect(
        qualify(
          ota.protocol,
          ota.digest,
          input.pair,
          input.evidence,
          kind === "retained-full" ? ["development:task"] : [],
        ).eligible,
      ).toBe(false)
    },
  )

  test("task-pareto is a new frozen rule, never a zero sentinel or a hot protocol replacement", async () => {
    const { file } = await fixture(performance)
    expect(() => new OTA(file, { ...pareto, minimumMeanGainBps: 0 }, seed)).toThrow("strict growth")
    expect(() => new OTA(file, pareto, seed)).toThrow("protocol or seed changed")
  })

  test("a required historical full pass cannot be traded for mean gain or called a new gain", async () => {
    const policy = { ...performance, requiredFull: ["development:task", "confirmation:task"] }
    const { ota } = await fixture(policy)
    const input = proposal(ota)
    input.evidence.baseline.rows.slice(1).forEach((row) => {
      row.passed = 150
    })
    const all = qualify(policy, ota.digest, input.pair, input.evidence)
    expect(all.eligible).toBe(true)
    expect(all.primaryImproved).toBe(false)
    input.evidence.rows[1].passed = 199
    expect(qualify(policy, ota.digest, input.pair, input.evidence).eligible).toBe(false)
  })

  test("control full passes are remembered even when the candidate is rejected", async () => {
    const { ota } = await fixture(performance)
    const input = proposal(ota)
    input.evidence.rows[1].passed = 190
    const rejected = ota.settle(ota.read().revision, input.pair, input.evidence, 102)
    expect(rejected.retainedFull).toEqual(["development:task", "confirmation:task"])
    expect(rejected.active.slot).toBe("s")
  })

  test.each([100, 200])(
    "a paired gain at the %i bps threshold can switch, without claiming primary improvement",
    async (margin) => {
      const policy = { ...performance, minimumMeanGainBps: margin }
      const { ota } = await fixture(policy)
      const input = proposal(ota)
      input.evidence.baseline.rows.slice(1).forEach((row) => {
        row.passed = 150
      })
      input.evidence.rows.slice(1).forEach((row) => {
        row.passed = 150 + margin / 50
      })
      const decision = qualify(policy, ota.digest, input.pair, input.evidence)
      expect(decision.eligible).toBe(true)
      expect(decision.primaryImproved).toBe(false)
      expect(decision.allFull).toBe(false)
      expect(decision.panels.map((panel) => panel.meanGainExact)).toEqual([
        ["1", String(10_000 / margin)],
        ["1", String(10_000 / margin)],
      ])
      expect(ota.settle(ota.read().revision, input.pair, input.evidence, 102).active.slot).toBe("h")
    },
  )

  test.each([100, 200])("a gain below %i bps cannot switch", async (margin) => {
    const { ota } = await fixture({ ...performance, minimumMeanGainBps: margin })
    const input = proposal(ota)
    input.evidence.baseline.rows.slice(1).forEach((row) => {
      row.passed = 150
    })
    input.evidence.rows.slice(1).forEach((row) => {
      row.passed = 149 + margin / 50
    })
    expect(ota.settle(ota.read().revision, input.pair, input.evidence, 102).active.pair).toEqual(seed)
  })

  test.each(["too-small", "confirmation-regression", "safety-failure", "lost-full", "old-baseline"])(
    "does not switch on %s",
    async (kind) => {
      const { ota } = await fixture(performance)
      const input = proposal(ota)
      input.evidence.baseline.rows.slice(1).forEach((row) => {
        row.passed = 150
      })
      input.evidence.rows.slice(1).forEach((row) => {
        row.passed = 190
      })
      if (kind === "too-small")
        input.evidence.rows.slice(1).forEach((row) => {
          row.passed = 153
        })
      if (kind === "confirmation-regression")
        input.evidence.rows.slice(3).forEach((row) => {
          row.passed = 149
        })
      if (kind === "safety-failure") input.evidence.rows[0].passed -= 1
      if (kind === "lost-full")
        input.evidence.baseline.rows.slice(1, 3).forEach((row) => {
          row.passed = 200
        })
      if (kind === "old-baseline") input.evidence.baseline.subject = hash("not the active pair")
      if (kind === "old-baseline") {
        expect(() => ota.settle(ota.read().revision, input.pair, input.evidence, 102)).toThrow("current pair")
        return
      }
      expect(ota.settle(ota.read().revision, input.pair, input.evidence, 102).active.pair).toEqual(seed)
    },
  )

  test("new robust full pass takes priority over mean margin; already-full confirmation can tie", async () => {
    const { ota } = await fixture(performance)
    const input = proposal(ota)
    input.evidence.baseline.rows.slice(1, 3).forEach((row) => {
      row.passed = 199
    })
    const decision = qualify(performance, ota.digest, input.pair, input.evidence)
    expect(decision.primaryImproved).toBe(true)
    expect(decision.eligible).toBe(true)
    expect(decision.allFull).toBe(true)
    const state = ota.settle(ota.read().revision, input.pair, input.evidence, 102)
    expect(new Set(state.retainedFull)).toEqual(new Set(["development:task", "confirmation:task"]))
  })

  test("a noisy low parent rerun does not erase a previously established full pass", async () => {
    const { ota } = await fixture(performance)
    const input = proposal(ota)
    input.evidence.baseline.rows.slice(1).forEach((row) => {
      row.passed = 150
    })
    input.evidence.rows.slice(1).forEach((row) => {
      row.passed = 190
    })
    expect(qualify(performance, ota.digest, input.pair, input.evidence, ["development:task"]).eligible).toBe(false)
  })

  test("a single successful replicate is not a robust full pass", async () => {
    const { ota } = await fixture(performance)
    const input = proposal(ota)
    input.evidence.baseline.rows.slice(1).forEach((row) => {
      row.passed = 150
    })
    input.evidence.rows[2].passed = 190
    input.evidence.rows[4].passed = 190
    expect(qualify(performance, ota.digest, input.pair, input.evidence).primaryImproved).toBe(false)
  })

  test("performance scope cannot silently omit confirmation or replicas", async () => {
    const { file } = await fixture()
    expect(() => new OTA(file, { ...performance, tests: performance.tests.slice(0, 3) }, seed)).toThrow("confirmation")
    expect(
      () => new OTA(file, { ...performance, tests: performance.tests.filter((test) => !test.id.endsWith("/1")) }, seed),
    ).toThrow("two distinct")
  })
})
