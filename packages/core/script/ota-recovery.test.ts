import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { hash, OTA } from "./ota-rsi"
import { Artifacts, EvaluationInterrupted, supervise } from "./ota-supervisor"
import type { Driver, Job } from "./ota-supervisor"

const fixtures: { root: string; ota: OTA }[] = []
afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture) => {
      fixture.ota.db.close()
      await fs.rm(fixture.root, { recursive: true, force: true })
    }),
  )
})

test.each(["recover", "peer-cleanup", "guard-denied", "cancel", "missing-guard", "withdrawn-task"])(
  "supervisor preserves original task execution only after complete recovery checks: %s",
  async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-recovery-"))
    const artifacts = new Artifacts(path.join(root, "objects"))
    const put = (text: string) => artifacts.put(new TextEncoder().encode(text))
    const seed = { s: await put("s0"), h: await put("h0") }
    const checkpoint = await put("unchanged original task workspace")
    const receipt = await put("scripted host interruption and cleanup witness; not benchmark evidence")
    const started = Date.now()
    const ota = new OTA(
      path.join(root, "ota.sqlite"),
      {
        trusted: hash("fixture authority"),
        scope: "mechanics",
        evidence: "bound-v1",
        performanceRule: "task-pareto",
        deployment: {
          kind: "task",
          task: "original-task",
          started,
          deadline: started + 60_000,
          checkpoint,
          revisions: 2,
          recovery: "provider-unavailable",
        },
        tests: [
          { id: "first", total: 1 },
          { id: "never-start", total: 1 },
        ],
        startupMs: 60_000,
        heartbeatMs: 60_000,
        probationMs: 1000,
        evaluationConcurrency: 2,
      },
      seed,
    )
    fixtures.push({ root, ota })
    const jobs: Job[] = []
    const evaluations: string[] = []
    const accounting = { source: await artifacts.get(receipt), knownCost: null, incomplete: true }
    const driver: Driver = {
      fingerprint: async () => ota.protocol.trusted,
      fence: async () => {},
      start: async (job) => {
        jobs.push(job)
        if (job.purpose !== "continuation") await Bun.write(path.join(job.output, job.mutable), "new inactive H")
        return {
          result: Promise.resolve(),
          progress: async () => 0,
          stop: async () => accounting,
          continuation: async () => ({
            previous: job.task!.checkpoint,
            checkpoint,
            receipt,
            outcome: job.allowRevise ? "revise" : "delivered",
          }),
        }
      },
      evaluate: async (input) => {
        evaluations.push(input.test.id)
        if (input.pair.h === (await artifacts.get(seed.h))) {
          await Bun.sleep(25)
          throw new EvaluationInterrupted("provider-unavailable", receipt, accounting)
        }
        while (!input.signal.aborted) await Bun.sleep(1)
        await Bun.sleep(20)
        if (mode === "peer-cleanup") throw new Error("grader cleanup unacknowledged")
        throw new EvaluationInterrupted("peer-cancelled", receipt, accounting)
      },
      ...(mode === "missing-guard"
        ? {}
        : {
            recover: async () => {
              if (mode === "guard-denied") throw new Error("shared outage guard stopped")
              if (mode === "cancel") await Bun.write(path.join(root, "CANCEL"), "operator cancellation")
              if (mode === "withdrawn-task") ota.stop(ota.read().revision, "task withdrawn", Date.now())
            },
          }),
    }
    const state = await supervise(root, ota, artifacts, driver)
    expect(state.active.pair).toEqual(seed)
    expect(state.task!.revisions).toBe(0)
    expect(state.epoch).toBe(1)
    expect(ota.history().some((event) => JSON.stringify(event).includes('"type":"qualification"'))).toBe(false)
    expect(evaluations).not.toContain("never-start")
    if (mode === "recover") {
      expect(state.stopped).toBe("task delivered")
      expect(jobs.map((job) => job.purpose ?? "proposal")).toEqual(["continuation", "proposal", "continuation"])
      expect(jobs[2]).toMatchObject({
        allowRevise: false,
        task: { id: "original-task", checkpoint },
        deadline: started + 60_000,
      })
      expect(state.task!.adaptationClosed).toMatch(/^[a-f0-9]{64}$/)
    } else {
      expect(state.stopped).not.toBe("task delivered")
      expect(state.task!.adaptationClosed).toBeUndefined()
      expect(jobs).toHaveLength(mode === "missing-guard" ? 0 : 2)
    }
  },
)
