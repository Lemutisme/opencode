export * as RepeatedToolInput from "./repeated-tool-input"

import { type LLMEvent } from "@opencode-ai/llm"
import { Data } from "effect"

export class Failure extends Data.TaggedError("RepeatedToolInput")<{
  readonly callID: string
  readonly message: string
}> {}

/** Used only after an uncalled input failure. This is a bounded-operation heuristic, not JSON validation. */
export function make() {
  const inputs = new Map<string, { bytes: number; characters: number; character: string; run: number; since: number }>()
  return {
    observe(event: LLMEvent, now: number) {
      if (event.type === "tool-input-start") {
        inputs.set(event.id, { bytes: 0, characters: 0, character: "", run: 0, since: now })
        return
      }
      if (event.type === "tool-input-end" || event.type === "tool-call") {
        inputs.delete(event.id)
        return
      }
      if (event.type !== "tool-input-delta") return
      const input = inputs.get(event.id)
      if (!input) return
      input.bytes += Buffer.byteLength(event.text, "utf8")
      for (const character of event.text) {
        if (character !== input.character) {
          input.character = character
          input.run = 0
          input.since = now
        }
        input.characters++
        input.run++
      }
      if (
        input.bytes < 65_536 ||
        input.run < 16_384 ||
        input.run / input.characters < 0.95 ||
        now - input.since < 60_000 ||
        input.character.trim().length === 0
      )
        return
      return new Failure({
        callID: event.id,
        message:
          "Local recovery guard stopped this provider turn while receiving another highly repetitive tool input. " +
          `The trailing run is ${input.run} copies of U+${input.character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} ` +
          `over at least ${now - input.since} ms. ` +
          "No complete call was received for this input. Recheck the required data length against its source; " +
          "construct repeated data with a short expression or a local generator instead of retrying the long literal.",
      })
    },
  }
}
