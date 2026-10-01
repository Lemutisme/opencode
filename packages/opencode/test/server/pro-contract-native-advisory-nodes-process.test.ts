import { expect } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { RelativePath } from "@opencode-ai/core/schema"
import type { NativeAdvisoryStore } from "../../../sdk-next/src/native-advisory-store"
import { nativeAdvisoryProcess } from "../fixture/native-advisory-process"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, NodeServices.layer, FetchHttpClient.layer))
const statement = {
  summary: "Original candidate, with an unchanged submission",
  uncertainties: ["Only the approved smoke replay was run"],
}
const opinion =
  "I read materials.json and candidate/answer.txt. The captured native material supports the narrow smoke claim; broader conclusions remain unverified. This advice needs no response."
const ready = (summary = statement.summary) => reply().tool("contract_report_ready", { ...statement, summary })
const review = () => [
  reply().tool("read", { path: "materials.json" }),
  reply().tool("read", { path: "candidate/answer.txt" }),
  reply().text(opinion).stop(),
]
const replay = {
  checks: [
    {
      argv: [
        "node",
        "-e",
        "if (!require('fs').readFileSync('answer.txt','utf8').length) process.exit(1); console.log('native node replay executed')",
      ],
      timeout: 5000,
      exit: 0,
    },
  ],
  protected: [],
  artifacts: [RelativePath.make("answer.txt")],
}

for (const mode of ["submission", "lost-return", "defect-after", "interrupted-check"] as const)
  it.live(
    `native node ${mode}: retains real evidence, reads frozen claims, and resumes the original Session`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* nativeAdvisoryProcess(true)
        const llm = yield* TestLLMServer
        const id = `pct_native_node_${mode}`
        const begin = Promise.withResolvers<void>()
        yield* llm.push(
          (mode === "interrupted-check" ? reply().tool("contract_check", {}) : ready()).wait(begin.promise),
          ...review(),
          ready(),
        )
        const input = yield* fixture.issue(id, {
          defaultNodes: mode !== "interrupted-check",
          nodes: { version: 1, submission: false, midcourse: { afterMs: 1 } },
          replay,
        })
        yield* llm.wait(1)
        const before = yield* fixture.binding(id)
        if (mode === "lost-return") yield* fixture.host.command("checkpoint-arm", "node-error-after")
        if (mode === "defect-after") yield* fixture.host.command("checkpoint-arm", "node-defect-after")
        if (mode === "interrupted-check") {
          yield* pollWithTimeout(
            fixture.host.command("native-attempt", id).pipe(
              Effect.map((value) => {
                const attempt = value as NativeAdvisoryStore.Attempt | undefined
                return attempt && Date.now() >= attempt.startedAt + 1 ? attempt : undefined
              }),
            ),
            "Host did not persist the attempt clock",
            "10 seconds",
          )
          yield* fixture.host.command("checkpoint-arm", "node-return")
        }
        yield* Effect.sync(() => begin.resolve())
        yield* fixture.ready(id)
        const requests = yield* fixture.requests(id)
        expect(requests).toHaveLength(1)
        const request = requests[0]
        expect(request).toMatchObject({
          phase: "resumed",
          outcome: { status: "complete" },
          attempt: 1,
          trigger: { type: mode === "interrupted-check" ? "check" : "submission" },
          resumedSessionID: before.sessionID,
          deliveryState: { inbox: "promoted" },
        })
        expect(yield* fixture.binding(id)).toMatchObject({
          attempts: 1,
          generation: 2,
          sessionID: before.sessionID,
          actionsUsed: mode === "interrupted-check" ? 2 : 1,
        })
        expect(yield* fixture.host.command("root-info", id)).toMatchObject({
          status: "verification",
          spec: { budget: input.spec.budget },
          handoff: { ...statement, replay: { passed: true } },
        })
        const hits = yield* llm.hits
        expect(hits).toHaveLength(5)
        expect(JSON.stringify(hits[2].body)).toContain("materials.json")
        expect(JSON.stringify(hits[3].body)).toContain("captured native material")
        expect(JSON.stringify(hits[4].body)).toContain(opinion)
        const material = JSON.parse((yield* fixture.host.command("native-object", request.materials!.hash)) as string)
        if (mode !== "interrupted-check") {
          expect(material.executorStatement).toEqual({ trust: "untrusted-executor-statement", ...statement })
          expect(JSON.stringify(hits[2].body)).toContain("untrusted-executor-statement")
          expect(request.delivery?.input.text).toContain("Delivery has not been recorded")
          expect(request.delivery?.input.text).toContain(statement.summary)
        }
        if (mode === "lost-return" || mode === "defect-after") {
          expect(
            yield* fixture.host.command(
              "checkpoint-status",
              mode === "lost-return" ? "node-error-after" : "node-defect-after",
            ),
          ).toBe(true)
          const context = yield* fixture.host.command("session-context", id, { sessionID: before.sessionID })
          expect(JSON.stringify(context)).toContain("admission")
        }
        if (mode === "interrupted-check") {
          expect(yield* fixture.host.command("checkpoint-status", "node-return")).toBe(true)
          if (request.trigger?.type !== "check") return yield* Effect.die("Missing check provenance")
          expect(request.trigger.replay.passed).toBe(true)
          expect(request.delivery?.input.text).toContain(request.trigger.replay.evidenceHash)
          expect(JSON.stringify(hits[4].body)).toContain("Tool execution interrupted")
          expect(JSON.stringify(hits[4].body)).toContain("contract_check passed: true")
          const evidence = yield* fixture.host.command("replay-report", id, {
            hash: request.trigger.replay.evidenceHash,
          })
          expect(evidence).toMatchObject({ contractID: id, passed: true })
          expect(JSON.stringify(evidence)).toContain("native node replay executed")
        }
        const deliveries = (yield* fixture.ledger(id)).filter(
          (event) => event.command.type === "report-ready" && event.decision.type === "accepted",
        )
        expect(deliveries).toHaveLength(1)
        yield* fixture.archive(id, { before, hits, material })
      }),
    60_000,
  )

