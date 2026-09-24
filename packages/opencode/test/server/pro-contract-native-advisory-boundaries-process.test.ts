import { expect } from "bun:test"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import type { SessionMessage } from "@opencode-ai/core/session/message"
import { nativeAdvisoryProcess } from "../fixture/native-advisory-process"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpError, raw, reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, NodeServices.layer, FetchHttpClient.layer))
const ready = () =>
  reply().tool("contract_report_ready", {
    summary: "Native task ready without an advisory response",
    uncertainties: [],
  })
const review = () => reply().tool("contract_request", { kind: "review", payload: {} })
const advice =
  "I read candidate/answer.txt, which says captured native material. Consider adding a second example. I do not accept this candidate; this is ordinary optional advice."

function tool(index: number, name: string, input: unknown) {
  return {
    type: "response.output_item.done",
    output_index: index,
    item: {
      id: `fc_native_${index}`,
      call_id: `native_${index}`,
      type: "function_call",
      name,
      arguments: JSON.stringify(input),
      status: "completed",
    },
  }
}
const finish = {
  type: "response.completed",
  response: { incomplete_details: null, usage: { input_tokens: 20, output_tokens: 10 } },
}

it.live(
  "scheme A refuses two reviews while a real long bash remains running, with unchanged admission",
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeAdvisoryProcess(false, true)
      const llm = yield* TestLLMServer
      const id = "pct_native_busy"
      const gate = Promise.withResolvers<void>()
      yield* llm.push(
        raw({
          protocol: "responses",
          head: [
            tool(0, "bash", {
              command:
                "printf 'started\\n' > long-started; while [ ! -f long-release ]; do sleep 0.05; done; printf 'completed\\n' > long-finished",
              timeout: 15_000,
            }),
          ],
          wait: gate.promise,
          tail: [
            tool(1, "contract_request", { kind: "review", payload: {} }),
            tool(2, "contract_request", { kind: "review", payload: {} }),
            finish,
          ],
        }),
        ready(),
      )
      yield* fixture.issue(id)
      yield* pollWithTimeout(
        Effect.promise(
          async () => (await Bun.file(path.join(fixture.directory, "long-started")).exists()) || undefined,
        ),
        "Bash never started",
        "15 seconds",
      )
      const before = yield* fixture.binding(id)
      yield* Effect.sync(() => gate.resolve())
      const requests = yield* pollWithTimeout(
        fixture.requests(id).pipe(Effect.map((requests) => (requests.length === 2 ? requests : undefined))),
        "Busy requests were not recorded",
        "10 seconds",
      )
      expect(
        requests.every(
          (request) =>
            request.phase === "returned" &&
            !request.pause &&
            !request.job &&
            request.reason?.includes("no review is queued"),
        ),
      ).toBe(true)
      expect((yield* fixture.binding(id)).admission).toEqual(before.admission)
      expect((yield* fixture.binding(id)).generation).toBe(before.generation)
      expect(yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "long-finished")).exists())).toBe(false)
      yield* Effect.promise(() => Bun.write(path.join(fixture.directory, "long-release"), "continue"))
      yield* fixture.ready(id)
      expect(yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "long-finished")).text())).toBe(
        "completed\n",
      )
      expect(yield* llm.calls).toBe(2)
      yield* fixture.archive(id, { before, hits: yield* llm.hits })
    }),
  60_000,
)

