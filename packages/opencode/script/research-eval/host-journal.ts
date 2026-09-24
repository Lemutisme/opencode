import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import path from "node:path"
import { Schema } from "effect"
import { digest } from "./ledger"

const chunkBytes = 65_536
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Reference = Schema.Struct({
  version: Schema.Literal("cas:1"),
  binding: Hash,
  hash: Hash,
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
  chunks: Schema.NonEmptyArray(Hash),
})
export type JournalEvent = Record<string, unknown> & {
  event: string
  sequence: number
  at: number
  id?: string
  action?: string
  contractID?: string
  journalID?: string
  connectionID?: string
  result?: unknown
  payload?: unknown
}

function binding(row: JournalEvent, field: string) {
  return digest(
    JSON.stringify([row.journalID, row.connectionID, row.sequence, field, row.id, row.action, row.contractID]),
  )
}

function metadata(line: string, previous?: JournalEvent, expected?: "cas:1") {
  const row = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(line) as JournalEvent
  if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.event !== "string")
    throw new Error("Invalid host journal event")
  if (row.format === undefined && expected === undefined) {
    if (previous?.format || row.payloadRef !== undefined || row.resultRef !== undefined)
      throw new Error("Host journal format changed")
    return row
  }
  if (
    row.format !== "cas:1" ||
    typeof row.journalID !== "string" ||
    !row.journalID ||
    typeof row.connectionID !== "string" ||
    !row.connectionID ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence !== (previous?.sequence ?? 0) + 1 ||
    !Number.isFinite(row.at) ||
    (previous && (previous.format !== "cas:1" || previous.journalID !== row.journalID))
  )
    throw new Error("Host journal format, identity or sequence changed")
  for (const field of ["payload", "result"] as const) {
    if (field in row) throw new Error("CAS journal contains unbound inline content")
    if (row[field + "Ref"] === undefined) continue
    const ref = Schema.decodeUnknownSync(Reference, { onExcessProperty: "error" })(row[field + "Ref"])
    if (ref.binding !== binding(row, field) || ref.chunks.length !== Math.ceil(ref.bytes / chunkBytes))
      throw new Error("Host journal reference belongs to another event")
  }
  return row
}

/** Existing CAS files retain their identity and sequence across host connections. */
export function journal(file: string) {
  const prior = existsSync(file) ? readFileSync(file, "utf8") : ""
  if (prior && !prior.endsWith("\n")) throw new Error("Incomplete host journal tail")
  const last = (prior ? prior.slice(0, -1).split("\n") : []).reduce<JournalEvent | undefined>(
    (previous, line) => metadata(line, previous, "cas:1"),
    undefined,
  )
  const state = { sequence: last?.sequence ?? 0, id: last?.journalID ?? crypto.randomUUID() }
  const directory = path.join(path.dirname(file), "operations.objects")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return {
    id: state.id,
    append(value: Record<string, unknown> & { event: string; connectionID: string }) {
      const row: JournalEvent = {
        ...value,
        format: "cas:1",
        journalID: state.id,
        sequence: state.sequence + 1,
        at: Date.now(),
      }
      for (const field of ["payload", "result"] as const) {
        if (value[field] !== undefined) {
          const bytes = Buffer.from(JSON.stringify(value[field]))
          const chunks: string[] = []
          for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
            const chunk = bytes.subarray(offset, offset + chunkBytes)
            const hash = digest(chunk)
            const target = path.join(directory, hash)
            if (existsSync(target)) {
              if (!readFileSync(target).equals(chunk)) throw new Error("Existing host journal object changed")
            } else writeFileSync(target, chunk, { flag: "wx", mode: 0o600, flush: true })
            chunks.push(hash)
          }
          row[field + "Ref"] = {
            version: "cas:1",
            binding: binding(row, field),
            hash: digest(bytes),
            bytes: bytes.length,
            chunks,
          }
        }
        delete row[field]
      }
      appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600, flush: true })
      state.sequence = row.sequence
    },
  }
}

/** The loader can resolve archived objects; no reference ever supplies a filesystem path. */
export async function* readJournal(
  file: string,
  expected?: "cas:1",
  load = async (hash: string) =>
    new Uint8Array(await Bun.file(path.join(path.dirname(file), "operations.objects", hash)).arrayBuffer()),
) {
  const source = Bun.file(file)
  if (source.size && (await source.slice(source.size - 1).text()) !== "\n")
    throw new Error("Incomplete host journal tail")
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  const state = { previous: undefined as JournalEvent | undefined }
  for await (const line of lines) {
    if (!line) throw new Error("Empty host journal event")
    const row = metadata(line, state.previous, expected)
    state.previous = row
    const restored = { ...row }
    for (const field of ["payload", "result"] as const) {
      if (row.format !== "cas:1" || row[field + "Ref"] === undefined) continue
      const ref = Schema.decodeUnknownSync(Reference)(row[field + "Ref"])
      const chunks: Uint8Array[] = []
      for (const [index, hash] of ref.chunks.entries()) {
        const bytes = await load(hash)
        if (digest(bytes) !== hash || bytes.length !== Math.min(chunkBytes, ref.bytes - index * chunkBytes))
          throw new Error("Host journal object missing or corrupt")
        chunks.push(bytes)
      }
      const bytes = Buffer.concat(chunks)
      if (bytes.length !== ref.bytes || digest(bytes) !== ref.hash)
        throw new Error("Host journal content identity changed")
      restored[field] = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(bytes.toString("utf8"))
      delete restored[field + "Ref"]
    }
    yield restored
  }
}
