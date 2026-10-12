import { describe, expect, test } from "bun:test"
import type { ProContractInfo } from "@opencode-ai/sdk/v2"
import { loadDialogContracts } from "../../src/component/dialog-contracts"

const contract = {
  id: "pct_interactive",
  scope: "proj_test",
  revision: 1,
  specHash: "frozen",
  status: "dormant",
  issuer: "local-owner",
  spec: {
    trigger: { type: "immediate" },
    goal: "Interactive work",
    brief: "",
    requires: [],
    authority: ["filesystem.read"],
    budget: { deadline: 21_600_000 },
    evidence: { type: "principal", claim: "Inspect the exact result" },
    resolution: { maxAttempts: 1, retryDelay: 0 },
  },
} satisfies ProContractInfo

describe("Contract browsing", () => {
  test("queries project identity plus historical directory scopes without duplicates", async () => {
    const scopes: string[] = []
    const legacy = { ...contract, id: "pct_legacy", scope: "/workspace" }
    const result = await loadDialogContracts({
      scope: "proj_test",
      directory: "/workspace",
      list: async (query) => {
        scopes.push(query.scope)
        return { data: { data: query.scope === "proj_test" ? [contract] : [legacy, contract] } }
      },
    })
    expect(scopes).toEqual(["proj_test", "/workspace"])
    expect(result).toEqual([contract, legacy])
  })

  test("never falls back to an unscoped global list", async () => {
    expect(
      await loadDialogContracts({
        list: async () => {
          throw new Error("must not query")
        },
      }),
    ).toEqual([])
    const calls: string[] = []
    await loadDialogContracts({
      scope: "/workspace",
      directory: "/workspace",
      list: async (query) => {
        calls.push(query.scope)
        return { data: { data: [] } }
      },
    })
    expect(calls).toEqual(["/workspace"])
  })

  test("surfaces listing failures instead of silently hiding obligations", async () => {
    await expect(
      loadDialogContracts({ scope: "proj_test", list: async () => ({ error: new Error("unavailable") }) }),
    ).rejects.toThrow("unavailable")
  })
})
