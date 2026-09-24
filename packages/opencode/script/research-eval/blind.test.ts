import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepare, seal, unseal } from "./blind"

test("candidate judgment is immutable before reviewer unsealing and preserves independent disagreement", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "research-blind-"))
  try {
    const bound = await prepare(directory, {
      agreement: "Original task",
      files: { "report.json": "candidate" },
      rawEvidence: { "data.json": "observations" },
      rubric: { conclusion: "supported by observations" },
    })
    await expect(unseal(directory, '{"verdict":"accept"}')).rejects.toThrow()
    const first = { ...bound, rater: "rater-one", items: { conclusion: true } }
    const second = { ...bound, rater: "rater-two", items: { conclusion: false } }
    expect((await seal(directory, first, second)).verdict).toBe("indeterminate")
    await expect(seal(directory, first, { ...second, items: { conclusion: true } })).rejects.toThrow()
    expect((await unseal(directory, '{"verdict":"accept"}')).phaseOne.verdict).toBe("indeterminate")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
