import { describe, expect, test } from "bun:test"

describe("ProContract constitution", () => {
  test("keeps the authority-changing kernel pure and finite", async () => {
    const source = await Bun.file(new URL("../src/pro-contract/kernel.ts", import.meta.url)).text()
    const imports = source.match(/^import .+$/gm) ?? []
    const commandSource = source.slice(source.indexOf("export type Command"), source.indexOf("export type Decision"))
    const issueSource = source.slice(
      source.indexOf('if (command.type === "issue")'),
      source.indexOf("const contract ="),
    )
    const commands = [...commandSource.matchAll(/readonly type: "([^"]+)"/g)].map((match) => match[1])

    expect(imports).toEqual([
      'import { ProContract } from "@opencode-ai/schema/pro-contract"',
      'import { Hash } from "../util/hash"',
    ])
    for (const essential of [
      "issue",
      "activate",
      "report-ready",
      "petition-revision",
      "decide-revision",
      "discharge",
      "challenge",
      "release",
    ])
      expect(commands).toContain(essential)
    expect(new Set(commands).size).toBe(commands.length)
    expect(issueSource).not.toContain("requirement.policy")
    expect(issueSource).not.toContain("spec.policy")
    expect(issueSource).not.toContain("replay.checks")
    expect(issueSource).not.toContain("replay.protected")
    expect(issueSource).not.toContain("replay.artifacts")

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

  test("keeps the executor handoff affordance operational rather than institutional", async () => {
    const source = await Bun.file(new URL("../src/tool/contract-control.ts", import.meta.url)).text()

    expect(source).toContain(
      "Hand off the active contract for independent verification. State completed checks and every known unresolved assumption; use contract_report_blocked instead when an uncertainty prevents meaningful verification.",
    )
    expect(source).not.toContain("The goal governs effort; the claim governs finality")
    expect(source).not.toContain("frozen evidence policy can adjudicate its settlement claim")
  })
})
