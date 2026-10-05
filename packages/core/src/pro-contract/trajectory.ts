export * as ProContractTrajectory from "./trajectory"

import { Option, Schema } from "effect"
import { ProContract } from "@opencode-ai/schema/pro-contract"
import { Hash } from "../util/hash"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/))
const MessageID = Schema.String.check(Schema.isPattern(/^msg_[A-Za-z0-9_-]+$/))
const SessionID = Schema.String.check(Schema.isPattern(/^ses_[A-Za-z0-9_-]+$/))
const Time = Schema.Struct({
  created: Count,
  ran: Schema.optional(Count),
  completed: Schema.optional(Count),
  pruned: Schema.optional(Count),
})
const Usage = Schema.Struct({
  input: Count,
  output: Count,
  reasoning: Count,
  cache: Schema.Struct({ read: Count, write: Count }),
})
const Envelope = Schema.Struct({
  sessionID: Schema.optional(SessionID),
  sessionMessageCount: Schema.optional(Count),
  contract: Schema.optional(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^pct_[A-Za-z0-9_-]+$/)),
      revision: Count.check(Schema.isGreaterThan(0)),
      specHash: Schema.NonEmptyString,
      scope: Schema.NonEmptyString,
      status: ProContract.Status,
      spec: Schema.Struct({
        goal: Schema.String,
        brief: Schema.String,
        budget: ProContract.Budget,
        requires: Schema.Array(ProContract.Requirement),
        evidence: Schema.optional(Schema.Struct({ claim: Schema.optional(Schema.String) })),
      }),
      handoff: Schema.optional(
        Schema.Struct({
          subjectHash: Schema.NonEmptyString,
          summary: Schema.String,
          time: Count,
          uncertainties: Schema.Array(Schema.String),
        }),
      ),
    }),
  ),
  execution: Schema.optional(
    Schema.Struct({
      contractID: Schema.NonEmptyString,
      revision: Count.check(Schema.isGreaterThan(0)),
      sessionID: SessionID,
      promptID: MessageID,
      executionPolicy: Schema.optional(Schema.String),
      model: Schema.optional(
        Schema.Struct({ providerID: Schema.String, id: Schema.String, variant: Schema.optional(Schema.String) }),
      ),
      turnsUsed: Schema.optional(Count),
      actionsUsed: Schema.optional(Count),
      attempts: Schema.optional(Count),
    }),
  ),
  messages: Schema.Struct({ data: Schema.Array(Schema.Unknown) }),
})
const Message = Schema.Struct({
  id: MessageID,
  sessionID: Schema.optional(SessionID),
  type: Schema.Literals([
    "user",
    "assistant",
    "system",
    "synthetic",
    "compaction",
    "shell",
    "agent-switched",
    "model-switched",
  ]),
  time: Time,
  text: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(Schema.Unknown)),
  cost: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  tokens: Schema.optional(Usage),
  finish: Schema.optional(Schema.String),
})
const Content = Schema.Struct({
  type: Schema.NonEmptyString,
  id: Identifier,
  messageID: Schema.optional(MessageID),
})
const Tool = Schema.Struct({
  name: Identifier,
  time: Time,
  state: Schema.Struct({
    status: Schema.Literals(["pending", "running", "completed", "error"]),
    input: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)]),
    content: Schema.optional(Schema.Array(Schema.Unknown)),
    error: Schema.optional(Schema.Struct({ message: Schema.String })),
  }),
})

export type Limits = {
  sourceBytes?: number
  messages?: number
  records?: number
  fieldBytes?: number
  outputBytes?: number
}

export type Input = {
  /** Exact archived JSON bytes decoded as UTF-8, not a reserialized approximation. */
  source: string
  sourceID: string
  /** Obtained from the authorized archive by the caller; a hash does not authorize reading. */
  sourceHash: string
  selection?: { messageIDs?: readonly string[]; offset?: number; limit?: number }
  /** Bounds on this projection operation, never cumulative research or provider budgets. */
  limits?: Limits
}

