import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { connect } from "node:net"
import { provider, routeURL, type Transport } from "./provider"

const identity = { contractID: "contract", jobID: "job", operationID: "operation", sessionID: "session" }

test("trusted provider fixes role, model and credentials; rejects candidate routing and headers", async () => {
  const seen: { headers: import("node:http").IncomingHttpHeaders; body: string }[] = []
  const upstream = createServer(async (incoming, outgoing) => {
    const body: Buffer[] = []
    for await (const chunk of incoming) body.push(Buffer.from(chunk))
    seen.push({ headers: incoming.headers, body: Buffer.concat(body).toString() })
    outgoing.writeHead(200, {
      "content-type": "text/event-stream",
      "x-request-id": "upstream-id",
      "set-cookie": "private=secret",
    })
    outgoing.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address() as { port: number }
  const route = {
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    model: "frozen-model",
    parameters: { temperature: 0 },
    credential: "fixture-secret",
  }
  const records: Transport[] = []
  const controller = new AbortController()
  const proxy = await provider({
    mode: "local-fixture",
    routes: { worker: route, reviewer: route },
    timeout: 2000,
    signal: controller.signal,
    identify: async () => ({ identity, role: "reviewer", deadline: Date.now() + 5000 }),
    observe: (record) => records.push(record),
    request: () => {},
  })
  try {
    const send = (body: unknown, headers?: Record<string, string>, url = proxy.url + "/chat/completions") =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
    expect((await send({ model: "worker", stream: true })).status).toBe(403)
    expect((await send({ model: "reviewer", stream: true }, { authorization: "Bearer candidate" })).status).toBe(403)
    expect((await send({ model: "reviewer", stream: true }, {}, proxy.url + "/responses")).status).toBe(403)
    expect(
      (await send({ model: "reviewer", stream: true }, {}, proxy.url + "/chat/completions?url=https://evil")).status,
    ).toBe(403)
    expect(seen).toHaveLength(0)
    const result = await send(
      { model: "reviewer", stream: true, temperature: 1, messages: [] },
      { "x-arbitrary": "do-not-forward" },
    )
    expect(await result.text()).toBe("data: [DONE]\n\n")
    expect(result.headers.get("set-cookie")).toBeNull()
    expect(seen).toHaveLength(1)
    expect(seen[0].headers.authorization).toBe("Bearer fixture-secret")
    expect(seen[0].headers["x-arbitrary"]).toBeUndefined()
    expect(JSON.parse(seen[0].body)).toMatchObject({ model: "frozen-model", temperature: 0 })
    expect(records.map((item) => item.event.kind)).toEqual(["wire", "response", "transport", "complete"])
    expect(records.find((item) => item.event.kind === "transport")?.event).toMatchObject({
      complete: true,
      headers: { "x-request-id": "upstream-id" },
    })
    expect(JSON.stringify(records)).not.toContain("fixture-secret")
  } finally {
    proxy.close()
    upstream.closeAllConnections()
    upstream.close()
  }
  await expect(
    provider({
      mode: "model",
      routes: { worker: route, reviewer: route },
      timeout: 1000,
      signal: controller.signal,
      identify: async () => ({ identity, role: "worker", deadline: Date.now() }),
      observe: () => {},
      request: () => {},
    }),
  ).rejects.toThrow("Invalid frozen")
})

for (const protocol of ["chat/completions", "responses"])
  test(`original deadline cancels a partial ${protocol} stream and denies resumed admission`, async () => {
    const calls = { count: 0 }
    const upstream = createServer((_incoming, outgoing) => {
      calls.count++
      outgoing.writeHead(200, { "content-type": "text/event-stream" })
      outgoing.write("data: partial\n\n")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const route = {
      endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/${protocol}`,
      model: "fixture",
      parameters: {},
      credential: "fixture-only",
    }
    const deadline = Date.now() + 300
    const records: Transport[] = []
    const controller = new AbortController()
    const proxy = await provider({
      mode: "local-fixture",
      routes: { worker: route, reviewer: route },
      timeout: 2000,
      signal: controller.signal,
      identify: async () => ({ identity, role: "worker", deadline }),
      observe: (item) => records.push(item),
      request: () => {},
    })
    try {
      const send = () =>
        fetch(proxy.url + "/" + protocol, {
          method: "POST",
          body: JSON.stringify({ model: "worker", stream: true, store: false, input: [] }),
        })
      const response = await send()
      await response.text().catch(() => "interrupted")
      expect(Date.now()).toBeLessThan(deadline + 500)
      expect((await send()).status).toBe(410)
      expect(calls.count).toBe(1)
      const partial = records.find((item) => item.event.kind === "transport")?.event
      expect(partial).toMatchObject({ complete: false, body: Buffer.from("data: partial\n\n").toString("base64") })
    } finally {
      proxy.close()
      upstream.closeAllConnections()
      upstream.close()
    }
  })

test("explicit no-auth local Responses route preserves tools and usage without hosted execution", async () => {
  const seen: { authorization?: string; body: Record<string, unknown> }[] = []
  const response =
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}}\n\n'
  const upstream = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    seen.push({ authorization: incoming.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) })
    outgoing.writeHead(200, { "content-type": "text/event-stream" })
    outgoing.end(response)
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const route = {
    endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/responses`,
    model: "frozen-local-model",
    parameters: { reasoning_effort: "low" },
    credential: null,
  }
  const records: Transport[] = []
  const proxy = await provider({
    mode: "model",
    routes: { worker: route, reviewer: route },
    timeout: 2000,
    signal: new AbortController().signal,
    identify: async () => ({ identity, role: "worker", deadline: Date.now() + 5000 }),
    request: () => {},
    observe: (item) => records.push(item),
  })
  const body = {
    model: "worker",
    stream: true,
    store: false,
    input: [{ role: "user", content: [{ type: "input_text", text: "Use the local function" }] }],
    tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
    reasoning: { effort: "high" },
  }
  const send = (extra: Record<string, unknown>, suffix = "/responses") =>
    fetch(proxy.url + suffix, {
      method: "POST",
      body: JSON.stringify({ ...body, ...extra }),
    })
  try {
    for (const extra of [
      { store: true },
      { background: true },
      { previous_response_id: "private" },
      { conversation: "private" },
      { prompt: { id: "stored" } },
      { tools: [{ type: "web_search" }] },
      { tool_choice: { type: "web_search" } },
      { tool_choice: { type: "allowed_tools", tools: [{ type: "web_search" }] } },
      { tool_choice: { type: "function", name: "undeclared" } },
      { input: [{ type: "item_reference", id: "private" }] },
      { input: [{ type: "reasoning", id: "private", summary: [] }] },
      { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.org" }] }] },
      { input: [{ type: "function_call_output", output: [{ type: "input_file", file_id: "private" }] }] },
    ])
      expect((await send(extra)).status).toBe(403)
    expect((await send({}, "/chat/completions")).status).toBe(403)
    expect(seen).toHaveLength(0)
    expect(await (await send({})).text()).toBe(response)
    expect(seen).toEqual([
      {
        authorization: undefined,
        body: {
          ...body,
          model: "frozen-local-model",
          background: false,
          reasoning: { effort: "low" },
        },
      },
    ])
    expect(records.find((item) => item.event.kind === "transport")?.event).toMatchObject({
      complete: true,
      body: Buffer.from(response).toString("base64"),
    })
    const replay = [{ type: "reasoning", id: "local", summary: [], encrypted_content: "retained-local-content" }]
    expect(await (await send({ input: replay, tool_choice: { type: "function", name: "read" } })).text()).toBe(response)
    expect(seen[1].body.input).toEqual(replay)
    for (const endpoint of [
      "http://example.org/v1/responses",
      "https://example.org/v1/responses",
      "http://localhost/v1/responses",
      route.endpoint + "?x=1",
    ])
      expect(() => routeURL("model", { ...route, endpoint }, false)).toThrow("Invalid frozen")
    expect(() => routeURL("model", route, true)).toThrow("Invalid frozen")
    expect(() => routeURL("model", { ...route, parameters: { seed: 1 } }, false)).toThrow("Invalid frozen")
  } finally {
    proxy.close()
    upstream.closeAllConnections()
    upstream.close()
  }
})

test("explicit cancellation and partial request headers cannot leave live sockets", async () => {
  const reached = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const upstream = createServer((_incoming, outgoing) => {
    outgoing.writeHead(200)
    outgoing.write("partial")
    reached.resolve()
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const route = {
    endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/chat/completions`,
    model: "fixture",
    parameters: {},
    credential: "fixture-only",
  }
  const controller = new AbortController()
  const proxy = await provider({
    mode: "local-fixture",
    routes: { worker: route, reviewer: route },
    timeout: 300,
    signal: controller.signal,
    identify: async () => ({ identity, role: "worker", deadline: Date.now() + 10_000 }),
    observe: (item) => {
      if (item.event.kind === "transport" && !item.event.complete) closed.resolve()
    },
    request: () => {},
  })
  try {
    const socket = connect(Number(new URL(proxy.url).port), "127.0.0.1")
    const ended = new Promise<void>((resolve) => socket.once("close", resolve))
    socket.on("error", () => {})
    socket.resume()
    socket.write("POST /v1/chat/completions HTTP/1.1\r\n")
    await ended
    const response = fetch(proxy.url + "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "worker", stream: true }),
    })
      .then((r) => r.text())
      .catch(() => "cancelled")
    await reached.promise
    controller.abort()
    await response
    await closed.promise
  } finally {
    proxy.close()
    upstream.closeAllConnections()
    upstream.close()
  }
})
