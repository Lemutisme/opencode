export * as SessionObservationPack from "./observation-pack"

import { Context, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { NonNegativeInt, PositiveInt } from "../schema"
import { Hash } from "../util/hash"
import { SessionMessage } from "./message"

export const toolName = "session_read_observation"
export const THRESHOLD_BYTES = 10 * 1024
export const RECENT_ASSISTANTS = 2
export const EXCERPT_BYTES = 1024
export const DIAGNOSTIC_PATTERN = "\\b(?:[a-z]*errors?|fail(?:ed|ure|ures|ing)?|fatal|panic|traceback)\\b"
const diagnostic = new RegExp(DIAGNOSTIC_PATTERN, "i")

export class Policy extends Context.Service<Policy, "contract" | "all" | "off">()(
  "@opencode/SessionObservationPack.Policy",
) {}

export const policyLayer = (setting: string | undefined) =>
  Layer.succeed(Policy, setting === undefined ? "contract" : setting === "1" ? "all" : "off")

// Registration and request projection share one host setting for the lifetime of the process graph.
export const policyNode = makeGlobalNode({
  service: Policy,
  layer: Layer.suspend(() => policyLayer(process.env.OPENCODE_OBSERVATION_PACK)),
  deps: [],
})

export const ReadInput = Schema.Struct({
  messageID: SessionMessage.ID,
  callID: Schema.NonEmptyString,
  block: NonNegativeInt,
  hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  offset: NonNegativeInt,
  length: PositiveInt.check(Schema.isLessThanOrEqualTo(16 * 1024)),
})

const successfulShell = Schema.is(
  Schema.Struct({
    exit: Schema.Literal(0),
    truncated: Schema.Literal(false),
    timeout: Schema.optional(Schema.Literal(false)),
  }),
)

/** Only the provider view changes. The durable message remains the source for exact recall. */
export function project(messages: readonly SessionMessage.Message[]) {
  const completed = messages.flatMap((message, index) =>
    message.type === "assistant" && message.time.completed !== undefined && message.error === undefined ? [index] : [],
  )
  const cutoff = completed.at(-RECENT_ASSISTANTS) ?? -1
  return messages.map((message, index) => {
    if (index >= cutoff || message.type !== "assistant" || message.error !== undefined) return message
    return {
      ...message,
      content: message.content.map((tool) => {
        if (tool.type !== "tool" || !eligible(tool) || tool.state.status !== "completed") return tool
        return {
          ...tool,
          state: {
            ...tool.state,
            content: tool.state.content.map((part, block) => {
              if (part.type !== "text" || Buffer.byteLength(part.text) <= THRESHOLD_BYTES) return part
              const bytes = Buffer.from(part.text)
              const text = JSON.stringify({
                observation: "session-text-v1",
                tool: tool.name,
                status: tool.state.status,
                bytes: bytes.length,
                excerptEncoding: "utf8-lossy",
                recall: {
                  messageID: message.id,
                  callID: tool.id,
                  block,
                  hash: Hash.sha256(bytes),
                  offset: 0,
                  length: 4096,
                },
                notice: `Older tool text omitted. Call ${toolName} for exact pages. Omitted text may contain failures even when the process exited zero. This is recorded display text, not a new execution or settlement.`,
                head: bytes.subarray(0, EXCERPT_BYTES / 2).toString("utf8"),
                tail: bytes.subarray(-EXCERPT_BYTES / 2).toString("utf8"),
              })
              return Buffer.byteLength(text) < bytes.length ? { ...part, text } : part
            }),
          },
        }
      }),
    }
  })
}

/** Hash checks detect changed/pruned text; ownership must be checked against the stored row by the caller. */
export function read(message: SessionMessage.Message, input: typeof ReadInput.Type) {
  if (!Schema.is(ReadInput)(input)) return
  if (message.id !== input.messageID || message.type !== "assistant") return
  const tool = message.content.find((part) => part.type === "tool" && part.id === input.callID)
  // Readback must survive later changes to packing eligibility (including stricter diagnostic vetoes).
  if (tool?.type !== "tool" || tool.time.pruned !== undefined || tool.state.status !== "completed") return
  const part = tool.state.content[input.block]
  if (part?.type !== "text") return
  const bytes = Buffer.from(part.text)
  if (Hash.sha256(bytes) !== input.hash || input.offset > bytes.length) return
  const page = bytes.subarray(input.offset, input.offset + input.length)
  const text = page.toString("utf8")
  // Escape-heavy terminal output must not turn a bounded page into oversized JSON.
  const encoding =
    Buffer.from(text).equals(page) && Buffer.byteLength(JSON.stringify(text)) <= 16 * 1024
      ? ("utf8" as const)
      : ("base64" as const)
  return {
    messageID: message.id,
    callID: tool.id,
    block: input.block,
    hash: input.hash,
    bytes: bytes.length,
    offset: input.offset,
    length: input.length,
    nextOffset: input.offset + page.length,
    eof: input.offset + page.length === bytes.length,
    encoding,
    data: encoding === "utf8" ? text : page.toString("base64"),
  }
}

function eligible(tool: SessionMessage.AssistantTool) {
  if (
    tool.provider?.executed ||
    tool.time.pruned !== undefined ||
    tool.time.completed === undefined ||
    tool.state.status !== "completed" ||
    tool.state.structured.truncated === true ||
    tool.state.structured.timeout === true ||
    tool.state.attachments?.length ||
    tool.state.content.some((part) => part.type !== "text")
  )
    return false
  // Receipts, failures and incomplete process captures stay fully visible. Shell exit zero is not a correctness claim.
  if (tool.name === "bash")
    return (
      successfulShell(tool.state.structured) &&
      !tool.state.content.some((part) => part.type === "text" && diagnostic.test(part.text))
    )
  return ["read", "glob", "grep"].includes(tool.name)
}
