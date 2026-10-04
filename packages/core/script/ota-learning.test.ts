import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { comparisonBinding, hash, opposite, OTA, subject } from "./ota-rsi"
import type { Evidence, Pair, Protocol } from "./ota-rsi"
import { Artifacts, recursiveSelections, supervise } from "./ota-supervisor"
import type { Job } from "./ota-supervisor"

const fixtures: { root: string; ota: OTA }[] = []
afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (f) => {
      f.ota.db.close()
      await fs.rm(f.root, { recursive: true, force: true })
    }),
  )
})
async function fixture(research = true, firstChange: "s" | "h" = "h") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-learning-"))
  const artifacts = new Artifacts(path.join(root, "objects"))
  const seed = {
    s: await artifacts.put(new TextEncoder().encode("s0")),
    h: await artifacts.put(new TextEncoder().encode("h0")),
  }
  const protocol: Protocol = {
    trusted: hash("fixture authority"),
    scope: "performance",
    performanceRule: "task-pareto",
    evidence: "bound-v1",
    firstChange,
    expansion: { width: 1 },
    ...(research ? { research: { proposals: 2 } } : {}),
    tests: [
      { id: "safety", total: 1 },
      ...["development", "confirmation"].flatMap((panel) =>
        ["1", "2"].map((replicate) => ({
          id: `${panel}-${replicate}`,
          total: 100,
          performance: { panel: panel as "development" | "confirmation", task: panel, replicate },
        })),
      ),
    ],
    startupMs: 60_000,
    heartbeatMs: 60_000,
    probationMs: 1000,
  }
  const ota = new OTA(path.join(root, "ota.sqlite"), protocol, seed)
  fixtures.push({ root, ota })
  return { root, ota, artifacts, seed, protocol }
}
function begin(ota: OTA, name: string, development = 60, confirmation = 49, safety = 1) {
  const state = ota.begin(ota.read().revision, ota.read().clock + 10)
  const producer = state.job!.producer ?? state.active
  const pair = { ...producer.pair, [opposite(producer.slot)]: hash(name) }
  ota.handedOff(state.revision, state.epoch, state.job!.id, state.clock + 1, hash(name + " handoff"))
  const evidence: Evidence = {
    protocol: ota.digest,
    subject: subject(pair),
    job: state.job!.id,
    binding: comparisonBinding(ota.read(), pair),
    receipt: hash(name + " comparison"),
    rows: ota.protocol.tests.map((test) => ({
      id: test.id,
      total: test.total,
      valid: true,
      passed: !test.performance ? safety : test.performance.panel === "development" ? development : confirmation,
    })),
    baseline: {
      subject: subject(state.active.pair),
      rows: ota.protocol.tests.map((test) => ({
        id: test.id,
        total: test.total,
        valid: true,
        passed: test.performance ? 50 : 1,
      })),
    },
  }
  return { state, pair, evidence }
}
function settle(ota: OTA, input: { pair: Pair; evidence: Evidence }) {
  return ota.settle(ota.read().revision, input.pair, input.evidence, ota.read().clock + 1)
}

test("a non-adopted qualified H actually becomes producer of S, without replacing the incumbent", async () => {
  const f = await fixture()
  const first = begin(f.ota, "h1")
  const rejected = settle(f.ota, first)
  expect(rejected.active.pair).toEqual(f.seed)
  expect(rejected.lineage![0].reasons).toContain("task-regressed:confirmation:confirmation")
  expect(rejected.kernel.contracts[rejected.lineage![0].researchSupport!].status).toBe("discharged")
  const second = begin(f.ota, "s1", 65, 49)
  expect(second.state.job!.producer?.pair).toEqual(first.pair)
  expect(second.state.job!.producer?.checkpoint).toBe(hash("h1 handoff"))
  expect(second.pair.h).toBe(first.pair.h)
  expect(second.pair.s).not.toBe(f.seed.s)
  const final = settle(f.ota, second)
  expect(final.active).toEqual(rejected.active)
  expect(final.epoch).toBe(1)
  expect(final.lineage!.every((node) => node.outcome === "rejected")).toBe(true)
  expect(() => f.ota.begin(final.revision, final.clock + 1)).toThrow("schedule exhausted")
})

