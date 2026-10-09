import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Stream } from "effect"
import { AIError, InvalidRequestError, LLMEvent } from "@opencode/ai"
import { TestLLM } from "@opencode/ai/testing"
import { ContractAdvisory } from "./contract-advisory"
import { config, continuation, fixture, probe, script, toolText } from "./contract-advisory.fixture"

test("probe access returns independent title/argument copies without reopening changed delivery", async () => {
  await using f = await fixture()
  await f.delivery.act({
    action: "probe",
    probe: { ...probe, stdin: "hidden stdin", env: { SECRET: "hidden environment" } },
  })
  await f.delivery.act({ action: "handoff", summary: "only this case" })
  await Bun.write(path.join(f.directory, "new-file"), "changed\n")
  const before = await Bun.file(path.join(f.state, "delivery.jsonl")).text()
  const copy = f.delivery.probes()
  expect(copy).toEqual([probe])
  copy[0].title = "mutated copy"
  copy[0].args.push("mutated copy")
  expect(f.delivery.probes()).toEqual([probe])
  expect(await Bun.file(path.join(f.state, "delivery.jsonl")).text()).toBe(before)
  expect((await f.delivery.status()).state).toBe("open")
})

test("materials preserve Appendix A.1, bound statements and probe summaries, and omit private probe inputs", async () => {
  await using f = await fixture()
  for (const index of Array.from({ length: 201 }, (_, index) => index))
    await f.delivery.act({
      action: "probe",
      probe: {
        title: "p" + index + "t".repeat(400),
        args: [String(index)],
        stdin: "NOT IN MATERIALS",
        env: { FIXTURE_PRIVATE: "NOT IN MATERIALS" },
      },
    })
  const result = await f.advisory!.review({ node: "blocked", statement: "说".repeat(9000) })
  expect(result!.outcome).toBe("completed")
  const prompt = await Bun.file(path.join(f.state, "advisory/1/prompt.txt")).text()
  const design = await Bun.file(new URL("../../../specs/pro-contract-v2-advisory.md", import.meta.url)).text()
  const fixed = design.split("**A.1 reviewer 固定说明**\n\n")[1].split("\n\n**A.2")[0]
  expect(prompt).toStartWith(
    fixed.replace("{reviewMinutes}", String(Math.floor((await f.journal())[0].budget / 60_000))),
  )
  const statement = prompt
    .split("Researcher statement (an untrusted claim, not evidence):\n")[1]
    .split("\n\nRetained public probes")[0]
  expect(statement.length).toBeLessThanOrEqual(8000)
  expect(statement).toEndWith("[Statement truncated.]")
  expect(prompt).toContain("Retained public probes (201 total;")
  const entries = prompt.split("expected outputs):\n")[1].split("\n")
  expect(entries).toHaveLength(201)
  expect(entries.slice(0, 200).every((entry) => entry.length <= 300)).toBe(true)
  expect(entries.at(-1)).toBe("[Probe list truncated to 200 entries.]")
  expect(prompt).not.toContain("NOT IN MATERIALS")
}, 30_000)

test("reviewer budget minutes are rounded down to an integer", async () => {
  await using f = await fixture({ config: { ...config, reviewMs: 90_999 } })
  expect(await f.advisory!.review({ node: "idle", statement: "progress" })).toMatchObject({ outcome: "completed" })
  expect((await f.journal())[0].budget).toBe(90_999)
  expect(await Bun.file(path.join(f.state, "advisory/1/prompt.txt")).text()).toContain(
    "You have about 1 minutes. Finish with your final advice before then.",
  )
})

