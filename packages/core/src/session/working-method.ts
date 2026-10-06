export * as SessionWorkingMethod from "./working-method"

import { and, desc, eq, lt, or, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema, Semaphore } from "effect"
import { mkdir, rename } from "node:fs/promises"
import path from "node:path"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { Global } from "../global"
import { Hash } from "../util/hash"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"
import { SessionStore } from "./store"

export const toolName = "working_method"
// Individual read guards, not execution/search budgets. Archives are never silently truncated.
export const readGuards = { ledger: 16 * 1024 * 1024, message: 8 * 1024 * 1024 }
const messageBytes = sql<number>`length(cast(${SessionMessageTable.data} as blob))`
const Text = Schema.NonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter<string>((value) =>
    value.isWellFormed() && value.trim().length > 0 ? undefined : "Expected nonblank well-formed Unicode text",
  ),
)
const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Positive = Schema.Int.check(Schema.isGreaterThan(0))
const Reference = Schema.Struct({
  messageID: SessionMessage.ID,
  callID: Schema.optional(Schema.NonEmptyString),
  channel: Schema.Literals(["content", "error", "diagnostic", "structured", "input", "user"]),
  block: Natural,
  hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
const validReference = Schema.makeFilter<{ channel: string; callID?: string; block: number }>((value) =>
  value.channel === "user"
    ? value.callID === undefined && value.block === 0
      ? undefined
      : "User feedback has block 0 and no tool callID"
    : value.callID !== undefined
      ? undefined
      : "Tool observations require their actual callID",
)
export const Evidence = Schema.Struct({
  ...Reference.fields,
  channel: Schema.Literals(["content", "error", "diagnostic", "structured", "user"]),
  quote: Text,
}).check(validReference)
const EvidenceList = Schema.Array(Evidence).check(Schema.isMaxLength(8))
export const Read = Schema.Struct({
  action: Schema.Literal("read"),
  revision: Schema.optional(Positive),
  before: Schema.optional(SessionMessage.ID),
  historyOffset: Schema.optional(Natural),
  messageID: Schema.optional(SessionMessage.ID),
  captureOffset: Schema.optional(Natural),
  observation: Schema.optional(
    Schema.Struct({
      ...Reference.fields,
      offset: Natural,
      length: Positive.check(Schema.isLessThanOrEqualTo(4096)),
    }).check(validReference),
  ),
})
export const Revise = Schema.Struct({
  action: Schema.Literal("revise"),
  expectedRevision: Natural,
  replaces: Schema.optional(Positive),
  condition: Text,
  previous: Schema.optional(Text),
  change: Text,
  expectation: Text,
  reconsiderWhen: Text,
  reason: Text,
  evidence: EvidenceList.check(Schema.isMinLength(1)),
})
export const Retract = Schema.Struct({
  action: Schema.Literal("retract"),
  expectedRevision: Natural,
  replaces: Positive,
  reason: Text,
  evidence: Schema.optional(EvidenceList),
})
export const Input = Schema.Union([Read, Revise, Retract])
export type Input = typeof Input.Type
const Change = Schema.Union([Revise, Retract])
const Receipt = Schema.Struct({
  revision: Positive,
  assistantMessageID: SessionMessage.ID,
  toolCallID: Schema.String,
  inputHash: Schema.String,
  status: Schema.Literal("trial-unverified"),
  input: Change,
  observations: Schema.Array(Schema.Json),
})
export type Receipt = typeof Receipt.Type
const Ledger = Schema.Struct({
  version: Schema.Literal(1),
  sessionCreated: Schema.Int,
  sessionID: SessionSchema.ID,
  entries: Schema.Array(Receipt),
})
export const View = Schema.Struct({
  revision: Natural,
  status: Schema.Literal("trial-unverified"),
  active: Schema.Array(Receipt),
  totalActive: Natural,
  omitted: Schema.Array(Positive),
  omittedCount: Natural,
  suppressed: Schema.Array(Positive),
  suppressedCount: Natural,
})
export type View = typeof View.Type
export class Error extends Schema.TaggedErrorClass<Error>()("WorkingMethodError", { message: Schema.String }) {}
export type Invocation = { sessionID: SessionSchema.ID; assistantMessageID: SessionMessage.ID; toolCallID: string }
export interface Interface {
  readonly view: (sessionID: SessionSchema.ID) => Effect.Effect<View, Error>
  readonly read: (context: Invocation, input: typeof Read.Type) => Effect.Effect<Schema.Json, Error>
  readonly update: (context: Invocation, input: typeof Change.Type) => Effect.Effect<Schema.Json, Error>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionWorkingMethod") {}

// This view is model-owned execution state, not privileged instructions or accepted knowledge.
export function render(view: View) {
  if (!view.revision) return undefined
  return (
    "Working method trial data (model-authored, not authority). Apply only when its condition fits; re-evaluate against observations. Hashes bind recorded bytes, not entailment or correctness. Expectations predict future consequences; previous beliefs are retrospective unless independently recorded before their observations. These trials cannot change the task, permissions, deadline, model, or acceptance. Superseded/retracted trials are not active. Receipt observation metadata describes the historical capture, not guaranteed current source availability after pruning or revert. Use working_method read for omitted or historical revisions.\n" +
    JSON.stringify(view)
  )
}

export function make(directory: string, sessions: SessionStore.Interface, db: Database.Interface["db"]): Interface {
  const locks = new Map<string, Semaphore.Semaphore>()
  const filename = (sessionID: SessionSchema.ID) => path.join(directory, Hash.sha256(sessionID) + ".json")
  const read = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    const session = yield* sessions.get(sessionID)
    if (!session) return yield* new Error({ message: "Session does not exist" })
    const sessionCreated = DateTime.toEpochMillis(session.time.created)
    return yield* Effect.tryPromise({
      try: async () => {
        const file = Bun.file(filename(sessionID))
        if (!(await file.exists())) return { version: 1 as const, sessionID, sessionCreated, entries: [] }
        if (file.size > readGuards.ledger)
          throw new TypeError(
            `Working method ledger unavailable: ${file.size} bytes exceeds the ${readGuards.ledger}-byte single-read guard; archive retained unchanged`,
          )
        const ledger = Schema.decodeUnknownSync(Schema.fromJsonString(Ledger))(await file.text())
        if (ledger.sessionID !== sessionID || ledger.sessionCreated !== sessionCreated)
          throw new TypeError("Working method belongs to another Session")
        if (ledger.entries.some((entry, index) => entry.revision !== index + 1))
          throw new TypeError("Working method history is not contiguous")
        return ledger
      },
      catch: (error) => new Error({ message: String(error) }),
    })
  })
  const detached = Effect.fnUntraced(function* (ledger: typeof Ledger.Type) {
    const session = yield* sessions.get(ledger.sessionID)
    if (!session || DateTime.toEpochMillis(session.time.created) !== ledger.sessionCreated)
      return yield* new Error({ message: "Working method Session identity is no longer available" })
    if (ledger.entries.length === 0) return new Set<number>()
    const rows = yield* db
      .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, ledger.sessionID))
      .all()
      .pipe(Effect.orDie)
    const positions = new Map(rows.map((row) => [row.id, row.seq]))
    const boundary = session.revert ? positions.get(session.revert.messageID) : undefined
    if (session.revert && boundary === undefined)
      return yield* new Error({ message: "Staged Session revert boundary is unavailable" })
    const suppressed = new Set(
      ledger.entries
        .filter((entry) => {
          const seq = positions.get(entry.assistantMessageID)
          return seq === undefined || (boundary !== undefined && seq > boundary)
        })
        .map((entry) => entry.revision),
    )
    return suppressed
  })
  const view = (ledger: typeof Ledger.Type) =>
    detached(ledger).pipe(Effect.map((suppressed) => activeView(ledger, suppressed)))
  const invocation = Effect.fnUntraced(function* (context: Invocation, input?: typeof Change.Type, retry = false) {
    const row = yield* db
      .select({ seq: SessionMessageTable.seq, bytes: messageBytes })
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.id, context.assistantMessageID),
          eq(SessionMessageTable.session_id, context.sessionID),
          eq(SessionMessageTable.type, "assistant"),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new Error({ message: "Working method invocation is not in this Session" })
    if (input) {
      if (row.bytes > readGuards.message)
        return yield* new Error({
          message: `Invocation unavailable: ${row.bytes} bytes exceeds the ${readGuards.message}-byte single-read guard`,
        })
      const stored = yield* sessions.message(context.assistantMessageID)
      const tool =
        stored?.message.type === "assistant"
          ? stored.message.content.find((part) => part.type === "tool" && part.id === context.toolCallID)
          : undefined
      if (
        tool?.type !== "tool" ||
        tool.name !== toolName ||
        tool.provider?.executed === true ||
        tool.time.pruned !== undefined ||
        (tool.state.status !== "running" &&
          !(retry && (tool.state.status === "completed" || tool.state.status === "error")))
      )
        return yield* new Error({ message: "Mutation requires its exact local running working_method invocation" })
      const recorded = Schema.decodeUnknownOption(Change)(tool.state.input)
      if (recorded._tag === "None" || JSON.stringify(recorded.value) !== JSON.stringify(input))
        return yield* new Error({ message: "Working method input differs from its recorded invocation" })
    }
    return row.seq
  })
  const source = Effect.fnUntraced(function* (context: Invocation, before: number, reference: typeof Reference.Type) {
    const row = yield* db
      .select({ seq: SessionMessageTable.seq, bytes: messageBytes })
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.id, reference.messageID),
          eq(SessionMessageTable.session_id, context.sessionID),
          lt(SessionMessageTable.seq, before),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new Error({ message: "Evidence must precede this invocation in the same Session" })
    if (row.bytes > readGuards.message)
      return yield* new Error({
        message: `Source unavailable: ${row.bytes} bytes exceeds the ${readGuards.message}-byte single-read guard; recorded source is not absent`,
      })
    const stored = yield* sessions.message(reference.messageID)
    const found =
      stored && stored.sessionID === context.sessionID
        ? captures(stored.message).find(
            (capture) =>
              capture.callID === reference.callID &&
              capture.channel === reference.channel &&
              capture.block === reference.block,
          )
        : undefined
    if (!found || found.hash !== reference.hash)
      return yield* new Error({ message: "Evidence is unavailable, pruned, self-referential, or its bytes changed" })
    return found
  })
  return {
    view: (sessionID) => read(sessionID).pipe(Effect.flatMap(view)),
    read: Effect.fn("WorkingMethod.read")(function* (context, input) {
      const current = yield* invocation(context)
      const ledger = yield* read(context.sessionID)
      if (input.observation) {
        const capture = yield* source(context, current, input.observation)
        const bytes = Buffer.from(capture.text)
        if (input.observation.offset > bytes.length)
          return yield* new Error({ message: "Observation offset exceeds captured bytes" })
        const page = bytes.subarray(input.observation.offset, input.observation.offset + input.observation.length)
        const text = page.toString("utf8")
        const encoding = Buffer.from(text).equals(page) ? "utf8" : "base64"
        return json({
          revision: ledger.entries.length,
          observation: {
            ...withoutText(capture),
            offset: input.observation.offset,
            nextOffset: input.observation.offset + page.length,
            eof: input.observation.offset + page.length === bytes.length,
            encoding,
            data: encoding === "utf8" ? text : page.toString("base64"),
          },
        })
      }
      if (input.revision !== undefined) {
        const receipt = ledger.entries.find((entry) => entry.revision === input.revision)
        if (!receipt) return yield* new Error({ message: "Working method revision does not exist" })
        return json({ revision: ledger.entries.length, receipt })
      }
      if (input.historyOffset !== undefined)
        return json({
          revision: ledger.entries.length,
          history: ledger.entries.slice(input.historyOffset, input.historyOffset + 1),
          nextOffset: Math.min(ledger.entries.length, input.historyOffset + 1),
          total: ledger.entries.length,
        })
      const boundary = input.before
        ? yield* db
            .select({ seq: SessionMessageTable.seq, bytes: messageBytes })
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, input.before),
                eq(SessionMessageTable.session_id, context.sessionID),
                lt(SessionMessageTable.seq, current),
              ),
            )
            .get()
            .pipe(Effect.orDie)
        : { seq: current }
      if (!boundary) return yield* new Error({ message: "Observation cursor is not earlier in this Session" })
      const rows = yield* db
        .select({ id: SessionMessageTable.id, bytes: messageBytes })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, context.sessionID),
            or(eq(SessionMessageTable.type, "assistant"), eq(SessionMessageTable.type, "user")),
            lt(SessionMessageTable.seq, boundary.seq),
            input.messageID ? eq(SessionMessageTable.id, input.messageID) : undefined,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .limit(8)
        .all()
        .pipe(Effect.orDie)
      if (input.messageID && rows.length === 0)
        return yield* new Error({ message: "Observation message is not earlier in this Session" })
      const messages = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          if (row.bytes > readGuards.message)
            return {
              messageID: row.id,
              captures: [],
              unavailable: { reason: "single-read-byte-guard", bytes: row.bytes, limit: readGuards.message },
            }
          const stored = yield* sessions.message(SessionMessage.ID.make(row.id))
          return {
            messageID: row.id,
            captures: stored && stored.sessionID === context.sessionID ? captures(stored.message) : [],
            unavailable:
              stored && stored.sessionID === context.sessionID ? undefined : { reason: "source-no-longer-available" },
          }
        }),
      )
      const observed = messages.flatMap<ReturnType<typeof captures>[number]>((message) => message.captures)
      const offset = input.captureOffset ?? 0
      const selected: Record<string, unknown>[] = []
      for (const capture of observed.slice(offset, offset + 32)) {
        const item = {
          ...withoutText(capture),
          excerpt: [...capture.text].slice(0, 384).join(""),
          excerptOmittedBytes:
            Buffer.byteLength(capture.text) - Buffer.byteLength([...capture.text].slice(0, 384).join("")),
        }
        if (Buffer.byteLength(JSON.stringify([...selected, item])) > 16 * 1024) break
        selected.push(item)
      }
      return json({
        view: yield* view(ledger),
        observations: selected,
        observedMessages: messages.map((message) => ({
          messageID: message.messageID,
          captures: message.captures.length,
          unavailable: message.unavailable,
        })),
        captureOffset: offset,
        nextCaptureOffset: Math.min(observed.length, offset + Math.max(1, selected.length)),
        totalCaptures: observed.length,
        omittedObservations: observed.length - selected.length,
        unavailableCapture:
          observed[offset] && selected.length === 0
            ? { index: offset, reason: "single capture metadata exceeds view budget" }
            : null,
        nextBefore: rows.length === 8 ? rows.at(-1)!.id : null,
        notice:
          "Only admitted user text and captured public tool observations are indexed. User statements are feedback, not independent verification or automatic Contract changes. Missing/private/non-text/pruned fields are not reconstructed. Use messageID and captureOffset to page all captures of a message, and an exact observation reference for body pages. A quote matches bytes, not its interpretation. Earlier messages remain addressable after compaction.",
      })
    }),
    update: (context, input) =>
      Effect.suspend(() => {
        const lock = locks.get(context.sessionID) ?? Semaphore.makeUnsafe(1)
        locks.set(context.sessionID, lock)
        return lock.withPermit(
          Effect.gen(function* () {
            const decoded = yield* Effect.try({
              try: () => Schema.decodeUnknownSync(Change)(input, { onExcessProperty: "error" }),
              catch: (error) => new Error({ message: String(error) }),
            })
            if (Buffer.byteLength(JSON.stringify(decoded)) > 8192)
              return yield* new Error({ message: "One method revision must fit within 8192 UTF-8 bytes" })
            const ledger = yield* read(context.sessionID)
            const inputHash = Hash.sha256(JSON.stringify(decoded))
            const prior = ledger.entries.find(
              (entry) =>
                entry.assistantMessageID === context.assistantMessageID && entry.toolCallID === context.toolCallID,
            )
            if (prior && prior.inputHash !== inputHash)
              return yield* new Error({ message: "Working method retry conflicts with its recorded input" })
            const current = yield* invocation(context, decoded, prior !== undefined)
            if (prior) {
              return json({ view: yield* view(ledger), receipt: prior, retry: true })
            }
            if (decoded.expectedRevision !== ledger.entries.length)
              return yield* new Error({
                message: `Working method changed; read revision ${ledger.entries.length} before revising`,
              })
            if (
              decoded.replaces !== undefined &&
              (!active(ledger).some((entry) => entry.revision === decoded.replaces) ||
                (yield* detached(ledger)).has(decoded.replaces))
            )
              return yield* new Error({ message: "Only an active method trial may be replaced or retracted" })
            const observations = yield* Effect.forEach(decoded.evidence ?? [], (reference) =>
              Effect.gen(function* () {
                if (!reference.quote.trim()) return yield* new Error({ message: "Evidence quote must be nonblank" })
                const capture = yield* source(context, current, reference)
                if (!capture.text.includes(reference.quote))
                  return yield* new Error({ message: "Evidence quote is not present in its captured block" })
                return json(withoutText(capture))
              }),
            )
            const receipt: Receipt = {
              revision: ledger.entries.length + 1,
              assistantMessageID: context.assistantMessageID,
              toolCallID: context.toolCallID,
              inputHash,
              status: "trial-unverified",
              input: decoded,
              observations,
            }
            const next = { ...ledger, entries: [...ledger.entries, receipt] }
            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(directory, { recursive: true, mode: 0o700 })
                await Bun.write(filename(context.sessionID) + ".pending", JSON.stringify(next))
                await rename(filename(context.sessionID) + ".pending", filename(context.sessionID))
              },
              catch: (error) => new Error({ message: String(error) }),
            })
            return json({ view: yield* view(next), receipt, retry: false })
          }),
        )
      }),
  }
}

