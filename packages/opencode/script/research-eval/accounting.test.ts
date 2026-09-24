import { expect, test } from "bun:test"
import { stage } from "./accounting"
import { duration, report, type Event, type Instance } from "./ledger"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import type { ResearchModel } from "../../../sdk-next/src/research/model"

test("operation stages follow historical jobs and preserve worker work", () => {
  const runs = [
    { plan: { jobID: "old-plan" }, reviewJobID: "old-review", verifierJobID: "experiment", purpose: "experiment" },
    { plan: { jobID: "new-plan" }, reviewJobID: "new-review", verifierJobID: "final" },
  ] as ResearchModel.Run[]
  for (const [jobID, kind, expected] of [
    ["old-plan", "provider", "plan_review"],
    ["old-review", "provider", "review"],
    ["experiment", "verification", "experiment"],
    ["final", "verification", "verification"],
    [undefined, "provider", "worker"],
  ] as const)
    expect(stage({ source: { jobID }, kind } as ProContractJob.Operation, runs)).toBe(expected)
})

test("ready before deadline remains timely when external scoring and recognition finish later", () => {
  const instance: Instance = {
    id: "one",
    track: "research",
    family: "R3",
    repeat: 1,
    defective: false,
    packetHash: "a".repeat(64),
  }
  const events: Event[] = [
    { kind: "issued", at: 100, deadline: 100 + duration, contractID: "contract" },
    {
      kind: "candidate",
      at: duration + 200,
      readyAt: duration,
      scoredAt: duration + 150,
      attestedAt: duration + 190,
      hash: "candidate",
      scoreHash: "a".repeat(64),
      bundleValid: true,
      verdict: "correct",
    },
    { kind: "stopped", at: duration + 201, reason: "done" },
  ]
  const result = report([instance], new Map([[instance.id, events]]))
  expect(result.metrics.delivered.numerator).toBe(1)
  expect(result.efficiency.elapsed[0]).toMatchObject({
    researchMilliseconds: duration - 100,
    scoringMilliseconds: 150,
    recognitionMilliseconds: 40,
    externalMilliseconds: 190,
  })
})
