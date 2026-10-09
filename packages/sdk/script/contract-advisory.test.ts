import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema, Stream } from "effect"
import { AIError, InvalidRequestError, LLMEvent } from "@opencode/ai"
import { TestLLM } from "@opencode/ai/testing"
import { Session } from "@opencode/schema/session"
import { ContractDelivery } from "./contract-delivery"
import { ContractAdvisory } from "./contract-advisory"
import { Input, initialPrompt } from "./contract-worker"
import { config, continuation, fixture, probe, script, toolText } from "./contract-advisory.fixture"

test("legacy worker input and initial prompt stay byte-identical; advisory config is explicit", () => {
  const legacy = {
    contractID: "pct_test",
    revision: 1,
    sessionID: "ses_test",
    promptID: "msg_test",
    deadline: 123,
    directory: "/candidate",
    reference: "/reference",
    state: "/state",
    standing: "/standing",
    socket: "/socket",
    model: "scripted",
    effort: "max",
    prompt: "Original task.\n\nKeep spacing.\n",
  }
  expect(Schema.decodeUnknownSync(Input)(legacy)).toEqual(legacy)
  expect(initialPrompt(legacy)).toBe(legacy.prompt + "\n\n" + ContractDelivery.instructions)
  for (const bad of [
    {},
    { nodes: config.nodes, reviewMs: 1 },
    { nodes: { submission: true }, reviewMs: 1, afterMs: 0 },
    { ...config, nodes: { submission: false, blocked: false, idle: false } },
    ...[0, -1, NaN, Infinity, true].map((reviewMs) => ({ ...config, reviewMs })),
    ...[-1, NaN, Infinity, true].map((afterMs) => ({ ...config, afterMs })),
  ])
    expect(() => Schema.decodeUnknownSync(Input)({ ...legacy, advisory: bad })).toThrow()
  expect(Schema.decodeUnknownSync(Input)({ ...legacy, advisory: config }).advisory).toEqual(config)
})

test("initial advisory text uses Appendix A.4 and lists only enabled nodes", async () => {
  const design = await Bun.file(new URL("../../../specs/pro-contract-v2-advisory.md", import.meta.url)).text()
  const expected = design
    .split("开启时追加在交付说明之后，只列出已开启的节点：\n\n")[1]
    .trim()
    .replace("{afterMinutes}", "0")
  expect(ContractAdvisory.instructions(config)).toBe(expected)
  const text = initialPrompt({
    prompt: "task",
    advisory: { ...config, nodes: { submission: true, blocked: false, idle: false } },
  })
  expect(text).toStartWith("task\n\n" + ContractDelivery.instructions + "\n\nIndependent advisory review")
  expect(text).toContain("once, after a successful handoff;")
  expect(text).not.toContain("- once, when you report blocked;")
  expect(text).not.toContain("- when you stop before completing delivery,")
})

test("disabled profile keeps leaf tools, foreground serialization, continuation and no advisory files", async () => {
  await using f = await fixture({ config: false })
  f.serve(
    script(
      TestLLM.toolCalls(
        LLMEvent.toolCall({
          id: "shell",
          name: "shell",
          input: { command: "sleep 0.02; printf baseline > ordered", background: true, timeout: 900000 },
        }),
        LLMEvent.toolCall({ id: "read", name: "read", input: { path: path.join(f.directory, "ordered") } }),
      ),
      TestLLM.text("Premature stop", "early"),
      TestLLM.tool("blocked", "contract_delivery", { action: "blocked", reason: "fixture done" }),
      TestLLM.text("Done", "done"),
    ),
  )
  await f.prompt()
  expect(await f.drain()).toMatchObject({ state: "blocked" })
  expect(await toolText(f, "read")).toContain("baseline")
  expect(f.requests[0].request.tools.map((tool) => tool.name).sort()).toEqual([
    "contract_delivery",
    "glob",
    "grep",
    "patch",
    "read",
    "shell",
  ])
  const users = await f.host.message.list({ sessionID: f.sessionID, type: "user", order: "asc" })
  expect(users.data.filter((message) => message.type === "user").map((message) => message.text)).toEqual([
    initialPrompt({ prompt: "Implement the documented program.\nPreserve this exact task text." }),
    continuation,
  ])
  expect(f.advisory).toBeUndefined()
  expect(await Bun.file(path.join(f.state, "advisory.jsonl")).exists()).toBe(false)
  expect((await fs.readdir(f.state)).includes("advisory")).toBe(false)
})

