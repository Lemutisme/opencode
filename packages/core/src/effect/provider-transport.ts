import { request, type IncomingMessage } from "node:http"
import { Readable } from "node:stream"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { RequestExecutor } from "@opencode-ai/llm/route"

/** Model-only local transport; ordinary HTTP tools keep their default client. */
export function providerFetch(socket: string): typeof fetch {
  if (!socket.startsWith("/") || socket.includes("\0")) throw new Error("Provider socket must be an absolute path")
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (
        url.origin !== "http://programbench-provider.invalid" ||
        url.pathname !== "/v1/responses" ||
        url.search ||
        url.username ||
        url.password
      )
        throw new Error("Offline model channel refuses this endpoint")
      const outgoing = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      if (outgoing.method !== "POST") throw new Error("Offline model channel only accepts inference requests")
      const body = Buffer.from(await outgoing.arrayBuffer())
      outgoing.signal.throwIfAborted()
      // Bun fetch has a separate 300s inactivity limit. Session execution owns
      // model timeouts; this socket must obey its AbortSignal instead.
      return new Promise<Response>((resolve, reject) => {
        let incoming: IncomingMessage | undefined
        const call = request({
          socketPath: socket,
          path: url.pathname,
          method: outgoing.method,
          headers: {
            ...Object.fromEntries(outgoing.headers),
            host: url.host,
            "content-length": String(body.byteLength),
          },
          timeout: 0,
          agent: false,
        })
        const abort = () => {
          const error =
            outgoing.signal.reason instanceof Error ? outgoing.signal.reason : new Error("Provider request aborted")
          incoming?.destroy(error)
          call.destroy(error)
          reject(error)
        }
        outgoing.signal.addEventListener("abort", abort, { once: true })
        call.once("close", () => {
          if (!incoming) outgoing.signal.removeEventListener("abort", abort)
        })
        call.once("error", reject)
        call.once("response", (response) => {
          incoming = response
          response.once("close", () => outgoing.signal.removeEventListener("abort", abort))
          if (response.headers["x-programbench-transport-error"] === "upstream_connection_failed") {
            response.resume()
            reject(Object.assign(new Error("Provider gateway transport failed"), { code: "EPROVIDERTRANSPORT" }))
            return
          }
          const headers = new Headers()
          response.rawHeaders.forEach((value, index) => {
            if (index % 2 === 0) headers.append(value, response.rawHeaders[index + 1])
          })
          // Node and Bun expose different ReadableStream type surfaces. Bridge
          // with backpressure and cancellation rather than asserting BodyInit.
          const reader = Readable.toWeb(response).getReader()
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              const next = await reader.read()
              if (next.done) return controller.close()
              controller.enqueue(next.value)
            },
            cancel: (reason) => reader.cancel(reason),
          })
          resolve(
            new Response(response.statusCode === 204 || response.statusCode === 304 ? null : body, {
              status: response.statusCode,
              statusText: response.statusMessage,
              headers,
            }),
          )
        })
        call.end(body)
      })
    },
    { preconnect: () => undefined },
  )
}

export function layerWith(socket?: string) {
  return Layer.effect(
    RequestExecutor.Service,
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      if (!socket) return executor
      const transport = providerFetch(socket)
      return RequestExecutor.Service.of({
        execute: (request) => executor.execute(request).pipe(Effect.provideService(FetchHttpClient.Fetch, transport)),
      })
    }),
  ).pipe(Layer.provide(RequestExecutor.layer))
}

export const layer = Layer.unwrap(Effect.sync(() => layerWith(process.env.OPENCODE_PROVIDER_SOCKET)))

export * as ProviderTransport from "./provider-transport"
