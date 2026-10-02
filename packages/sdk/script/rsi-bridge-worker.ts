// Mutable H plugin for host-owned benchmark tools, not another agent loop.
import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import type { JsonSchema } from "effect"
import { bridgeTools } from "./rsi-bridge"

export async function interruptOnTerminal(context: Plugin.Context, terminal: () => boolean) {
  const stop = (sessionID: string) => {
    // Never await interruption from inside the tool being interrupted.
    void context.session.interrupt({ sessionID }).catch(() => undefined)
  }
  await context.session.hook("model.request", async (event) => {
    if (!terminal()) return
    stop(event.sessionID)
    // This hook cannot authorize another provider request while the asynchronous
    // interrupt reaches the execution fiber. The fiber cancels this suspension;
    // no timer, background loop or implicit provider retry is introduced.
    await new Promise<never>(() => {})
  })
  return stop
}

export async function bridgeProfile(input: {
  deadline: number
  standing: () => Promise<void>
  file?: string
  socket?: string
}) {
  const tools = bridgeTools(await Bun.file(input.file ?? "/task/bridge-tools.json").json(), "bridge")
  const current = {
    value: { state: "open" as "open" | "ready" | "blocked", summary: "" },
  }
  const plugin = Plugin.define({
    id: "rsi.benchmark-worker",
    async setup(context) {
      const stop = await interruptOnTerminal(context, () => current.value.state !== "open")
      await context.tool.transform((editor) => {
        for (const tool of editor.list()) editor.remove(tool.id)
        for (const tool of tools.tools) {
          if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema))
            throw new Error("benchmark tool requires a JSON Schema object")
          editor.add({
            name: tool.name,
            description: tool.description,
            input: tool.inputSchema as JsonSchema.JsonSchema,
            options: { codemode: false },
            execute: async (value, call) => {
              await input.standing()
              call.signal.throwIfAborted()
              if (current.value.state !== "open") throw new Error("benchmark allocation already handed off")
              const response = await fetch("http://benchmark.invalid/call", {
                unix: input.socket ?? "/benchmark/tools.sock",
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  id: `${call.messageID}:${call.id}`,
                  sessionID: call.sessionID,
                  name: tool.name,
                  arguments: value,
                }),
                signal: AbortSignal.any([
                  call.signal,
                  AbortSignal.timeout(Math.max(1, Math.min(900_000, input.deadline - Date.now()))),
                ]),
              })
              if (!response.ok) throw new Error(`Host benchmark tool refused: ${response.status}`)
              const result = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }))(await response.json())
              return { content: JSON.stringify(result.result) }
            },
          })
        }
        for (const state of ["ready", "blocked"] as const)
          editor.add({
            name: state === "ready" ? "task_handoff" : "task_blocked",
            description:
              state === "ready"
                ? "Submit the retained benchmark environment for independent official verification. This does not assert success."
                : "Stop this allocation with a concrete unresolved reason. The official verifier remains independent.",
            input: Schema.Struct({ summary: Schema.String }),
            options: { codemode: false },
            execute: async (value, call) => {
              await input.standing()
              call.signal.throwIfAborted()
              if (current.value.state !== "open" || !value.summary.trim())
                throw new Error("one nonempty benchmark handoff required")
              current.value = { state, summary: value.summary }
              stop(call.sessionID)
              return { content: JSON.stringify({ ...current.value, authoritativeCompletion: false }) }
            },
          })
      })
    },
  })
  return {
    plugin,
    instructions:
      "Use the host-provided benchmark tools to solve the task. Local filesystem/shell tools are not available in the native agent container; task actions happen only through these tools in the retained benchmark environment. " +
      "When done, call task_handoff with an honest summary; if unable to continue, use task_blocked. Official verification is host-owned and independent. Do not assert that hidden tests passed.",
    status: () => current.value,
  }
}
