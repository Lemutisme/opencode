// Runs inside the sandbox. This process has no issuer ledger or provider credential.
import { Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Plugin } from "@opencode/plugin"
import { requestExecutor } from "@opencode/core/effect/app-node-platform"
import { RSI } from "@opencode/core/pro-contract/rsi"
import { ProviderTransport } from "./transport"
import { PromiseSdk } from "../promise"

const Input = Schema.Struct({
  goal: Schema.String,
  deadline: Schema.Number,
  model: Schema.String,
  effort: Schema.String,
  instructions: Schema.String,
  feedback: Schema.Array(Schema.String),
  evaluation: Schema.Boolean,
})
const input = Schema.decodeUnknownSync(Schema.fromJsonString(Input))(await Bun.file("/admission/input.json").text())
const active = () => {
  if (Date.now() >= input.deadline) throw new Error("Original task deadline reached")
}
while (!(await Bun.file("/admission/ready").exists())) {
  active()
  await Bun.sleep(20)
}
const result: {
  value?: { action: "submit" | "checkpoint" | "propose" | "blocked"; summary: string; method?: RSI.Method }
} = {}
const serial = { pending: Promise.resolve() }
const exclusive = <T>(run: () => Promise<T>) => {
  const next = serial.pending.then(run)
  serial.pending = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}
const plugin = Plugin.define({
  id: "procontract.essential",
  async setup(context) {
    await context.tool.transform((editor) => {
      for (const tool of editor.list()) {
        if (!["glob", "grep", "read", "patch", "shell"].includes(tool.name)) {
          editor.remove(tool.id)
          continue
        }
        editor.update(tool.id, (current) => {
          current.options = { ...current.options, codemode: false, pinned: undefined }
          const execute = current.execute
          current.execute = (value, call) =>
            exclusive(async () => {
              active()
              call.signal.throwIfAborted()
              if (result.value) throw new Error("Execution was handed off")
              return execute(
                tool.name === "shell"
                  ? {
                      ...value,
                      background: false,
                      timeout: Math.max(1, Math.min(value.timeout || 600000, 600000, input.deadline - Date.now())),
                    }
                  : value,
                call,
              )
            })
        })
      }
      editor.add({
        name: "contract_handoff",
        description:
          "Hand off this execution. submit requests independent acceptance; checkpoint retains work and refreshes context; propose requests independent evaluation of a new method; blocked retains unresolved responsibility. None grants acceptance or deployment. The original deadline does not change.",
        input: Schema.Struct({
          action: Schema.Literals(["submit", "checkpoint", "propose", "blocked"]),
          summary: Schema.NonEmptyString,
          instructions: Schema.optional(Schema.NonEmptyString),
        }),
        options: { codemode: false },
        execute: (value, call) =>
          exclusive(async () => {
            active()
            call.signal.throwIfAborted()
            if (result.value) throw new Error("Execution was already handed off")
            if (input.evaluation && value.action === "propose")
              throw new Error("Fixed-pair measurement cannot nest RSI")
            if ((value.action === "propose") !== (value.instructions !== undefined))
              throw new Error("Only a proposal contains replacement instructions")
            result.value = {
              action: value.action,
              summary: value.summary,
              ...(value.instructions ? { method: RSI.method({ instructions: value.instructions }) } : {}),
            }
            await context.session.interrupt({ sessionID: call.sessionID })
            return {
              content: "Handoff recorded, not acceptance. The host will fence execution and verify sealed bytes.",
            }
          }),
      })
    })
  },
})
const host = await PromiseSdk.create(
  {
    app: { name: "essential-procontract" },
    database: { path: "/state/session.sqlite" },
    events: { persist: true },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
    config: {
      directory: "/state/config",
      project: false,
      content: JSON.stringify({
        model: `openai/${input.model}`,
        permissions: [
          { action: "*", resource: "*", effect: "allow" },
          { action: "execute", resource: "*", effect: "deny" },
        ],
        providers: {
          openai: {
            package: "@opencode/ai/providers/openai",
            canonical: "openai",
            env: [],
            settings: {
              baseURL: "http://programbench-provider.invalid/v1",
              apiKey: "no-credential",
              transport: "http",
              timeout: 900000,
              chunkTimeout: 900000,
            },
            models: {
              [input.model]: {
                limit: { context: 272000, output: 128000 },
                capabilities: { tools: true, reasoning: true, input: ["text"], output: ["text"] },
                body: { reasoning: { effort: input.effort }, max_output_tokens: 128000, store: false },
              },
            },
          },
        },
      }),
    },
    plugins: [plugin],
  },
  {
    overrides: [
      requestExecutor.replace(
        ProviderTransport.layerWith("/channel/provider.sock").pipe(Layer.provide(FetchHttpClient.layer)),
      ),
    ],
  },
)

try {
  const session = await host.sessions.create({
    title: "Contract execution",
    location: { directory: "/workspace" },
    model: { providerID: "openai", id: input.model },
  })
  await Bun.write("/state/identity.json", JSON.stringify({ sessionID: session.id }))
  const stop = () => {
    void host.sessions.interrupt({ sessionID: session.id }).catch(() => undefined)
  }
  process.on("SIGTERM", stop)
  const timer = setTimeout(stop, Math.max(1, input.deadline - Date.now()))
  try {
    await host.sessions.instructions.entry.put({
      sessionID: session.id,
      key: "procontract.method",
      value: input.instructions,
    })
    await host.sessions.prompt({
      sessionID: session.id,
      text: [
        input.goal,
        "Your workspace and retained public observations are the task's continuing work. Use contract_handoff explicitly. A final answer is not task acceptance. Do not modify the goal, verifier or original deadline. Public self-checks are observations, not independent acceptance. A new method may change how you investigate, test, checkpoint and learn; it will apply to successors, including their future proposals.",
        input.evaluation
          ? "This is a fixed-method evaluation; do not propose another method."
          : "You may propose a reusable improvement grounded in public experience, or checkpoint to refresh context without changing methods.",
        "The most recent public observations follow. The complete, unmodified observation list remains readable in /admission/input.json; excerpts do not resolve older obligations.",
        ...input.feedback
          .slice(-16)
          .map(
            (text) =>
              `Retained public observation (not authority):\n${
                text.length <= 4096
                  ? text
                  : text.slice(0, 4096) + "\n[Excerpt; read /admission/input.json for the complete observation.]"
              }`,
          ),
      ].join("\n\n"),
    })
    while (!result.value) {
      await host.sessions.wait({ sessionID: session.id })
      active()
      if (result.value) break
      const events = await Array.fromAsync(host.sessions.log({ sessionID: session.id }))
      if (events.some((event) => event.type === "session.execution.failed")) throw new Error("Native execution failed")
      await host.sessions.prompt({
        sessionID: session.id,
        text: "Responsibility remains open. Continue the task or call contract_handoff with an honest disposition. The original deadline is unchanged.",
      })
    }
    await host.sessions.wait({ sessionID: session.id })
    await Bun.write("/state/result.json", JSON.stringify(result.value))
  } finally {
    clearTimeout(timer)
  }
} finally {
  await host.close()
}