it.live(
  "scheme A admits first, then refuses a later bash before process creation and retains that call across resume",
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeAdvisoryProcess(true, true)
      const llm = yield* TestLLMServer
      const id = "pct_native_later_tool"
      const start = Promise.withResolvers<void>()
      const later = Promise.withResolvers<void>()
      yield* llm.push(
        raw({ protocol: "responses", wait: start.promise, tail: [tool(0, "read", { path: "answer.txt" }), finish] }),
        raw({
          protocol: "responses",
          head: [tool(0, "contract_request", { kind: "review", payload: {} })],
          wait: later.promise,
          tail: [
            tool(1, "bash", { command: "printf 'incorrectly started\\n' > forbidden-process-marker", timeout: 5_000 }),
            tool(2, "contract_request", { kind: "review", payload: {} }),
            finish,
          ],
        }),
        reply().tool("read", { path: "candidate/answer.txt" }),
        reply().text(advice).stop(),
        ready(),
      )
      yield* fixture.issue(id)
      yield* llm.wait(1)
      yield* fixture.host.command("checkpoint-arm", "sweep")
      yield* Effect.sync(() => start.resolve())
      const accepted = yield* pollWithTimeout(
        fixture.requests(id).pipe(Effect.map((requests) => requests.find((request) => request.phase === "accepted"))),
        "Review was not accepted",
        "15 seconds",
      )
      const closed = yield* fixture.binding(id)
      expect(closed.admission?.open).toBe(false)
      yield* Effect.sync(() => later.resolve())
      const tools = yield* pollWithTimeout(
        fixture.host.command("session-context", id, { sessionID: closed.sessionID }).pipe(
          Effect.map((context) => {
            const tools = (context as SessionMessage.Message[]).flatMap((message) =>
              message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
            )
            return tools.find((tool) => tool.name === "bash" && tool.state.status === "error") ? tools : undefined
          }),
        ),
        "Later bash did not retain its refusal",
        "10 seconds",
      )
      expect(
        yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "forbidden-process-marker")).exists()),
      ).toBe(false)
      expect(tools.find((tool) => tool.name === "bash")?.state.status).toBe("error")
      expect(yield* fixture.requests(id)).toHaveLength(1)
      yield* fixture.host.command("checkpoint-release", "sweep")
      yield* fixture.ready(id)
      expect((yield* fixture.binding(id)).sessionID).toBe(accepted.execution.sessionID)
      expect(
        yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "forbidden-process-marker")).exists()),
      ).toBe(false)
      expect(JSON.stringify((yield* llm.hits).at(-1)?.body)).toContain("forbidden-process-marker")
      expect(JSON.stringify((yield* llm.hits).at(-1)?.body)).toContain("did not start")
      yield* fixture.archive(id, { tools, hits: yield* llm.hits })
    }),
  60_000,
)

it.live(
  "returns complete same-input advice from cache without a second pause or job, regardless of its verdict",
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeAdvisoryProcess()
      const llm = yield* TestLLMServer
      const id = "pct_native_cached"
      yield* llm.push(
        review(),
        reply().tool("read", { path: "candidate/answer.txt" }),
        reply().text(advice).stop(),
        review(),
        ready(),
      )
      const input = yield* fixture.issue(id)
      yield* fixture.ready(id)
      const requests = yield* fixture.requests(id)
      expect(requests).toHaveLength(2)
      const original = requests.find((request) => !!request.pause)!
      const cached = requests.find((request) => !!request.cachedFrom)!
      expect(cached.cachedFrom).toBe(original.id)
      expect(cached.pause).toBeUndefined()
      expect(cached.job).toEqual(original.job)
      expect(cached.outcome?.status).toBe("complete")
      expect(cached.prequery?.key).toBe(original.actual?.key)
      expect(yield* fixture.binding(id)).toMatchObject({ generation: 2, attempts: 1 })
      expect(yield* fixture.host.command("root-info", id)).toMatchObject({ spec: { budget: input.spec.budget } })
      expect(JSON.stringify((yield* llm.hits).at(-1)?.body)).toContain("cached")
      expect(yield* llm.calls).toBe(5)
      yield* fixture.archive(id, { hits: yield* llm.hits })
    }),
  60_000,
)

it.live(
  "a new explicit request after reviewer failure creates a new job for the same material",
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeAdvisoryProcess()
      const llm = yield* TestLLMServer
      const id = "pct_native_retry_failure"
      yield* llm.push(
        review(),
        httpError(400, { error: { message: "deterministic reviewer unavailable" } }),
        review(),
        reply().tool("read", { path: "candidate/answer.txt" }),
        reply().text(advice).stop(),
        ready(),
      )
      yield* fixture.issue(id)
      yield* fixture.ready(id)
      const requests = [...(yield* fixture.requests(id))].sort((a, b) => a.createdAt - b.createdAt)
      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.outcome?.status)).toEqual(["unavailable", "complete"])
      expect(requests[0].job?.id).not.toBe(requests[1].job?.id)
      expect(requests[0].materials?.key).toBe(requests[1].materials?.key)
      expect(requests.every((request) => !request.cachedFrom && request.phase === "resumed")).toBe(true)
      expect(yield* fixture.binding(id)).toMatchObject({
        generation: 3,
        attempts: 1,
        sessionID: requests[0].execution.sessionID,
      })
      expect(yield* llm.calls).toBe(6)
      yield* fixture.archive(id, { hits: yield* llm.hits })
    }),
  60_000,
)

