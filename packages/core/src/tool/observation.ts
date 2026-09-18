export * as SessionObservationTools from "./observation"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionObservationPack } from "../session/observation-pack"
import { SessionStore } from "../session/store"
import { NonNegativeInt } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const sessions = yield* SessionStore.Service
    const permissions = yield* PermissionV2.Service
    yield* tools
      .register({
        [SessionObservationPack.toolName]: Tool.make({
          description:
            "Read an exact byte page of older tool display text or a canonical structured result from this Session's durable history. Copy messageID, callID, block, source and hash from the observation placeholder; continue using nextOffset until eof. Offsets and lengths are bytes. Encoding is utf8 when the page round-trips exactly, otherwise base64. The recorded value may already contain a capture/truncation notice; recall does not reconstruct bytes that were never recorded. It does not execute a tool again or settle a Contract.",
          input: SessionObservationPack.ReadInput,
          output: Schema.Struct({
            ...SessionObservationPack.ReadInput.fields,
            bytes: NonNegativeInt,
            nextOffset: NonNegativeInt,
            eof: Schema.Boolean,
            encoding: Schema.Literals(["utf8", "base64"]),
            data: Schema.String,
          }),
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permissions
                .assert({
                  action: SessionObservationPack.toolName,
                  resources: [input.messageID],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: String(error) })))
              const stored = yield* sessions.message(input.messageID)
              if (!stored || stored.sessionID !== context.sessionID)
                return yield* new ToolFailure({ message: "Observation is unavailable in this Session" })
              const page = SessionObservationPack.read(stored.message, input)
              if (!page)
                return yield* new ToolFailure({ message: "Observation is unavailable or its hash changed" })
              return page
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

/** Explicit host registration; the runner's host policy still controls projection and catalog visibility. */
export const node = makeLocationNode({
  name: "tool/session-observation",
  deps: [ToolRegistry.node, PermissionV2.node, SessionStore.node],
  layer,
})

export const layerWith = (enabled: boolean) => (enabled ? layer : Layer.empty)

/** The host enables Contract packing by default; request policy keeps ordinary Sessions opt-in. */
export const configuredNode = makeLocationNode({
  name: "tool/session-observation-configured",
  deps: [ToolRegistry.node, PermissionV2.node, SessionStore.node, SessionObservationPack.policyNode],
  layer: Layer.unwrap(
    Effect.gen(function* () {
      const policy = yield* SessionObservationPack.Policy
      return layerWith(policy !== "off")
    }),
  ),
})
