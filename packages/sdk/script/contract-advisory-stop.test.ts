import { expect, test } from "bun:test"
import path from "node:path"
import { TestLLM } from "@opencode/ai/testing"
import { LLMEvent } from "@opencode/ai"
import { config, continuation, fixture, script, toolText } from "./contract-advisory.fixture"

test("an already cancelled call never starts an advisory attempt or writes an orphan end record", async () => {
  await using f = await fixture()
  const call = new AbortController()
  call.abort()
  await expect(f.advisory!.review({ node: "blocked", statement: "unresolved" }, call.signal)).rejects.toThrow()
  expect(await Bun.file(path.join(f.state, "advisory.jsonl")).exists()).toBe(false)
  expect(f.advisory!.eligible("blocked")).toBe(true)
  expect(f.advisory!.reviewer(`${f.sessionID}_review_1`)).toBeUndefined()
})

test("creation returning after budget never prompts and leaves the chance unused", async () => {
  const prompted: unknown[] = []
  await using f = await fixture({
    config: { ...config, reviewMs: 40 },
    adapt: (host) => ({
      ...host,
      sessions: {
        ...host.sessions,
        create: async (value, options) => {
          await Bun.sleep(90)
          return host.sessions.create(value, options)
        },
        prompt: (value, options) => {
          prompted.push(options)
          return host.sessions.prompt(value, options)
        },
      },
    }),
  })
  const result = await f.advisory!.review({ node: "blocked", statement: "unresolved" })
  expect(result).toMatchObject({ outcome: "timeout", started: false, opinion: "" })
  expect(prompted).toEqual([])
  expect(f.advisory!.eligible("blocked")).toBe(true)
  expect(f.advisory!.reviewer(`${f.sessionID}_review_1`)).toBe("closed")
})

for (const cancel of [false, true])
  test(`late prompt admission is re-interrupted and settles as ${cancel ? "aborted" : "timeout"} without resetting the budget`, async () => {
    const call = new AbortController()
    const interruptions: number[] = []
    const promptOptions: unknown[] = []
    await using f = await fixture({
      config: { ...config, reviewMs: 80 },
      timing: { marginMs: 0, minimumMs: 1, settlementMs: 500 },
      reviewer: () =>
        TestLLM.hangAfter(
          LLMEvent.textStart({ id: "partial" }),
          LLMEvent.textDelta({ id: "partial", text: "UNUSABLE" }),
        ),
      adapt: (host) => ({
        ...host,
        sessions: {
          ...host.sessions,
          prompt: async (value, options) => {
            promptOptions.push(options)
            if (cancel) call.abort()
            await Bun.sleep(140)
            return host.sessions.prompt(value)
          },
          interrupt: (value, options) => {
            interruptions.push(Date.now())
            return host.sessions.interrupt(value, options)
          },
        },
      }),
    })
    const result = f.advisory!.review({ node: "blocked", statement: "unresolved" }, call.signal)
    if (cancel) await expect(result).rejects.toThrow()
    if (!cancel) expect(await result).toMatchObject({ outcome: "timeout", started: true, opinion: "" })
    await f.advisory!.settle()
    expect(promptOptions).toEqual([undefined])
    expect(interruptions.length).toBeGreaterThanOrEqual(2)
    expect((await f.journal()).at(-1)).toMatchObject({ outcome: cancel ? "aborted" : "timeout" })
    expect(
      (await f.events(`${f.sessionID}_review_1`)).some((event) => event.type === "session.execution.interrupted"),
    ).toBe(true)
    expect((await f.journal()).at(-1).time - (await f.journal())[0].time).toBeLessThan(580)
  })