test("handoff remains ready, reviews once, preserves JSON and writes evidence before reviewer creation", async () => {
  const creations: string[] = []
  const promptOptions: unknown[] = []
  await using f = await fixture({
    researcher: script(
      TestLLM.tool("probe", "contract_delivery", { action: "probe", probe }),
      TestLLM.tool("handoff", "contract_delivery", { action: "handoff", summary: "Only one public case is covered." }),
      TestLLM.tool("again", "contract_delivery", { action: "handoff", summary: "No change." }),
      TestLLM.text("Done", "done"),
    ),
    adapt: (host) => ({
      ...host,
      sessions: {
        ...host.sessions,
        create: async (value, options) => {
          expect(f.advisory!.reviewer(value!.id!)).toBe("running")
          expect((await f.journal()).at(-1)).toMatchObject({
            type: "started",
            sessionID: value!.id,
            node: "submission",
          })
          creations.push(value!.id!)
          return host.sessions.create(value, options)
        },
        prompt: (value, options) => {
          promptOptions.push(options)
          return host.sessions.prompt(value, options)
        },
      },
    }),
  })
  await f.prompt()
  const ready = await f.drain()
  expect(ready).toMatchObject({ state: "ready", probes: 1 })
  expect(creations).toEqual([`${f.sessionID}_review_1`])
  expect(promptOptions).toEqual([undefined])
  const text = await toolText(f, "handoff")
  expect(text).toStartWith("Your handoff is recorded and delivery is ready.")
  expect(text).toContain("add or rerun a probe")
  expect(text).toContain("nothing is submitted for evaluation, including this recorded handoff.")
  expect(text.indexOf('"authoritativeCompletion":false')).toBeLessThan(
    text.indexOf("The reviewer could read the files"),
  )
  expect(text.indexOf("The reviewer could read the files")).toBeLessThan(text.indexOf("Advisory opinion:"))
  expect(text).toContain("Check the empty argument case")
  expect(JSON.parse(await toolText(f, "again"))).toMatchObject({ state: "ready", authoritativeCompletion: false })
  expect((await f.journal()).map((row) => row.type)).toEqual(["started", "ended"])
  expect((await f.journal()).at(-1).outcome).toBe("completed")
  expect(f.advisory!.reviewer(creations[0])).toBe("closed")
  const session = await f.host.sessions.get({ sessionID: creations[0] })
  expect(session.title).toBe("Contract advisory submission 1")
  expect(session.model).toEqual({ providerID: "openai", id: "gpt-5.6-luna", variant: "max" })
  expect(session.permissions).toEqual(
    ["edit", "shell", "contract_delivery", "external_directory"].map((action) => ({
      action,
      resource: "*",
      effect: "deny",
    })),
  )
  const material = await Bun.file(path.join(f.state, "advisory/1/prompt.txt")).text()
  expect(material).toContain("Implement the documented program.\nPreserve this exact task text.")
  expect(material).toContain(ContractDelivery.instructions)
  expect(material).toContain("Retained public probes (1 total;")
  expect(material).toContain(JSON.stringify(probe))
  expect(material).toContain("Handed-off snapshot: " + ("snapshot" in ready ? ready.snapshot : "missing"))
  expect(await Bun.file(path.join(f.state, "advisory/1/opinion.txt")).text()).toContain("Check the empty argument case")
  expect((await fs.readdir(f.directory)).sort()).toEqual(["compile.sh", "executable", "source", "validate.sh"])
  expect((await f.delivery.status()).state).toBe("ready")
  for (const request of f.requests.filter((item) => item.sessionID.includes("_review_")))
    expect(request.request.tools.map((tool) => tool.name).sort()).toEqual(["glob", "grep", "read"])
})