function active(ledger: typeof Ledger.Type) {
  const removed = new Set(
    ledger.entries.flatMap((entry) => (entry.input.replaces === undefined ? [] : [entry.input.replaces])),
  )
  return ledger.entries.filter((entry) => entry.input.action === "revise" && !removed.has(entry.revision))
}
function activeView(ledger: typeof Ledger.Type, suppressed: ReadonlySet<number>): View {
  const trials = active(ledger).filter((entry) => !suppressed.has(entry.revision))
  const included: Receipt[] = []
  const omitted: number[] = []
  trials.toReversed().forEach((trial) => {
    if (Buffer.byteLength(JSON.stringify([...included, trial])) <= 16 * 1024) included.push(trial)
    else omitted.push(trial.revision)
  })
  return {
    revision: ledger.entries.length,
    status: "trial-unverified",
    active: included.toReversed(),
    totalActive: trials.length,
    omitted: omitted.slice(0, 64),
    omittedCount: omitted.length,
    suppressed: [...suppressed].slice(0, 64),
    suppressedCount: suppressed.size,
  }
}
function json(value: unknown) {
  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(JSON.stringify(value))
}
function withoutText(capture: ReturnType<typeof captures>[number]) {
  const { text, ...reference } = capture
  return reference
}

/** A public display capture is not a successful command or an independent semantic judgment. */
export function captures(message: SessionMessage.Message) {
  if (message.type === "user")
    return message.text.isWellFormed()
      ? [
          {
            interpretation: "user-feedback-statement-not-independent-verification",
            messageID: message.id,
            callID: undefined,
            tool: undefined,
            status: "recorded-user",
            warnings: undefined,
            channel: "user" as const,
            block: 0,
            text: message.text,
            hash: Hash.sha256(message.text),
            bytes: Buffer.byteLength(message.text),
          },
        ]
      : []
  if (message.type !== "assistant") return []
  return message.content.flatMap((tool) => {
    if (
      tool.type !== "tool" ||
      (tool.name === toolName && (tool.state.status !== "error" || tool.provider?.executed === true)) ||
      (tool.state.status !== "completed" && tool.state.status !== "error")
    )
      return []
    const common = {
      messageID: message.id,
      callID: tool.id,
      tool: tool.name,
      status: tool.state.status,
      warnings: {
        pruned: tool.time.pruned !== undefined,
        truncated: tool.state.structured.truncated === true,
        timeout: tool.state.structured.timeout === true,
        nonText: tool.state.content.some((part) => part.type !== "text"),
        providerExecuted: tool.provider?.executed === true,
      },
    }
    const text =
      tool.name !== toolName && tool.time.pruned === undefined
        ? tool.state.content.flatMap((part, block) =>
            part.type === "text" && part.text.isWellFormed()
              ? [{ channel: "content" as const, block, text: part.text }]
              : [],
          )
        : []
    const error =
      tool.time.pruned === undefined && tool.state.status === "error" && tool.state.error.message.isWellFormed()
        ? [{ channel: "error" as const, block: 0, text: tool.state.error.message }]
        : []
    // JSON-only canonical tool outputs are public model observations. Structured metadata
    // alongside explicit content is not: never silently promote that metadata into evidence.
    const structured =
      tool.time.pruned === undefined &&
      tool.state.status === "completed" &&
      tool.provider?.executed !== true &&
      tool.state.content.length === 0
        ? [{ channel: "structured" as const, block: 0, text: JSON.stringify(tool.state.structured) }]
        : []
    const input =
      tool.name !== toolName && tool.time.pruned === undefined
        ? [{ channel: "input" as const, block: 0, text: JSON.stringify(tool.state.input) }]
        : []
    const diagnostic = [
      {
        channel: "diagnostic" as const,
        block: 0,
        text: JSON.stringify({
          kind: "execution-diagnostic",
          interpretation: "capture-and-lifecycle-not-semantic-correctness",
          status: tool.state.status,
          completed: tool.time.completed !== undefined,
          pruned: tool.time.pruned !== undefined,
          ...(typeof tool.state.structured.exit === "number" && Number.isFinite(tool.state.structured.exit)
            ? { exit: tool.state.structured.exit }
            : {}),
          ...(typeof tool.state.structured.timeout === "boolean" ? { timeout: tool.state.structured.timeout } : {}),
          ...(typeof tool.state.structured.truncated === "boolean"
            ? { truncated: tool.state.structured.truncated }
            : {}),
          nonText: tool.state.content.some((part) => part.type !== "text"),
          emptyTextBlocks: tool.state.content.filter((part) => part.type === "text" && part.text.length === 0).length,
          malformedTextBlocks: tool.state.content.filter((part) => part.type === "text" && !part.text.isWellFormed())
            .length,
        }),
      },
    ]
    return [...text, ...error, ...structured, ...diagnostic, ...input].map((part) => ({
      interpretation:
        part.channel === "input"
          ? "declared-input-not-execution"
          : part.channel === "diagnostic" || tool.name === toolName
            ? "execution-diagnostic-not-correctness"
            : "recorded-public-observation",
      ...common,
      ...part,
      hash: Hash.sha256(part.text),
      bytes: Buffer.byteLength(part.text),
    }))
  })
}

export const node = makeGlobalNode({
  service: Service,
  deps: [Global.node, SessionStore.node, Database.node],
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const sessions = yield* SessionStore.Service
      const database = yield* Database.Service
      return make(path.join(global.data, "working-method"), sessions, database.db)
    }),
  ),
})
