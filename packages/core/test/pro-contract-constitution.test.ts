import { describe, expect, test } from "bun:test"

describe("ProContract constitution", () => {
  test("keeps the authority-changing kernel pure and finite", async () => {
    const source = await Bun.file(new URL("../src/pro-contract/kernel.ts", import.meta.url)).text()
    const imports = source.match(/^import .+$/gm) ?? []
    const commandSource = source.slice(source.indexOf("export type Command"), source.indexOf("export type Decision"))
    const commands = [...commandSource.matchAll(/readonly type: "([^"]+)"/g)].map((match) => match[1])

    expect(imports).toEqual([
      'import { ProContract } from "@opencode-ai/schema/pro-contract"',
      'import { Hash } from "../util/hash"',
    ])
    expect(commands).toEqual([
      "issue",
      "petition-revision",
      "decide-revision",
      "discharge",
      "activate",
      "resume",
      "challenge",
      "report-ready",
      "report-blocked",
      "escalate",
      "release",
    ])

    for (const forbidden of [
      'from "effect"',
      "Database",
      "Session",
      "Location",
      "ModelV2",
      "ProgramBench",
      "benchmark",
      "campaign",
      "score",
      "UCB",
      "MCTS",
    ])
      expect(source).not.toContain(forbidden)
  })
})
