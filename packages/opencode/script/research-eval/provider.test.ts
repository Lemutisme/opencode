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

const inlinePNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhN8AAAAASUVORK5CYII="

const contentCases = [
  {
    name: "accepts multipart text including bash warnings",
    content: [
      { type: "input_text", text: "loss: 13.0\ngradient: [4.0, 6.0]\n" },
      { type: "input_text", text: "Warnings:\nA local warning.\nCommand exited with code 0." },
    ],
    status: 200,
  },
  {
    name: "accepts text and an inline PNG in order",
    content: [
      { type: "input_text", text: "Image read successfully" },
      { type: "input_image", image_url: inlinePNG },
      { type: "input_text", text: "End of local output" },
    ],
    status: 200,
  },
  { name: "accepts an empty array", content: [], status: 200 },
  { name: "accepts empty text", content: [{ type: "input_text", text: "" }], status: 200 },
  ...["png", "jpeg", "gif", "webp"].map((mime, index) => ({
    name: `accepts canonical image/${mime} data URL syntax`,
    content: [
      { type: "input_image", image_url: `data:image/${mime};base64,${["AA==", "AAE=", "AAEC", "AAECAw=="][index]}` },
    ],
    status: 200,
  })),
  { name: "rejects a non-array object", content: { type: "input_text", text: "local" }, status: 403 },
  { name: "rejects null content", content: null, status: 403 },
  { name: "rejects numeric content", content: 42, status: 403 },
  { name: "rejects a null part", content: [null], status: 403 },
  { name: "rejects a string part", content: ["local"], status: 403 },
  { name: "rejects a nested array", content: [[{ type: "input_text", text: "local" }]], status: 403 },
  { name: "rejects missing text", content: [{ type: "input_text" }], status: 403 },
  { name: "rejects non-string text", content: [{ type: "input_text", text: 42 }], status: 403 },
  { name: "rejects non-string image URL", content: [{ type: "input_image", image_url: null }], status: 403 },
  { name: "rejects a file ID", content: [{ type: "input_image", file_id: "private" }], status: 403 },
  {
    name: "rejects a file ID alongside inline bytes",
    content: [{ type: "input_image", image_url: inlinePNG, file_id: "private" }],
    status: 403,
  },
  { name: "rejects an item reference", content: [{ type: "item_reference", id: "private" }], status: 403 },
  { name: "rejects an input file", content: [{ type: "input_file", file_id: "private" }], status: 403 },
  { name: "rejects an unknown part type", content: [{ type: "unknown", text: "local" }], status: 403 },
  { name: "rejects extra text fields", content: [{ type: "input_text", text: "local", extra: true }], status: 403 },
  {
    name: "rejects a remote URL hidden beside text",
    content: [{ type: "input_text", text: "local", image_url: "https://example.org/image.png" }],
    status: 403,
  },
  {
    name: "rejects extra image fields",
    content: [{ type: "input_image", image_url: inlinePNG, detail: "auto" }],
    status: 403,
  },
  {
    name: "rejects a mixed array with one remote part",
    content: [
      { type: "input_text", text: "local" },
      { type: "input_image", image_url: "https://example.org/image.png" },
    ],
    status: 403,
  },
  ...[
    "http://example.org/image.png",
    "https://example.org/image.png",
    "file:///private/image.png",
    "blob:https://example.org/image",
    "data:image/png;base64,",
    "data:image/png,AA==",
    "data:image/png;base64AA==",
    "data:image/png;charset=utf-8;base64,AA==",
    "data:image/png;base64,A",
    "data:image/png;base64,AA",
    "data:image/png;base64,AA===",
    "data:image/png;base64,AB==",
    "data:image/png;base64,AA*=",
    "data:image/png;base64,AA-_",
    "data:image/png;base64, AA==",
    "data:image/png;base64,AA==\n",
    "data:image/png;base64,AA==#fragment",
    "data:image/png;base64,%41%41%3D%3D",
    "data:image/svg+xml;base64,AA==",
    "data:image/avif;base64,AA==",
    "data:image/jpg;base64,AA==",
    "data:text/plain;base64,AA==",
  ].map((image_url) => ({
    name: `rejects image URL ${JSON.stringify(image_url)}`,
    content: [{ type: "input_image", image_url }],
    status: 403,
  })),
]

for (const sample of [
  { name: "accepts system text", input: [{ role: "system", content: "Local system instructions" }], status: 200 },
  {
    name: "accepts assistant output text",
    input: [{ role: "assistant", content: [{ type: "output_text", text: "Local response" }] }],
    status: 200,
  },
  {
    name: "accepts stateless reasoning without an item ID",
    input: [
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Local summary" }],
        encrypted_content: "local-state",
      },
    ],
    status: 200,
  },
  {
    name: "accepts a local function call",
    input: [{ type: "function_call", call_id: "call", name: "read", arguments: '{"filePath":"local.png"}' }],
    status: 200,
  },
  ...["local output", "", "https://example.org is literal text, not an image reference"].map((output) => ({
    name: `accepts string function output ${JSON.stringify(output)}`,
    input: [{ type: "function_call_output", call_id: "call", output }],
    status: 200,
  })),
  {
    name: "rejects output_text in a function output",
    input: [{ type: "function_call_output", call_id: "call", output: [{ type: "output_text", text: "local" }] }],
    status: 403,
  },
  { name: "rejects a stored item reference", input: [{ type: "item_reference", id: "private" }], status: 403 },
  ...[undefined, null, ""].map((encrypted_content) => ({
    name: `rejects reasoning without usable inline state (${String(encrypted_content)})`,
    input: [{ type: "reasoning", id: "private", summary: [], encrypted_content }],
    status: 403,
  })),
  ...["web_search_call", "file_search_call", "code_interpreter_call", "mcp_call"].map((type) => ({
    name: `rejects hosted item ${type}`,
    input: [{ type, id: "private" }],
    status: 403,
  })),
  ...contentCases.flatMap((sample) => [
    {
      name: `function output ${sample.name}`,
      input: [{ type: "function_call_output", call_id: "call", output: sample.content }],
      status: sample.status,
    },
    {
      name: `user content ${sample.name}`,
      input: [{ role: "user", content: sample.content }],
      status: sample.status,
    },
  ]),
])
  test(`Responses input ${sample.name}`, async () => {
    const seen: unknown[] = []
    const upstream = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      seen.push(JSON.parse(Buffer.concat(chunks).toString()))
      outgoing.writeHead(200, { "content-type": "text/event-stream" })
      outgoing.end("data: [DONE]\n\n")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const route = {
      endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/responses`,
      model: "frozen-local-model",
      parameters: {},
      credential: null,
    }
    const proxy = await provider({
      mode: "model",
      routes: { worker: route, reviewer: route },
      timeout: 2000,
      signal: new AbortController().signal,
      identify: async () => ({ identity, role: "worker", deadline: Date.now() + 5000 }),
      observe: () => {},
      request: () => {},
    })
    try {
      const body = { model: "worker", stream: true, store: false, input: sample.input }
      const result = await fetch(proxy.url + "/responses", { method: "POST", body: JSON.stringify(body) })
      expect(result.status).toBe(sample.status)
      expect(await result.text()).toBe(sample.status === 200 ? "data: [DONE]\n\n" : "Provider request denied")
      expect(seen).toEqual(sample.status === 200 ? [{ ...body, model: route.model, background: false }] : [])
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
