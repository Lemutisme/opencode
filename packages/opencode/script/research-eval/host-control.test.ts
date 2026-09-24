import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { readJournal } from "./host-journal"
import { hostEvidence } from "./host-evidence"
import { digest } from "./ledger"
import path from "node:path"
import { hostControl, observeHost } from "./host-control"
import { ResearchIssuance } from "../../../sdk-next/src/research/issuance"
import { Effect } from "effect"

test("issuance trace retains success, failure and actual interruption", async () => {
  const events: ResearchIssuance.Event[] = []
  const phase = ResearchIssuance.trace("contract", (event) => events.push(event))
  expect(await Effect.runPromise(phase("capture", Effect.succeed(3)))).toBe(3)
  await expect(Effect.runPromise(phase("save", Effect.fail(new Error("disk failed"))))).rejects.toThrow("disk failed")
  const signal = new AbortController()
  const waiting = Effect.runPromise(phase("materialize", Effect.never), { signal: signal.signal })
  signal.abort()
  await expect(waiting).rejects.toThrow()
  expect(events.map((item) => [item.phase, item.event, item.outcome])).toEqual([
    ["capture", "start", undefined],
    ["capture", "exit", "succeeded"],
    ["save", "start", undefined],
    ["save", "exit", "failed"],
    ["materialize", "start", undefined],
    ["materialize", "exit", "interrupted"],
  ])
})

for (const format of [undefined, "cas:1"] as const)
  for (const mode of ["late", "unconfirmed", "cleanup-timeout", "cancel", "deadline", "no-ready"] as const)
    test(`host deadlines retain actual process evidence: ${mode} ${format ?? "inline"}`, async () => {
      const root = await mkdtemp("/tmp/research-host-control-")
      const controller = new AbortController()
      const client = hostControl({
        policy: {
          version: 1,
          ...(format ? { journal: format } : {}),
          startup: mode === "no-ready" ? 50 : 2000,
          operation: 35,
          cleanup: mode === "cleanup-timeout" ? 20 : 2000,
        },
        deadline: Date.now() + (mode === "deadline" ? 2000 : 5000),
        signal: controller.signal,
        journal: root + "/operations.jsonl",
        cleanupFile: root + "/cleanup.json",
        spawn: (ipc) =>
          Bun.spawn(
            [
              process.execPath,
              path.join(import.meta.dir, "test/host-process.ts"),
              "supervisor",
              mode,
              root + "/work.jsonl",
            ],
            {
              ipc,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "pipe",
            },
          ),
      })
      if (mode === "no-ready") {
        await expect(client.started).rejects.toThrow()
        expect((await Bun.file(client.cleanupFile).json()).status).toBe("unconfirmed")
        await client.child.exited
        return
      }
      await client.started
      expect((await observeHost(client.identity)).state).toBe("alive")
      if (mode === "cancel") controller.abort()
      if (mode === "deadline") await Bun.sleep(2100)
      if (["cancel", "deadline"].includes(mode)) await client.stop().catch(() => undefined)
      else await expect(client.command("research-issue", "contract", {})).rejects.toThrow("timed out")
      await expect(client.command("research-get", "contract")).rejects.toThrow("admission closed")
      const report = await Bun.file(client.cleanupFile).json()
      expect(report.status).toBe(["unconfirmed", "cleanup-timeout"].includes(mode) ? "unconfirmed" : "confirmed")
      expect(report.deadline - report.startedAt).toBe(mode === "cleanup-timeout" ? 20 : 2000)
      const original = await Bun.file(client.cleanupFile).text()
      await client.stop().catch(() => undefined)
      expect(await Bun.file(client.cleanupFile).text()).toBe(original)
      await client.child.exited
      expect((await observeHost(client.identity)).state).toBe("gone")
      const events = await Array.fromAsync(readJournal(root + "/operations.jsonl", format))
      if (mode === "late") {
        const expired = events.find((row) => row.event === "wait_expired")!
        expect(expired.execution).toBe("unknown")
        expect(JSON.parse((await Bun.file(root + "/work.jsonl").text()).trim()).at).toBeGreaterThan(expired.at)
        expect(events.find((row) => row.event === "late_response")).toMatchObject({
          action: "research-issue",
          contractID: "contract",
          result: "late result",
        })
        expect(report.before.state).toBe("alive")
      }
      if (mode === "cleanup-timeout") expect(report.after.state).toBe("alive")
      if (mode === "cancel") expect(events.some((row) => row.event === "cancelled")).toBe(true)
      if (mode === "deadline") expect(events.some((row) => row.event === "deadline_expired")).toBe(true)
    }, 10_000)

test("missing process identity is unknown, not proof of absence", async () => {
  expect((await observeHost()).state).toBe("unknown")
})

function retainedHost(root: string, mode = "late", operation = 2000) {
  return hostControl({
    policy: { version: 1, startup: 3000, operation, cleanup: 3000, journal: "cas:1" },
    deadline: Date.now() + 10000,
    signal: new AbortController().signal,
    journal: root + "/operations.jsonl",
    cleanupFile: root + "/cleanup.json",
    spawn: (ipc) =>
      Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "test/host-process.ts"),
          "supervisor",
          mode,
          root + "/work.jsonl",
        ],
        {
          ipc,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        },
      ),
  })
}

