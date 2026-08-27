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
  test("rejects an authority the OpenCode adapter cannot execute", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = "contract-secret"
    process.env.OPENCODE_SERVER_PASSWORD = "contract-secret"
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const rejected = await fetch(new URL("/api/contract", listener.url), {
        method: "POST",
        headers: { authorization: authorization(), "content-type": "application/json" },
        body: JSON.stringify({
          id: "pct_http_unknown_authority",
          scope: "http",
          goal: "Reject an unusable execution profile",
          authority: ["workspace.read", "workspace.execute"],
          location: { directory: process.cwd() },
          model: { providerID: "openai", id: "gpt-5.4" },
        }),
      })

      expect(rejected.status).toBe(409)
      expect(await rejected.json()).toMatchObject({ message: expect.stringContaining("workspace.read") })
      expect(
        (
          await fetch(new URL("/api/contract/pct_http_unknown_authority", listener.url), {
            headers: { authorization: authorization() },
          })
        ).status,
      ).toBe(404)
    } finally {
      await listener.stop(true)
    }
  })

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
      const rejected = await issue([{ contractID: "pct_missing", revision: 1, policy: true }], "gpt-5.3-codex")

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

  test("pre-issues evaluation before returning a delivery execution", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = "contract-secret"
    process.env.OPENCODE_SERVER_PASSWORD = "contract-secret"
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const issued = await fetch(new URL("/api/contract", listener.url), {
        method: "POST",
        headers: { authorization: authorization(), "content-type": "application/json" },
        body: JSON.stringify({
          id: "pct_http_evaluated",
          scope: "http-evaluated",
          goal: "Deliver an implementation whose behavior is independently evaluated",
          location: { directory: process.cwd() },
          model: { providerID: "openai", id: "gpt-5.4" },
          evaluation: {
            evaluatorHash: "behavior-evaluator-v1",
            deadline: Date.now() + 2 * 24 * 60 * 60 * 1_000,
          },
        }),
      })

      expect(issued.status).toBe(200)
      const body = await issued.json()
      expect(body).toMatchObject({
        data: { id: "pct_http_evaluated" },
        execution: { contractID: "pct_http_evaluated", dispatched: false },
        formationHash: expect.any(String),
        evaluation: {
          id: expect.stringMatching(/^pct_eval_/),
          status: "dormant",
          spec: { requires: [{ contractID: "pct_http_evaluated", revision: 1 }] },
        },
        receipt: { frontier: 1 },
      })
      const quiet = await fetch(new URL("/api/contract/quiet?scope=http-evaluated", listener.url), {
        headers: { authorization: authorization() },
      })
      expect(await quiet.json()).toMatchObject({
        quiet: false,
        outstanding: expect.arrayContaining(["pct_http_evaluated", body.evaluation.id]),
      })

      const omitted = await fetch(new URL("/api/contract", listener.url), {
        method: "POST",
        headers: { authorization: authorization(), "content-type": "application/json" },
        body: JSON.stringify({
          id: "pct_http_evaluated",
          scope: "http-evaluated",
          goal: "Deliver an implementation whose behavior is independently evaluated",
          location: { directory: process.cwd() },
          model: { providerID: "openai", id: "gpt-5.4" },
        }),
      })
      expect(omitted.status).toBe(409)

      const exact = await fetch(new URL("/api/contract", listener.url), {
        method: "POST",
        headers: { authorization: authorization(), "content-type": "application/json" },
        body: JSON.stringify({
          id: "pct_http_evaluated",
          scope: "http-evaluated",
          goal: "Deliver an implementation whose behavior is independently evaluated",
          location: { directory: process.cwd() },
          model: { providerID: "openai", id: "gpt-5.4" },
          evaluation: {
            evaluatorHash: "behavior-evaluator-v1",
            deadline: body.evaluation.spec.budget.deadline,
          },
        }),
      })
      expect(exact.status).toBe(200)
      expect(await exact.json()).toMatchObject({ formationHash: body.formationHash, receipt: body.receipt })
    } finally {
      await listener.stop(true)
    }
  })

  test("fails principal mutations closed when server authentication is disabled", async () => {
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
      expect(missingModel.status).toBe(401)

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
      expect(response.status).toBe(401)

      const mutations = [
        ["/api/contract/pct_missing/attestation", { evidenceHash: "forged" }],
        [
          "/api/contract/pct_missing/challenge",
          {
            revision: 1,
            subjectHash: "forged-subject",
            evidenceHash: "forged-evidence",
            disclosure: "executor",
            summary: "forged challenge",
          },
        ],
        ["/api/contract/pct_missing/revision/decision", { accept: true }],
        ["/api/contract/pct_missing/release", { reason: "forged release" }],
      ] as const
      for (const [path, body] of mutations) {
        const mutation = await fetch(new URL(path, listener.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        expect(mutation.status).toBe(401)
      }
      expect(
        (
          await fetch(new URL("/api/contract/pct_missing/resume", listener.url), {
            method: "POST",
          })
        ).status,
      ).toBe(401)

      const contracts = await fetch(new URL("/api/contract?scope=http", listener.url))
      expect(contracts.status).toBe(200)
      expect(await contracts.json()).toEqual({ data: [] })
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
        policy: "Preserve verified behavior in future Contracts",
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
            policy: "Preserve verified behavior in future Contracts",
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
