import { createServer, request } from "node:http"
import { Server, connect } from "node:net"
import { Schema } from "effect"
import { digest } from "./ledger"
import type { Identity, Observation } from "./observe"

export type Role = "worker" | "reviewer"
export type Route = {
  endpoint: string
  model: string
  parameters: Record<string, string | number | boolean | null>
  credential: string | null
}
export type Admission = { identity: Identity; role: Role; deadline: number }
export type Transport = {
  boundary: "provider" | "script"
  role: Role
  origin: string
  event: Observation
}

/** No-auth HTTP is an explicit local gateway choice, never a remote transport fallback. */
export function routeURL(
  mode: "model" | "local-fixture",
  route: Omit<Route, "model" | "credential">,
  authenticated: boolean,
) {
  const url = new URL(route.endpoint)
  if (
    (mode === "local-fixture"
      ? url.protocol !== "http:" || url.hostname !== "127.0.0.1"
      : authenticated
        ? url.protocol !== "https:"
        : url.protocol !== "http:" || url.hostname !== "127.0.0.1") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/v1/chat/completions", "/v1/responses"].includes(url.pathname) ||
    Object.keys(route.parameters).some(
      (key) =>
        !(
          url.pathname === "/v1/responses"
            ? ["temperature", "top_p", "max_output_tokens", "reasoning_effort"]
            : ["temperature", "top_p", "seed", "max_tokens", "max_completion_tokens", "reasoning_effort"]
        ).includes(key),
    )
  )
    throw new Error("Invalid frozen provider route")
  return url
}

