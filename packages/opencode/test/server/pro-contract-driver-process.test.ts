import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { contractProcess } from "../fixture/contract-process"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { httpError, reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, NodeServices.layer, FetchHttpClient.layer))

describe("Contract driver production lifecycle", () => {
  it.live(
    "routes two native blocked Sessions to the issuer and resumes through authenticated HTTP",
    () =>
      Effect.gen(function* () {
        const fixture = yield* contractProcess
        const llm = yield* TestLLMServer
        const server = yield* fixture.start()
        const firstReport = Promise.withResolvers<void>()
        const secondReport = Promise.withResolvers<void>()
        const id = "pct_native_blocked_routing"
        const deadline = Date.now() + 120_000
        yield* llm.push(
          reply().tool("contract_report_blocked", { reason: "Dependency unavailable" }).wait(firstReport.promise),
          reply()
            .tool("contract_report_blocked", { reason: "Independent attempt confirms missing input" })
            .wait(secondReport.promise),
        )
        yield* server.request("/api/contract", {
          id,
          scope: "native-blocked-process",
          goal: "Inspect the assigned input",
          location: { directory: fixture.directory },
          model: { providerID: "local", id: "researcher" },
          authority: ["filesystem.read"],
          budget: { deadline },
          resolution: { retryDelay: 100 },
        })
        yield* awaitWithTimeout(llm.wait(1), "First native attempt did not start", "20 seconds")
        const first = yield* fixture.binding(id)
        expect(first).toMatchObject({ attempts: 1, blockedStreak: 0, blockedRouting: "escalate-after-repeat" })
        yield* Effect.sync(() => firstReport.resolve())
        yield* awaitWithTimeout(llm.wait(2), "Second native attempt did not start", "20 seconds")
        const second = yield* fixture.binding(id)
        expect(second).toMatchObject({ attempts: 2, blockedStreak: 1 })
        expect(second.sessionID).not.toBe(first.sessionID)
        yield* Effect.sync(() => secondReport.resolve())
        expect(yield* server.status(id, "escalated")).toMatchObject({
          escalation: {
            reason:
              "Blocked in 2 consecutive attempts; routed to the issuer: Independent attempt confirms missing input",
          },
        })
        yield* server.idle(second.sessionID)
        const stopped = yield* fixture.binding(id)
        expect(stopped).toMatchObject({ attempts: 2, blockedStreak: 0, dispatched: false })
        const events = yield* fixture.ledger(id)
        expect(
          events
            .filter((event) => ["report-blocked", "escalate"].includes(event.command.type))
            .map((event) => event.command.type),
        ).toEqual(["report-blocked", "report-blocked", "escalate"])
        // Exceed retryDelay plus several production scheduler intervals.
        yield* Effect.sleep("3 seconds")
        expect(yield* fixture.binding(id)).toEqual(stopped)
        expect(yield* fixture.ledger(id)).toEqual(events)
        expect(yield* llm.calls).toBe(2)
        const sessions = Schema.decodeUnknownSync(
          Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
        )(yield* server.request("/api/session"))
        expect(new Set(sessions.data.map((session) => session.id))).toEqual(
          new Set([first.sessionID, second.sessionID]),
        )

        yield* llm.push(
          reply().tool("contract_report_ready", { summary: "Input restored by issuer", uncertainties: [] }),
        )
        yield* server.request(`/api/contract/${id}/resume`, {})
        yield* awaitWithTimeout(llm.wait(3), "HTTP resume did not start a third Session", "20 seconds")
        expect(yield* server.status(id, "verification")).toMatchObject({ spec: { budget: { deadline } } })
        const resumed = yield* fixture.binding(id)
        expect(resumed.sessionID).not.toBe(first.sessionID)
        expect(resumed.sessionID).not.toBe(second.sessionID)
        expect(resumed.blockedStreak).toBe(0)
        const context = yield* server.context(resumed.sessionID)
        expect(context.find((message) => message.type === "user")?.text).toContain(
          "Previous attempt blocked:\nIndependent attempt confirms missing input",
        )
        expect(yield* llm.calls).toBe(3)
        if (process.env.OPENCODE_NATIVE_ADVISORY_ARTIFACTS) {
          const hits = yield* llm.hits
          const ledger = yield* fixture.ledger(id)
          yield* Effect.promise(() =>
            Bun.write(
              path.join(process.env.OPENCODE_NATIVE_ADVISORY_ARTIFACTS!, "native-blocked-routing.json"),
              JSON.stringify({ first, second, stopped, resumed, sessions, context, hits, ledger }, null, 2),
            ),
          )
        }
      }),
    60_000,
  )

  it.live(
    "persists repeated waits across SIGKILL and fails closed without the host driver",
    () =>
      Effect.gen(function* () {
        const fixture = yield* contractProcess
        const llm = yield* TestLLMServer
        const first = yield* fixture.startHost(true)
        const id = "pct_driver_wait_restart"
        const deadline = Date.now() + 120_000
        const result = yield* first.command("issue", id, {
          id,
          scope: "driver-e2e",
          driver: "test-process:1",
          now: Date.now(),
          location: { directory: fixture.directory },
          model: { providerID: "local", id: "researcher" },
          spec: {
            trigger: { type: "immediate" },
            goal: "Explore the assigned direction",
            brief: "Inspect the problem and return progress",
            requires: [],
            authority: ["filesystem.read"],
            budget: { deadline },
            evidence: { type: "principal", claim: "An independently reviewed exploration" },
            resolution: { maxAttempts: 1, retryDelay: 1 },
          },
        })
        expect(result).toMatchObject({ decision: { type: "accepted" }, execution: { admission: { open: false } } })
        const initial = yield* fixture.binding(id)
        yield* llm.push(reply().text("First exploration complete"))
        yield* first.command("open", id)
        yield* awaitWithTimeout(llm.wait(1), "Host driver never dispatched", "20 seconds")
        const waited = yield* pollWithTimeout(
          fixture
            .binding(id)
            .pipe(Effect.map((binding) => (!binding.dispatched && !binding.admission?.open ? binding : undefined))),
          "Host never entered durable wait",
          "20 seconds",
        )
        expect(waited).toMatchObject({
          attempts: 1,
          turnsUsed: 1,
          driver: "test-process:1",
          admission: { open: false },
        })
        expect(waited.sessionID).not.toBe(initial.sessionID)
        yield* first.kill

        const missing = yield* fixture.startHost(false)
        expect(yield* missing.command("open", id)).toMatchObject({ conflict: expect.any(String) })
        // A production listener with only the native driver also sees the same disk
        // state and must not activate or take over the custom binding.
        const native = yield* fixture.start()
        expect(yield* native.get(id)).toMatchObject({ status: "active", spec: { budget: { deadline } } })
        expect(yield* fixture.binding(id)).toEqual(waited)
        expect(yield* llm.calls).toBe(1)
        yield* missing.kill
        yield* native.kill

        const recovered = yield* fixture.startHost(true)
        yield* llm.push(reply().text("Second exploration complete"))
        yield* recovered.command("open", id)
        yield* awaitWithTimeout(llm.wait(2), "Recovered host did not dispatch", "20 seconds")
        const second = yield* pollWithTimeout(
          fixture
            .binding(id)
            .pipe(Effect.map((binding) => (binding.turnsUsed === 2 && !binding.dispatched ? binding : undefined))),
          "Recovered host never returned to wait",
          "20 seconds",
        )
        expect(second).toMatchObject({ attempts: 1, turnsUsed: 2, admission: { open: false } })
        expect(second.generation).toBe(waited.generation! + 1)
        expect(second.sessionID).not.toBe(waited.sessionID)
        expect(second.promptID).not.toBe(waited.promptID)
        expect((yield* fixture.ledger(id)).some((event) => event.command.type === "escalate")).toBe(false)
        expect(yield* llm.calls).toBe(2)
        const unfinished = Promise.withResolvers<void>()
        yield* llm.push(reply().text("Interrupted exploration").wait(unfinished.promise))
        yield* recovered.command("open", id)
        yield* awaitWithTimeout(llm.wait(3), "Third host turn never started", "20 seconds")
        const inFlight = yield* fixture.binding(id)
        yield* recovered.kill
        const absent = yield* fixture.start()
        const closed = yield* pollWithTimeout(
          fixture
            .binding(id)
            .pipe(
              Effect.map((binding) => (!binding.dispatched && binding.admission?.open === false ? binding : undefined)),
            ),
          "Missing driver did not close its expired execution",
          "45 seconds",
        )
        expect(closed).toMatchObject({
          attempts: 1,
          turnsUsed: 3,
          generation: inFlight.generation,
          driver: "test-process:1",
        })
        expect(yield* absent.get(id)).toMatchObject({ status: "active", spec: { budget: { deadline } } })
        expect(yield* llm.calls).toBe(3)
        yield* Effect.sync(() => unfinished.resolve())
      }),
    90_000,
  )
  const posix = process.platform === "win32" ? it.live.skip : it.live
  posix(
    "fences an old provider failure after a production lease takeover",
    () =>
      Effect.gen(function* () {
        const fixture = yield* contractProcess
        const llm = yield* TestLLMServer
        const original = yield* fixture.start()
        const delayed = Promise.withResolvers<void>()
        const current = Promise.withResolvers<void>()
        const id = "pct_driver_stale_failure"
        yield* llm.push(
          httpError(401, { error: { message: "Expired key", type: "authentication_error" } }, delayed.promise),
          reply()
            .tool("contract_report_ready", { summary: "Current candidate", uncertainties: [] })
            .wait(current.promise),
        )
        yield* original.issue(id)
        yield* awaitWithTimeout(llm.wait(1), "Original provider never started", "20 seconds")
        const before = yield* fixture.binding(id)
        yield* Effect.sync(() => original.child.kill("SIGSTOP"))
        const replacement = yield* fixture.start()
        const after = yield* pollWithTimeout(
          fixture
            .binding(id)
            .pipe(Effect.map((binding) => (binding.generation !== before.generation ? binding : undefined))),
          "Production scheduler never reclaimed the expired lease",
          "45 seconds",
        )
        yield* awaitWithTimeout(llm.wait(2), "Replacement provider never started", "20 seconds")
        const ledger = yield* fixture.ledger(id)
        yield* Effect.sync(() => {
          original.child.kill("SIGCONT")
          delayed.resolve()
        })
        yield* original.settled(before.sessionID, 0)
        expect(yield* replacement.get(id)).toMatchObject({ status: "active", revision: 1 })
        expect(yield* fixture.binding(id)).toMatchObject({
          generation: after.generation,
          leaseOwner: after.leaseOwner,
          sessionID: after.sessionID,
          attempts: 1,
        })
        expect(yield* fixture.ledger(id)).toEqual(ledger)
        yield* Effect.sync(() => current.resolve())
        yield* replacement.status(id, "verification")
        expect(yield* llm.calls).toBe(2)
      }),
    90_000,
  )
})
