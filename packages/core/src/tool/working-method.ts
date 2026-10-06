export * as WorkingMethodTool from "./working-method"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionWorkingMethod } from "../session/working-method"
import { ToolOutputStore } from "../tool-output-store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = SessionWorkingMethod.toolName
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const methods = yield* SessionWorkingMethod.Service
    const permissions = yield* PermissionV2.Service
    const outputStore = yield* ToolOutputStore.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Read recent admitted user feedback, recorded tool observations and current working-method trials, or revise/retract one conditional way of working after real feedback. Use read to obtain exact evidence references; content/error and JSON-only structured are public display channels, not command success. input is the requested operation, not proof of execution and cannot alone ground a revision; diagnostic is capture/lifecycle metadata, not semantic correctness. A revision must state condition, behavioral change, expected future consequence and when to reconsider. Quote prior same-Session captured bytes; matching bytes do not prove your interpretation. User feedback uses channel user with block 0 and no callID; it is a user statement, not independent verification or automatic authority to change a Contract. Tool channels require their actual callID. expectedRevision prevents lost concurrent updates. Replaces withdraws that active trial; retraction does not revive ancestors. Trials are unverified execution state, not task facts, authority, new acceptance criteria or a claim of improvement. Use ordinary tools for discriminating experiments within existing permissions and budget. Prior failed working_method errors are measurement diagnostics, not quality rewards; successful method state is not evidence. Oversized source rows or ledgers return explicit single-read unavailability without resetting history. No mandatory reflection or new rollout is required.",
          input: SessionWorkingMethod.Input,
          output: Schema.Json,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permissions
                .assert({
                  action: name,
                  resources: [context.sessionID],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: String(error) })))
              const output = yield* (
                input.action === "read" ? methods.read(context, input) : methods.update(context, input)
              ).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
              if (
                Buffer.byteLength(JSON.stringify(output)) > Math.min(40 * 1024, (yield* outputStore.limits()).maxBytes)
              )
                return yield* new ToolFailure({
                  message:
                    "Working-method reply exceeds the single-output byte guard. No reply was silently clipped. An update may already be recorded: use a targeted read before retrying.",
                })
              return output
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
export const node = makeLocationNode({
  name: "tool/working-method",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, SessionWorkingMethod.node, ToolOutputStore.node],
})