test("failed handoffs do not trigger or consume submission review", async () => {
  await using f = await fixture()
  f.serve(
    () => {
      const count = f.requests.filter((item) => item.sessionID === f.sessionID).length
      return [
        TestLLM.tool("no-probe", "contract_delivery", { action: "handoff", summary: "no probe" }),
        TestLLM.tool("probe", "contract_delivery", { action: "probe", probe }),
        TestLLM.tool("bad-validator", "contract_delivery", { action: "handoff", summary: "validator fails" }),
        TestLLM.tool("fix-validator", "shell", {
          command: "printf 'exit 0\\n' > validate.sh; printf '#!/bin/sh\\necho wrong\\n' > source",
        }),
        TestLLM.tool("bad-probe", "contract_delivery", { action: "handoff", summary: "probe fails" }),
        TestLLM.tool("fix", "shell", { command: `cp ${f.root}/reference source` }),
        TestLLM.tool("handoff", "contract_delivery", { action: "handoff", summary: "repaired" }),
        TestLLM.text("Done", "done"),
      ][count - 1]
    },
    () => TestLLM.text("Inspect source:2.", "advice"),
  )
  await Bun.write(path.join(f.directory, "validate.sh"), "exit 1\n")
  await f.prompt()
  expect(await f.drain()).toMatchObject({ state: "ready" })
  for (const id of ["no-probe", "bad-validator", "bad-probe"]) expect(await toolText(f, id)).not.toContain("advisory")
  expect((await f.journal()).filter((row) => row.type === "started")).toHaveLength(1)
})

