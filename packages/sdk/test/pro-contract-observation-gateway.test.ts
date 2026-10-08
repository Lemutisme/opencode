import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const metadata = {
  kind: "native-result",
  sessionID: "session-observation",
  messageID: "message-observation",
  callID: "call-observation",
  tool: "shell",
}

test("the admitted native peer archives exact public bytes under host-owned identity", async () => {
  await using gateway = await fixture()
  const bytes = Buffer.from([0x00, 0xff, 0x0a, 0xe4, 0xb8, 0xad])
  expect(await gateway.post(metadata, bytes)).toBe(201)
  expect(await gateway.post({ ...metadata, kind: "model-visible" }, bytes)).toBe(201)
  expect(
    await gateway.post(
      {
        ...metadata,
        kind: "shell-capture",
        capture: {
          stream: "combined",
          encoding: "bytes",
          totalBytes: bytes.length,
          complete: true,
          timeout: false,
          status: "exited",
          exit: 0,
        },
      },
      bytes,
    ),
  ).toBe(201)
  const entries = await gateway.entries()
  expect(entries.map((entry) => entry.kind)).toEqual(["native-result", "model-visible", "shell-capture"])
  for (const entry of entries) {
    expect(entry).toMatchObject({
      ...metadata,
      kind: entry.kind,
      version: 1,
      execution: gateway.config.execution,
      deadline: gateway.config.deadline,
      bytes: bytes.length,
      hash: Bun.SHA256.hash(bytes, "hex"),
    })
    expect(await Bun.file(path.join(gateway.config.observations, "blobs", String(entry.hash))).bytes()).toEqual(bytes)
  }
  expect(await fs.readdir(path.join(gateway.config.observations, "blobs"))).toHaveLength(1)
  expect(await gateway.pending()).toEqual([])
  expect(await Bun.file(gateway.config.journal).exists()).toBe(false)
})

test("observation metadata cannot select host paths, allocation identity, or malformed capture dispositions", async () => {
  await using gateway = await fixture()
  for (const extra of [{ path: "/etc/passwd" }, { execution: "forged" }, { deadline: Date.now() + 999999 }]) {
    expect(await gateway.post({ ...metadata, ...extra })).toBe(403)
  }
  const capture = {
    stream: "combined",
    encoding: "bytes",
    totalBytes: 1,
    complete: true,
    timeout: false,
    status: "exited",
    exit: 0,
  }
  for (const invalid of [
    { complete: "true" },
    { timeout: 0 },
    { totalBytes: true },
    { totalBytes: 2 },
    { status: "timeout", timeout: true },
    { status: "killed" },
    { path: "/etc/passwd" },
    { exit: true },
  ]) {
    expect(
      await gateway.post({ ...metadata, kind: "shell-capture", capture: { ...capture, ...invalid } }, Buffer.from("x")),
    ).toBe(403)
  }
  expect(await gateway.post({ ...metadata, capture })).toBe(403)
  expect(await gateway.post({ ...metadata, kind: "shell-capture" })).toBe(403)
  expect(await gateway.post({ ...metadata, sessionID: "" })).toBe(403)
  expect(await gateway.post(metadata, Buffer.alloc(0), 64 * 1024 * 1024 + 1)).toBe(403)
  expect(await gateway.entries()).toEqual([])
  expect(await gateway.pending()).toEqual([])
  expect(await fs.readdir(path.join(gateway.config.observations, "blobs"))).toEqual([])
})

test("shell timeout observations preserve partial bytes without claiming completeness", async () => {
  await using gateway = await fixture()
  expect(
    await gateway.post(
      {
        ...metadata,
        kind: "shell-capture",
        capture: {
          stream: "combined",
          encoding: "bytes",
          totalBytes: 5,
          complete: false,
          timeout: true,
          status: "timeout",
          signal: "SIGTERM",
        },
      },
      Buffer.from("part"),
    ),
  ).toBe(201)
  expect((await gateway.entries())[0].capture).toMatchObject({ complete: false, timeout: true, totalBytes: 5 })
  expect(await gateway.pending()).toEqual([])
})

