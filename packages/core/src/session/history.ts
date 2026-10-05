import { and, asc, desc, eq, gt, gte, ne, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionMessageTable } from "./sql"
import { ContextBudget } from "./context-budget"

type DatabaseService = Database.Interface["db"]

const selection = (
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq?: number,
) =>
  and(
    eq(SessionMessageTable.session_id, sessionID),
    compaction
      ? or(
          gte(SessionMessageTable.seq, compaction.seq),
          baselineSeq === undefined
            ? undefined
            : and(eq(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
        )
      : undefined,
    baselineSeq === undefined
      ? undefined
      : or(ne(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
  )

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)

export const latestCompaction = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

const messageRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq?: number,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(selection(sessionID, compaction, baselineSeq))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows
})

const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

export const load = Effect.fn("SessionHistory.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const [epoch, compaction] = yield* Effect.all(
    [
      db
        .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
      latestCompaction(db, sessionID),
    ],
    { concurrency: "unbounded" },
  )
  return yield* Effect.forEach(yield* messageRows(db, sessionID, compaction, epoch?.baselineSeq), decodeMessageRow)
})

export const loadForRunner = Effect.fn("SessionHistory.loadForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return (yield* entriesForRunner(db, sessionID, baselineSeq)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  // Load only row identities up front. Parsing every historical image before
  // selecting the prompt defeats any later token/byte bound and can OOM first.
  const rows = yield* db
    .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(selection(sessionID, yield* latestCompaction(db, sessionID), baselineSeq))
    .orderBy(desc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const omit = ContextBudget.mediaSelector()
  const decoded = { bytes: 0 }
  const entries = yield* Effect.forEach(rows, (key) =>
    Effect.gen(function* () {
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.id, key.id), eq(SessionMessageTable.session_id, sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die("A projected Session message disappeared during prompt selection")
      const message = yield* decodeMessageRow(row)
      return {
        seq: row.seq,
        message: selectMessageMedia(message, (mime, uri) => {
          decoded.bytes += Buffer.byteLength(uri)
          return omit(mime, uri)
        }),
      }
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // Bun may not discover a sibling cgroup's limit from a private cgroup
          // namespace. Reclaim discarded blobs at bounded decoding checkpoints.
          if (
            process.env.OPENCODE_RUNTIME_GC === "1" &&
            decoded.bytes >= 8 * 1024 * 1024 &&
            typeof Bun !== "undefined"
          ) {
            Bun.gc(true)
            decoded.bytes = 0
          }
        }),
      ),
    ),
  )
  return entries.toReversed()
})

export function selectMessageMedia(
  message: SessionMessage.Message,
  omit: (mime: string, uri: string) => string | undefined,
): SessionMessage.Message {
  if (message.type === "user") {
    const notes: string[] = []
    const files = message.files
      ?.toReversed()
      .filter((file) => {
        const note = omit(file.mime, file.uri)
        if (!note) return true
        notes.push(`[${file.name ?? "attachment"}; message=${message.id}] ${note}`)
        return false
      })
      .toReversed()
    return notes.length ? { ...message, files, text: [message.text, ...notes].join("\n") } : message
  }
  if (message.type !== "assistant") return message
  return {
    ...message,
    content: message.content
      .toReversed()
      .map((part) => {
        if (part.type !== "tool" || part.state.status !== "completed") return part
        const hasMedia = part.state.content.some((item) => item.type === "file")
        if (!hasMedia) return part
        const content = part.state.content
          .toReversed()
          .map((item) => {
            if (item.type !== "file") return item
            const note = omit(item.mime, item.uri)
            return note ? { type: "text" as const, text: `[${item.name ?? part.name}; call=${part.id}] ${note}` } : item
          })
          .toReversed()
        // Legacy read results duplicate the blob in structured.content. The rich
        // content (or explicit retained-media reference) is authoritative for prompts.
        const payload = part.state.structured.content
        const duplicate =
          part.state.structured.encoding === "base64" &&
          typeof payload === "string" &&
          part.state.content.some(
            (item) =>
              item.type === "file" &&
              item.uri.startsWith("data:") &&
              item.uri.slice(item.uri.indexOf(",") + 1) === payload,
          )
        const structured = duplicate
          ? Object.fromEntries(Object.entries(part.state.structured).filter(([key]) => key !== "content"))
          : part.state.structured
        return { ...part, state: { ...part.state, structured, content } }
      })
      .toReversed(),
  }
}

export * as SessionHistory from "./history"