test("a research descendant can adopt a complete pair against incumbent, not against its parent", async () => {
  const f = await fixture()
  settle(f.ota, begin(f.ota, "h1"))
  const second = begin(f.ota, "s1", 65, 55)
  expect(second.evidence.baseline.subject).toBe(subject(f.seed))
  const selected = settle(f.ota, second)
  expect(selected.active.pair).toEqual(second.pair)
  expect(selected.active.slot).toBe("s")
  expect(String(selected.kernel.contracts[selected.active.support!].spec.requires[0].contractID)).toBe(
    selected.lineage![1].evaluation!,
  )
})

test("withdrawal removes live selection/research support, not the historical comparison or unrelated acceptances", async () => {
  const f = await fixture(false)
  const a = settle(f.ota, begin(f.ota, "h1", 60, 60))
  const b = settle(f.ota, begin(f.ota, "s1", 70, 70))
  const evaluation = a.lineage![0].evaluation!
  const result = f.ota.withdrawEvaluation(b.revision, evaluation, "measurement identity was wrong", b.clock + 1)
  expect(result.kernel.contracts[evaluation].status).toBe("escalated")
  expect(result.kernel.contracts[a.active.support!].status).toBe("escalated")
  expect(result.kernel.contracts[b.active.support!].status).toBe("discharged")
  expect(result.kernel.attestations).toEqual(b.kernel.attestations)
  expect(result.active.pair).toEqual(b.active.pair)
  f.ota.withdrawEvaluation(result.revision, b.lineage![1].evaluation!, "second withdrawn", result.clock + 1)
  expect(() => f.ota.begin(f.ota.read().revision, f.ota.read().clock + 1)).toThrow("support was withdrawn")
})

test("bad safety, withdrawn research support and an exhausted frontier cannot execute as parents", async () => {
  const bad = await fixture()
  const failed = settle(bad.ota, begin(bad.ota, "bad", 70, 70, 0))
  expect(failed.lineage![0].researchSupport).toBeUndefined()
  expect(bad.ota.researchParent()).toBeUndefined()
  expect(() => bad.ota.begin(failed.revision, failed.clock + 1)).toThrow("frontier exhausted")
  const f = await fixture()
  const qualified = settle(f.ota, begin(f.ota, "h1"))
  f.ota.withdrawEvaluation(qualified.revision, qualified.lineage![0].evaluation!, "withdrawn", qualified.clock + 1)
  expect(f.ota.researchParent()).toBeUndefined()
})

test.each(["binding", "history", "parent", "active-partition"])("rejects %s rebinding atomically", async (change) => {
  const f = await fixture()
  settle(f.ota, begin(f.ota, "h1"))
  const next = begin(f.ota, "s1", 65, 55)
  if (change === "binding") next.evidence.binding = undefined
  if (change === "history") next.evidence.binding = hash("a different exposed history")
  if (change === "parent") next.evidence.baseline.subject = subject(next.state.job!.producer!.pair)
  if (change === "active-partition") {
    next.pair.h = hash("changed both producer partitions")
    next.evidence.subject = subject(next.pair)
    next.evidence.binding = comparisonBinding(f.ota.read(), next.pair)
  }
  const before = f.ota.read()
  expect(() => settle(f.ota, next)).toThrow()
  expect(f.ota.read()).toEqual(before)
})

test("a failed research producer is fenced without rolling back or poisoning the incumbent", async () => {
  const f = await fixture()
  const first = settle(f.ota, begin(f.ota, "h1"))
  const running = f.ota.begin(first.revision, first.clock + 1)
  const failed = f.ota.failResearch(running.revision, "acknowledged worker failure", running.clock + 1)
  expect(failed.active).toEqual(first.active)
  expect(failed.epoch).toBe(first.epoch)
  expect(failed.job).toBeUndefined()
  expect(failed.kernel.contracts[first.lineage![0].evaluation!].status).toBe("discharged")
  expect(failed.kernel.contracts[first.lineage![0].researchSupport!].status).toBe("escalated")
})

test("bound evidence still identifies the adoption support for the existing recursive closure", async () => {
  const f = await fixture(false)
  settle(f.ota, begin(f.ota, "h1", 60, 60))
  settle(f.ota, begin(f.ota, "s1", 70, 70))
  const progress = recursiveSelections(f.ota)
  expect(progress.valid).toBe(true)
  expect(progress.selections).toHaveLength(2)
  expect(progress.selections.at(-1)!.support).toBe(f.ota.read().active.support!)
})

