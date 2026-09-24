import { readFile, readdir, readlink } from "node:fs/promises"
import { createServer, request } from "node:http"
import { Server, connect } from "node:net"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"

export type ProcessIdentity = {
  pid: number
  parent: number
  start: string
  boot: string
  state: string
  argv: string[]
  executable: string
  directory: string
}
export type Identity = { contractID: string; jobID: string; operationID: string; sessionID: string }
export type Observation =
  | { kind: "begin"; at: number; identity: Identity }
  | { kind: "wire" | "response" | "complete"; at: number; identity: Identity; requestID: string }
  | { kind: "spawn" | "alive" | "exit" | "cleaned"; at: number; identity: Identity; process: ProcessIdentity }
  | {
      kind: "transport"
      at: number
      identity: Identity
      requestID: string
      status?: number
      headers: Record<string, string>
      body: string
      complete: boolean
      truncated: boolean
    }
  | { kind: "kill"; at: number; identity: Identity; host: ProcessIdentity }

export function window(events: readonly Observation[], kind: "provider" | "test_process") {
  const killed = events.find((item) => item.kind === "kill")
  if (!killed) return "not_injected" as const
  const matching = events.filter((item) => JSON.stringify(item.identity) === JSON.stringify(killed.identity))
  if (kind === "provider") {
    return matching.some(
      (item) =>
        (item.kind === "wire" || item.kind === "response") &&
        item.at <= killed.at &&
        !matching.some((end) => end.kind === "complete" && end.requestID === item.requestID && end.at <= killed.at),
    )
      ? ("injected" as const)
      : ("injection_miss" as const)
  }
  const alive = matching.findLast((item) => item.kind === "alive" && item.at <= killed.at)
  if (!alive || !("process" in alive)) return "injection_miss" as const
  const same = (item: ProcessIdentity) =>
    item.pid === alive.process.pid && item.start === alive.process.start && item.boot === alive.process.boot
  return matching.some((item) => item.kind === "spawn" && same(item.process) && item.at <= alive.at) &&
    !matching.some(
      (item) =>
        (item.kind === "exit" || item.kind === "spawn") &&
        "process" in item &&
        item.process.pid === alive.process.pid &&
        (item.kind === "exit" || !same(item.process)) &&
        item.at >= alive.at &&
        item.at <= killed.at,
    )
    ? ("injected" as const)
    : ("injection_miss" as const)
}

export async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  return Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile(`/proc/${pid}/cmdline`, "utf8"),
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readlink(`/proc/${pid}/exe`),
    readlink(`/proc/${pid}/cwd`),
  ]).then(
    ([stat, command, boot, executable, directory]) => {
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      return {
        pid,
        parent: Number(fields[1]),
        start: fields[19],
        boot: boot.trim(),
        state: fields[0],
        argv: command.split("\0").filter(Boolean),
        executable,
        directory,
      }
    },
    () => undefined,
  )
}

export const sameProcess = (a: ProcessIdentity, b: ProcessIdentity | undefined) =>
  !!b && a.pid === b.pid && a.start === b.start && a.boot === b.boot && !["Z", "X"].includes(b.state)

export function active(
  operations: readonly ProContractJob.Operation[],
  jobID: string,
  kind: "provider" | "verification",
): Identity {
  const matched = operations.filter(
    (item) => item.kind === kind && item.source.jobID === jobID && item.status === "running",
  )
  if (matched.length !== 1) throw new Error("Fault observation requires exactly one matching active operation")
  const item = matched[0]
  return { contractID: item.source.contractID, jobID, operationID: item.id, sessionID: item.source.sessionID }
}

// Read /proc from an independent controller. Do not trust files or PIDs supplied by candidate code.
export async function testProcess(host: ProcessIdentity, executable: string, harness: string) {
  if (!sameProcess(host, await processIdentity(host.pid))) return undefined
  const pending = [host.pid]
  const seen = new Set<number>()
  while (pending.length) {
    const pid = pending.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    const threads = await readdir(`/proc/${pid}/task`).catch(() => [])
    const ids = (
      await Promise.all(
        threads.map((thread) => readFile(`/proc/${pid}/task/${thread}/children`, "utf8").catch(() => "")),
      )
    ).flatMap((text) => text.trim().split(/\s+/).filter(Boolean).map(Number))
    for (const id of new Set(ids)) {
      const child = await processIdentity(id)
      if (!child || child.parent !== pid) continue
      if (
        child.executable === executable &&
        child.argv.includes("--permission") &&
        child.argv.some((arg) => arg === harness || arg.endsWith("/" + harness))
      )
        return child
      pending.push(id)
    }
  }
  return undefined
}

export async function killAtProcess(
  host: ProcessIdentity,
  process: ProcessIdentity,
  identity: Identity,
  events: Observation[],
) {
  const current = await processIdentity(process.pid)
  if (!sameProcess(process, current) || !sameProcess(host, await processIdentity(host.pid))) return false
  events.push({ kind: "alive", at: performance.now(), identity, process: current! })
  processKill(host.pid)
  // A second OS observation after the signal establishes that the test process spanned injection.
  const after = await processIdentity(process.pid)
  events.push({ kind: "kill", at: performance.now(), identity, host })
  if (!sameProcess(process, after)) events.push({ kind: "exit", at: events.at(-1)!.at, identity, process })
  return sameProcess(process, after)
}

function processKill(pid: number) {
  process.kill(pid, "SIGKILL")
}

