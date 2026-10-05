import { expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { LLM, Message, Model, ToolResultPart } from "@opencode-ai/llm"
import { OpenAIResponses } from "@opencode-ai/llm/protocols/openai-responses"
import { ContextBudget } from "../src/session/context-budget"
import { SessionCompaction } from "../src/session/compaction"
import { SessionMessage } from "../src/session/message"
import { SessionHistory } from "../src/session/history"

const model = Model.make({ id: "test", provider: "openai", route: OpenAIResponses.route })

test("encoded media size is not treated as language tokens", () => {
  const request = (bytes: number) =>
    LLM.request({ model, messages: [Message.user({ type: "media", mediaType: "image/png", data: "x".repeat(bytes) })] })
  expect(ContextBudget.estimate(request(1_450_000))).toBe(ContextBudget.estimate(request(12)))
  expect(ContextBudget.estimate(request(1_450_000))).toBeLessThan(10_000)
})

test("repeated exact media is retained once without mutating durable input", () => {
  const image = { type: "media" as const, mediaType: "image/png", data: "x".repeat(1_450_000) }
  const history = [Message.user(image), Message.assistant("measurements"), Message.user(image)]
  const selected = ContextBudget.selectMedia(history)
  expect(selected[0].content[0].type).toBe("text")
  expect(selected[2].content[0]).toEqual(image)
  expect(history[0].content[0]).toEqual(image)
  expect(selected[1]).toEqual(history[1])
})

test("different media beyond the byte bound is explicitly omitted, not called a duplicate", () => {
  const history = [
    Message.user({ type: "media", mediaType: "image/png", data: "a".repeat(20 * 1024 * 1024) }),
    Message.user({ type: "media", mediaType: "image/png", data: "b".repeat(20 * 1024 * 1024) }),
  ]
  const selected = ContextBudget.selectMedia(history)
  expect(selected[0].content[0]).toMatchObject({ type: "text" })
  expect(JSON.stringify(selected[0])).toContain("byte-safety")
  expect(JSON.stringify(selected[0])).not.toContain("exact-byte copy")
  expect(selected[1].content[0].type).toBe("media")
})

test("matching remote URLs are not mistaken for immutable identical media", () => {
  const part = { type: "media" as const, mediaType: "image/png", data: "https://example.test/changing.png" }
  const result = ContextBudget.selectMedia([Message.user(part), Message.user(part)])
  expect(result[0].content[0].type).toBe("media")
  expect(result[1].content[0].type).toBe("media")
})

test("runner history drops duplicate blob representations without editing durable messages", () => {
  const raw = Schema.decodeUnknownSync(SessionMessage.Message)({
    id: "msg_image",
    type: "assistant",
    agent: "build",
    model: { providerID: "openai", id: "test" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "image_call",
        name: "read",
        time: { created: 1 },
        state: {
          status: "completed",
          input: { path: "/picture.png" },
          structured: { encoding: "base64", content: "AAAA" },
          content: [{ type: "file", mime: "image/png", uri: "data:image/png;base64,AAAA", name: "picture.png" }],
        },
      },
    ],
  })
  const selector = ContextBudget.mediaSelector()
  const newer = SessionHistory.selectMessageMedia(raw, selector)
  const older = SessionHistory.selectMessageMedia(raw, selector)
  expect(JSON.stringify(newer)).toContain("data:image/png;base64,AAAA")
  expect(JSON.stringify(older)).not.toContain("data:image/png;base64,AAAA")
  expect(JSON.stringify(older)).not.toContain('"content":"AAAA"')
  expect(JSON.stringify(raw)).toContain('"content":"AAAA"')
  expect(JSON.stringify(older)).toContain("exact-byte copy")
})

test("tool media is bounded, but ordinary text and JSON keep their true size", () => {
  const image = "data:image/png;base64," + "x".repeat(1_450_000)
  const tool = LLM.request({
    model,
    messages: [
      Message.tool(
        ToolResultPart.make({
          id: "a",
          name: "read",
          result: { type: "content", value: [{ type: "file", uri: image, mime: "image/png" }] },
        }),
      ),
    ],
  })
  expect(ContextBudget.estimate(tool)).toBeLessThan(10_000)
  expect(ContextBudget.estimate(LLM.request({ model, prompt: image }))).toBeGreaterThan(300_000)
  expect(
    ContextBudget.estimate(
      LLM.request({
        model,
        messages: [
          Message.tool(
            ToolResultPart.make({
              id: "b",
              name: "read",
              result: { type: "json", value: { type: "file", uri: image } },
            }),
          ),
        ],
      }),
    ),
  ).toBeGreaterThan(300_000)
})

test("history partition does not duplicate the prefix of a split message", () => {
  const text = "0123456789".repeat(20)
  const selected = SessionCompaction.select(
    [
      {
        seq: 1,
        message: {
          id: SessionMessage.ID.make("msg_partition"),
          type: "user",
          text,
          time: { created: DateTime.makeUnsafe(1) },
        },
      },
    ],
    10,
  )
  expect(selected).toBeDefined()
  expect(selected!.head + selected!.recent).toBe(`[User]: ${text}`)
})

test("failed summaries preserve explicitly labelled excerpts, never partial generated claims", () => {
  const result = SessionCompaction.extractiveFallback({
    previousSummary: "Requirement A remains unresolved",
    context: ["tool failed: expected 7, actual 3"],
  })
  expect(result).toContain("compaction:extractive-fallback")
  expect(result).toContain("Requirement A remains unresolved")
  expect(result).toContain("expected 7, actual 3")
  expect(result).toContain("not verified facts")
})
