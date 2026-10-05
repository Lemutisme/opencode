import { Message, type ContentPart, type LLMRequest, type ToolContent } from "@opencode-ai/llm"
import { Hash } from "../util/hash"
import { Token } from "../util/token"

// A conservative scheduling allowance, not a provider tokenizer. Actual context
// overflow still invokes recovery. Encoded bytes are never language tokens.
export const MEDIA_ALLOWANCE = 8_192
export const MAX_INLINE_MEDIA_BYTES = 32 * 1024 * 1024

/** Request selection only: complete media remains in the durable Session. */
export function mediaSelector() {
  const seen = new Set<string>()
  const budget = { bytes: 0 }
  return (mime: string, data: string | Uint8Array) => {
    // Equal remote URLs are not evidence of equal bytes at different times.
    const remote = typeof data === "string" && /^(?:https?|file):/i.test(data)
    const key = `${mime}:${Hash.sha256(typeof data === "string" ? data : Buffer.from(data))}`
    if (!remote && seen.has(key))
      return `An exact-byte copy of this ${mime} is retained later in this conversation (${key}).`
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : Math.ceil((data.byteLength * 4) / 3)
    if (budget.bytes + bytes > MAX_INLINE_MEDIA_BYTES)
      return `Media bytes omitted by the request byte-safety bound (${key}). The complete observation remains in Session history; re-read the source if required. Do not infer unseen visual facts.`
    if (!remote) seen.add(key)
    budget.bytes += bytes
    return undefined
  }
}

export function selectMedia(messages: ReadonlyArray<Message>) {
  const omit = mediaSelector()
  return messages
    .toReversed()
    .map((message) =>
      Message.make({
        ...message,
        content: message.content
          .toReversed()
          .map((part): ContentPart => {
            if (part.type === "media") {
              const note = omit(part.mediaType, part.data)
              return note ? Message.text(note) : part
            }
            if (part.type !== "tool-result" || part.result.type !== "content") return part
            const content: ReadonlyArray<ToolContent> = part.result.value
            return {
              ...part,
              result: {
                type: "content",
                value: content
                  .toReversed()
                  .map((item): ToolContent => {
                    if (item.type !== "file") return item
                    const note = omit(item.mime, item.uri)
                    return note ? { type: "text", text: `[${item.name ?? part.name}; call=${part.id}] ${note}` } : item
                  })
                  .toReversed(),
              },
            }
          })
          .toReversed(),
      }),
    )
    .toReversed()
}

export function estimate(request: Pick<LLMRequest, "system" | "messages" | "tools">) {
  const messages = request.messages.map((message) => ({ message, parts: message.content.map(stripMedia) }))
  return (
    Token.estimate(
      JSON.stringify({
        system: request.system,
        tools: request.tools,
        messages: messages.map((entry) => ({ ...entry.message, content: entry.parts.map((part) => part[0]) })),
      }),
    ) + messages.reduce((total, entry) => total + entry.parts.reduce((sum, part) => sum + part[1], 0), 0)
  )
}

function stripMedia(part: ContentPart): readonly [ContentPart, number] {
  if (part.type === "media") return [{ ...part, data: "[encoded media]" }, MEDIA_ALLOWANCE]
  if (part.type !== "tool-result" || part.result.type !== "content") return [part, 0]
  const content: ReadonlyArray<ToolContent> = part.result.value
  return [
    {
      ...part,
      result: {
        type: "content",
        value: content.map((item) => (item.type === "file" ? { ...item, uri: "[encoded media]" } : item)),
      },
    },
    content.filter((item) => item.type === "file").length * MEDIA_ALLOWANCE,
  ]
}

export * as ContextBudget from "./context-budget"