/** Credentials and role selection stay in the controller, outside the sandbox. */
export async function provider(input: {
  mode: "model" | "local-fixture"
  routes: Record<Role, Route>
  timeout: number
  identify: () => Promise<Admission>
  observe: (record: Transport) => void
  request: (record: Admission & { requestID: string; hash: string; bytes: number }) => void
  signal: AbortSignal
  scriptProtocol?: "route"
  script?: (admission: Admission, body: Record<string, unknown>) => Promise<Response | undefined>
}) {
  if (!Number.isSafeInteger(input.timeout) || input.timeout <= 0 || input.timeout > 900_000)
    throw new Error("Provider operation timeout must be within the production 15 minute limit")
  const routes = Object.fromEntries(
    Object.entries(input.routes).map(([role, route]) => {
      const url = routeURL(input.mode, route, route.credential !== null)
      if (!route.model || (route.credential !== null && (!route.credential || /[\r\n]/.test(route.credential))))
        throw new Error("Invalid frozen provider credential or model")
      return [role, { ...route, url }]
    }),
  ) as Record<Role, Route & { url: URL }>
  const sockets = new Set<import("node:net").Socket>()
  const active = new Set<string>()
  const cancellations = new Set<() => void>()
  const server = createServer((incoming, outgoing) => {
    outgoing.setHeader("connection", "close")
    const deny = (status: number) => {
      outgoing.writeHead(status)
      outgoing.end("Provider request denied")
    }
    if (
      input.signal.aborted ||
      incoming.method !== "POST" ||
      !["/v1/chat/completions", "/v1/responses"].includes(incoming.url ?? "") ||
      incoming.headers.authorization ||
      incoming.headers["proxy-authorization"] ||
      incoming.headers["x-api-key"]
    )
      return deny(403)
    const chunks: Buffer[] = []
    const size = { bytes: 0 }
    incoming.on("error", () => outgoing.destroy())
    incoming.on("data", (chunk: Buffer) => {
      size.bytes += chunk.length
      if (size.bytes > 16 * 1024 * 1024) return incoming.destroy()
      chunks.push(chunk)
    })
    incoming.on("end", () => {
      void (async () => {
        const admission = await input.identify()
        if (outgoing.destroyed) return
        if (input.signal.aborted || Date.now() >= admission.deadline) return deny(410)
        if (active.has(admission.identity.operationID)) return deny(409)
        const body = Schema.decodeUnknownSync(
          Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Schema.Record(Schema.String, Schema.Unknown))),
        )(Buffer.concat(chunks).toString("utf8"))
        const route = routes[admission.role]
        const pathname =
          input.script && input.scriptProtocol !== "route" && admission.role === "worker"
            ? "/v1/chat/completions"
            : route.url.pathname
        // The alias is checked, but never used to select role or destination.
        if (body.model !== admission.role || body.stream !== true || incoming.url !== pathname) return deny(403)
        // Responses must replay local history and use only local functions. Server-side
        // conversations, hosted tools and remote inputs would bypass the isolated host.
        if (
          pathname === "/v1/responses" &&
          (Object.keys(body).some(
            (key) =>
              ![
                "model",
                "stream",
                "input",
                "instructions",
                "tools",
                "tool_choice",
                "parallel_tool_calls",
                "max_output_tokens",
                "temperature",
                "top_p",
                "reasoning",
                "include",
                "store",
                "background",
                "text",
                "prompt_cache_key",
              ].includes(key),
          ) ||
            body.store !== false ||
            body.background === true ||
            body.previous_response_id !== undefined ||
            body.conversation !== undefined ||
            !Array.isArray(body.input) ||
            body.input.some((item) => !localInput(item)) ||
            !localChoice(body.tool_choice, body.tools) ||
            (body.tools !== undefined &&
              (!Array.isArray(body.tools) ||
                body.tools.some((tool) => !tool || typeof tool !== "object" || tool.type !== "function"))))
        )
          return deny(403)
        active.add(admission.identity.operationID)
        const cancellation = {
          run: () => {
            outgoing.destroy()
          },
        }
        const cancel = () => cancellation.run()
        cancellations.add(cancel)
        const timer = setTimeout(cancel, Math.min(input.timeout, admission.deadline - Date.now()))
        outgoing.once("close", () => {
          active.delete(admission.identity.operationID)
          cancellations.delete(cancel)
          clearTimeout(timer)
        })
        const scripted = await input.script?.(admission, body)
        if (outgoing.destroyed || input.signal.aborted || Date.now() >= admission.deadline) return outgoing.destroy()
        const requestID = crypto.randomUUID()
        const emit = (event: Observation) =>
          input.observe({
            boundary: scripted ? "script" : "provider",
            role: admission.role,
            origin: scripted ? "script:probe-worker" : route.url.origin,
            event,
          })
        const parameters = Object.fromEntries(
          Object.entries(route.parameters).filter(
            ([key]) => route.url.pathname !== "/v1/responses" || key !== "reasoning_effort",
          ),
        )
        const bytes = JSON.stringify({
          ...body,
          ...parameters,
          model: route.model,
          ...(pathname === "/v1/responses"
            ? {
                store: false,
                background: false,
                reasoning:
                  route.parameters.reasoning_effort === undefined
                    ? undefined
                    : { effort: route.parameters.reasoning_effort },
              }
            : {}),
        })
        input.request({ ...admission, requestID, hash: digest(bytes), bytes: Buffer.byteLength(bytes) })
        if (scripted) {
          outgoing.writeHead(scripted.status, { "content-type": "text/event-stream" })
          // Scripted worker requests are never counted as provider wire requests.
          outgoing.end(await scripted.text())
          return
        }
        const state = { captured: false, bytes: 0, truncated: false, status: undefined as number | undefined }
        const captured: Buffer[] = []
        const headers: Record<string, string> = {}
        const finish = (complete: boolean) => {
          if (state.captured) return
          state.captured = true
          emit({
            kind: "transport",
            at: performance.now(),
            identity: admission.identity,
            requestID,
            status: state.status,
            headers,
            body: Buffer.concat(captured).toString("base64"),
            complete,
            truncated: state.truncated,
          })
          emit({ kind: "complete", at: performance.now(), identity: admission.identity, requestID })
        }
        const https = route.url.protocol === "https:" ? await import("node:https") : undefined
        const transport = https?.request ?? request
        if (outgoing.destroyed || input.signal.aborted || Date.now() >= admission.deadline) return outgoing.destroy()
        const upstream = transport(
          route.url,
          {
            method: "POST",
            agent: false,
            // Do not forward candidate headers, cookies, authorization or proxy settings.
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream",
              ...(route.credential === null ? {} : { authorization: "Bearer " + route.credential }),
              "content-length": Buffer.byteLength(bytes),
            },
          },
          (response) => {
            if (state.captured) {
              response.destroy()
              return
            }
            state.status = response.statusCode
            for (const key of ["content-type", "x-request-id", "request-id"])
              if (typeof response.headers[key] === "string") headers[key] = response.headers[key]
            emit({ kind: "response", at: performance.now(), identity: admission.identity, requestID })
            response.on("data", (chunk: Buffer) => {
              if (state.captured) return
              state.bytes += chunk.length
              if (state.bytes > 16 * 1024 * 1024) {
                state.truncated = true
                upstream.destroy()
                outgoing.destroy()
                return
              }
              captured.push(Buffer.from(chunk))
            })
            response.once("end", () => finish(response.complete))
            response.once("error", () => {
              finish(false)
              outgoing.destroy()
            })
            response.once("close", () => finish(false))
            // No redirect following and no arbitrary response headers enter the sandbox.
            outgoing.writeHead(response.statusCode ?? 502, headers)
            response.pipe(outgoing)
          },
        )
        upstream.once("finish", () => {
          if (!state.captured) emit({ kind: "wire", at: performance.now(), identity: admission.identity, requestID })
        })
        upstream.once("error", () => {
          finish(false)
          outgoing.destroy()
        })
        cancellation.run = () => {
          finish(false)
          upstream.destroy()
          outgoing.destroy()
        }
        outgoing.once("close", () => {
          finish(false)
          upstream.destroy()
        })
        upstream.end(bytes)
      })().catch(() => {
        if (outgoing.headersSent) outgoing.destroy()
        else deny(503)
      })
    })
  })
  server.headersTimeout = input.timeout
  server.requestTimeout = input.timeout
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Provider listener unavailable")
  // Bound partial headers and bodies even on Bun, whose HTTP socket appears after headers.
  const entrance = new Server((socket) => {
    const relay = connect(address.port, "127.0.0.1")
    sockets.add(socket)
    sockets.add(relay)
    const timer = setTimeout(() => {
      socket.destroy()
      relay.destroy()
    }, input.timeout)
    socket.on("error", () => relay.destroy())
    relay.on("error", () => socket.destroy())
    socket.once("close", () => {
      clearTimeout(timer)
      relay.destroy()
      sockets.delete(socket)
      sockets.delete(relay)
    })
    relay.once("close", () => socket.destroy())
    socket.pipe(relay).pipe(socket)
  })
  const close = () => {
    for (const cancel of cancellations) cancel()
    for (const socket of sockets) socket.destroy()
    entrance.close()
    server.closeAllConnections()
    server.close()
    input.signal.removeEventListener("abort", close)
  }
  await new Promise<void>((resolve, reject) => {
    entrance.once("error", reject)
    entrance.listen(0, "127.0.0.1", resolve)
  })
  input.signal.addEventListener("abort", close, { once: true })
  const entry = entrance.address()
  if (!entry || typeof entry === "string") throw new Error("Provider entrance unavailable")
  if (input.signal.aborted) close()
  return { url: `http://127.0.0.1:${entry.port}/v1`, close }
}