type Captured = {
  hash: string
  bytes: number
  encoding: "utf8" | "canonical-json"
} & (
  | { status: "complete"; text: string }
  | { status: "redacted"; text: string; omitted: number }
  | { status: "unavailable"; reason: "field-byte-guard" | "pending-input-unparsed" }
)

type PublicRecord = {
  messageID: string
  messageOrder: number
  contentOrder: number | null
  partID?: string
  type: "user-text" | "assistant-text" | "tool"
  time: typeof Time.Type
  text?: Captured
  tool?: {
    name: string
    status: typeof Tool.Type.state.status
    input: Captured
    content: ReadonlyArray<
      { order: number; text: Captured } | { order: number; status: "unavailable"; reason: "non-text-output" }
    >
    error?: Captured
    output: "recorded" | "pending" | "unavailable"
    // Neither a successful tool call nor text in its output proves an inner command actually ran.
    interpretation: "unverified-observation"
  }
}

/**
 * Project only explicitly public native Session fields. Source hashes bind provenance,
 * not truth. Excluded/private messages stay out even when explicitly selected.
 */
export function project(input: Input) {
  const limits = {
    sourceBytes: 32 * 1024 * 1024,
    messages: 10_000,
    records: 10_000,
    fieldBytes: 256 * 1024,
    outputBytes: 8 * 1024 * 1024,
    ...input.limits,
  }
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0))
    throw new Error("Trajectory unavailable: invalid operation guard")
  if (typeof input.source !== "string" || Buffer.byteLength(input.source) > limits.sourceBytes)
    throw new Error("Trajectory unavailable: source byte guard exceeded")
  if (!input.sourceID || input.sourceID.length > 1024 || !/^[a-f0-9]{64}$/.test(input.sourceHash))
    throw new Error("Trajectory unavailable: invalid source coordinates")
  if (Hash.sha256(input.source) !== input.sourceHash) throw new Error("Trajectory unavailable: source hash mismatch")
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(input.source)
  if (Option.isNone(decoded)) throw new Error("Trajectory unavailable: malformed source JSON")
  const source = decode(Envelope, decoded.value)
  if (source.messages.data.length > limits.messages)
    throw new Error("Trajectory unavailable: message count guard exceeded")
  if (source.contract && !source.execution) throw new Error("Trajectory unavailable: missing execution coordinates")
  if (source.execution && !source.contract) throw new Error("Trajectory unavailable: missing Contract coordinates")
  if (
    source.execution &&
    source.contract &&
    (source.execution.contractID !== source.contract.id || source.execution.revision !== source.contract.revision)
  )
    throw new Error("Trajectory unavailable: inconsistent Contract execution coordinates")
  const sessionID = source.execution?.sessionID ?? source.sessionID
  if (!sessionID || (source.sessionID && source.sessionID !== sessionID))
    throw new Error("Trajectory unavailable: inconsistent Session coordinates")
  if (source.sessionMessageCount !== undefined && source.sessionMessageCount < source.messages.data.length)
    throw new Error("Trajectory unavailable: inconsistent message count")
  const messages = source.messages.data.map((value) => decode(Message, value))
  if (new Set(messages.map((message) => message.id)).size !== messages.length)
    throw new Error("Trajectory unavailable: duplicate message identity")
  if (messages.some((message) => message.sessionID && message.sessionID !== sessionID))
    throw new Error("Trajectory unavailable: message belongs to another Session")
  const requested = input.selection?.messageIDs
  if (
    requested &&
    (new Set(requested).size !== requested.length || requested.some((id) => !messages.some((m) => m.id === id)))
  )
    throw new Error("Trajectory unavailable: unknown or duplicate selected message identity")
  const offset = input.selection?.offset ?? 0
  const limit = input.selection?.limit ?? messages.length
  if (![offset, limit].every((value) => Number.isSafeInteger(value) && value >= 0) || offset > messages.length)
    throw new Error("Trajectory unavailable: invalid message window")
  const capture = (text: string, encoding: Captured["encoding"] = "utf8", omitted = 0): Captured => {
    const common = { hash: Hash.sha256(text), bytes: Buffer.byteLength(text), encoding }
    if (common.bytes > limits.fieldBytes) return { ...common, status: "unavailable", reason: "field-byte-guard" }
    if (omitted) return { ...common, status: "redacted", text, omitted }
    return { ...common, status: "complete", text }
  }
  const records: PublicRecord[] = []
  const index = messages.map((message, order) => {
    const selected = order >= offset && order < offset + limit && (!requested || requested.includes(message.id))
    const count = { public: 0 }
    const append = (record: PublicRecord) => {
      count.public++
      if (selected && records.length < limits.records) records.push(record)
    }
    if (message.type === "user") {
      if (message.text === undefined) throw new Error("Trajectory unavailable: missing public user text")
      append({
        messageID: message.id,
        messageOrder: order,
        contentOrder: null,
        type: "user-text",
        time: message.time,
        text: capture(message.text),
      })
    }
    if (message.type === "assistant") {
      if (!message.content) throw new Error("Trajectory unavailable: missing assistant content")
      message.content.forEach((value, contentOrder) => {
        const part = decode(Content, value)
        if (part.messageID && part.messageID !== message.id)
          throw new Error("Trajectory unavailable: forged part message identity")
        if (part.type !== "text" && part.type !== "tool") return
        const common = { messageID: message.id, messageOrder: order, contentOrder, partID: part.id, time: message.time }
        if (part.type === "text") {
          append({
            ...common,
            type: "assistant-text",
            text: capture(decode(Schema.Struct({ text: Schema.String }), value).text),
          })
          return
        }
        const tool = decode(Tool, value)
        if (
          tool.state.status === "pending" &&
          (typeof tool.state.input !== "string" || tool.state.content || tool.state.error)
        )
          throw new Error("Trajectory unavailable: malformed pending tool input")
        if (tool.state.status !== "pending" && typeof tool.state.input === "string")
          throw new Error("Trajectory unavailable: malformed tool input")
        if (tool.state.status !== "error" && tool.state.error)
          throw new Error("Trajectory unavailable: inconsistent tool error")
        if (tool.state.status === "error" && !tool.state.error)
          throw new Error("Trajectory unavailable: missing tool error")
        const cleaned = typeof tool.state.input === "string" ? undefined : publicInput(tool.state.input)
        append({
          ...common,
          type: "tool",
          time: tool.time,
          tool: {
            name: tool.name,
            status: tool.state.status,
            input: cleaned
              ? capture(cleaned.text, "canonical-json", cleaned.omitted)
              : {
                  hash: Hash.sha256(tool.state.input as string),
                  bytes: Buffer.byteLength(tool.state.input as string),
                  encoding: "utf8",
                  status: "unavailable",
                  reason: "pending-input-unparsed",
                },
            content: (tool.state.content ?? []).map((value, order) => {
              const content = decode(Schema.Struct({ type: Schema.String }), value)
              if (content.type !== "text")
                return { order, status: "unavailable" as const, reason: "non-text-output" as const }
              return { order, text: capture(decode(Schema.Struct({ text: Schema.String }), value).text) }
            }),
            error: tool.state.error ? capture(tool.state.error.message) : undefined,
            output:
              tool.time.pruned !== undefined || !tool.state.content
                ? tool.state.status === "pending"
                  ? "pending"
                  : "unavailable"
                : "recorded",
            interpretation: "unverified-observation",
          },
        })
      })
    }
    return {
      messageID: message.id,
      order,
      type: message.type,
      time: message.time,
      selected,
      visibility: message.type === "user" || message.type === "assistant" ? "public-fields" : "excluded",
      records: count.public,
      usage: message.type === "assistant" ? { cost: message.cost, tokens: message.tokens } : undefined,
      finish: message.type === "assistant" ? message.finish : undefined,
    }
  })
  const contract = source.contract
    ? {
        id: source.contract.id,
        revision: source.contract.revision,
        specHash: source.contract.specHash,
        scope: source.contract.scope,
        status: source.contract.status,
        goal: capture(source.contract.spec.goal),
        brief: capture(source.contract.spec.brief),
        evidenceClaim:
          source.contract.spec.evidence?.claim === undefined ? undefined : capture(source.contract.spec.evidence.claim),
        budget: source.contract.spec.budget,
        requires: source.contract.spec.requires,
        handoff: source.contract.handoff
          ? {
              subjectHash: source.contract.handoff.subjectHash,
              time: source.contract.handoff.time,
              summary: capture(source.contract.handoff.summary),
              uncertainties: source.contract.handoff.uncertainties.map((text) => capture(text)),
            }
          : undefined,
      }
    : undefined
  const execution = source.execution
    ? {
        ...source.execution,
        executionPolicy:
          source.execution.executionPolicy === undefined ? undefined : capture(source.execution.executionPolicy),
      }
    : undefined
  const packet = {
    version: 1 as const,
    kind: "public-trajectory" as const,
    purpose: "development-only" as const,
    source: { id: input.sourceID, hash: input.sourceHash, bytes: Buffer.byteLength(input.source), sessionID },
    scope: {
      interpretation: "unverified-observations" as const,
      sourceMessages: messages.length,
      declaredSessionMessages: source.sessionMessageCount,
      selectedMessages: index.filter((entry) => entry.selected).length,
      availablePublicRecords: index.reduce((total, entry) => total + entry.records, 0),
      selectedPublicRecords: index.filter((entry) => entry.selected).reduce((total, entry) => total + entry.records, 0),
      sourceCompleteness:
        source.sessionMessageCount === undefined
          ? "unknown"
          : source.sessionMessageCount === messages.length
            ? "declared-complete"
            : "partial",
      excluded: ["reasoning", "provider-metadata", "system-and-internal-messages", "non-text-tool-payloads"],
    },
    contract,
    execution,
    index,
    records: records.map((record) => ({
      ...record,
      id: `${record.messageID}:${record.contentOrder ?? "user"}`,
      hash: Hash.sha256(JSON.stringify(record)),
    })),
    capture:
      index.filter((entry) => entry.selected).reduce((total, entry) => total + entry.records, 0) > records.length ||
      !complete({ contract, execution, records })
        ? ("truncated" as const)
        : ("complete" as const),
  }
  const result = { ...packet, hash: Hash.sha256(JSON.stringify(packet)) }
  if (Buffer.byteLength(JSON.stringify(result)) > limits.outputBytes)
    throw new Error("Trajectory unavailable: output byte guard exceeded; request a smaller message window")
  return result
}