for (const name of ["contract_report_ready", "contract_check"] as const)
  for (const fault of ["error", "defect"] as const)
    it.live(
      `${name} continues through a pre-admission host ${fault} and completes actual replay`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* nativeAdvisoryProcess(true)
          const llm = yield* TestLLMServer
          const id = `pct_native_node_pre_${fault}_${name}`
          const begin = Promise.withResolvers<void>()
          yield* llm.push(
            (name === "contract_check" ? reply().tool("contract_check", {}) : ready()).wait(begin.promise),
            ...(name === "contract_check" ? [ready()] : []),
          )
          yield* fixture.issue(id, { defaultNodes: true, replay })
          yield* llm.wait(1)
          yield* fixture.host.command("checkpoint-arm", `node-${fault}-before`)
          yield* Effect.sync(() => begin.resolve())
          yield* fixture.ready(id)
          expect(yield* fixture.host.command("checkpoint-status", `node-${fault}-before`)).toBe(true)
          expect(yield* fixture.requests(id)).toHaveLength(0)
          expect(yield* fixture.binding(id)).toMatchObject({ generation: 1, attempts: 1 })
          expect(yield* fixture.host.command("root-info", id)).toMatchObject({ handoff: { replay: { passed: true } } })
          expect(yield* fixture.host.log()).toContain(
            `Fixture node ${fault === "error" ? "failed" : "defect"} before admission`,
          )
          yield* fixture.archive(id, { hits: yield* llm.hits })
        }),
      60_000,
    )

