import { afterEach, describe, expect, test } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { ProContractGroup } from "@opencode-ai/protocol/groups/pro-contract"
import { ServerAuth } from "@opencode-ai/server/auth"
import { ProContractHandler } from "@opencode-ai/server/handlers/pro-contract"
import { authorizationLayer, principalAuthorizationLayer } from "@opencode-ai/server/middleware/authorization"
import { schemaErrorLayer } from "@opencode-ai/server/middleware/schema-error"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  HttpRouter.serve(
    HttpApiBuilder.layer(HttpApi.make("server").add(ProContractGroup)).pipe(
      Layer.provide(ProContractHandler),
      Layer.provide([authorizationLayer, principalAuthorizationLayer, schemaErrorLayer]),
      Layer.provide(ServerAuth.Config.configLayer({ password: Option.some("contract-secret"), username: "opencode" })),
      Layer.provide(SessionExecution.noopLayer),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(
      LayerNode.compile(LayerNode.group([ProContract.node, ProContractOpenCode.node]), [
        [Database.node, Database.layerFromPath(":memory:")],
      ]),
    ),
  ),
)

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
  it.live("rejects a delayed attestation for a replaced handoff without recording evidence", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const now = yield* Clock.currentTimeMillis
      const contractID = ProContract.ID.make("pct_http_stale_attestation")
      yield* contracts.issue({
        id: contractID,
        scope: "http",
        spec: ProContract.defaultSpec("Verify the exact delivered candidate", now),
        executor: "opencode",
      })
      expect((yield* contracts.activate(contractID, 1, now)).decision.type).toBe("accepted")
      expect(
        (yield* contracts.reportReady({
          contractID,
          revision: 1,
          summary: "Candidate A",
          uncertainties: [],
          subjectHash: "subject-a",
          time: now,
        })).decision.type,
      ).toBe("accepted")

      const response = yield* HttpClientRequest.get(`/api/contract/${contractID}`).pipe(
        HttpClientRequest.setHeader("authorization", authorization()),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      const first = Schema.decodeUnknownSync(Schema.Struct({ data: ProContract.Info }))(yield* response.json)
      if (!first.data.handoff) return yield* Effect.die("Candidate A was not handed off")
      const captured = {
        revision: first.data.revision,
        specHash: first.data.specHash,
        subjectHash: first.data.handoff.subjectHash,
        evidenceHash: "external-evaluation-a",
      }

      const challenge = yield* HttpClientRequest.post(`/api/contract/${contractID}/challenge`).pipe(
        HttpClientRequest.setHeader("authorization", authorization()),
        HttpClientRequest.bodyJsonUnsafe({
          revision: captured.revision,
          subjectHash: captured.subjectHash,
          evidenceHash: "counterexample-a",
          disclosure: "executor",
          summary: "Candidate A needs correction",
        }),
        HttpClient.execute,
      )
      expect(challenge.status).toBe(200)
      expect((yield* contracts.activate(contractID, 1, now)).decision.type).toBe("accepted")
      expect(
        (yield* contracts.reportReady({
          contractID,
          revision: 1,
          summary: "Candidate B",
          uncertainties: [],
          subjectHash: "subject-b",
          time: now,
        })).decision.type,
      ).toBe("accepted")
      const current = yield* contracts.get(contractID)
      if (!current?.handoff) return yield* Effect.die("Candidate B was not handed off")
      expect(current).toMatchObject({ status: "verification", handoff: { subjectHash: "subject-b" } })

      const attest = HttpClientRequest.post(`/api/contract/${contractID}/attestation`).pipe(
        HttpClientRequest.setHeader("authorization", authorization()),
      )
      const incomplete = yield* attest.pipe(
        HttpClientRequest.bodyJsonUnsafe({ evidenceHash: captured.evidenceHash }),
        HttpClient.execute,
      )
      expect(incomplete.status).toBe(400)
      expect(yield* contracts.get(contractID)).toEqual(current)

      const stale = yield* attest.pipe(HttpClientRequest.bodyJsonUnsafe(captured), HttpClient.execute)
      expect(stale.status).toBe(409)
      expect(yield* stale.json).toMatchObject({ message: "attestation subject does not match" })
      expect(yield* contracts.get(contractID)).toEqual(current)
      const rejected = (yield* contracts.history({ contractID })).at(-1)
      expect(rejected).toMatchObject({
        command: { type: "discharge", attestation: captured },
        decision: { type: "rejected", reason: "attestation subject does not match" },
      })
      if (rejected?.command.type !== "discharge") return yield* Effect.die("Rejection was not audited")
      expect(yield* contracts.getAttestation(rejected.command.attestation.id)).toBeUndefined()
      expect((yield* contracts.quiet("http")).quiet).toBe(false)

      const accepted = yield* attest.pipe(
        HttpClientRequest.bodyJsonUnsafe({
          revision: current.revision,
          specHash: current.specHash,
          subjectHash: current.handoff.subjectHash,
          evidenceHash: "external-evaluation-b",
        }),
        HttpClient.execute,
      )
      expect(accepted.status).toBe(200)
      const discharged = yield* contracts.get(contractID)
      expect(discharged?.status).toBe("discharged")
      if (!discharged?.attestationID) return yield* Effect.die("Accepted evidence was not recorded")
      expect(yield* contracts.getAttestation(discharged.attestationID)).toMatchObject({
        contractID,
        revision: current.revision,
        specHash: current.specHash,
        subjectHash: current.handoff.subjectHash,
        evidenceHash: "external-evaluation-b",
      })
      expect((yield* contracts.quiet("http")).quiet).toBe(true)
    }),
  )

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
        [
          "/api/contract/pct_missing/attestation",
          { revision: 1, specHash: "forged-spec", subjectHash: "forged-subject", evidenceHash: "forged" },
        ],
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
        executionPolicy: "Preserve verified behavior in future Contracts",
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
        execution: {
          contractID: "pct_http",
          executionPolicy: "Preserve verified behavior in future Contracts",
          dispatched: false,
        },
        receipt: { frontier: 0 },
      })
      const legacyRetry = await fetch(new URL("/api/contract", listener.url), {
        method: "POST",
        headers: { authorization: authorization(), "content-type": "application/json" },
        body: JSON.stringify({
          id: "pct_http",
          scope: "http",
          goal: "Exercise the contract ledger",
          policy: "Preserve verified behavior in future Contracts",
          brief: "Preserve this handoff across future execution.",
          location: { directory: process.cwd() },
          model: { providerID: "openai", id: "gpt-5.3-codex" },
        }),
      })
      expect(legacyRetry.status).toBe(200)
      const conflictingPolicy = await fetch(new URL("/api/contract", listener.url), {
        method: "POST",
        headers: { authorization: authorization(), "content-type": "application/json" },
        body: JSON.stringify({
          id: "pct_http_conflict",
          scope: "http",
          goal: "Reject ambiguous execution policy",
          executionPolicy: "Policy A",
          policy: "Policy B",
          location: { directory: process.cwd() },
          model: { providerID: "openai", id: "gpt-5.3-codex" },
        }),
      })
      expect(conflictingPolicy.status).toBe(409)

      const before = await fetch(new URL("/api/contract/quiet?scope=http", listener.url), {
        headers: { authorization: authorization() },
      })
      expect(await before.json()).toMatchObject({ quiet: false, frontier: 1, outstanding: ["pct_http"] })

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
      expect(await after.json()).toMatchObject({ quiet: true, frontier: 3, outstanding: [] })
    } finally {
      await listener.stop(true)
    }
  })
})
