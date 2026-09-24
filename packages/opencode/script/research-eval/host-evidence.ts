import path from "node:path"
import { mkdir } from "node:fs/promises"
import { put } from "./archive"
import { digest } from "./ledger"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { readJournal, type JournalEvent } from "./host-journal"

/** Never query retained SQLite in place, or certify a live copy as a terminal database. */
export async function hostEvidence(input: { directory: string; storage: string; contractID: string }) {
  const files: { path: string; hash: string }[] = []
  const retain = async (name: string) => {
    const file = Bun.file(path.join(input.storage, name))
    if (await file.exists())
      files.push({ path: "host/" + name, hash: await put(input.directory, new Uint8Array(await file.arrayBuffer())) })
  }
  // Freeze the journal before enumerating blocks: late responses may still arrive during unknown cleanup.
  for (const name of ["issuance.jsonl", "operations.jsonl", "cleanup.json"]) await retain(name)
  const additional = (
    await Promise.all(
      ["operations.objects/*", "cleanup-*.json"].map((pattern) =>
        Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: input.storage, onlyFiles: true })).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return []
            throw error
          },
        ),
      ),
    )
  ).flat()
  for (const name of additional.sort()) await retain(name)
  const legacyHash = files.find((file) => file.path === "host/cleanup.json")?.hash
  const legacy = (
    legacyHash
      ? await Bun.file(path.join(input.directory, "objects", legacyHash))
          .json()
          .catch(() => undefined)
      : undefined
  ) as { complete: boolean; status: string } | undefined
  const inspectJournal = async () => {
    const connections = new Map<string, { startup: JournalEvent; cleanup?: JournalEvent }>()
    const captured = files.find((file) => file.path === "host/operations.jsonl")
    if (captured)
      for await (const event of readJournal(
        path.join(input.directory, "objects", captured.hash),
        undefined,
        async (hash) => {
          const block = files.find((file) => file.path === "host/operations.objects/" + hash)
          if (!block || block.hash !== hash) throw new Error("Captured journal reference has no intact archived block")
          return new Uint8Array(await Bun.file(path.join(input.directory, "objects", block.hash)).arrayBuffer())
        },
      )) {
        if (event.format !== "cas:1") continue
        if (!/^[a-zA-Z0-9_-]+$/.test(event.connectionID!)) throw new Error("Invalid host connection identity")
        if (event.event === "startup") {
          if (connections.has(event.connectionID!)) throw new Error("Duplicate host connection startup")
          connections.set(event.connectionID!, { startup: event })
          continue
        }
        const connection = connections.get(event.connectionID!)
        if (!connection) throw new Error("Host event has no matching connection startup")
        if (event.event === "cleanup") {
          if (connection.cleanup) throw new Error("Duplicate connection cleanup")
          connection.cleanup = event
        }
      }
    if (!connections.size) {
      if (additional.length) throw new Error("CAS objects or connection cleanups have no journal")
      return { cleanup: legacy }
    }
    const reports = []
    for (const [id, connection] of connections) {
      if (!connection.cleanup) throw new Error("Latest host connection cleanup is missing")
      const retained = files.find((file) => file.path === `host/cleanup-${id}.json`)
      if (!retained) throw new Error("Connection cleanup was not archived")
      const report = await Bun.file(path.join(input.directory, "objects", retained.hash)).json()
      const { event, format, sequence, at, ...record } = connection.cleanup
      if (
        JSON.stringify(record) !== JSON.stringify({ ...report, connectionID: id }) ||
        report.journalID !== connection.startup.journalID ||
        report.connectionID !== id ||
        report.supervisor.pid !== connection.startup.supervisorPID ||
        report.startedAt < connection.startup.at
      )
        throw new Error("Cleanup belongs to another host connection")
      reports.push(report)
    }
    return {
      cleanup: reports.at(-1),
      connections: reports,
      allConfirmed: reports.every(
        (report) => report.complete && report.status === "confirmed" && !report.recordingError,
      ),
    }
  }
  const journal = await inspectJournal().catch((error) => ({ cleanup: undefined, error: String(error) }))
  const cleanup = journal.cleanup as typeof legacy
  const base = {
    capturedAt: Date.now(),
    contractID: input.contractID,
    files,
    cleanup,
    ...(additional.length || "error" in journal ? { journal } : {}),
  }
  if ("error" in journal || ("allConfirmed" in journal && !journal.allConfirmed))
    return { ...base, state: "unknown" as const, reason: "host_journal_or_cleanup_unconfirmed" }
  if (!cleanup?.complete) return { ...base, state: "unknown" as const, reason: "cleanup_unconfirmed" }
  const copy = path.join(input.directory, "database-" + crypto.randomUUID())
  await mkdir(copy, { mode: 0o700 })
  const sources: { path: string; hash: string }[] = []
  const inspect = async () => {
    for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
      const original = Bun.file(path.join(input.storage, name))
      if (!(await original.exists())) continue
      const bytes = new Uint8Array(await original.arrayBuffer())
      sources.push({ path: "host/" + name, hash: await put(input.directory, bytes) })
      await Bun.write(path.join(copy, name), bytes)
    }
    if (!sources.some((item) => item.path === "host/opencode.db"))
      return { ...base, state: "unknown" as const, sources, reason: "database_missing" }
    const { Database } = await import("bun:sqlite")
    const db = new Database(path.join(copy, "opencode.db"), { readonly: true })
    try {
      const names = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name)
      const rows = (table: string, key = "id") =>
        names.includes(table)
          ? db.query<Record<string, unknown>, [string]>(`SELECT * FROM ${table} WHERE ${key} = ?`).all(input.contractID)
          : undefined
      const runs = rows("sdk_research_run_v1")?.map((row) => JSON.parse(String(row.data)) as ResearchModel.Run)
      const history = rows("sdk_research_event_v1")?.map((row) => ({
        version: row.version,
        data: JSON.parse(String(row.data)) as ResearchModel.Run,
      }))
      const operations = rows("pro_contract_operation_usage", "contract_id")?.map(
        (row) => JSON.parse(String(row.data)) as ProContractJob.Operation,
      )
      const preparation = rows("sdk_research_preparation_v1")
      const contracts = rows("pro_contract")
      for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
        const file = Bun.file(path.join(input.storage, name))
        const hash = (await file.exists()) ? digest(new Uint8Array(await file.arrayBuffer())) : undefined
        if (hash !== sources.find((item) => item.path === "host/" + name)?.hash)
          throw new Error("Stopped database source changed during copy")
      }
      return {
        ...base,
        state: "stable_copy" as const,
        sources,
        copy,
        runs,
        history,
        operations,
        preparation,
        contracts,
      }
    } finally {
      db.close()
    }
  }
  return inspect().catch((error) => ({ ...base, state: "unknown" as const, sources, copy, reason: String(error) }))
}
