import { expect, test } from "bun:test"
import { createServer, request } from "node:http"
import { connect } from "node:net"
import {
  cleanup,
  gateway,
  processIdentity,
  sameProcess,
  window,
  type Identity,
  type Observation,
  type ProcessIdentity,
} from "./observe"

const identity: Identity = { contractID: "contract", jobID: "job", operationID: "op", sessionID: "session" }
const process: ProcessIdentity = {
  pid: 10,
  parent: 2,
  start: "123",
  boot: "boot",
  state: "S",
  argv: ["node", "--permission", "acceptance.mjs"],
  executable: "/usr/bin/node",
  directory: "/candidate",
}
const kill: Observation = { kind: "kill", at: 4, identity, host: { ...process, pid: 2, parent: 1 } }

test("fault coverage requires the declared transport/process window and preserves misses", () => {
  const begin: Observation = { kind: "begin", at: 1, identity }
  const wire: Observation = { kind: "wire", at: 2, identity, requestID: "request" }
  const done: Observation = { kind: "complete", at: 3, identity, requestID: "request" }
  expect(window([begin], "provider")).toBe("not_injected")
  expect(window([begin, kill], "provider")).toBe("injection_miss")
  expect(window([begin, wire, kill], "provider")).toBe("injected")
  expect(window([begin, wire, done, kill], "provider")).toBe("injection_miss")
  expect(window([begin, { ...wire, identity: { ...identity, operationID: "other" } }, kill], "provider")).toBe(
    "injection_miss",
  )
  expect(window([begin, wire, done, { ...wire, at: 3.5, requestID: "retry" }, kill], "provider")).toBe("injected")
  const spawn: Observation = { kind: "spawn", at: 2, identity, process }
  const alive: Observation = { kind: "alive", at: 3, identity, process }
  expect(window([begin, kill], "test_process")).toBe("injection_miss")
  expect(window([begin, spawn, alive, kill], "test_process")).toBe("injected")
  expect(window([begin, spawn, alive, { kind: "exit", at: 3.5, identity, process }, kill], "test_process")).toBe(
    "injection_miss",
  )
  expect(
    window([begin, spawn, alive, { ...spawn, at: 3.5, process: { ...process, start: "456" } }, kill], "test_process"),
  ).toBe("injection_miss")
  expect(sameProcess(process, { ...process, start: "456" })).toBe(false)
})

test("gateway records real wire and response events, including every request beyond the old 3000 limit", async () => {
  const upstream = createServer((_request, response) => response.end("ok"))
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  if (!address || typeof address === "string") throw new Error("No test listener")
  const events: Observation[] = []
  const proxy = await gateway({
    upstream: new URL(`http://127.0.0.1:${address.port}`),
    timeout: 5000,
    identify: async () => identity,
    observe: (event) => events.push(event),
  })
  try {
    // Sequential requests exercise the gateway itself; no finite sentinel or count-reset route.
    for (let count = 0; count < 3002; count++)
      expect(await (await fetch(new URL("/v1/chat/completions", proxy.url), { method: "POST" })).text()).toBe("ok")
    expect(events.filter((event) => event.kind === "wire")).toHaveLength(3002)
    expect(events.filter((event) => event.kind === "response")).toHaveLength(3002)
    expect(events.filter((event) => event.kind === "complete")).toHaveLength(3002)
    expect(
      events.filter(
        (event) =>
          event.kind === "transport" && event.complete && Buffer.from(event.body, "base64").toString() === "ok",
      ),
    ).toHaveLength(3002)
    expect(new Set(events.filter((event) => "requestID" in event).map((event) => event.requestID)).size).toBe(3002)
  } finally {
    proxy.close()
    upstream.closeAllConnections()
    upstream.close()
  }
}, 30_000)

test("OS observer distinguishes a live process from its exited identity and cleans it", async () => {
  const child = Bun.spawn(["/usr/bin/node", "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" })
  const identity = await processIdentity(child.pid)
  expect(identity).toBeDefined()
  expect(sameProcess(identity!, await processIdentity(child.pid))).toBe(true)
  await cleanup([identity!])
  await child.exited
  expect(sameProcess(identity!, await processIdentity(child.pid))).toBe(false)
})

test("gateway denies absolute targets, alternate origins, methods and routes", async () => {
  const seen: string[] = []
  const upstream = createServer((request, response) => {
    seen.push(request.url!)
    response.end("provider")
  })
  const privateServer = createServer((_request, response) => {
    seen.push("LEAK")
    response.end("private")
  })
  await Promise.all(
    [upstream, privateServer].map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
  )
  const address = upstream.address()
  const secret = privateServer.address()
  if (!address || typeof address === "string" || !secret || typeof secret === "string")
    throw new Error("Missing listener")
  const proxy = await gateway({
    upstream: new URL(`http://127.0.0.1:${address.port}`),
    timeout: 150,
    identify: async () => identity,
    observe: () => {},
  })
  try {
    for (const target of [
      `http://127.0.0.1:${secret.port}/private`,
      `//127.0.0.1:${secret.port}/private`,
      "/private",
      "/v1/chat/completions?redirect=private",
    ]) {
      const status = await new Promise((resolve, reject) => {
        const call = request(
          { hostname: proxy.url.hostname, port: proxy.url.port, path: target, method: "POST" },
          (response) => {
            response.resume()
            resolve(response.statusCode)
          },
        )
        call.on("error", reject)
        call.end()
      })
      expect(status).toBe(403)
    }
    expect((await fetch(new URL("/v1/responses", proxy.url))).status).toBe(403)
    expect(await (await fetch(new URL("/v1/responses", proxy.url), { method: "POST" })).text()).toBe("provider")
    expect(seen).toEqual(["/v1/responses"])
    for (const wire of [
      "POST /v1/responses HTTP/1.1\r\nHost: local\r\n",
      "POST /v1/responses HTTP/1.1\r\nHost: local\r\nContent-Length: 100\r\n\r\nincomplete",
    ]) {
      const started = performance.now()
      await new Promise<void>((resolve, reject) => {
        const socket = connect(Number(proxy.url.port), proxy.url.hostname, () => socket.write(wire))
        const timer = setTimeout(() => {
          socket.destroy()
          reject(new Error("Unbounded gateway input"))
        }, 1500)
        socket.on("error", () => {})
        socket.on("close", () => {
          clearTimeout(timer)
          resolve()
        })
      })
      expect(performance.now() - started).toBeLessThan(1000)
    }
  } finally {
    proxy.close()
    for (const server of [upstream, privateServer]) {
      server.closeAllConnections()
      server.close()
    }
  }
})