it.live(
  "default nodes allow voluntary review, a second pause before delivery, and unchanged successful resubmission",
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeAdvisoryProcess(true)
      const llm = yield* TestLLMServer
      const id = "pct_native_node_voluntary_then_submission"
      yield* llm.push(
        reply().tool("contract_request", { kind: "review", payload: {} }),
        ...review(),
        ready(),
        ...review(),
        ready(),
      )
      yield* fixture.issue(id, { defaultNodes: true, replay })
      yield* fixture.ready(id)
      const requests = yield* fixture.requests(id)
      const voluntary = requests.find((request) => request.trigger?.type === "request")!
      const submission = requests.find((request) => request.trigger?.type === "submission")!
      expect(requests).toHaveLength(2)
      expect(
        requests.every(
          (request) => request.pause && request.phase === "resumed" && request.outcome?.status === "complete",
        ),
      ).toBe(true)
      expect(voluntary.resumedSessionID).toBe(voluntary.execution.sessionID)
      expect(submission.resumedSessionID).toBe(voluntary.execution.sessionID)
      expect(submission.actual?.subjectHash).toBe(voluntary.actual?.subjectHash)
      expect(submission.materials?.key).not.toBe(voluntary.materials?.key)
      expect(submission.cachedFrom).toBeUndefined()
      expect(submission.delivery?.input.text).toContain("Delivery has not been recorded")
      expect(submission.delivery?.input.text).toContain(statement.summary)
      expect(yield* fixture.binding(id)).toMatchObject({
        attempts: 1,
        generation: 3,
        sessionID: voluntary.execution.sessionID,
        actionsUsed: 1,
      })
      expect(yield* fixture.host.command("native-attempt", id)).toMatchObject({ submission: submission.id })
      expect(yield* fixture.host.command("root-info", id)).toMatchObject({
        handoff: { ...statement, replay: { passed: true } },
      })
      const hits = yield* llm.hits
      expect(hits).toHaveLength(9)
      for (const index of [2, 6]) expect(JSON.stringify(hits[index].body)).toContain("materials.json")
      for (const index of [3, 7]) expect(JSON.stringify(hits[index].body)).toContain("captured native material")
      for (const index of [4, 8]) expect(JSON.stringify(hits[index].body)).toContain(opinion)
      expect(
        (yield* fixture.ledger(id)).filter(
          (event) => event.command.type === "report-ready" && event.decision.type === "accepted",
        ),
      ).toHaveLength(1)
      yield* fixture.archive(id, { hits })
    }),
  60_000,
)

for (const checkpoint of ["loop-attempt-scan", "loop-attempt-observe", "loop-request-scan"] as const)
  it.live(
    `a single ${checkpoint} SQLite defect does not strand an already paused review`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* nativeAdvisoryProcess(true)
        const llm = yield* TestLLMServer
        const id = `pct_native_node_${checkpoint}`
        const begin = Promise.withResolvers<void>()
        yield* llm.push(ready().wait(begin.promise), ...review(), ready())
        yield* fixture.issue(id, { nodes: { version: 1, submission: true, midcourse: { afterMs: 600_000 } }, replay })
        yield* llm.wait(1)
        const before = yield* fixture.binding(id)
        yield* fixture.host.command("checkpoint-arm", "actual")
        yield* Effect.sync(() => begin.resolve())
        yield* pollWithTimeout(
          fixture.host
            .command("checkpoint-status", "actual")
            .pipe(Effect.map((reached) => (reached ? true : undefined))),
          "Review did not reach its persisted snapshot",
          "15 seconds",
        )
        expect((yield* fixture.binding(id)).admission?.open).toBe(false)
        expect((yield* fixture.requests(id))[0]).toMatchObject({
          phase: "accepted",
          actual: { subjectHash: expect.any(String) },
        })
        yield* fixture.host.command("checkpoint-arm", checkpoint)
        yield* pollWithTimeout(
          fixture.host
            .command("checkpoint-status", checkpoint)
            .pipe(Effect.map((reached) => (reached ? true : undefined))),
          "Main loop did not reach the injected failure",
          "10 seconds",
        )
        yield* fixture.host.command("checkpoint-release", "actual")
        yield* fixture.ready(id)
        expect(yield* fixture.requests(id)).toMatchObject([
          {
            phase: "resumed",
            outcome: { status: "complete" },
            resumedSessionID: before.sessionID,
            deliveryState: { inbox: "promoted" },
          },
        ])
        expect(yield* fixture.binding(id)).toMatchObject({
          attempts: 1,
          generation: 2,
          sessionID: before.sessionID,
          actionsUsed: 1,
        })
        const log = yield* fixture.host.log()
        expect(log).toContain("needs reconciliation")
        expect(log).toContain("injected_loop_failure")
        expect(yield* llm.calls).toBe(5)
        yield* fixture.archive(id, { before, hits: yield* llm.hits })
      }),
    60_000,
  )