function decode<S extends Schema.Decoder<unknown>>(schema: S, value: unknown): S["Type"] {
  const result = Schema.decodeUnknownOption(schema)(value)
  if (Option.isNone(result)) throw new Error("Trajectory unavailable: malformed native public record")
  return result.value
}

// Tool inputs are public call arguments, but never forward nested provider-private envelopes.
// Their canonical encoding is explicitly distinct from exact UTF-8 text output bytes.
function publicInput(input: Record<string, unknown>) {
  const state = { omitted: 0, nodes: 0 }
  const visit = (value: unknown, depth: number): unknown => {
    if (++state.nodes > 100_000 || depth > 64)
      throw new Error("Trajectory unavailable: tool input structure guard exceeded")
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1))
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .flatMap(([key, value]) => {
          if (["providerMetadata", "reasoning", "reasoningEncryptedContent"].includes(key)) {
            state.omitted++
            return []
          }
          return [[key, visit(value, depth + 1)]]
        }),
    )
  }
  return { text: JSON.stringify(visit(input, 0)), omitted: state.omitted }
}

// Traverse only the newly constructed public projection, never arbitrary source payloads.
function complete(value: unknown): boolean {
  if (!value || typeof value !== "object") return true
  if ("status" in value && (value.status === "unavailable" || value.status === "redacted")) return false
  if ("output" in value && value.output === "unavailable") return false
  return Object.values(value).every(complete)
}
