import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

const original = {
  flagPassword: Flag.OPENCODE_SERVER_PASSWORD,
  envPassword: process.env.OPENCODE_SERVER_PASSWORD,
}

afterEach(async () => {
  Flag.OPENCODE_SERVER_PASSWORD = original.flagPassword
  if (original.envPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = original.envPassword
  await disposeAllInstances()
  await resetDatabase()
})

function authorization() {
  return `Basic ${btoa("opencode:contract-secret")}`
}

describe("ProContract HttpApi", () => {
  test("rejects a missing dependency without leaving an execution binding", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = "contract-secret"
    process.env.OPENCODE_SERVER_PASSWORD = "contract-secret"
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const issue = (requires: unknown[], model: string) =>
        fetch(new URL("/api/contract", listener.url), {
          method: "POST",
          headers: { authorization: authorization(), "content-type": "application/json" },
          body: JSON.stringify({
            id: "pct_http_dependency",
            scope: "http",
            goal: "Run only after verified setup",
            requires,
            location: { directory: process.cwd() },
            model: { providerID: "openai", id: model },
          }),
        })
      const rejected = await issue([{ contractID: "pct_missing", revision: 1 }], "gpt-5.3-codex")

      expect(rejected.status).toBe(409)
      expect(
        (
          await fetch(new URL("/api/contract/pct_http_dependency", listener.url), {
            headers: { authorization: authorization() },
          })
        ).status,
      ).toBe(404)
      expect((await issue([], "gpt-5.4")).status).toBe(200)
    } finally {
      await listener.stop(true)
    }
  })

  test("uses the server authentication boundary for principal mutations", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = undefined
    delete process.env.OPENCODE_SERVER_PASSWORD
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const missingModel = await fetch(new URL("/api/contract", listener.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "pct_missing_model",
          scope: "http",
          goal: "Must bind an execution model",
          location: { directory: process.cwd() },
        }),
      })
      expect(missingModel.status).toBe(400)

      const response = await fetch(new URL("/api/contract", listener.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "pct_unsecured",
          scope: "http",
          goal: "Admitted by the unsecured local server",
          location: { directory: process.cwd() },
          model: { providerID: "openai", id: "gpt-5.3-codex" },
        }),
      })
      expect(response.status).toBe(200)
      const retried = await fetch(new URL("/api/contract", listener.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "pct_unsecured",
          scope: "http",
          goal: "Admitted by the unsecured local server",
          location: { directory: process.cwd() },
          model: { providerID: "openai", id: "gpt-5.3-codex" },
        }),
      })
      expect(retried.status).toBe(200)

      const forgedPetition = await fetch(new URL("/api/contract/pct_unsecured/revision", listener.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "forged", spec: {} }),
      })
      expect(forgedPetition.headers.get("content-type")).not.toContain("application/json")
      const contract = await fetch(new URL("/api/contract/pct_unsecured", listener.url))
      expect((await contract.json()).data.pendingRevision).toBeUndefined()
    } finally {
      await listener.stop(true)
    }
  })

  test("persists principal decisions and exposes frontier-relative quiescence", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = "contract-secret"
    process.env.OPENCODE_SERVER_PASSWORD = "contract-secret"
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const payload = JSON.stringify({
        id: "pct_http",
        scope: "http",
        goal: "Exercise the contract ledger",
        brief: "Preserve this handoff across future execution.",
        location: { directory: process.cwd() },
        model: { providerID: "openai", id: "gpt-5.3-codex" },
      })
      const unauthorized = await fetch(new URL("/api/contract", listener.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      })
      expect(unauthorized.status).toBe(401)

      const issued = await fetch(new URL("/api/contract", listener.url), {
        method: "POST",
        headers: { authorization: authorization(), "content-type": "application/json" },
        body: payload,
      })
      expect(issued.status).toBe(200)
      expect(await issued.json()).toMatchObject({
        data: {
          id: "pct_http",
          status: "dormant",
          spec: {
            goal: "Exercise the contract ledger",
            brief: "Preserve this handoff across future execution.",
            requires: [],
          },
        },
        execution: { contractID: "pct_http", dispatched: false },
        receipt: { frontier: 0 },
      })

      const before = await fetch(new URL("/api/contract/quiet?scope=http", listener.url), {
        headers: { authorization: authorization() },
      })
      expect(await before.json()).toMatchObject({ quiet: false, frontier: 0, outstanding: ["pct_http"] })

      const release = () =>
        fetch(new URL("/api/contract/pct_http/release", listener.url), {
          method: "POST",
          headers: { authorization: authorization(), "content-type": "application/json" },
          body: JSON.stringify({ reason: "explicit release" }),
        })
      expect((await release()).status).toBe(200)
      expect((await release()).status).toBe(409)

      const after = await fetch(new URL("/api/contract/quiet?scope=http", listener.url), {
        headers: { authorization: authorization() },
      })
      expect(await after.json()).toMatchObject({ quiet: true, frontier: 2, outstanding: [] })
    } finally {
      await listener.stop(true)
    }
  })
})