const tool = (index: number, name: string, input: object) => ({
  type: "response.output_item.done",
  output_index: index,
  item: {
    id: `fc_node_${index}`,
    call_id: `node_${index}`,
    type: "function_call",
    name,
    arguments: JSON.stringify(input),
    status: "completed",
  },
})
const finish = {
  type: "response.completed",
  response: { incomplete_details: null, usage: { input_tokens: 20, output_tokens: 10 } },
}
const response = (...events: unknown[]) => raw({ protocol: "responses", head: events, tail: [finish] })

for (const repair of [false, true])
  it.live(
    repair
      ? "busy submission runs failing replay, then repair still gets a review and an unchanged resubmission succeeds"
      : "busy submission delivers directly without consuming the node opportunity",
    () =>
      Effect.gen(function* () {
        const fixture = yield* nativeAdvisoryProcess(true, true)
        const llm = yield* TestLLMServer
        const id = `pct_native_node_busy_${repair}`
        const tail = Promise.withResolvers<void>()
        yield* llm.push(
          raw({
            protocol: "responses",
            head: [
              tool(0, "bash", {
                command: "printf started > node-busy; while [ ! -f node-release ]; do sleep 0.05; done",
                timeout: 15_000,
              }),
            ],
            wait: tail.promise,
            tail: [tool(1, "contract_report_ready", statement), finish],
          }),
          ...(repair
            ? [
                response(tool(0, "bash", { command: "printf 'repaired\\n' > answer.txt", timeout: 5000 })),
                response(tool(0, "contract_report_ready", statement)),
                response(tool(0, "read", { path: "materials.json" })),
                response(tool(0, "read", { path: "candidate/answer.txt" })),
                response({ type: "response.output_text.delta", item_id: "msg_node_opinion", delta: opinion }),
                response(tool(0, "contract_report_ready", statement)),
              ]
            : []),
        )
        yield* fixture.issue(id, {
          defaultNodes: true,
          replay: repair
            ? {
                ...replay,
                checks: [
                  {
                    argv: [
                      "node",
                      "-e",
                      "process.exit(require('fs').readFileSync('answer.txt','utf8') === 'repaired\\n' ? 0 : 1)",
                    ],
                    timeout: 5000,
                    exit: 0,
                  },
                ],
              }
            : replay,
        })
        yield* pollWithTimeout(
          Effect.promise(async () => (await Bun.file(path.join(fixture.directory, "node-busy")).exists()) || undefined),
          "Tracked bash never started",
          "10 seconds",
        )
        const before = yield* fixture.binding(id)
        yield* Effect.sync(() => tail.resolve())
        yield* pollWithTimeout(
          fixture.requests(id).pipe(Effect.map((items) => items[0])),
          "Busy node was not recorded",
          "10 seconds",
        )
        expect((yield* fixture.binding(id)).admission).toEqual(before.admission)
        yield* Effect.promise(() => Bun.write(path.join(fixture.directory, "node-release"), "release"))
        yield* fixture.ready(id)
        const requests = yield* fixture.requests(id)
        const hits = yield* llm.hits
        yield* fixture.archive(id, { before, hits })
        expect(requests).toHaveLength(repair ? 2 : 1)
        expect(requests.filter((request) => !request.pause)).toMatchObject([
          { reason: expect.stringContaining("pending or running") },
        ])
        expect(requests.filter((request) => request.pause)).toMatchObject(
          repair ? [{ phase: "resumed", trigger: { type: "submission" }, outcome: { status: "complete" } }] : [],
        )
        expect(yield* fixture.binding(id)).toMatchObject({
          attempts: 1,
          generation: repair ? 2 : 1,
          actionsUsed: repair ? 4 : 2,
        })
        if (repair) {
          expect(JSON.stringify(hits[1].body)).toContain("No handoff was recorded")
          expect(JSON.stringify(hits.at(-1)?.body)).toContain(opinion)
        }
        if (!repair) {
          expect(
            ((yield* fixture.host.command("native-attempt", id)) as NativeAdvisoryStore.Attempt).submission,
          ).toBeUndefined()
          expect(hits).toHaveLength(1)
        }
        expect(yield* fixture.host.command("root-info", id)).toMatchObject({ handoff: { replay: { passed: true } } })
      }),
    60_000,
  )

