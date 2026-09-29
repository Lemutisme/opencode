import { expect, test } from "bun:test"
import { ProviderTransport } from "../src/effect/provider-transport.js"

test("model socket preserves HTTP framing, status and caller cancellation", async () => {
  const socket = `/tmp/provider-transport-${crypto.randomUUID()}.sock`
  const received: { host: string | null; length: string | null; body: string }[] = []
  const server = Bun.serve({
    unix: socket,
    async fetch(request) {
      const body = await request.text()
      received.push({ host: request.headers.get("host"), length: request.headers.get("content-length"), body })
      if (body === "gateway-failure")
        return new Response("provider transport failed", {
          status: 502,
          headers: { "x-programbench-transport-error": "upstream_connection_failed" },
        })
      if (body === "wait")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": open\n\n"))
            },
          }),
        )
      return new Response("status retained", { status: 429 })
    },
  })
  const endpoint = "http://programbench-provider.invalid/v1/responses"
  const transport = ProviderTransport.providerFetch(socket)
  try {
    const response = await transport(endpoint, { method: "POST", body: "hello" })
    expect(response.status).toBe(429)
    expect(await response.text()).toBe("status retained")
    expect(received[0]).toEqual({ host: "programbench-provider.invalid", length: "5", body: "hello" })
    const controller = new AbortController()
    const pending = await transport(endpoint, { method: "POST", body: "wait", signal: controller.signal })
    const text = pending.text()
    controller.abort()
    await expect(text).rejects.toBeInstanceOf(Error)
    await expect(transport("https://example.com/", { method: "POST" })).rejects.toThrow("refuses")
    await expect(transport(endpoint)).rejects.toThrow("only accepts")
    await expect(transport(endpoint, { method: "POST", body: "gateway-failure" })).rejects.toMatchObject({
      code: "EPROVIDERTRANSPORT",
    })
    expect(received).toHaveLength(3)
  } finally {
    server.stop(true)
  }
})