for (const mode of ["late", "unconfirmed"])
  test(`same-storage CAS recovery binds each cleanup to its own connection: ${mode}`, async () => {
    const root = await mkdtemp("/tmp/research-host-restart-")
    const { Database } = await import("bun:sqlite")
    const db = new Database(root + "/opencode.db")
    db.run("CREATE TABLE fixture (value TEXT)")
    db.close()
    const first = retainedHost(root)
    await first.started
    await first.command("fixture", "contract", { first: true })
    await first.stop()
    const second = retainedHost(root, mode)
    await second.started
    await second.command("fixture", "contract", { second: true })
    if (mode === "late") await second.stop()
    else await expect(second.stop()).rejects.toThrow("unconfirmed")
    const rows = await Array.fromAsync(readJournal(root + "/operations.jsonl", "cas:1"))
    expect(new Set(rows.map((row) => row.journalID)).size).toBe(1)
    expect(new Set(rows.map((row) => row.connectionID)).size).toBe(2)
    expect(rows.map((row) => row.sequence)).toEqual(rows.map((_, index) => index + 1))
    expect(first.cleanupFile).not.toBe(second.cleanupFile)
    expect((await Bun.file(first.cleanupFile).json()).complete).toBe(true)
    const audit = await hostEvidence({ directory: root + "/archive", storage: root, contractID: "contract" })
    expect(audit.state).toBe(mode === "late" ? "stable_copy" : "unknown")
    if (mode !== "late") expect(audit).not.toHaveProperty("sources")
    expect(audit.files.filter((file) => file.path.startsWith("host/cleanup-")).length).toBe(2)
  }, 15000)

for (const failure of ["objects", "append", "cleanup"])
  test(`CAS storage failure still closes admission and performs actual cleanup: ${failure}`, async () => {
    const root = await mkdtemp("/tmp/research-host-storage-failure-")
    const client = retainedHost(root)
    await client.started
    if (failure === "cleanup") {
      await mkdir(client.cleanupFile)
      await expect(client.stop()).rejects.toThrow()
    } else {
      const target = root + (failure === "objects" ? "/operations.objects" : "/operations.jsonl")
      await rm(target, { recursive: true })
      if (failure === "objects") await Bun.write(target, "not a directory")
      else await mkdir(target)
      await expect(client.command("fixture", "contract", { source: "original payload" })).rejects.toThrow(
        "recording failed",
      )
      await expect(client.stop()).rejects.toThrow("recording failed")
      const report = await Bun.file(client.cleanupFile).json()
      expect(report.complete).toBe(true)
      expect(report.recordingError).toContain("recording failed")
    }
    await client.child.exited
    expect((await observeHost(client.identity)).state).toBe("gone")
    await expect(client.command("fixture", "contract")).rejects.toThrow("admission closed")
  }, 10000)

for (const failure of ["objects", "append"])
  test(`a response recording failure never resolves the pending operation: ${failure}`, async () => {
    const root = await mkdtemp("/tmp/research-response-recording-")
    const client = retainedHost(root)
    await client.started
    const result = client.command("fixture", "contract").then(
      (value) => ({ value, error: undefined }),
      (error: Error) => ({ value: undefined, error }),
    )
    const target = root + (failure === "objects" ? "/operations.objects" : "/operations.jsonl")
    await rm(target, { recursive: true })
    if (failure === "objects") await Bun.write(target, "not a directory")
    else await mkdir(target)
    expect((await result).error?.message).toContain("recording failed")
    await expect(client.stop()).rejects.toThrow("recording failed")
    await client.child.exited
    expect((await observeHost(client.identity)).state).toBe("gone")
    expect(await Bun.file(root + "/work.jsonl").exists()).toBe(true)
  }, 10000)

test("a synchronous response write crossing the operation deadline is retained but never delivered as success", async () => {
  const root = await mkdtemp("/tmp/research-response-deadline-")
  const client = retainedHost(root, "late", 500)
  await client.started
  const bytes = JSON.stringify("late result")
  const fifo = root + "/operations.objects/" + digest(bytes)
  const created = Bun.spawn(["mkfifo", fifo], { stdout: "ignore", stderr: "pipe" })
  expect(await created.exited).toBe(0)
  // A separate process releases the actual blocking filesystem read after this operation expires.
  const release = Bun.spawn(
    [
      process.execPath,
      "-e",
      "import {writeFileSync} from 'node:fs'; await Bun.sleep(Math.max(0,Number(process.argv[2])-Date.now())); writeFileSync(process.argv[1],process.argv[3]);",
      fifo,
      String(Date.now() + 750),
      bytes,
    ],
    { stdout: "ignore", stderr: "pipe" },
  )
  try {
    await expect(client.command("fixture", "contract")).rejects.toThrow("before recorded delivery")
    await release.exited
    await client.stop()
    await rm(fifo)
    await Bun.write(fifo, bytes)
    const rows = await Array.fromAsync(readJournal(root + "/operations.jsonl", "cas:1"))
    expect(rows.some((row) => row.event === "response" && row.result === "late result")).toBe(true)
    expect(rows.some((row) => row.event === "delivery_expired" && Number(row.deadline) < row.at)).toBe(true)
    expect((await observeHost(client.identity)).state).toBe("gone")
  } finally {
    if (release.exitCode === null) release.kill("SIGKILL")
    await release.exited
    await client.stop().catch(() => undefined)
  }
}, 10000)

test("a killed issuance retains a started phase without inventing its exit", async () => {
  const root = await mkdtemp("/tmp/research-issuance-killed-")
  const file = root + "/trace.jsonl"
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "test/issuance-process.ts"), file], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
  try {
    const limit = Date.now() + 5000
    while (!(await Bun.file(file).exists()) && Date.now() < limit && child.exitCode === null) await Bun.sleep(20)
    expect(await Bun.file(file).exists()).toBe(true)
    child.kill("SIGKILL")
    await child.exited
    const rows = (await Bun.file(file).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ contractID: "pct_eval_interrupted", phase: "snapshot_capture", event: "start" })
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
}, 10000)