for (const missing of ["some", "all"] as const)
  it.live(
    `missing materials: ${missing === "some" ? "reviewer reads the frozen missing list and remaining file" : "all approved files absent leaves admission open"}`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* nativeAdvisoryProcess()
        const llm = yield* TestLLMServer
        const id = `pct_native_missing_${missing}`
        const begin = Promise.withResolvers<void>()
        const submit = Promise.withResolvers<void>()
        const opinion =
          "I read materials.json and candidate/answer.txt: captured native material. later-result.txt is listed as missing, so I cannot assess that result. This is optional advice."
        yield* llm.push(
          review().wait(begin.promise),
          ...(missing === "some"
            ? [
                reply().tool("read", { path: "materials.json" }),
                reply().tool("read", { path: "candidate/answer.txt" }),
                reply().text(opinion).stop(),
              ]
            : []),
          ready().wait(submit.promise),
        )
        const input = yield* fixture.issue(id, {
          materials:
            missing === "some" ? ["answer.txt", "later-result.txt"] : ["not-created-a.txt", "not-created-b.txt"],
        })
        yield* llm.wait(1)
        const before = yield* fixture.binding(id)
        yield* Effect.sync(() => begin.resolve())
        yield* llm.wait(missing === "some" ? 5 : 2)
        const requests = yield* fixture.requests(id)
        expect(requests).toHaveLength(1)
        const request = requests[0]
        const after = yield* fixture.binding(id)
        expect(after.sessionID).toBe(before.sessionID)
        expect(after.attempts).toBe(before.attempts)
        if (missing === "some") {
          expect(request).toMatchObject({
            phase: "resumed",
            outcome: { status: "complete" },
            materials: { missing: ["later-result.txt"], files: [{ path: "answer.txt" }] },
            deliveryState: { inbox: "promoted" },
          })
          expect(after.generation).toBe(before.generation! + 1)
          const hits = yield* llm.hits
          expect(JSON.stringify(hits[2].body)).toContain("later-result.txt")
          expect(JSON.stringify(hits[3].body)).toContain("captured native material")
          expect(JSON.stringify(hits.at(-1)!.body)).toContain(opinion)
          expect(yield* fixture.host.command("native-attachment", id)).toMatchObject([
            { missing: ["later-result.txt"], opinion },
          ])
        }
        if (missing === "all") {
          expect(request).toMatchObject({
            phase: "returned",
            outcome: { status: "unavailable", reason: expect.stringContaining("No approved review material") },
          })
          expect(request.pause).toBeUndefined()
          expect(request.job).toBeUndefined()
          expect(after.admission).toEqual(before.admission)
          expect(after.generation).toBe(before.generation)
        }
        yield* Effect.sync(() => submit.resolve())
        yield* fixture.ready(id)
        expect(yield* fixture.host.command("root-info", id)).toMatchObject({ spec: { budget: input.spec.budget } })
        expect(yield* llm.calls).toBe(missing === "some" ? 5 : 2)
        yield* fixture.archive(id, { before, hits: yield* llm.hits })
      }),
    60_000,
  )

it.live(
  "an unavailable reviewer model does not become a native submission requirement",
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeAdvisoryProcess()
      const llm = yield* TestLLMServer
      const id = "pct_native_unavailable_model"
      yield* llm.push(review(), ready())
      const input = yield* fixture.issue(id, {
        reviewerModel: { providerID: "missing-native-reviewer", id: "unavailable" },
      })
      yield* fixture.ready(id)
      expect(yield* fixture.requests(id)).toMatchObject([
        { phase: "resumed", outcome: { status: "unavailable" }, deliveryState: { inbox: "promoted" } },
      ])
      expect(yield* fixture.host.command("root-info", id)).toMatchObject({ spec: { budget: input.spec.budget } })
      expect(yield* llm.calls).toBe(2)
      yield* fixture.archive(id)
    }),
  60_000,
)