test("latest assistant selection stays explicit past 50 messages and ignores older assistant text", async () => {
  let step = 0
  await using f = await fixture({
    reviewer: () => {
      step++
      if (step > 55) return TestLLM.text("LATEST ADVICE", "latest")
      return TestLLM.toolCalls(
        LLMEvent.textStart({ id: "older" }),
        LLMEvent.textDelta({ id: "older", text: "OLDER ADVICE" }),
        LLMEvent.textEnd({ id: "older" }),
        LLMEvent.toolCall({ id: `read-${step}`, name: "read", input: { path: path.join(f.directory, "source") } }),
      )
    },
  })
  expect(await f.advisory!.review({ node: "idle", statement: "progress" })).toMatchObject({
    outcome: "completed",
    opinion: "LATEST ADVICE",
  })
  const id = `${f.sessionID}_review_1`
  expect((await f.host.message.list({ sessionID: id })).data).toHaveLength(50)
  expect(await ContractAdvisory.latestText(f.host, id)).toBe("LATEST ADVICE")
}, 30_000)

test("an execution failure never adopts text left by a failed reviewer", async () => {
  await using f = await fixture({
    reviewer: () =>
      TestLLM.failAfter(
        new AIError({ reason: new InvalidRequestError({ message: "scripted post-output failure" }) }),
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "partial" }),
        LLMEvent.textDelta({ id: "partial", text: "UNUSABLE ADVICE" }),
      ),
  })
  expect(await f.advisory!.review({ node: "idle", statement: "progress" })).toMatchObject({
    outcome: "failed",
    opinion: "",
  })
  expect(await ContractAdvisory.latestText(f.host, `${f.sessionID}_review_1`)).toBe("UNUSABLE ADVICE")
})

for (const failure of ["events", "files"] as const)
  test(`a settled reviewer with failed ${failure} export fails open without becoming unsettled`, async () => {
    await using f = await fixture({
      adapt:
        failure === "events"
          ? (host) => ({
              ...host,
              sessions: {
                ...host.sessions,
                log: () => {
                  throw new Error("scripted event export failure")
                },
              },
            })
          : undefined,
      researcher: script(
        TestLLM.tool("blocked", "contract_delivery", { action: "blocked", reason: "unresolved" }),
        TestLLM.text("Done", "done"),
      ),
    })
    if (failure === "files")
      await Bun.write(path.join(f.state, "advisory"), "This file prevents creating the evidence directory.")
    await f.prompt()
    expect(await f.drain()).toMatchObject({ state: "blocked" })
    expect(await toolText(f, "blocked")).toContain("did not produce usable advice")
    expect((await f.journal()).at(-1).outcome).toBe("failed")
    expect(f.advisory!.reviewer(`${f.sessionID}_review_1`)).toBe("closed")
    if (failure === "events") {
      expect((await fs.readdir(path.join(f.state, "advisory/1"))).sort()).toEqual([
        "events.json",
        "opinion.txt",
        "prompt.txt",
      ])
      expect(await Bun.file(path.join(f.state, "advisory/1/events.json")).json()).toEqual([])
    }
  })

for (const kind of ["bytes", "lines", "characters"] as const)
  test(`visible advice respects ${kind} limit and evidence retains full Unicode opinion`, async () => {
    const opinion =
      kind === "bytes" ? "中文🙂".repeat(8000) : kind === "lines" ? "中文\n".repeat(10_000) : "a".repeat(25_000)
    await using f = await fixture({
      reviewer: () => TestLLM.text(opinion, "long-advice"),
      researcher: script(
        TestLLM.tool("probe", "contract_delivery", { action: "probe", probe }),
        TestLLM.tool("handoff", "contract_delivery", { action: "handoff", summary: "Public evidence only." }),
        TestLLM.text("Done", "done"),
      ),
    })
    await f.prompt()
    await f.drain()
    const text = await toolText(f, "handoff")
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(45 * 1024)
    expect(text.split("\n").length).toBeLessThanOrEqual(1800)
    expect(text.split("Advisory opinion:\n")[1].length).toBeLessThanOrEqual(20_000)
    expect(text).toContain("[Opinion truncated;")
    expect(text).not.toContain("full output saved to")
    expect(text).not.toContain("�")
    expect(await Bun.file(path.join(f.state, "advisory/1/opinion.txt")).text()).toBe(opinion)
  })