it.live(
  "insufficient review time preserves the opportunity and delivers through native replay",
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeAdvisoryProcess(true)
      const llm = yield* TestLLMServer
      const id = "pct_native_node_insufficient_time"
      yield* llm.push(ready())
      const input = yield* fixture.issue(id, { defaultNodes: true, replay, time: { operationMs: 6 * 60 * 60 * 1000 } })
      yield* fixture.ready(id)
      const requests = yield* fixture.requests(id)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        phase: "returned",
        outcome: { status: "not-started", reason: expect.stringContaining("Insufficient time") },
      })
      expect(requests[0].pause).toBeUndefined()
      expect(
        ((yield* fixture.host.command("native-attempt", id)) as NativeAdvisoryStore.Attempt).submission,
      ).toBeUndefined()
      expect(yield* fixture.binding(id)).toMatchObject({ generation: 1, attempts: 1, actionsUsed: 1 })
      expect(yield* fixture.host.command("root-info", id)).toMatchObject({
        spec: { budget: input.spec.budget },
        handoff: { replay: { passed: true } },
      })
      expect(yield* llm.calls).toBe(1)
      yield* fixture.archive(id, { hits: yield* llm.hits })
    }),
  60_000,
)

it.live(
  "a real cache hit does not postpone a due midcourse review of a changed snapshot",
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeAdvisoryProcess(true)
      const llm = yield* TestLLMServer
      const id = "pct_native_node_cache_clock"
      const cached = Promise.withResolvers<void>()
      const afterMs = 10_000
      yield* llm.push(
        reply().tool("contract_request", { kind: "review", payload: {} }),
        ...review(),
        reply().tool("contract_request", { kind: "review", payload: {} }).wait(cached.promise),
        reply().tool("bash", { command: "printf 'updated material\\n' > answer.txt", timeout: 5000 }),
        reply().tool("contract_check", {}),
        ...review(),
        ready(),
      )
      yield* fixture.issue(id, { nodes: { version: 1, submission: false, midcourse: { afterMs } }, replay })
      yield* llm.wait(5)
      const first = (yield* fixture.requests(id))[0]
      expect(first).toMatchObject({ phase: "resumed", outcome: { status: "complete" } })
      // Advance real time to the policy boundary while the next provider response
      // remains held. This tests the interval itself, not scheduler readiness.
      yield* pollWithTimeout(
        Effect.sync(() => (Date.now() >= first.createdAt + afterMs ? true : undefined)),
        "First accepted review did not reach the configured interval",
        "15 seconds",
      )
      yield* Effect.sync(() => cached.resolve())
      yield* fixture.ready(id)
      const requests = yield* fixture.requests(id)
      const hit = requests.find((request) => request.cachedFrom)
      const midcourse = requests.find((request) => request.trigger?.type === "check")
      yield* fixture.archive(id, { hits: yield* llm.hits })
      expect(requests).toHaveLength(3)
      expect(hit).toMatchObject({ cachedFrom: first.id, outcome: { status: "complete" } })
      expect(hit?.pause).toBeUndefined()
      expect(midcourse).toMatchObject({
        phase: "resumed",
        outcome: { status: "complete" },
        resumedSessionID: first.execution.sessionID,
      })
      expect(midcourse?.actual?.subjectHash).not.toBe(first.actual?.subjectHash)
      expect(midcourse!.createdAt).toBeGreaterThanOrEqual(first.createdAt + afterMs)
      expect(midcourse!.createdAt).toBeLessThan(hit!.createdAt + afterMs)
      expect(yield* fixture.binding(id)).toMatchObject({ attempts: 1, generation: 3, actionsUsed: 3 })
    }),
  60_000,
)

