import { Option, Schema } from "effect"
import { SessionMessage } from "../message"

const decode = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

/** Native Tool.Called sets ran durably before local execution; unknown imported provenance is left alone. */
export function isUncalledFailure(
  part: SessionMessage.AssistantContent,
): part is SessionMessage.AssistantTool & { state: SessionMessage.ToolStateError } {
  return (
    part.type === "tool" &&
    part.state.status === "error" &&
    part.time.ran === undefined &&
    part.provider?.executed === false
  )
}

/** Describe retained arguments only after their provider turn has ended without a tool call. */
export function describe(text: string, reason: string) {
  let previous = ""
  let run = 0
  let longest = 0
  let characters = 0
  for (const character of text) {
    run = character === previous ? run + 1 : 1
    longest = Math.max(longest, run)
    previous = character
    characters++
  }
  return [
    `${reason}.`,
    "This tool was not executed locally: no complete tool call was received.",
    `Retained argument text: ${Buffer.byteLength(text, "utf8")} UTF-8 bytes.`,
    Option.isSome(decode(text))
      ? "The text parses as complete JSON, but the tool call was not completed."
      : "The text does not parse as complete JSON; it may be incomplete or malformed.",
    // This threshold only controls a diagnostic after interruption; it never stops a healthy stream.
    ...(longest >= 1024
      ? [
          `Longest identical-character run: ${longest} characters (${((longest / characters) * 100).toFixed(1)}% of the text).`,
          "If that repetition is intended data, generate it with code instead of emitting a long literal.",
        ]
      : []),
    "Send a new call with complete arguments. For large file content, consider smaller writes.",
  ].join(" ")
}

export * as InterruptedToolInput from "./interrupted-tool-input"
