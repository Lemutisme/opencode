import { describe, expect, test } from "bun:test"
import { LLMEvent } from "@opencode-ai/llm"
import { RepeatedToolInput } from "@opencode-ai/core/session/runner/repeated-tool-input"

const start = (id = "call-a") => LLMEvent.toolInputStart({ id, name: "write" })
const delta = (text: string, id = "call-a") => LLMEvent.toolInputDelta({ id, name: "write", text })

describe("RepeatedToolInput recovery observation", () => {
  test("reports a sustained trailing numeric literal only after one minute", () => {
    const guard = RepeatedToolInput.make()
    expect(guard.observe(start(), 0)).toBeUndefined()
    expect(guard.observe(delta('{"content":"17976931348623157' + "0".repeat(65_536)), 10)).toBeUndefined()
    expect(guard.observe(delta("0"), 60_009)).toBeUndefined()
    const failure = guard.observe(delta("0"), 60_010)
    expect(failure).toBeInstanceOf(RepeatedToolInput.Failure)
    expect(failure?.callID).toBe("call-a")
    expect(failure?.message).toContain("U+0030")
    expect(failure?.message).toContain("No complete call was received")
  })

  test("allows a complete legitimate JSON argument emitted in one chunk", () => {
    const guard = RepeatedToolInput.make()
    guard.observe(start(), 0)
    expect(guard.observe(delta(JSON.stringify({ content: "0".repeat(100_000) })), 120_000)).toBeUndefined()
    expect(guard.observe(LLMEvent.toolInputEnd({ id: "call-a", name: "write" }), 120_001)).toBeUndefined()
  })

  test("does not mistake old tool-start time for sustained repetition time", () => {
    const guard = RepeatedToolInput.make()
    guard.observe(start(), 0)
    expect(guard.observe(delta("0".repeat(100_000)), 120_000)).toBeUndefined()
    expect(guard.observe(delta("0"), 179_999)).toBeUndefined()
    expect(guard.observe(delta("0"), 180_000)).toBeInstanceOf(RepeatedToolInput.Failure)
  })

  test("requires 65536 actual UTF-8 bytes", () => {
    const guard = RepeatedToolInput.make()
    guard.observe(start(), 0)
    guard.observe(delta("0".repeat(65_534)), 0)
    expect(guard.observe(delta("0"), 60_000)).toBeUndefined()
    expect(guard.observe(delta("0"), 60_000)).toBeInstanceOf(RepeatedToolInput.Failure)
  })

  test("counts astral Unicode characters and keeps the 16384-character run boundary", () => {
    const guard = RepeatedToolInput.make()
    guard.observe(start(), 0)
    // Four ASCII bytes make the first delta exactly 65536 bytes, while the
    // trailing Unicode run is still one code point below the run threshold.
    guard.observe(delta("abcd" + "🟢".repeat(16_383)), 0)
    expect(guard.observe(delta(""), 60_000)).toBeUndefined()
    const failure = guard.observe(delta("🟢"), 60_000)
    expect(failure).toBeInstanceOf(RepeatedToolInput.Failure)
    expect(failure?.message).toContain("16384 copies of U+1F7E2")
  })

  test("requires the trailing run to cover at least 95 percent of characters", () => {
    const below = RepeatedToolInput.make()
    below.observe(start(), 0)
    below.observe(delta("1" + "01".repeat(2_000) + "0".repeat(76_000)), 0)
    expect(below.observe(delta(""), 60_000)).toBeUndefined()

    const boundary = RepeatedToolInput.make()
    boundary.observe(start(), 0)
    boundary.observe(delta("01".repeat(2_000) + "0".repeat(76_000)), 0)
    expect(boundary.observe(delta(""), 60_000)).toBeInstanceOf(RepeatedToolInput.Failure)
  })

  test("resets duration when the trailing repeated character changes", () => {
    const guard = RepeatedToolInput.make()
    guard.observe(start(), 0)
    guard.observe(delta("0".repeat(20)), 0)
    guard.observe(delta("1".repeat(70_000)), 59_000)
    expect(guard.observe(delta("1"), 60_000)).toBeUndefined()
    expect(guard.observe(delta("1"), 118_999)).toBeUndefined()
    expect(guard.observe(delta("1"), 119_000)).toBeInstanceOf(RepeatedToolInput.Failure)
  })

  test("keeps independent calls from pooling bytes, runs or time", () => {
    const guard = RepeatedToolInput.make()
    guard.observe(start("call-a"), 0)
    guard.observe(start("call-b"), 10)
    guard.observe(delta("0".repeat(33_000), "call-a"), 0)
    guard.observe(delta("1".repeat(33_000), "call-b"), 10)
    expect(guard.observe(delta("0", "call-a"), 60_010)).toBeUndefined()
    const failure = guard.observe(delta("1".repeat(34_000), "call-b"), 60_010)
    expect(failure?.callID).toBe("call-b")
    expect(guard.observe(delta("0", "call-a"), 60_011)).toBeUndefined()
  })

  for (const end of [
    LLMEvent.toolInputEnd({ id: "call-a", name: "write" }),
    LLMEvent.toolCall({ id: "call-a", name: "write", input: { content: "finished" } }),
  ]) {
    test(`clears pending state at ${end.type}`, () => {
      const guard = RepeatedToolInput.make()
      guard.observe(start(), 0)
      guard.observe(delta("0".repeat(70_000)), 0)
      expect(guard.observe(end, 100)).toBeUndefined()
      expect(guard.observe(delta("0"), 60_000)).toBeUndefined()
      guard.observe(start(), 60_001)
      expect(guard.observe(delta("0"), 120_002)).toBeUndefined()
    })
  }

  test("ignores deltas without a started call", () => {
    const guard = RepeatedToolInput.make()
    expect(guard.observe(delta("0".repeat(100_000)), 0)).toBeUndefined()
    expect(guard.observe(delta("0".repeat(100_000)), 60_000)).toBeUndefined()
  })

  test("accepts large nonrepetitive input and changes that end a long run", () => {
    const guard = RepeatedToolInput.make()
    guard.observe(start(), 0)
    guard.observe(delta("01".repeat(40_000)), 0)
    expect(guard.observe(delta("01".repeat(40_000)), 60_000)).toBeUndefined()

    const ended = RepeatedToolInput.make()
    ended.observe(start(), 0)
    ended.observe(delta("0".repeat(70_000)), 0)
    expect(ended.observe(delta('"}'), 60_000)).toBeUndefined()
  })

  for (const character of [" ", "\n", "\r", "\t", "\u3000"]) {
    test(`does not classify whitespace U+${character.codePointAt(0)?.toString(16)} as a repeated data literal`, () => {
      const guard = RepeatedToolInput.make()
      guard.observe(start(), 0)
      guard.observe(delta(character.repeat(70_000)), 0)
      expect(guard.observe(delta(character), 60_000)).toBeUndefined()
    })
  }
})
