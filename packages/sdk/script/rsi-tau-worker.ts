// Part of mutable H. Business state, private user simulation and grading stay
// outside this process. This plugin contributes tools to the native V2 Session.
import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { interruptOnTerminal } from "./rsi-bridge-worker"

const Public = Schema.Struct({
  kind: Schema.Literal("tau-public-v1"),
  sequence: Schema.Int,
  terminal: Schema.Boolean,
  termination: Schema.NullOr(Schema.String),
  steps: Schema.Int,
  maxSteps: Schema.Literal(100),
  deadline: Schema.Number,
  policy: Schema.String,
  tools: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  messages: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
})

export async function tauProfile(input: {
  deadline: number
  standing: () => Promise<void>
  revise?: (reason: string) => void
  socket?: string
}) {
  const request = async (route: string, value: unknown, signal?: AbortSignal) => {
    await input.standing()
    const response = await fetch(`http://tau.invalid${route}`, {
      unix: input.socket ?? "/benchmark/tools.sock",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(Math.max(1, Math.min(900_000, input.deadline - Date.now()))),
      ]),
    })
    if (!response.ok) throw new Error(`Official tau environment refused ${route}: ${response.status}`)
    const result = Schema.decodeUnknownSync(Public)(await response.json())
    if (result.deadline !== input.deadline) throw new Error("tau original deadline changed")
    return result
  }
  const current = { value: await request("/state", {}), revision: undefined as string | undefined }
  const instructions =
    "You are participating in the official tau3 text half-duplex conversation. " +
    "Use tau_turn for every customer-facing message or business operation; ordinary assistant prose is private and is not delivered to the customer. " +
    "A tau_turn contains EITHER speak, OR an ordered batch of official tool calls, OR stop:true. Never mix speech and tools. " +
    "Call tau_turn at most once per provider response; put parallel business operations in its calls array. " +
    "This cohort freezes 100 official interaction steps and 10 errors, preserved across runtime changes. " +
    "Internal planning is not a business interaction; no cumulative provider/tool budget is added. " +
    "Do not repeat a committed business action after a runtime change. Hidden goals, evaluation criteria and scores are unavailable. " +
    "When the returned conversation is terminal, finish without further tools. Stop does not assert that hidden evaluation passed.\n\n" +
    `Official domain policy:\n${current.value.policy}\n\n` +
    `Official tools (name, description, JSON arguments schema):\n${JSON.stringify(current.value.tools)}\n\n` +
    `Public conversation, including any committed predecessor actions:\n${JSON.stringify(current.value.messages)}`
  const plugin = Plugin.define({
    id: "rsi.tau-worker",
    async setup(context) {
      const stop = await interruptOnTerminal(context, () => current.value.terminal || !!current.revision)
      await context.tool.transform((editor) => {
        for (const tool of editor.list()) editor.remove(tool.id)
        // A single batch boundary avoids guessing when streamed parallel tools
        // form one official assistant message. It is not a second agent loop.
        editor.add({
          name: "tau_turn",
          description:
            "Perform one official tau assistant turn: customer speech OR an ordered batch of official business tools OR stop. Use only names/arguments from the supplied official tool schemas.",
          input: Schema.Union([
            Schema.Struct({ speak: Schema.String }),
            Schema.Struct({
              calls: Schema.Array(
                Schema.Struct({ name: Schema.String, arguments: Schema.Record(Schema.String, Schema.Unknown) }),
              ),
            }),
            Schema.Struct({ stop: Schema.Literal(true) }),
          ]),
          options: { codemode: false },
          execute: async (action, call) => {
            await input.standing()
            call.signal.throwIfAborted()
            if (current.value.terminal || current.revision) throw new Error("tau allocation already handed off")
            const previous = current.value
            current.value = await request(
              "/turn",
              { id: `${call.messageID}:${call.id}`, sequence: previous.sequence, action },
              call.signal,
            )
            if (current.value.terminal) stop(call.sessionID)
            for (const message of current.value.messages.slice(previous.messages.length)) {
              if (message.role !== "user" || typeof message.content !== "string" || current.value.terminal) continue
              await context.session.prompt({
                sessionID: call.sessionID,
                text: message.content,
                delivery: "steer",
                resume: true,
              })
            }
            return {
              content: JSON.stringify({
                sequence: current.value.sequence,
                steps: current.value.steps,
                terminal: current.value.terminal,
                termination: current.value.termination,
                messages: current.value.messages.slice(previous.messages.length),
                authoritativeCompletion: false,
              }),
            }
          },
        })
        if (input.revise)
          editor.add({
            name: "rsi_revise",
            description:
              "Request a separately qualified strategy/runtime successor for this same conversation. All committed business actions, user state, interaction steps and original deadline remain. Never use this to retry a task or hidden reward.",
            input: Schema.Struct({ reason: Schema.String }),
            options: { codemode: false },
            execute: async (value, call) => {
              await input.standing()
              call.signal.throwIfAborted()
              if (current.value.terminal || current.revision || !value.reason.trim())
                throw new Error("tau revision requires a live conversation and concrete reason")
              current.revision = value.reason
              input.revise!(value.reason)
              stop(call.sessionID)
              return { content: "Revision requested; the same host-owned business conversation is retained." }
            },
          })
      })
    },
  })
  return {
    plugin,
    instructions,
    status: () =>
      current.revision
        ? { state: "revise" as const, reason: current.revision, sequence: current.value.sequence }
        : current.value.terminal
          ? {
              state: "ready" as const,
              summary: current.value.termination ?? "official conversation ended",
              sequence: current.value.sequence,
            }
          : { state: "open" as const, sequence: current.value.sequence },
  }
}