function localInput(item: unknown) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false
  if ("type" in item && item.type === "reasoning")
    return "encrypted_content" in item && typeof item.encrypted_content === "string" && !!item.encrypted_content
  if ("type" in item && item.type === "function_call_output")
    return (
      "output" in item &&
      (typeof item.output === "string" ||
        (Array.isArray(item.output) && item.output.every((part) => localContent(part))))
    )
  if ("type" in item && item.type === "function_call") return !("file_id" in item || "image_url" in item)
  if ("type" in item && item.type !== "message") return false
  if (!("content" in item)) return false
  return (
    typeof item.content === "string" ||
    (Array.isArray(item.content) && item.content.every((part) => localContent(part, true)))
  )
}

function localContent(part: unknown, allowOutputText = false) {
  if (!part || typeof part !== "object" || Array.isArray(part) || Object.keys(part).length !== 2 || !("type" in part))
    return false
  if (part.type === "input_text" || (allowOutputText && part.type === "output_text"))
    return "text" in part && typeof part.text === "string"
  if (part.type !== "input_image" || !("image_url" in part) || typeof part.image_url !== "string") return false
  const data = /^data:image\/(?:png|jpeg|gif|webp);base64,(.+)$/s.exec(part.image_url)?.[1]
  // Buffer's decoder tolerates malformed base64; round-tripping rejects it and
  // matches the canonical local media bytes emitted by the LLM client.
  return !!data && Buffer.from(data, "base64").toString("base64") === data
}

function localChoice(choice: unknown, tools: unknown) {
  if (choice === undefined) return true
  if (typeof choice === "string") return ["auto", "none", "required"].includes(choice)
  return (
    !!choice &&
    typeof choice === "object" &&
    "type" in choice &&
    choice.type === "function" &&
    "name" in choice &&
    typeof choice.name === "string" &&
    Array.isArray(tools) &&
    tools.some(
      (tool: unknown) =>
        !!tool &&
        typeof tool === "object" &&
        "type" in tool &&
        tool.type === "function" &&
        "name" in tool &&
        tool.name === choice.name,
    )
  )
}