test("a child of the admitted native peer has no observation-write capability", async () => {
  await using gateway = await fixture()
  const child = Bun.spawn(
    [
      "/usr/bin/python3",
      "-c",
      [
        "import socket, sys",
        "peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
        "peer.connect(sys.argv[1])",
        "peer.sendall(sys.argv[2].encode())",
        "peer.shutdown(socket.SHUT_WR)",
        "print(peer.recv(4096).decode().splitlines()[0])",
      ].join("\n"),
      gateway.config.socket,
      headers(metadata, 0),
    ],
    { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  expect(stdout).toContain("403")
  expect(await gateway.entries()).toEqual([])
  expect(await gateway.pending()).toEqual([])
})

test("expired or cancelled original tasks reject observation admission", async () => {
  for (const options of [{ deadline: Date.now() - 1 }, { cancelled: true }]) {
    await using gateway = await fixture(options)
    // The independent deadline/cancellation monitor may close the endpoint before
    // the request arrives; neither a denial nor a closed endpoint admits bytes.
    const result = await gateway.post(metadata, Buffer.from("forbidden")).catch(() => undefined)
    expect(result === 403 || result === undefined).toBe(true)
    expect(await gateway.entries()).toEqual([])
    expect(await gateway.pending()).toEqual([])
    expect(await fs.readdir(path.join(gateway.config.observations, "blobs"))).toEqual([])
  }
})

test("disk reserve and truncated uploads never publish partial observations", async () => {
  await using full = await fixture({ reserveBytes: Number.MAX_SAFE_INTEGER })
  expect(await full.post(metadata, Buffer.from("x"))).toBe(403)
  expect(await full.entries()).toEqual([])
  expect(await full.pending()).toEqual([])
  expect(await fs.readdir(path.join(full.config.observations, "blobs"))).toEqual([])

  await using truncated = await fixture()
  expect(await truncated.post(metadata, Buffer.from("x"), 2)).toBe(403)
  expect(await truncated.entries()).toEqual([])
  expect(await truncated.pending()).toEqual([])
  expect(await fs.readdir(path.join(truncated.config.observations, "blobs"))).toEqual([])
})

async function fixture(options: { deadline?: number; cancelled?: boolean; reserveBytes?: number } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "observation-gateway-"))
  const config = {
    observations: path.join(directory, "observations"),
    observationStaging: path.join(directory, "observation-staging"),
    execution: "host-execution",
    deadline: options.deadline ?? Date.now() + 30000,
    reserveBytes: options.reserveBytes ?? 0,
    socket: path.join(directory, "gateway.sock"),
    ledger: path.join(directory, "ledger.sqlite"),
    journal: path.join(directory, "requests.jsonl"),
    cancel: path.join(directory, "CANCEL"),
    task: "original-task",
    grant: "method-grant",
    parent: "parent-policy-hash",
    method: "method-policy-hash",
    model: "never-called",
    effort: "max",
    upstream: "http://127.0.0.1:1/v1",
    pid: process.pid,
    birth: (await Bun.file(`/proc/${process.pid}/stat`).text()).split(")").at(-1)!.trim().split(/\s+/)[19],
  }
  await fs.mkdir(path.join(config.observations, "blobs"), { recursive: true })
  await fs.mkdir(config.observationStaging)
  using db = new Database(config.ledger)
  db.run("CREATE TABLE state (id INTEGER PRIMARY KEY, data TEXT)")
  db.run("INSERT INTO state VALUES (1, ?)", [
    JSON.stringify({
      kernel: {
        contracts: {
          [config.task]: { status: "active", spec: { budget: { deadline: config.deadline } } },
          [config.grant]: { status: "discharged", handoff: { subjectHash: config.parent } },
        },
      },
    }),
  ])
  await Bun.write(path.join(directory, "config.json"), JSON.stringify(config))
  if (options.cancelled) await Bun.write(config.cancel, "cancelled")
  const child = Bun.spawn(["/usr/bin/python3", "src/pro-contract/gateway.py", path.join(directory, "config.json")], {
    cwd: path.join(import.meta.dir, ".."),
    env: { PATH: "/usr/bin:/bin" },
    stdout: "ignore",
    stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const ready = Date.now() + 3000
  while (
    !(await fs.stat(config.socket).then(
      () => true,
      () => false,
    ))
  ) {
    if (child.exitCode !== null || Date.now() >= ready) {
      child.kill()
      await child.exited
      await fs.rm(directory, { recursive: true, force: true })
      throw new Error(`Observation gateway did not start: ${await stderr}`)
    }
    await Bun.sleep(5)
  }
  return {
    config,
    post(value: Record<string, unknown>, body = Buffer.alloc(0), size = body.length) {
      return new Promise<number>((resolve, reject) => {
        const chunks: Buffer[] = []
        const socket = net.createConnection({ path: config.socket, allowHalfOpen: true })
        socket.setTimeout(2000, () => socket.destroy(new Error("Observation request timed out")))
        socket.once("error", reject)
        socket.once("connect", () => socket.end(Buffer.concat([Buffer.from(headers(value, size)), body])))
        socket.on("data", (chunk) => chunks.push(chunk))
        socket.once("end", () => {
          const status = Number(
            Buffer.concat(chunks)
              .toString()
              .match(/^HTTP\/1\.0 (\d{3})/)?.[1],
          )
          if (!status) return reject(new Error("Observation endpoint closed without a response"))
          resolve(status)
        })
      })
    },
    async entries(): Promise<Record<string, unknown>[]> {
      const file = Bun.file(path.join(config.observations, "index.jsonl"))
      if (!(await file.exists())) return []
      return (await file.text())
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line))
    },
    async pending() {
      return [
        ...(await fs.readdir(config.observations)).filter((file) => file.startsWith(".pending-")),
        ...(await fs.readdir(config.observationStaging)),
      ]
    },
    async [Symbol.asyncDispose]() {
      child.kill()
      await child.exited
      await stderr
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

function headers(value: Record<string, unknown>, size: number) {
  return [
    "POST /v1/observations HTTP/1.0",
    "Host: observation.test",
    `Content-Length: ${size}`,
    `X-Observation: ${Buffer.from(JSON.stringify(value)).toString("base64")}`,
    "",
    "",
  ].join("\r\n")
}
