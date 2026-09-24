import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { journal, readJournal } from "./host-journal"
import { hostEvidence } from "./host-evidence"
import { digest } from "./ledger"

test("CAS journals restore exact JSON, Unicode boundaries and repeated growing histories with fewer stored bytes", async () => {
  const root = await mkdtemp("/tmp/research-journal-")
  const file = root + "/operations.jsonl"
  const writer = journal(file)
  const values: unknown[] = [null, false, 0, "", { value: "x".repeat(65525) + "🔬研究", array: [null, 1, true] }]
  const versions = Array.from({ length: 20 }, (_, version) => ({
    version,
    data: { id: "contract", text: "q".repeat(100_000), version },
  }))
  values.push(...versions.map((_, index) => versions.slice(0, index + 1)))
  values.forEach((result, index) =>
    writer.append({
      event: index === 0 ? "late_response" : "response",
      connectionID: "one",
      id: String(index),
      action: "history",
      contractID: "contract",
      result,
      payload: { index },
    }),
  )
  const rows = await Array.fromAsync(readJournal(file, "cas:1"))
  expect(rows.map((row) => row.result)).toEqual(values)
  expect(rows.map((row) => row.payload)).toEqual(values.map((_, index) => ({ index })))
  const files = await readdir(root + "/operations.objects")
  const retained =
    Bun.file(file).size + files.reduce((sum, name) => sum + Bun.file(root + "/operations.objects/" + name).size, 0)
  const inline = Buffer.byteLength(JSON.stringify(values))
  expect(retained).toBeLessThan(inline / 4)
  console.log(
    JSON.stringify({ journalStorageFixture: { inlineBytes: inline, retainedBytes: retained, objects: files.length } }),
  )
  const resumed = journal(file)
  expect(resumed.id).toBe(writer.id)
  resumed.append({
    event: "response",
    connectionID: "two",
    id: "restart",
    action: "get",
    contractID: "contract",
    error: "actual failure",
  })
  const latest = (await Array.fromAsync(readJournal(file))).at(-1)!
  expect(latest.sequence).toBe(rows.length + 1)
  expect(latest.connectionID).toBe("two")
  expect(latest.error).toBe("actual failure")
})

test("CAS refuses changed bindings, sequence, format, chunks, totals and incomplete tails", async () => {
  const root = await mkdtemp("/tmp/research-journal-integrity-")
  const file = root + "/operations.jsonl"
  const writer = journal(file)
  writer.append({
    event: "response",
    connectionID: "one",
    id: "request",
    action: "get",
    contractID: "contract",
    result: { candidate: true, text: "w".repeat(100_000) },
  })
  const original = await Bun.file(file).text()
  const row = JSON.parse(original)
  for (const change of [
    { id: "other-request" },
    { action: "history" },
    { contractID: "other" },
    { journalID: "other" },
    { connectionID: "other" },
    { sequence: 2 },
    { format: "cas:2" },
    { result: {} },
    { resultRef: { ...row.resultRef, bytes: row.resultRef.bytes - 1 } },
    { resultRef: { ...row.resultRef, chunks: row.resultRef.chunks.toReversed() } },
    { resultRef: { ...row.resultRef, hash: digest("different") } },
    { payloadRef: row.resultRef, resultRef: undefined },
  ]) {
    await Bun.write(file, JSON.stringify({ ...row, ...change }) + "\n")
    await expect(Array.fromAsync(readJournal(file, "cas:1"))).rejects.toThrow()
  }
  await Bun.write(file, original.trimEnd())
  expect(() => journal(file)).toThrow("tail")
  await expect(Array.fromAsync(readJournal(file))).rejects.toThrow("tail")
  for (const invalid of ["\n", original + "\n", "\n" + original]) {
    await Bun.write(file, invalid)
    expect(() => journal(file)).toThrow()
    await expect(Array.fromAsync(readJournal(file))).rejects.toThrow()
  }
  await Bun.write(file, original)
  const object = root + "/operations.objects/" + row.resultRef.chunks[0]
  await Bun.write(object, "corruption")
  await expect(Array.fromAsync(readJournal(file))).rejects.toThrow("corrupt")
  expect(() =>
    writer.append({ event: "response", connectionID: "one", result: { candidate: true, text: "w".repeat(100_000) } }),
  ).toThrow("changed")
  expect(await Bun.file(object).text()).toBe("corruption")
  await rm(object)
  await expect(Array.fromAsync(readJournal(file))).rejects.toThrow()
})

test("legacy inline journals remain readable without inventing missing payloads", async () => {
  const root = await mkdtemp("/tmp/research-journal-legacy-")
  const file = root + "/operations.jsonl"
  const rows = [
    { event: "command_start", id: "legacy" },
    { event: "response", id: "legacy", result: { value: false } },
  ]
  await Bun.write(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
  expect(JSON.stringify(await Array.fromAsync(readJournal(file)))).toBe(JSON.stringify(rows))
  expect(() => journal(file)).toThrow()
  await expect(Array.fromAsync(readJournal(file, "cas:1"))).rejects.toThrow()
  await Bun.write(root + "/cleanup.json", "{malformed cleanup")
  const audit = await hostEvidence({ directory: root + "/archive", storage: root, contractID: "legacy" })
  expect(audit.state).toBe("unknown")
  expect(audit.files.some((file) => file.path === "host/cleanup.json")).toBe(true)
})

test("archived journal and raw chunks restore without live storage, even when cleanup is unknown", async () => {
  const root = await mkdtemp("/tmp/research-journal-archive-")
  const storage = root + "/host"
  const file = storage + "/operations.jsonl"
  const writer = journal(file)
  writer.append({ event: "startup", connectionID: "one", supervisorPID: 123 })
  writer.append({
    event: "command_start",
    connectionID: "one",
    id: "q",
    action: "research-get",
    contractID: "contract",
    payload: { reason: "retain" },
  })
  writer.append({
    event: "late_response",
    connectionID: "one",
    id: "q",
    action: "research-get",
    contractID: "contract",
    result: { id: "contract", stage: "ready", subjectHash: "candidate" },
  })
  const expected = await Array.fromAsync(readJournal(file))
  const audit = await hostEvidence({ directory: root + "/archive", storage, contractID: "contract" })
  expect(audit.state).toBe("unknown")
  expect(audit.files.some((item) => item.path.startsWith("host/operations.objects/"))).toBe(true)
  await rm(storage, { recursive: true })
  const archived = root + "/archive/objects/" + audit.files.find((item) => item.path === "host/operations.jsonl")!.hash
  const restored = await Array.fromAsync(
    readJournal(archived, "cas:1", async (hash) => {
      const entry = audit.files.find((item) => item.path === "host/operations.objects/" + hash)!
      return new Uint8Array(await Bun.file(root + "/archive/objects/" + entry.hash).arrayBuffer())
    }),
  )
  expect(restored).toEqual(expected)
})