test("blocked reviews a nonempty reason once before recording and preserves repeated blocked behavior", async () => {
  await using f = await fixture({
    researcher: script(
      TestLLM.tool("empty", "contract_delivery", { action: "blocked", reason: "  " }),
      TestLLM.tool("first", "contract_delivery", { action: "blocked", reason: "unresolved behavior" }),
      TestLLM.tool("second", "contract_delivery", { action: "blocked", reason: "still unresolved" }),
      TestLLM.tool("third", "contract_delivery", { action: "blocked", reason: "already blocked" }),
      TestLLM.text("Done", "done"),
    ),
  })
  await f.prompt()
  expect(await f.drain()).toMatchObject({ state: "blocked", reason: "already blocked" })
  expect(await toolText(f, "first")).toContain('"state":"open"')
  expect(await toolText(f, "first")).toStartWith("Blocked was not recorded yet")
  expect(JSON.parse(await toolText(f, "second"))).toMatchObject({ state: "blocked" })
  expect((await f.events()).filter((event) => event.type === "session.tool.failed")).toHaveLength(1)
  const delivery = (await Bun.file(path.join(f.state, "delivery.jsonl")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(delivery.map((row) => row.reason)).toEqual(["still unresolved", "already blocked"])
  expect((await f.journal()).filter((row) => row.type === "started")).toHaveLength(1)
})

test("an allocation already blocked never starts a reviewer", async () => {
  await using f = await fixture({
    researcher: script(
      TestLLM.tool("again", "contract_delivery", { action: "blocked", reason: "again" }),
      TestLLM.text("Done", "done"),
    ),
  })
  await f.delivery.act({ action: "blocked", reason: "before prompt" })
  await f.prompt()
  await f.drain()
  expect(await Bun.file(path.join(f.state, "advisory.jsonl")).exists()).toBe(false)
})

for (const eligible of [false, true])
  test(`idle continuation ${eligible ? "appends advice with zero probes" : "before afterMs is byte-identical"}`, async () => {
    await using f = await fixture({
      config: { ...config, afterMs: eligible ? 0 : 60_000, nodes: { submission: false, blocked: false, idle: true } },
      researcher: script(
        TestLLM.text("My latest progress", "progress"),
        TestLLM.tool("blocked", "contract_delivery", { action: "blocked", reason: "fixture complete" }),
        TestLLM.text("Done", "done"),
      ),
    })
    await f.prompt()
    await f.drain()
    const users = await f.host.message.list({ sessionID: f.sessionID, type: "user", order: "desc", limit: 1 })
    const latest = users.data[0]
    expect(latest.type).toBe("user")
    if (latest.type !== "user") throw new Error("missing continuation")
    expect(latest.text).toStartWith(continuation)
    if (!eligible) {
      expect(latest.text).toBe(continuation)
      return
    }
    expect(latest.text).toContain("Advisory opinion:")
    const material = await Bun.file(path.join(f.state, "advisory/1/prompt.txt")).text()
    expect(material).toContain("My latest progress")
    expect(material).toContain("Retained public probes (0 total;")
    expect(material).toContain("0 probes.")
  })

test("idle timing starts at the last prompted review end; skipped attempts neither reset it nor consume chances", async () => {
  const selected = { ...config, afterMs: 60, reviewMs: 5 }
  await using f = await fixture({
    config: selected,
    timing: { marginMs: 0, minimumMs: 10, settlementMs: 1000 },
    started: Date.now() - 1000,
  })
  expect((await f.advisory!.review({ node: "idle", statement: "progress" }))!.outcome).toBe("skipped")
  expect(f.advisory!.eligible("idle")).toBe(true)
  expect((await f.advisory!.review({ node: "submission", statement: "done" }))!.started).toBe(false)
  expect(f.advisory!.eligible("submission")).toBe(true)
  selected.reviewMs = 10_000
  expect((await f.advisory!.review({ node: "submission", statement: "done" }))!.outcome).toBe("completed")
  expect(f.advisory!.eligible("idle")).toBe(false)
  await Bun.sleep(70)
  expect(f.advisory!.eligible("idle")).toBe(true)
  expect((await f.journal()).map((row) => row.type)).toEqual(["skipped", "skipped", "started", "ended"])
  expect((await f.journal())[2].sessionID).toBe(`${f.sessionID}_review_3`)
})

for (const failure of ["error", "timeout", "empty", "budget", "prompt"] as const)
  test(`blocked fails open for ${failure} with accurate started wording and no residual advice`, async () => {
    await using f = await fixture({
      config: { ...config, reviewMs: failure === "timeout" ? 250 : config.reviewMs },
      timing: failure === "budget" ? {} : undefined,
      reviewer: () =>
        failure === "error"
          ? Stream.fail(new AIError({ reason: new InvalidRequestError({ message: "scripted failure" }) }))
          : failure === "timeout"
            ? TestLLM.hangAfter(...TestLLM.text("UNUSABLE RESIDUE", "partial").slice(0, -2))
            : failure === "empty"
              ? TestLLM.stop()
              : TestLLM.text("UNUSABLE RESIDUE", "advice"),
      adapt:
        failure === "prompt"
          ? (host) => ({
              ...host,
              sessions: {
                ...host.sessions,
                prompt: async (value, options) => {
                  expect(options).toBeUndefined()
                  await host.sessions.prompt(value)
                  throw new Error("scripted prompt response failure")
                },
              },
            })
          : undefined,
      researcher: script(
        TestLLM.tool("blocked", "contract_delivery", { action: "blocked", reason: "unresolved" }),
        TestLLM.text("Done", "done"),
      ),
    })
    await f.prompt()
    expect(await f.drain()).toMatchObject({ state: "blocked" })
    const text = await toolText(f, "blocked")
    expect(text).toStartWith("Blocked is recorded.")
    expect(text).toContain(failure === "budget" ? "did not start" : "did not produce usable advice")
    expect(text).not.toContain("UNUSABLE RESIDUE")
    expect((await f.journal()).at(-1)).toMatchObject(
      failure === "budget"
        ? { type: "skipped" }
        : {
            type: "ended",
            outcome: { error: "failed", timeout: "timeout", empty: "no-opinion", prompt: "failed" }[failure],
            prompted: true,
          },
    )
  })

test("create failure keeps the submission chance and the next attempt uses a fresh registered ID", async () => {
  await using f = await fixture({
    adapt: (host) => ({
      ...host,
      sessions: {
        ...host.sessions,
        create: async (value, options) => {
          if (value?.id?.endsWith("_review_1")) throw new Error("scripted create failure")
          return host.sessions.create(value, options)
        },
      },
    }),
    researcher: script(
      TestLLM.tool("probe", "contract_delivery", { action: "probe", probe }),
      TestLLM.tool("first", "contract_delivery", { action: "handoff", summary: "first" }),
      TestLLM.tool("second", "contract_delivery", { action: "handoff", summary: "second" }),
      TestLLM.text("Done", "done"),
    ),
  })
  await f.prompt()
  await f.drain()
  expect(await toolText(f, "first")).toContain("did not start (scripted create failure)")
  expect(await toolText(f, "second")).toContain("Advisory opinion:")
  expect((await f.journal()).filter((row) => row.type === "started").map((row) => row.sessionID)).toEqual([
    `${f.sessionID}_review_1`,
    `${f.sessionID}_review_2`,
  ])
})

test("reviewer isolation rejects external paths and contract_delivery; closed tools bypass and reject the held queue", async () => {
  const rejected: Promise<unknown>[] = []
  const responses = script(
    TestLLM.tool("outside", "read", { path: "/etc/passwd" }),
    TestLLM.tool("delivery", "contract_delivery", { action: "blocked", reason: "forbidden" }),
    TestLLM.text("Paths were denied.", "advice"),
  )
  await using f = await fixture({
    reviewer: (request) => {
      if (!rejected.length) {
        const tool = f.calls.get("contract_delivery")!
        rejected.push(
          tool
            .execute(
              { action: "status" },
              {
                ...tool.call,
                sessionID: Session.ID.make(`${f.sessionID}_review_1`),
              },
            )
            .catch((error: unknown) => error),
        )
      }
      return responses(request)
    },
    researcher: script(
      TestLLM.tool("first", "contract_delivery", { action: "blocked", reason: "review me" }),
      TestLLM.tool("second", "contract_delivery", { action: "blocked", reason: "confirmed" }),
      TestLLM.text("Done", "done"),
    ),
  })
  await f.prompt()
  await f.drain()
  expect(await rejected[0]).toMatchObject({ message: "Advisory reviewers cannot call contract_delivery" })
  const id = `${f.sessionID}_review_1`
  const failures = (await f.events(id)).filter((event) => event.type === "session.tool.failed")
  expect(failures.map((event) => event.data.id)).toEqual(["outside", "delivery"])
  expect(JSON.stringify(failures)).toContain("external_directory")
  const held = Promise.withResolvers<void>()
  const queued = f.delivery.exclusive(() => held.promise)
  try {
    const read = f.calls.get("read")!
    await expect(
      read.execute({ path: path.join(f.directory, "source") }, { ...read.call, sessionID: Session.ID.make(id) }),
    ).rejects.toThrow("closed")
    const delivery = f.calls.get("contract_delivery")!
    await expect(
      delivery.execute({ action: "status" }, { ...delivery.call, sessionID: Session.ID.make(id) }),
    ).rejects.toThrow("cannot call contract_delivery")
  } finally {
    held.resolve()
    await queued
  }
  expect(f.requests.every((request) => request.request.tools.length > 0)).toBe(true)
})

for (const following of ["patch", "probe", "blocked"] as const)
  test(`parallel ${following === "blocked" ? "blocked/blocked" : `handoff/${following}`} runs the queued action after advisory`, async () => {
    await using f = await fixture()
    const observed: string[] = []
    f.serve(
      () => {
        if (f.requests.filter((item) => item.sessionID === f.sessionID).length === 1)
          return TestLLM.toolCalls(
            LLMEvent.toolCall({
              id: "first",
              name: "contract_delivery",
              input:
                following === "blocked"
                  ? { action: "blocked", reason: "first" }
                  : { action: "handoff", summary: "ready" },
            }),
            LLMEvent.toolCall({
              id: "queued",
              name: following === "patch" ? "patch" : "contract_delivery",
              input:
                following === "patch"
                  ? { patchText: `*** Begin Patch\n*** Add File: ${f.directory}/after\n+queued\n*** End Patch` }
                  : following === "probe"
                    ? { action: "probe", probe }
                    : { action: "blocked", reason: "queued" },
            }),
          )
        observed.push("researcher resumed")
        return TestLLM.text("Done", "done")
      },
      (request) => {
        observed.push("review")
        return request.messages.some((message) => message.role === "tool")
          ? TestLLM.text("Inspect coverage.", "advice")
          : TestLLM.tool("read", "read", { path: path.join(f.directory, "source") })
      },
    )
    if (following !== "blocked") await f.delivery.act({ action: "probe", probe })
    await f.prompt()
    await f.wait()
    expect((await f.delivery.status()).state).toBe(following === "blocked" ? "blocked" : "open")
    expect(await toolText(f, "first")).toContain("Advisory opinion:")
    expect(observed.at(-1)).toBe("researcher resumed")
    const events = await f.events()
    const first = events.findIndex((event) => event.type === "session.tool.success" && event.data.id === "first")
    const second = events.findIndex((event) => event.type === "session.tool.success" && event.data.id === "queued")
    expect(first).toBeLessThan(second)
  })
