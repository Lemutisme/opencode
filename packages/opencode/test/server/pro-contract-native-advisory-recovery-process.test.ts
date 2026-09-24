import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import type { NativeAdvisoryStore } from "../../../sdk-next/src/native-advisory-store"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { nativeAdvisoryProcess } from "../fixture/native-advisory-process"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, NodeServices.layer, FetchHttpClient.layer))

for (const cut of ["accepted", "actual", "prepared", "job", "completed", "collected", "reopened"] as const)
  it.live(
    `startup reconciliation after SIGKILL at ${cut} uses native retirement and never restarts review`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* nativeAdvisoryProcess(true)
        const llm = yield* TestLLMServer
        const id = `pct_native_restart_${cut}`
        const reviewing = ["job", "completed", "collected", "reopened"].includes(cut)
        const begin = Promise.withResolvers<void>()
        const resume = Promise.withResolvers<void>()
        yield* llm.push(
          reply().tool("contract_request", { kind: "review", payload: {} }).wait(begin.promise),
          ...(reviewing
            ? [
                (cut === "job" ? reply().text("Partial reviewer reading retained after host death") : reply()).tool(
                  "read",
                  { path: "candidate/answer.txt" },
                ),
                cut === "job"
                  ? reply().text("A delta that has not yet reached a durable text boundary").hang()
                  : reply()
                      .text("Completed independent advice from captured native material; no response is required.")
                      .stop(),
              ]
            : []),
          reply()
            .tool("contract_report_ready", { summary: "Native task continued after host restart", uncertainties: [] })
            .wait(resume.promise),
        )
        const input = yield* fixture.issue(id)
        yield* llm.wait(1)
        if (cut === "accepted") {
          yield* fixture.host.command("checkpoint-arm", "sweep")
          yield* fixture.host.command("checkpoint-arm", "accepted")
        }
        if (["actual", "prepared", "completed", "collected"].includes(cut))
          yield* fixture.host.command("checkpoint-arm", cut)
        if (cut === "reopened") {
          yield* fixture.host.command("checkpoint-arm", "reopened")
          yield* fixture.host.command("checkpoint-arm", "claim-after-reopen")
        }
        yield* Effect.sync(() => begin.resolve())
        if (cut === "job") yield* llm.wait(3)
        if (cut !== "job")
          yield* pollWithTimeout(
            fixture.host.command("checkpoint-status", cut).pipe(Effect.map((reached) => (reached ? true : undefined))),
            `Did not reach ${cut} checkpoint`,
            "20 seconds",
          )
        const request = (yield* fixture.requests(id))[0]
        const before = yield* fixture.binding(id)
        const originalJob = request.job
          ? ((yield* fixture.host.command("job-get", request.job.id)) as ProContractJob.Job)
          : undefined
        if (cut === "accepted") {
          expect(request.job).toBeUndefined()
          expect(before).toMatchObject({ dispatched: true, admission: { open: false } })
        }
        if (cut === "actual" || cut === "prepared") {
          expect(request.actual).toBeDefined()
          expect(before).toMatchObject({ dispatched: false, admission: { open: false } })
          expect(request.outcome).toBeUndefined()
        }
        if (cut === "actual") expect(request.job).toBeUndefined()
        if (cut === "prepared") expect(originalJob).toMatchObject({ status: "prepared", generation: 0 })
        if (cut === "job") expect(originalJob).toMatchObject({ status: "open", generation: 1 })
        if (cut === "completed") {
          expect(originalJob).toMatchObject({ status: "completed", generation: 1 })
          expect(request.phase).toBe("job")
          expect(request.outcome).toBeUndefined()
        }
        if (cut === "collected") expect(request).toMatchObject({ phase: "collected", outcome: { status: "complete" } })
        if (cut === "reopened") {
          expect(request.phase).toBe("collected")
          expect(before.admission).toMatchObject({ open: true, input: request.delivery!.input })
          expect(request.resumedAt).toBeUndefined()
        }
        const oldLog = yield* fixture.host.log()
        yield* fixture.host.kill
        const host = yield* fixture.startHost(false, { nativeAdvisory: true })
        if (cut === "accepted" || cut === "job") {
          expect(Date.now()).toBeLessThan((cut === "job" ? originalJob!.leaseExpiresAt : before.leaseExpiresAt)!)
          expect((yield* fixture.binding(id)).admission?.open).toBe(false)
          expect(yield* llm.calls).toBe(cut === "accepted" ? 1 : 3)
        }
        const resumed = yield* pollWithTimeout(
          host
            .command("native-requests", id)
            .pipe(
              Effect.map((value) =>
                (value as NativeAdvisoryStore.Request[]).find((request) => request.phase === "resumed"),
              ),
            ),
          "Startup did not reconcile the request",
          "45 seconds",
        ).pipe(Effect.tapError(() => host.log().pipe(Effect.tap((log) => Effect.sync(() => console.error(log))))))
        const expectedCalls = reviewing ? 4 : 2
        yield* llm.wait(expectedCalls)
        const after = yield* fixture.binding(id)
        expect(resumed.pause!.stopAt).toBe(request.pause!.stopAt)
        expect(after).toMatchObject({ attempts: before.attempts, generation: 2 })
        expect(after.turnsUsed).toBeGreaterThanOrEqual(before.turnsUsed)
        expect(after.actionsUsed).toBeGreaterThanOrEqual(before.actionsUsed)
        expect(after.admission?.capabilities).toEqual(before.admission?.capabilities)
        if (cut === "accepted") {
          expect(after.sessionID).not.toBe(before.sessionID)
          expect(resumed.resume).toBe("replace")
          expect(resumed.delivery).toBeUndefined()
          const prompt = JSON.stringify((yield* llm.hits).at(-1)!.body)
          expect(prompt).toContain(JSON.stringify(input.spec.brief).slice(1, -1))
          expect(prompt).not.toContain("Your optional review request")
        }
        if (cut !== "accepted") {
          expect(after.sessionID).toBe(before.sessionID)
          expect(resumed.resume).toBe("preserve")
          if (request.job) {
            const job = (yield* host.command("job-get", request.job.id)) as ProContractJob.Job
            expect(job.generation).toBe(cut === "prepared" ? 0 : 1)
            expect(job.owner).toBeUndefined()
            expect(job.status).toBe(cut === "job" || cut === "prepared" ? "cancelled" : "completed")
          }
          if (cut === "actual" || cut === "prepared") {
            expect(resumed.outcome?.status).toBe("unavailable")
            expect(resumed.outcome?.rawHash).toBeUndefined()
          }
          if (cut === "job") {
            expect(resumed.outcome?.status).toBe("unavailable")
            const archive = yield* host.command("native-object", resumed.outcome!.archiveHash!)
            expect(archive).toContain("Partial reviewer reading")
          }
          if (reviewing && cut !== "job") expect(resumed.outcome?.status).toBe("complete")
          if (cut === "reopened") expect(after.admission!.input).toEqual(before.admission!.input)
          const context = JSON.stringify(yield* host.command("session-context", id, { sessionID: after.sessionID }))
          expect(context.split("Your optional review request")).toHaveLength(2)
          expect(context).toContain(JSON.stringify(input.spec.brief).slice(1, -1))
          if (reviewing && cut !== "job")
            expect(context).toContain("Completed independent advice from captured native material")
        }
        yield* Effect.sync(() => resume.resolve())
        yield* pollWithTimeout(
          fixture
            .ledger(id)
            .pipe(
              Effect.map((events) =>
                events.find((event) => event.command.type === "report-ready" && event.decision.type === "accepted"),
              ),
            ),
          "Recovered native execution did not submit",
          "20 seconds",
        )
        expect(yield* host.command("root-info", id)).toMatchObject({
          status: "verification",
          spec: { budget: input.spec.budget },
        })
        expect(yield* llm.calls).toBe(expectedCalls)
        yield* fixture.archive(id, { before, request, originalJob, oldLog, hits: yield* llm.hits }, host)
      }),
    90_000,
  )