for (const changed of [false, true])
  it.live(
    `new attempt with ${changed ? "different" : "identical"} claims ${changed ? "misses" : "hits"} the real completed-review cache`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* nativeAdvisoryProcess(true)
        const llm = yield* TestLLMServer
        const id = `pct_native_node_cache_${changed}`
        const summary = changed ? "A new claim about the exact same candidate" : statement.summary
        yield* llm.push(
          ready(),
          ...review(),
          reply().text("This native Session ends without a handoff.").stop(),
          ready(summary),
          ...(changed ? [...review(), ready(summary)] : []),
        )
        yield* fixture.issue(id, { defaultNodes: true, replay })
        yield* fixture.ready(id)
        const requests = yield* fixture.requests(id)
        expect(requests).toHaveLength(2)
        const accepted = requests.filter((request) => request.pause)
        expect(accepted).toHaveLength(changed ? 2 : 1)
        expect(new Set(requests.map((request) => request.actual!.subjectHash)).size).toBe(1)
        expect(yield* fixture.binding(id)).toMatchObject({ attempts: 2 })
        if (changed) {
          expect(new Set(requests.map((request) => request.materials!.key)).size).toBe(2)
          expect(requests.every((request) => request.cachedFrom === undefined)).toBe(true)
        }
        if (!changed) {
          expect(requests.find((request) => request.cachedFrom)?.cachedFrom).toBe(accepted[0].id)
          expect(yield* fixture.host.command("native-attempt", id)).toMatchObject({ attempt: 2 })
          expect(
            ((yield* fixture.host.command("native-attempt", id)) as NativeAdvisoryStore.Attempt).submission,
          ).toBeUndefined()
        }
        yield* fixture.archive(id, { hits: yield* llm.hits })
      }),
    60_000,
  )

it.live(
  "SIGKILL after node snapshot preserves the attempt clock, consumed slot and original submission",
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeAdvisoryProcess(true)
      const llm = yield* TestLLMServer
      const id = "pct_native_node_restart"
      const begin = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      yield* llm.push(ready().wait(begin.promise), ready().wait(resume.promise))
      yield* fixture.issue(id, { nodes: { version: 1, submission: true, midcourse: { afterMs: 600_000 } }, replay })
      yield* llm.wait(1)
      yield* fixture.host.command("checkpoint-arm", "actual")
      yield* Effect.sync(() => begin.resolve())
      yield* pollWithTimeout(
        fixture.host.command("checkpoint-status", "actual").pipe(Effect.map((reached) => (reached ? true : undefined))),
        "Node did not reach the actual snapshot checkpoint",
        "15 seconds",
      )
      const request = (yield* fixture.requests(id))[0]
      const attempt = yield* fixture.host.command("native-attempt", id)
      const before = yield* fixture.binding(id)
      const oldLog = yield* fixture.host.log()
      yield* fixture.host.kill
      const host = yield* fixture.startHost(false, { nativeAdvisory: true, nativeCheckpoints: true })
      yield* llm.wait(2)
      expect(yield* host.command("native-attempt", id)).toEqual(attempt)
      const restored = ((yield* host.command("native-requests", id)) as NativeAdvisoryStore.Request[])[0]
      expect(restored).toMatchObject({
        id: request.id,
        phase: "resumed",
        resumedSessionID: before.sessionID,
        outcome: { status: "unavailable" },
      })
      expect(restored.job).toBeUndefined()
      expect(restored.delivery?.input.text).toContain(statement.summary)
      expect(restored.delivery?.input.text).toContain("Delivery has not been recorded")
      yield* Effect.sync(() => resume.resolve())
      yield* pollWithTimeout(
        fixture
          .ledger(id)
          .pipe(
            Effect.map((events) =>
              events.find((event) => event.command.type === "report-ready" && event.decision.type === "accepted"),
            ),
          ),
        "Recovered node did not deliver",
        "15 seconds",
      )
      expect(yield* host.command("native-requests", id)).toHaveLength(1)
      expect(yield* fixture.binding(id)).toMatchObject({ sessionID: before.sessionID, attempts: 1, generation: 2 })
      expect(yield* llm.calls).toBe(2)
      yield* fixture.archive(id, { attempt, before, oldLog, hits: yield* llm.hits }, host)
    }),
  60_000,
)