export async function cleanup(processes: readonly ProcessIdentity[]) {
  await Promise.all(
    processes.map(async (item) => {
      if (sameProcess(item, await processIdentity(item.pid))) processKill(item.pid)
    }),
  )
  const deadline = performance.now() + 5000
  while (performance.now() < deadline) {
    if (
      (await Promise.all(processes.map((item) => processIdentity(item.pid)))).every(
        (item, index) => !sameProcess(processes[index], item),
      )
    )
      return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Old test processes remain live; recovery forbidden")
}

// Bounded transparent HTTP gateway, suitable for a local selfcheck upstream or a frozen HTTP deployment proxy.
// The observer receives actual transport events, never an intent-to-fetch notification.
export async function gateway(input: {
  upstream: URL
  timeout: number
  identify: () => Promise<Identity>
  observe: (event: Observation) => void
}) {
  if (input.upstream.protocol !== "http:") throw new Error("Gateway requires a frozen HTTP deployment proxy")
  const headers = new WeakMap<object, ReturnType<typeof setTimeout>>()
  const server = createServer((incoming, outgoing) => {
    clearTimeout(headers.get(incoming.socket))
    outgoing.setHeader("connection", "close")
    // Request targets never choose an origin, port, query, or arbitrary upstream route.
    if (incoming.method !== "POST" || !["/v1/chat/completions", "/v1/responses"].includes(incoming.url ?? "")) {
      outgoing.writeHead(403, { connection: "close" })
      outgoing.end("Gateway route denied")
      return
    }
    const timer = setTimeout(() => {
      incoming.destroy()
      outgoing.destroy()
    }, input.timeout)
    outgoing.once("close", () => clearTimeout(timer))
    const chunks: Buffer[] = []
    const size = { value: 0 }
    incoming.on("data", (chunk: Buffer) => {
      size.value += chunk.length
      if (size.value > 16 * 1024 * 1024) {
        incoming.destroy()
        return
      }
      chunks.push(chunk)
    })
    incoming.on("error", () => outgoing.destroy())
    incoming.on("end", () => {
      void input.identify().then(
        (identity) => {
          if (outgoing.destroyed) return
          const requestID = crypto.randomUUID()
          const state = {
            complete: false,
            captured: false,
            bytes: 0,
            truncated: false,
            status: undefined as number | undefined,
          }
          const body: Buffer[] = []
          const responseHeaders: Record<string, string> = {}
          const capture = (complete: boolean) => {
            if (state.captured) return
            state.captured = true
            input.observe({
              kind: "transport",
              at: performance.now(),
              identity,
              requestID,
              status: state.status,
              headers: responseHeaders,
              body: Buffer.concat(body).toString("base64"),
              complete,
              truncated: state.truncated,
            })
          }
          const emit = (kind: "wire" | "response" | "complete") => {
            if (state.complete) return
            if (kind === "complete") state.complete = true
            input.observe({ kind, at: performance.now(), identity, requestID })
          }
          const target = new URL(input.upstream.origin)
          target.pathname = incoming.url!
          const upstream = request(
            target,
            {
              method: "POST",
              headers: { ...incoming.headers, host: target.host },
              timeout: input.timeout,
            },
            (response) => {
              state.status = response.statusCode
              for (const name of ["content-type", "x-request-id", "request-id"])
                if (typeof response.headers[name] === "string") responseHeaders[name] = response.headers[name]
              response.on("data", (chunk: Buffer) => {
                if (state.bytes + chunk.length > 16 * 1024 * 1024) {
                  state.truncated = true
                  capture(false)
                  upstream.destroy(new Error("Gateway response limit"))
                  return
                }
                state.bytes += chunk.length
                body.push(Buffer.from(chunk))
              })
              emit("response")
              outgoing.writeHead(response.statusCode ?? 502, response.headers)
              response.pipe(outgoing)
              response.once("end", () => {
                capture(true)
                emit("complete")
              })
              response.once("error", () => {
                capture(false)
                emit("complete")
                outgoing.destroy()
              })
              response.once("close", () => capture(false))
            },
          )
          upstream.once("finish", () => emit("wire"))
          upstream.once("timeout", () => upstream.destroy(new Error("Gateway operation timeout")))
          upstream.once("error", () => {
            capture(false)
            emit("complete")
            outgoing.destroy()
          })
          outgoing.once("close", () => upstream.destroy())
          upstream.end(Buffer.concat(chunks))
        },
        () => {
          outgoing.writeHead(503)
          outgoing.end("Operation identity unavailable")
        },
      )
    })
  })
  server.on("connection", (socket) => {
    const timer = setTimeout(() => socket.destroy(), input.timeout)
    headers.set(socket, timer)
    socket.once("close", () => clearTimeout(timer))
  })
  server.headersTimeout = input.timeout
  server.requestTimeout = input.timeout
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const internal = server.address()
  if (!internal || typeof internal === "string") throw new Error("Gateway address unavailable")
  // Bun's HTTP compatibility layer does not expose a socket until headers arrive.
  // A TCP front door enforces an absolute bound even on partial headers and slow bodies.
  const sockets = new Set<import("node:net").Socket>()
  const entrance = new Server((socket) => {
    const relay = connect(internal.port, "127.0.0.1")
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
  await new Promise<void>((resolve, reject) => {
    entrance.once("error", reject)
    entrance.listen(0, "127.0.0.1", resolve)
  })
  const address = entrance.address()
  if (!address || typeof address === "string") throw new Error("Gateway address unavailable")
  return {
    url: new URL(`http://127.0.0.1:${address.port}`),
    close: () => {
      for (const socket of sockets) socket.destroy()
      entrance.close()
      server.closeAllConnections()
      server.close()
    },
  }
}
