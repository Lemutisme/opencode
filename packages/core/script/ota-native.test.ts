import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { driver } from "./ota-opencode"
import type { Supplies } from "./ota-opencode"
import { reference } from "./ota-native"

test.skipIf(!process.env.OPENCODE_OTA_FULL_SUPPLIES || !process.env.OPENCODE_OTA_SEED_BUILD)(
  "a real isolated source-build rejection is repairable, not a fabricated benchmark failure",
  async () => {
    const supply = path.resolve(process.env.OPENCODE_OTA_FULL_SUPPLIES!)
    const seed = path.resolve(process.env.OPENCODE_OTA_SEED_BUILD!)
    const root = path.join(path.dirname(path.dirname(supply)), `rejected-build-${Date.now()}`)
    await mkdir(root, { mode: 0o700 })
    const supplies = (await Bun.file(supply).json()) as Supplies
    const parent = path.join(root, "h.json")
    const strategy = path.join(root, "s")
    const patch = path.join(root, "invalid.patch")
    await Bun.write(
      parent,
      JSON.stringify({
        kind: "opencode-release-v1",
        image: supplies.image,
        source: await reference(path.join(seed, "source.tar")),
        binary: await reference(path.join(seed, "opencode")),
        build: await reference(path.join(seed, "build.log")),
      }),
    )
    await Bun.write(strategy, "strategy")
    await Bun.write(patch, "this is not a source patch\n")
    const value = driver({
      root,
      supplies,
      authority: [],
      provider: {
        model: "gpt-5.6-sol",
        effort: "max",
        upstream: "http://127.0.0.1:1/v1",
        key: "unused",
        gateway: await reference(path.join(path.dirname(supply), "provider-gateway.py")),
        fixture: true,
      },
      task: () => {
        throw new Error("a build must not run evaluation")
      },
      grade: async () => {
        throw new Error("a build must not invent scores")
      },
    })
    try {
      const result = await value.prepare!({
        job: {
          id: "bad-source",
          epoch: 1,
          slot: "s",
          mutable: "h",
          deadline: Date.now() + 21_600_000,
          pair: { s: strategy, h: parent },
          output: root,
          memory: { id: "e1" },
        },
        proposal: patch,
        signal: new AbortController().signal,
      })
      expect(result).not.toBeInstanceOf(Uint8Array)
      expect(result).toMatchObject({ rejected: true })
      await Bun.write(
        path.join(root, "VALIDATION.json"),
        JSON.stringify({ passed: true, result, benchmarkEvaluations: 0, realModelCalls: 0 }, null, 2),
      )
    } finally {
      await value.fence()
    }
  },
  120_000,
)
