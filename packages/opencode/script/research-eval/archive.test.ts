import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import { collect } from "./archive"
import { digest } from "./ledger"

test("non-delivered runs retain historical feedback, responses, admissions and job-local maps", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "research-feedback-archive-"))
  const contents = [
    "manifest",
    "old outcome",
    "old response",
    "current outcome",
    "current response",
    "plan",
    "plan map",
    "admission",
    "delivery map",
    "diagnostic experiment",
    "raw output",
    "completion basis",
    "completion proof",
  ].map((name) => JSON.stringify({ name }))
  const objects = new Map(contents.map((value) => [digest(value), value]))
  const hashes = contents.map(digest)
  const run = {
    id: "pct_archive",
    version: 2,
    stage: "cancelled",
    manifestHash: hashes[0],
    feedbackHistory: [{ phase: "plan", outcomeHash: hashes[1], responseHash: hashes[2] }],
    feedback: { phase: "delivery", outcomeHash: hashes[3], responseHash: hashes[4] },
    plan: { value: {} as ResearchModel.Plan, hash: hashes[5], referencesHash: hashes[6], admissionHash: hashes[7] },
    referencesHash: hashes[8],
    lastExperiment: {
      verificationHash: hashes[9],
      planHash: hashes[5],
      approvalHash: hashes[7],
      subjectHash: "candidate",
    },
  } as unknown as ResearchModel.Run
  const rawLinked = JSON.stringify({ name: "current outcome", rawHash: hashes[10] })
  objects.set(digest(rawLinked), rawLinked)
  const completed = JSON.stringify({
    basisHash: hashes[11],
    request: { responseHash: hashes[2], evidence: [hashes[12]] },
  })
  objects.set(digest(completed), completed)
  const current = {
    ...run,
    completionHashes: [digest(completed)],
    feedback: { ...run.feedback!, outcomeHash: digest(rawLinked) },
  }
  try {
    const collected = await collect({
      directory,
      run: current,
      command: async (action, id) => {
        if (action === "research-history")
          return [
            { version: 1, data: run },
            { version: 2, data: current },
          ]
        if (action === "operations") return []
        if (action === "research-object" && objects.has(id)) return objects.get(id)
        throw new Error("Unexpected archive command " + action + ":" + id)
      },
    })
    expect(current.bundleHash).toBeUndefined()
    expect(collected.unavailable).toEqual([])
    expect(collected.objects.toSorted()).toEqual([...objects.keys()].toSorted())
    for (const [hash, value] of objects)
      expect(await Bun.file(path.join(directory, "objects", hash)).text()).toBe(value)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