test("S-first is explicit and does not require a harness modification", async () => {
  const f = await fixture(false, "s")
  const next = begin(f.ota, "s1", 60, 60)
  expect(next.pair.h).toBe(f.seed.h)
  expect(next.pair.s).not.toBe(f.seed.s)
  expect(settle(f.ota, next).active.slot).toBe("s")
})

test("the real supervisor passes producer bytes, records reasons and completes a two-proposal research schedule", async () => {
  const f = await fixture()
  const jobs: Job[] = []
  const accounting = { source: "scripted-mechanics", knownCost: "0", incomplete: false }
  const final = await supervise(f.root, f.ota, f.artifacts, {
    fingerprint: async () => f.protocol.trusted,
    fence: async () => {},
    start: async (job) => {
      jobs.push(job)
      return {
        result: Bun.write(path.join(job.output, job.mutable), jobs.length === 1 ? "h1" : "s1").then(() => undefined),
        progress: async () => 1,
        stop: async () => accounting,
      }
    },
    evaluate: async (input) => {
      const candidate = (await Bun.file(input.pair.h).text()) !== "h0"
      return {
        passed: !input.test.performance
          ? 1
          : candidate
            ? input.test.performance.panel === "development"
              ? 60
              : 49
            : 50,
        total: input.test.total,
        valid: true,
        accounting,
      }
    },
  })
  expect(final.stopped).toBe("research proposal schedule completed")
  expect(final.active.pair).toEqual(f.seed)
  expect(jobs.map((job) => job.mutable)).toEqual(["h", "s"])
  expect(await Bun.file(jobs[1].producer!.pair.h).text()).toBe("h1")
  expect(jobs[1].feedback?.reasons?.some((reason) => reason.includes("confirmation"))).toBe(false)
  expect(
    (await fs.readdir(path.join(f.root, "receipts"))).filter((name) => name.endsWith("-decision.json")),
  ).toHaveLength(2)
})

test("research S preparation rejection records the producer-relative artifact without altering incumbent", async () => {
  const f = await fixture()
  const first = settle(f.ota, begin(f.ota, "h1"))
  const next = begin(f.ota, "bad-s")
  const failed = f.ota.rejectPreparation(
    f.ota.read().revision,
    next.pair,
    "invalid UTF-8 strategy",
    hash("build diagnostics"),
    f.ota.read().clock + 1,
  )
  expect(failed.active).toEqual(first.active)
  expect(f.ota.completedProposals()).toBe(2)
  expect(f.ota.history().at(-1)).toMatchObject({
    type: "preparation-rejected",
    details: { performanceEvaluated: false, reason: "invalid UTF-8 strategy" },
  })
})

test("a research descendant cannot resample the incumbent against itself", async () => {
  const f = await fixture()
  settle(f.ota, begin(f.ota, "h1"))
  const next = begin(f.ota, "s1")
  const before = f.ota.read()
  expect(() =>
    f.ota.settle(
      before.revision,
      f.seed,
      { ...next.evidence, subject: subject(f.seed), binding: comparisonBinding(before, f.seed) },
      before.clock + 1,
    ),
  ).toThrow("unchanged incumbent")
  expect(f.ota.read()).toEqual(before)
})

test("the admitted public memory stays frozen when handoff writes the next checkpoint", async () => {
  const f = await fixture(false)
  const first = begin(f.ota, "h1", 60, 60)
  expect(f.ota.read().job!.inputMemory).toEqual({ id: "e1" })
  const accepted = settle(f.ota, first)
  const next = f.ota.begin(accepted.revision, accepted.clock + 1)
  expect(next.job!.inputMemory?.origin).toBe(hash("h1 handoff"))
  const pair = { ...next.active.pair, s: hash("s1") }
  const binding = comparisonBinding(next, pair)
  const changedContext = {
    ...next,
    job: { ...next.job!, inputMemory: { ...next.job!.inputMemory!, origin: hash("different actual prompt memory") } },
  }
  expect(comparisonBinding(changedContext, pair)).not.toBe(binding)
  f.ota.handedOff(next.revision, next.epoch, next.job!.id, next.clock + 1, hash("output summary"))
  expect(comparisonBinding(f.ota.read(), pair)).toBe(binding)
})