test("independent Researcher interruption waits for reviewer settlement, then preserves baseline continuation", async () => {
  const arrived = Promise.withResolvers<void>()
  const idle = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await using f = await fixture({
    config: { ...config, nodes: { submission: false, blocked: true, idle: false } },
    reviewer: () => {
      arrived.resolve()
      return TestLLM.hangAfter()
    },
    researcher: script(
      TestLLM.tool("first", "contract_delivery", { action: "blocked", reason: "interrupted reason" }),
      TestLLM.tool("second", "contract_delivery", { action: "blocked", reason: "after continuation" }),
      TestLLM.text("Done", "done"),
    ),
    adapt: (host) => ({
      ...host,
      sessions: {
        ...host.sessions,
        wait: async (value, options) => {
          const result = await host.sessions.wait(value, options)
          idle.resolve()
          await release.promise
          return result
        },
      },
    }),
  })
  await f.prompt()
  await arrived.promise
  const draining = f.drain()
  try {
    await f.host.sessions.interrupt({ sessionID: f.sessionID })
    await f.host.sessions.wait({ sessionID: f.sessionID })
    await idle.promise
    expect(f.requests.filter((request) => request.sessionID === f.sessionID)).toHaveLength(1)
    expect((await f.delivery.status()).state).toBe("open")
    expect(await Bun.file(path.join(f.state, "delivery.jsonl")).exists()).toBe(false)
  } finally {
    release.resolve()
  }
  expect(await draining).toMatchObject({ state: "blocked", reason: "after continuation" })
  expect(f.controller.signal.aborted).toBe(false)
  expect((await f.journal()).at(-1).outcome).toBe("aborted")
  const users = await f.host.message.list({ sessionID: f.sessionID, type: "user", order: "desc", limit: 1 })
  expect(users.data[0]).toMatchObject({ type: "user", text: continuation })
  expect(await toolText(f, "first")).toBe("")
  expect(JSON.parse(await toolText(f, "second"))).toMatchObject({ state: "blocked" })
  const ended = (await f.journal()).at(-1).time
  expect(f.requests.find((request) => request.sessionID === f.sessionID && request.time >= ended)).toBeDefined()
})

for (const source of ["worker", "deadline", "standing"] as const)
  test(`${source} stop rejects blocked and never sends continuation`, async () => {
    const arrived = Promise.withResolvers<void>()
    await using f = await fixture({
      deadlineMs: source === "deadline" ? 1000 : 120_000,
      reviewer: () => {
        arrived.resolve()
        if (source === "standing") {
          f.standing.active = false
          return TestLLM.tool("read", "read", { path: path.join(f.directory, "source") })
        }
        return TestLLM.hangAfter()
      },
      researcher: script(
        TestLLM.tool("blocked", "contract_delivery", { action: "blocked", reason: "unresolved" }),
        TestLLM.text("Stopped", "stopped"),
      ),
    })
    await f.prompt()
    await arrived.promise
    if (source === "worker") f.controller.abort()
    await expect(f.drain()).rejects.toThrow()
    await f.advisory!.settle()
    expect((await f.delivery.status()).state).toBe("open")
    expect(await Bun.file(path.join(f.state, "delivery.jsonl")).exists()).toBe(false)
    expect((await f.events()).filter((event) => event.type === "session.inbox.enqueued")).toHaveLength(1)
    expect(
      (await f.events(`${f.sessionID}_review_1`)).some((event) => event.type === "session.execution.interrupted"),
    ).toBe(true)
  })

test("parent stop wins even when reviewer timeout already fired", async () => {
  const idle = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await using f = await fixture({
    config: { ...config, reviewMs: 100 },
    reviewer: () => TestLLM.hangAfter(),
    adapt: (host) => ({
      ...host,
      sessions: {
        ...host.sessions,
        wait: async (value, options) => {
          const result = await host.sessions.wait(value, options)
          idle.resolve()
          await release.promise
          return result
        },
      },
    }),
  })
  const call = new AbortController()
  const reviewing = f.advisory!.review({ node: "blocked", statement: "unresolved" }, call.signal)
  await idle.promise
  call.abort()
  release.resolve()
  await expect(reviewing).rejects.toThrow()
  expect((await f.delivery.status()).state).toBe("open")
  expect((await f.journal()).at(-1).outcome).toBe("aborted")
})

test("settlement promise prevents normal host close while a reviewer prompt is still in flight", async () => {
  const admitted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await using f = await fixture({
    adapt: (host) => ({
      ...host,
      sessions: {
        ...host.sessions,
        prompt: async (value) => {
          const result = await host.sessions.prompt(value)
          admitted.resolve()
          await release.promise
          return result
        },
      },
    }),
  })
  const reviewing = f.advisory!.review({ node: "idle", statement: "progress" })
  await admitted.promise
  const closed: number[] = []
  const closing = f.advisory!.settle().then(() => {
    closed.push(Date.now())
  })
  await Bun.sleep(20)
  expect(closed).toEqual([])
  release.resolve()
  expect(await reviewing).toMatchObject({ outcome: "completed" })
  await closing
  expect(closed[0]).toBeGreaterThanOrEqual((await f.journal()).at(-1).time)
})
