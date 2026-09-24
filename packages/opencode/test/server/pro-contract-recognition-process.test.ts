import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { NodeServices } from "@effect/platform-node"
import { OpenCode } from "../../../client/src/index"
import { ProContract } from "@opencode-ai/schema/pro-contract"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import path from "node:path"
import { contractProcess } from "../fixture/contract-process"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, NodeServices.layer, FetchHttpClient.layer))
const ready = () => reply().tool("contract_report_ready", { summary: "Reviewed candidate", uncertainties: [] })
const decode = Schema.decodeUnknownSync(ProContract.OperationReceipt)
const refusal = Schema.decodeUnknownSync(Schema.Struct({ receipt: ProContract.OperationReceipt }))

const post = (server: { url: URL; authorization: string }, id: string, action: string, body: unknown) =>
  Effect.promise(async () => {
    const response = await fetch(new URL(`/api/contract/${id}/${action}`, server.url), {
      method: "POST",
      headers: { authorization: server.authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    return { status: response.status, body: (await response.json()) as unknown }
  })

describe("S2 production recognition E2E", () => {
  it.live(
    "serializes HTTP duplicates, rejects legacy payloads and same-subject stale targets through both SDKs",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const fixture = yield* contractProcess
        const server = yield* fixture.start()
        const id = "pct_recognition_sdk"
        yield* llm.push(ready())
        yield* server.issue(id)
        const current = yield* server.status(id, "verification")
        yield* server.settled((yield* server.execution(id)).sessionID, 1)
        const modern = OpenCode.make({ baseUrl: server.url.href, headers: { authorization: server.authorization } })[
          "server.proContract"
        ]
        const legacy = createOpencodeClient({
          baseUrl: server.url.href,
          headers: { authorization: server.authorization },
        }).v2.proContract
        expect(yield* Effect.promise(() => modern.recognition({ contractID: id }))).toEqual(current.recognition!)
        expect((yield* Effect.promise(() => legacy.recognition({ contractID: id }))).data).toEqual(current.recognition!)
        expect((yield* post(server, id, "attestation", { evidenceHash: "legacy" })).status).toBe(400)
        const input = {
          contractID: id,
          operationID: "concurrent-http",
          expected: current.recognition!.handoff!,
          evidenceHash: "review",
        }
        const attempts = yield* Effect.all(
          Array.from({ length: 6 }, () => post(server, id, "attestation", input)),
          { concurrency: "unbounded" },
        )
        expect(attempts.every((attempt) => attempt.status === 200)).toBe(true)
        const receipts = attempts.map((attempt) => decode(attempt.body))
        expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1)
        expect(new Set(receipts.map((receipt) => receipt.hash)).size).toBe(1)
        expect(
          (yield* fixture.ledger(id)).filter(
            (event) => event.command.type === "discharge" && event.decision.type === "accepted",
          ),
        ).toHaveLength(1)
        const conflict = yield* post(server, id, "attestation", { ...input, evidenceHash: "different" })
        expect(conflict.status).toBe(409)
        expect(refusal(conflict.body).receipt.decision.type).toBe("rejected")
        yield* llm.push(ready())
        const challenged = yield* Effect.promise(() =>
          legacy.challenge({
            contractID: id,
            operationID: "challenge-http",
            expected: input.expected,
            evidenceHash: "counterexample",
            disclosure: "executor",
            summary: "Check again",
          }),
        )
        expect(challenged.data?.decision.type).toBe("accepted")
        const next = yield* pollWithTimeout(
          server
            .get(id)
            .pipe(
              Effect.map((contract) =>
                contract.status === "verification" &&
                contract.recognition?.handoff?.handoffID !== input.expected.handoffID
                  ? contract
                  : undefined,
              ),
            ),
          "Second handoff missing",
          "20 seconds",
        )
        expect(next.handoff?.subjectHash).toBe(current.handoff?.subjectHash)
        yield* server.settled((yield* server.execution(id)).sessionID, 1)
        expect(yield* Effect.promise(() => modern.attest(input))).toMatchObject({
          hash: receipts[0]!.hash,
          replayed: true,
          support: { valid: false },
        })
        const stale = yield* Effect.promise(() => legacy.attest({ ...input, operationID: "late-sdk" }))
        expect(stale.error).toMatchObject({ receipt: { decision: { type: "rejected" } } })
        expect(
          (yield* post(server, id, "challenge", {
            operationID: "old-feedback",
            expected: input.expected,
            evidenceHash: "late",
            disclosure: "sealed",
          })).status,
        ).toBe(409)
        {
          const { OpenCode } = yield* Effect.promise(() => import("../../../client/src/effect"))
          const http = yield* HttpClient.HttpClient
          const receipt = yield* Effect.gen(function* () {
            const client = yield* OpenCode.make({ baseUrl: server.url })
            return yield* client["server.proContract"].attest({
              contractID: ProContract.ID.make(id),
              operationID: "effect-sdk",
              expected: next.recognition!.handoff!,
              evidenceHash: "fresh-review",
            })
          }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              http.pipe(HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", server.authorization))),
            ),
          )
          expect(receipt.support?.valid).toBe(true)
        }
      }),
    60_000,
  )

  for (const accepted of [true, false])
    it.live(
      `recovers a discarded ${accepted ? "accepted" : "rejected"} response after SIGKILL without another ledger event`,
      () =>
        Effect.gen(function* () {
          const llm = yield* TestLLMServer
          const fixture = yield* contractProcess
          const server = yield* fixture.start()
          const id = "pct_recognition_crash"
          yield* llm.push(ready())
          yield* server.issue(id)
          const current = yield* server.status(id, "verification")
          yield* server.settled((yield* server.execution(id)).sessionID, 1)
          const input = {
            operationID: "lost-response",
            expected: { ...current.recognition!.handoff!, ...(accepted ? {} : { subjectHash: "stale" }) },
            evidenceHash: "review",
          }
          // Deliberately discard the entire response body. Only the read-only ledger observer confirms commit.
          yield* Effect.promise(async () => {
            const response = await fetch(new URL(`/api/contract/${id}/attestation`, server.url), {
              method: "POST",
              headers: { authorization: server.authorization, "content-type": "application/json" },
              body: JSON.stringify(input),
              signal: AbortSignal.timeout(10_000),
            })
            await response.body?.cancel()
          })
          const ledger = yield* fixture.ledger(id)
          const original = ledger.at(-1)!
          expect(original.command.type).toBe("discharge")
          expect(original.decision.type).toBe(accepted ? "accepted" : "rejected")
          yield* server.kill
          const restarted = yield* fixture.start()
          const retried = yield* post(restarted, id, "attestation", input)
          expect(retried.status).toBe(accepted ? 200 : 409)
          const receipt = accepted ? decode(retried.body) : refusal(retried.body).receipt
          expect(receipt).toMatchObject({
            replayed: true,
            hash: original.hash,
            frontier: original.seq,
            decision: original.decision,
          })
          expect(yield* fixture.ledger(id)).toEqual(ledger)
          const conflict = yield* post(restarted, id, "attestation", {
            ...input,
            evidenceHash: "changed after restart",
          })
          const rejected = refusal(conflict.body).receipt
          expect(conflict.status).toBe(409)
          yield* restarted.kill
          const again = yield* fixture.start()
          expect(
            refusal((yield* post(again, id, "attestation", { ...input, evidenceHash: "changed after restart" })).body)
              .receipt,
          ).toEqual({ ...rejected, replayed: true })
          expect(yield* llm.calls).toBe(1)
        }),
      60_000,
    )

  it.live(
    "uses persisted exact targets through real CLI attest and evaluation commands",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const fixture = yield* contractProcess
        const server = yield* fixture.start()
        const id = "pct_recognition_cli"
        yield* llm.push(ready())
        yield* server.issue(id)
        const current = yield* server.status(id, "verification")
        yield* server.settled((yield* server.execution(id)).sessionID, 1)
        const expected = path.join(fixture.storage, "expected.json")
        yield* Effect.promise(() => Bun.write(expected, JSON.stringify(current.recognition!.handoff!)))
        const attest = [
          "attest",
          id,
          "--expected",
          expected,
          "--operation-id",
          "cli-attest",
          "--evidence-hash",
          "cli-review",
        ]
        const before = yield* fixture.ledger(id)
        expect(
          (yield* fixture.cli(["attest", id, "--expected", expected, "--operation-id", "", "--evidence-hash", "bad"]))
            .exit,
        ).not.toBe(0)
        expect(yield* fixture.ledger(id)).toEqual(before)
        const accepted = yield* fixture.cli(attest)
        expect(accepted.exit, accepted.stderr).toBe(0)
        const receipt = decode(JSON.parse(accepted.stdout))
        expect(receipt.support?.valid).toBe(true)
        const retry = yield* fixture.cli(attest)
        expect(retry.exit, retry.stderr).toBe(0)
        expect(decode(JSON.parse(retry.stdout))).toEqual({ ...receipt, replayed: true })
        expect((yield* fixture.cli(["attest", id, "--evidence-hash", "old-client"])).exit).not.toBe(0)
        const issue = yield* fixture.cli([
          "evaluation",
          "issue",
          id,
          "--evaluator-hash",
          "oracle",
          "--deadline",
          new Date(Date.now() + 120_000).toISOString(),
        ])
        expect(issue.exit, issue.stderr).toBe(0)
        const duty = Schema.decodeUnknownSync(Schema.Struct({ data: ProContract.Info }))(JSON.parse(issue.stdout)).data
        const report = {
          version: 2,
          deliveryContractID: id,
          delivery: current.recognition!.handoff!,
          deliveryAttestationID: receipt.support!.attestationID,
          evaluation: duty.recognition!.context!.target,
          evaluatorHash: "oracle",
          passed: true,
          disclosure: "sealed",
          summary: "oracle pass",
        }
        const file = path.join(fixture.storage, "report.json")
        yield* Effect.promise(() => Bun.write(file, JSON.stringify({ ...report, version: 1 })))
        expect(
          (yield* fixture.cli(["evaluation", "settle", duty.id, "--report", file, "--operation-id", "old-report"]))
            .exit,
        ).not.toBe(0)
        expect((yield* server.get(duty.id)).status).toBe("dormant")
        yield* Effect.promise(() => Bun.write(file, JSON.stringify(report)))
        const settled = yield* fixture.cli([
          "evaluation",
          "settle",
          duty.id,
          "--report",
          file,
          "--operation-id",
          "cli-evaluation",
        ])
        expect(settled.exit, settled.stderr).toBe(0)
        expect(
          Schema.decodeUnknownSync(Schema.Struct({ receipt: ProContract.OperationReceipt }))(JSON.parse(settled.stdout))
            .receipt.support?.valid,
        ).toBe(true)
        yield* server.kill
        const restarted = yield* fixture.start()
        expect((yield* restarted.get(duty.id)).status).toBe("discharged")
        const negativeIssue = yield* fixture.cli([
          "evaluation",
          "issue",
          id,
          "--evaluator-hash",
          "negative-oracle",
          "--deadline",
          new Date(Date.now() + 120_000).toISOString(),
        ])
        expect(negativeIssue.exit, negativeIssue.stderr).toBe(0)
        const negativeDuty = Schema.decodeUnknownSync(Schema.Struct({ data: ProContract.Info }))(
          JSON.parse(negativeIssue.stdout),
        ).data
        yield* Effect.promise(() =>
          Bun.write(
            file,
            JSON.stringify({
              ...report,
              evaluation: negativeDuty.recognition!.context!.target,
              evaluatorHash: "negative-oracle",
              passed: false,
              summary: "rejected",
            }),
          ),
        )
        const negative = yield* fixture.cli([
          "evaluation",
          "settle",
          negativeDuty.id,
          "--report",
          file,
          "--operation-id",
          "cli-negative",
        ])
        expect(negative.exit, negative.stderr).toBe(0)
        expect(
          Schema.decodeUnknownSync(Schema.Struct({ receipt: ProContract.OperationReceipt }))(
            JSON.parse(negative.stdout),
          ).receipt.decision.type,
        ).toBe("accepted")
        expect((yield* restarted.get(id)).status).toBe("escalated")
        expect((yield* restarted.get(duty.id)).status).toBe("escalated")
      }),
    90_000,
  )
  it.live(
    "binds the CLI revision decision to the saved petition and preserves its retry receipt",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const fixture = yield* contractProcess
        const server = yield* fixture.start()
        const id = "pct_recognition_cli_revision"
        yield* llm.push(reply().tool("contract_propose_revision", { goal: "Amended goal", reason: "Clarify criteria" }))
        yield* server.issue(id)
        const binding = yield* pollWithTimeout(
          server.execution(id).pipe(Effect.map((value) => (value.dispatched ? value : undefined))),
          "Session not dispatched",
          "20 seconds",
        )
        yield* awaitWithTimeout(llm.wait(1), "Provider did not create the revision Session", "20 seconds")
        yield* server.permission(binding.sessionID)
        const current = yield* server.get(id)
        const file = path.join(fixture.storage, "petition.json")
        yield* Effect.promise(() => Bun.write(file, JSON.stringify(current.recognition!.pending!)))
        const args = ["revision", id, "--expected", file, "--operation-id", "cli-revision", "--accept=false"]
        const decision = yield* fixture.cli(args)
        expect(decision.exit, decision.stderr).toBe(0)
        const receipt = decode(JSON.parse(decision.stdout))
        expect(receipt.decision.type).toBe("accepted")
        const retry = yield* fixture.cli(args)
        expect(retry.exit, retry.stderr).toBe(0)
        expect(decode(JSON.parse(retry.stdout))).toEqual({ ...receipt, replayed: true })
        expect((yield* server.get(id)).pendingRevision).toBeUndefined()
        // Leave the old permission pending; killing the process must not turn it into a new decision.
        yield* server.kill
        const restarted = yield* fixture.start()
        expect((yield* restarted.get(id)).pendingRevision).toBeUndefined()
      }),
    60_000,
  )
})
