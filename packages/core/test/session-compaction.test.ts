import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("compaction evidence retains diagnostic tool identity and bounded state", () => {
  const output = "prefix\n" + "x".repeat(6000) + "\nexpected value differed from actual value\n" + "y".repeat(6000)
  const message = SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_diagnostic"),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content: [
      SessionMessage.AssistantTool.make({
        type: "tool",
        id: "call_diagnostic",
        name: "bash",
        time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
        state: {
          status: "completed",
          input: { command: "check" },
          structured: { exit: 0, truncated: false },
          content: [{ type: "text", text: output }],
        },
      }),
    ],
    time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
  })

  const evidence = SessionCompaction.diagnosticEvidence([{ seq: 1, message }])
  expect(evidence).toContain("message=msg_diagnostic kind=tool tool=bash call=call_diagnostic status=completed")
  expect(evidence).toContain('input={"command":"check"}')
  expect(evidence).toContain("expected value differed from actual value")
  expect(evidence).toContain("diagnostic evidence omitted by compaction")
  expect(Buffer.byteLength(evidence, "utf8")).toBeLessThanOrEqual(8 * 1024)
})

test("compaction evidence does not retain an ordinary successful result", () => {
  const message = SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_success"),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content: [
      SessionMessage.AssistantTool.make({
        type: "tool",
        id: "call_success",
        name: "read",
        time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
        state: {
          status: "completed",
          input: { path: "file.txt" },
          structured: { value: "ok", truncated: false },
          content: [{ type: "text", text: "ordinary successful content" }],
        },
      }),
    ],
    time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
  })

  expect(SessionCompaction.diagnosticEvidence([{ seq: 1, message }])).toBe("")
})