test("an oversized immutable handoff JSON still leaves the node warning visible at the front", async () => {
  await using f = await fixture({
    researcher: script(
      TestLLM.tool("probe", "contract_delivery", { action: "probe", probe }),
      TestLLM.tool("handoff", "contract_delivery", { action: "handoff", summary: "x".repeat(60_000) }),
      TestLLM.text("Done", "done"),
    ),
  })
  await f.prompt()
  expect(await f.drain()).toMatchObject({ state: "ready" })
  const text = await toolText(f, "handoff")
  expect(text).toStartWith("Your handoff is recorded and delivery is ready.")
  expect(text).toContain("nothing is submitted for evaluation")
  expect(text).toContain("full output saved to")
  const raw = f.advisory!.render(
    "submission",
    { summary: "x".repeat(60_000) },
    { started: true, outcome: "completed", reason: "completed", opinion: "full advice" },
  )
  expect(raw).toContain(JSON.stringify({ summary: "x".repeat(60_000) }))
  expect(raw).toContain("Opinion omitted")
})

test("idle review failure leaves the original continuation unmodified", async () => {
  await using f = await fixture({
    config: { ...config, nodes: { submission: false, blocked: false, idle: true } },
    timing: {},
    researcher: script(
      TestLLM.text("Stopped early", "first"),
      TestLLM.tool("blocked", "contract_delivery", { action: "blocked", reason: "fixture done" }),
      TestLLM.text("Done", "done"),
    ),
  })
  await f.prompt()
  await f.drain()
  const users = await f.host.message.list({ sessionID: f.sessionID, type: "user", order: "desc", limit: 1 })
  expect(users.data[0]).toMatchObject({ type: "user", text: continuation })
  expect((await f.journal()).at(-1)).toMatchObject({ type: "skipped" })
})

test("oversized failure reasons are bounded while full reasons remain in evidence", async () => {
  const reason = "创建失败\n".repeat(15_000)
  await using f = await fixture({
    adapt: (host) => ({
      ...host,
      sessions: {
        ...host.sessions,
        create: async () => {
          throw new Error(reason)
        },
      },
    }),
    researcher: script(
      TestLLM.tool("blocked", "contract_delivery", { action: "blocked", reason: "unresolved" }),
      TestLLM.text("Done", "done"),
    ),
  })
  await f.prompt()
  await f.drain()
  const text = await toolText(f, "blocked")
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(45 * 1024)
  expect(text.split("\n").length).toBeLessThanOrEqual(1800)
  expect(text).toContain("[Reason truncated; see advisory evidence.]")
  expect((await f.journal()).at(-1).reason).toBe(reason)
})

test("reviewer requests overlap the Researcher reply tail and their start times match advisory windows", async () => {
  const arrived = Promise.withResolvers<void>()
  const tail: boolean[] = []
  await using f = await fixture()
  const first = TestLLM.tool("first", "contract_delivery", { action: "blocked", reason: "review now" })
  f.serve(
    script(
      Stream.fromIterable(first.slice(0, -2)).pipe(
        Stream.concat(Stream.fromEffect(Effect.promise(() => arrived.promise)).pipe(Stream.drain)),
        Stream.concat(
          Stream.fromEffect(
            Effect.sync(() => {
              tail.push(true)
            }),
          ).pipe(Stream.drain),
        ),
        Stream.concat(Stream.fromIterable(first.slice(-2))),
      ),
      TestLLM.tool("second", "contract_delivery", { action: "blocked", reason: "confirmed" }),
      TestLLM.text("Done", "done"),
    ),
    (request) => {
      if (!request.messages.some((message) => message.role === "tool")) {
        expect(tail).toEqual([])
        arrived.resolve()
        return TestLLM.tool("read", "read", { path: path.join(f.directory, "source") })
      }
      return TestLLM.text("Scripted advice.", "advice")
    },
  )
  await f.prompt()
  await f.drain()
  const journal = await f.journal()
  expect(tail).toEqual([true])
  for (const request of f.requests) {
    const inWindow = request.time >= journal[0].time && request.time < journal[1].time
    expect(inWindow).toBe(request.sessionID.includes("_review_"))
  }
})
