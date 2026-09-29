// Native V2 worker. This process cannot attest, issue, or change the host ledger.
import { Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Plugin } from "@opencode/plugin"
import { ProviderTransport } from "@opencode/core/effect/provider-transport"
import { requestExecutor } from "@opencode/core/effect/app-node-platform"
import { PromiseSdk } from "../src/promise"

const Input = Schema.Struct({
  contractID: Schema.String,
  revision: Schema.Int,
  sessionID: Schema.String,
  promptID: Schema.String,
  deadline: Schema.Number,
  directory: Schema.String,
  state: Schema.String,
  standing: Schema.String,
  socket: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  prompt: Schema.String,
})
const Standing = Schema.Struct({
  contractID: Schema.String,
  revision: Schema.Int,
  deadline: Schema.Number,
  active: Schema.Boolean,
})
const input = Schema.decodeUnknownSync(Schema.fromJsonString(Input))(await Bun.file(process.argv[2]).text())
const startup = Date.now() + 30_000
while (!(await Bun.file(input.standing + ".ready").exists())) {
  if (Date.now() >= Math.min(startup, input.deadline)) throw new Error("Host did not admit this worker")
  await Bun.sleep(25)
}
const assertStanding = async () => {
  const standing = Schema.decodeUnknownSync(Schema.fromJsonString(Standing))(await Bun.file(input.standing).text())
  if (
    !standing.active ||
    standing.contractID !== input.contractID ||
    standing.revision !== input.revision ||
    standing.deadline !== input.deadline ||
    Date.now() >= input.deadline
  )
    throw new Error("Contract authority is absent, stale, or expired")
}
await assertStanding()
// A fresh worker does not silently adopt V2 startup claims from another allocation.
if (await Bun.file(`${input.state}/session.sqlite`).exists())
  throw new Error("Explicit recovery qualification is required")
const guard = Plugin.define({
  id: "procontract.native-worker",
  async setup(context) {
    await context.tool.transform((editor) => {
      for (const tool of editor.list()) {
        if (!["glob", "grep", "patch", "read", "shell"].includes(tool.name)) {
          editor.remove(tool.id)
          continue
        }
        editor.update(tool.id, (current) => {
          // This first native profile exposes the shipped leaf tools directly.
          // Code Mode and independent subagents need separate execution qualification.
          current.options = { ...current.options, codemode: false, pinned: undefined }
          const execute = current.execute
          current.execute = async (value, call) => {
            await assertStanding()
            return execute(
              tool.name === "shell"
                ? {
                    ...value,
                    background: false,
                    timeout: Math.min(value.timeout || 600000, 600000, input.deadline - Date.now()),
                  }
                : value,
              call,
            )
          }
        })
      }
    })
  },
})
const host = await PromiseSdk.create(
  {
    app: { name: "procontract-v2-worker" },
    database: { path: `${input.state}/session.sqlite` },
    events: { persist: true },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
    config: {
      directory: `${input.state}/config`,
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
              apiKey: "no-upstream-credential",
              transport: "http",
              timeout: 900000,
              chunkTimeout: 900000,
            },
            models: {
              [input.model]: {
                limit: { context: 272000, output: 128000 },
                capabilities: { tools: true, reasoning: true, input: ["text"], output: ["text"] },
                body: { reasoning: { effort: input.effort }, max_output_tokens: 128000, store: false },
                variants: [{ id: input.effort, body: { reasoning: { effort: input.effort } } }],
              },
            },
          },
        },
      }),
    },
    plugins: [guard],
  },
  {
    overrides: [
      requestExecutor.replace(ProviderTransport.layerWith(input.socket).pipe(Layer.provide(FetchHttpClient.layer))),
    ],
  },
)
const controller = new AbortController()
const stop = () => controller.abort()
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
const timer = setTimeout(stop, Math.max(0, input.deadline - Date.now()))
try {
  const session = await host.sessions.create({
    id: input.sessionID,
    title: `Contract ${input.contractID}`,
    location: { directory: input.directory },
    model: { providerID: "openai", id: input.model, variant: input.effort },
  })
  const interrupt = () => {
    void host.sessions.interrupt({ sessionID: session.id }).catch(() => undefined)
  }
  controller.signal.addEventListener("abort", interrupt, { once: true })
  await assertStanding()
  if (controller.signal.aborted) throw new Error("Contract was cancelled before execution")
  await host.sessions.prompt({ id: input.promptID, sessionID: session.id, text: input.prompt })
  await host.sessions.wait({ sessionID: session.id })
  const messages = await host.message.list({ sessionID: session.id })
  await Bun.write(`${input.state}/messages.json`, JSON.stringify(messages, null, 2))
  const log = await Array.fromAsync(host.sessions.log({ sessionID: session.id }))
  await Bun.write(`${input.state}/events.json`, JSON.stringify(log, null, 2))
  if (log.some((event) => event.type === "session.execution.failed")) throw new Error("Native V2 execution failed")
  if (controller.signal.aborted) throw new Error("Contract cancelled or original deadline reached")
  await assertStanding()
  await Bun.write(
    `${input.state}/worker-ended.json`,
    JSON.stringify({
      sessionID: session.id,
      contractID: input.contractID,
      revision: input.revision,
      deadline: input.deadline,
      ended: Date.now(),
      authoritativeCompletion: false,
    }),
  )
} finally {
  clearTimeout(timer)
  await host.close()
}