it.live(
  "a bounded review timeout cancels through native jobs, archives partial text and resumes without retry",
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeAdvisoryProcess()
      const llm = yield* TestLLMServer
      const id = "pct_native_timeout"
      yield* llm.push(
        review(),
        reply().tool("read", { path: "candidate/answer.txt" }),
        reply().text("partial observation, never complete advice").hang(),
        ready(),
      )
      const input = yield* fixture.issue(id, { time: { operationMs: 15_000, reviewMs: 3_000 } })
      yield* fixture.ready(id)
      const requests = yield* fixture.requests(id)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ phase: "resumed", outcome: { status: "unavailable" } })
      expect(requests[0].outcome?.rawHash).toBeUndefined()
      const partial = yield* fixture.host.command("native-object", requests[0].outcome!.partialHash!)
      expect(partial).toContain("partial observation")
      expect(JSON.stringify((yield* llm.hits).at(-1)?.body)).not.toContain("partial observation")
      expect(yield* fixture.host.command("job-get", requests[0].job!.id)).toMatchObject({
        status: "cancelled",
        generation: 1,
        deadline: input.spec.budget.deadline,
      })
      expect(yield* fixture.host.command("root-info", id)).toMatchObject({ spec: { budget: input.spec.budget } })
      expect(yield* llm.calls).toBe(4)
      yield* fixture.archive(id, { partial, hits: yield* llm.hits })
    }),
  60_000,
)

for (const ordinary of [false, true])
  it.live(
    `review is per-contract and optional: ${ordinary ? "unregistered request stays unavailable" : "unrequested review never pauses"}`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* nativeAdvisoryProcess()
        const llm = yield* TestLLMServer
        const id = `pct_native_optional_${ordinary}`
        yield* llm.push(...(ordinary ? [review()] : []), reply().tool("contract_check", {}), ready())
        yield* fixture.issue(id, { ordinary })
        yield* fixture.ready(id)
        expect(yield* fixture.requests(id)).toHaveLength(0)
        expect(yield* fixture.binding(id)).toMatchObject({ generation: 1, attempts: 1 })
        expect(yield* llm.calls).toBe(ordinary ? 3 : 2)
        if (ordinary) expect(JSON.stringify((yield* llm.hits).at(-1)?.body)).toContain("adapter is unavailable")
        yield* fixture.archive(id, { hits: yield* llm.hits })
      }),
    60_000,
  )

it.live(
  "corrupt review copies lose trusted advice without blocking an independent native handoff",
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeAdvisoryProcess()
      const llm = yield* TestLLMServer
      const id = "pct_native_corrupt_copy"
      const gate = Promise.withResolvers<void>()
      yield* llm.push(
        review(),
        reply().tool("read", { path: "candidate/answer.txt" }),
        reply().text(advice).stop(),
        ready().wait(gate.promise),
      )
      yield* fixture.issue(id)
      yield* llm.wait(4)
      const request = (yield* fixture.requests(id))[0]
      yield* Effect.promise(async () => {
        const file = path.join(request.materials!.directory, "candidate/answer.txt")
        await chmod(file, 0o600)
        await Bun.write(file, "corrupt review copy")
      })
      expect(yield* fixture.host.command("native-attachment", id)).toMatchObject([
        { availability: expect.stringContaining("corrupt") },
      ])
      expect(
        ((yield* fixture.host.command("native-attachment", id)) as { opinion?: string }[])[0].opinion,
      ).toBeUndefined()
      yield* Effect.sync(() => gate.resolve())
      yield* fixture.ready(id)
      expect((yield* fixture.requests(id))[0].archiveFault).toContain("corrupt")
      expect(yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "answer.txt")).text())).toBe(
        "captured native material\n",
      )
      yield* fixture.archive(id)
    }),
  60_000,
)
