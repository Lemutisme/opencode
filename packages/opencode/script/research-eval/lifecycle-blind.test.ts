import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { lifecycleRevealGate } from "./lifecycle-blind"
import { lifecycleDevelopment } from "./lifecycle-scenarios"
import { codeIdentity } from "./provenance"
import { finalizeScoring, sealCandidate } from "./evaluate"
import { prepare, seal } from "./blind"
import { put } from "./archive"
import { digest } from "./ledger"
import type { runInstance } from "./instance"

test("model lifecycle reveal requires all three immutable candidate seals before any trajectory exposure", async () => {
  const root = await mkdtemp("/tmp/lifecycle-seals-")
  const codeHash = await codeIdentity()
  const examples = lifecycleDevelopment()
  const cohort = JSON.stringify({
    mode: "development-calibration",
    instances: examples.map((item) => ({ id: item.packet.id })),
    configuration: {
      runner: codeHash,
      evaluation: "repair-lifecycle-v1",
      order: examples.map((item) => item.packet.id),
    },
  })
  await Bun.write(root + "/cohort.json", cohort)
  const state = { previous: digest(cohort), rows: [] as string[] }
  const fixtures = []
  for (const example of examples) {
    const directory = root + "/" + example.packet.id
    const result = {
      mode: "model",
      codeHash,
      evaluation: "repair-lifecycle-v1",
      monitored: {
        raw: "private reviewer original",
        run: { id: "pct_eval_" + example.packet.id, input: { manifest: { feedbackProtocol: "repair-lifecycle:1" } } },
      },
    } as Awaited<ReturnType<typeof runInstance>>
    const resultHash = await put(directory + "/archive", result)
    const bound = await prepare(directory + "/blind", {
      agreement: "task",
      files: { source: "candidate" },
      rawEvidence: {},
      rubric: { valid: "valid" },
    })
    const scoring = {
      ...bound,
      resultHash,
      codeHash,
      oracleHash: await put(directory + "/archive", {}),
      evaluation: "repair-lifecycle-v1",
    }
    const hash = await put(directory + "/archive", scoring)
    await Bun.write(directory + "/scoring.json", await Bun.file(directory + "/archive/objects/" + hash).text())
    await Bun.write(directory + "/scoring-ref.json", JSON.stringify({ hash }))
    const row = { previous: state.previous, id: example.packet.id, evidence: resultHash }
    state.previous = digest(JSON.stringify(row))
    state.rows.push(JSON.stringify({ ...row, hash: state.previous }))
    fixtures.push({ directory, result, annotation: { ...bound, rater: "one", items: { valid: true } } })
  }
  await Bun.write(root + "/events.jsonl", state.rows.join("\n") + "\n")
  const first = fixtures[0]
  await expect(
    sealCandidate({
      directory: first.directory,
      first: first.annotation,
      second: { ...first.annotation, rater: "two", items: { valid: false } },
    }),
  ).rejects.toThrow("adjudication")
  expect(await Bun.file(first.directory + "/blind/sealed.json").exists()).toBe(false)
  for (const [index, fixture] of fixtures.entries()) {
    await expect(lifecycleRevealGate(first.directory, first.result)).rejects.toThrow()
    for (const item of fixtures) expect(await Bun.file(item.directory + "/blind/reviewer.json").exists()).toBe(false)
    await seal(fixture.directory + "/blind", fixture.annotation, { ...fixture.annotation, rater: "two" })
    if (index === 0) {
      const before = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: first.directory + "/blind" }))
      await expect(
        finalizeScoring({
          directory: first.directory,
          first: first.annotation,
          second: { ...first.annotation, rater: "two" },
        }),
      ).rejects.toThrow()
      expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: first.directory + "/blind" }))).toEqual(before)
    }
    if (index === 2) {
      await lifecycleRevealGate(first.directory, first.result)
      await expect(
        finalizeScoring({
          directory: first.directory,
          first: first.annotation,
          second: { ...first.annotation, rater: "two", items: { valid: false } },
        }),
      ).rejects.toThrow("adjudication")
      expect(await Bun.file(first.directory + "/score.json").exists()).toBe(false)
    }
  }
  await Bun.write(fixtures[2].directory + "/blind/sealed.json", "{}")
  await expect(lifecycleRevealGate(first.directory, first.result)).rejects.toThrow()
}, 30_000)
