// Runs inside the sandbox. This process has no issuer ledger or provider credential.
import { Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Plugin } from "@opencode/plugin"
import { requestExecutor } from "@opencode/core/effect/app-node-platform"
import { RSI } from "@opencode/core/pro-contract/rsi"
import { Shell } from "@opencode/schema/shell"
import { ProviderTransport } from "./transport"
import { ContractObservations } from "./observations"
import { PromiseSdk } from "../promise"

const Input = Schema.Struct({
  goal: Schema.String,
  deadline: Schema.Number,
  model: Schema.String,
  effort: Schema.String,
  instructions: Schema.String,
  feedback: Schema.Array(Schema.String),
  evaluation: Schema.Boolean,
  allowPropose: Schema.Boolean,
  toolCgroup: Schema.optional(Schema.Boolean),
})
const input = Schema.decodeUnknownSync(Schema.fromJsonString(Input))(await Bun.file("/admission/input.json").text())
const retention: { failure?: Error } = {}
const active = () => {
  if (retention.failure) throw retention.failure
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
              const forwarded =
                tool.name === "shell"
                  ? {
                      ...value,
                      command: input.toolCgroup
                        ? "/usr/bin/python3 -I -S /runtime/packages/sdk/src/pro-contract/tool-admission.py || exit 125\n" +
                          value.command
                        : value.command,
                      background: false,
                      timeout: Math.max(1, Math.min(value.timeout || 600000, 600000, input.deadline - Date.now())),
                    }
                  : value
              const identity = {
                sessionID: call.sessionID,
                messageID: call.messageID,
                callID: call.id,
                tool: tool.name,
              }
              const capture: { id?: Shell.ID } = {}
              const retainCapture = async () => {
                if (!capture.id) return
                // Cancellation can remove an upstream shell before its rejected
                // tool returns. Preserve available partial bytes, otherwise say
                // unavailable; never manufacture a successful capture receipt.
                return host.shell
                  .get({ id: capture.id, location: { directory: "/workspace" } })
                  .then((shell) => ContractObservations.shell(identity, shell.data, input.deadline))
                  .then(
                    () => ({ status: "retained", shellID: capture.id }),
                    (error: unknown) => ({ status: "unavailable", shellID: capture.id, reason: String(error) }),
                  )
              }
              const retain = (run: () => Promise<void>) =>
                run().catch(async (error: unknown) => {
                  retention.failure = new Error(`Public observation retention failed: ${String(error)}`)
                  await context.session.interrupt({ sessionID: call.sessionID })
                  throw retention.failure
                })
              return execute(forwarded, {
                ...call,
                progress: async (update) => {
                  if (tool.name === "shell" && typeof update.shellID === "string")
                    capture.id = Shell.ID.make(update.shellID)
                  await call.progress(update)
                },
              }).then(
                async (output) => {
                  await retain(async () => {
                    const shellCapture = await retainCapture()
                    await ContractObservations.json(
                      identity,
                      "native-result",
                      { input: value, executedInput: forwarded, status: "completed", result: output, shellCapture },
                      input.deadline,
                    )
                  })
                  return output
                },
                async (error: unknown) => {
                  await retain(async () => {
                    const shellCapture = await retainCapture()
                    await ContractObservations.json(
                      identity,
                      "native-result",
                      { input: value, executedInput: forwarded, status: "error", error: String(error), shellCapture },
                      input.deadline,
                    )
                  })
                  throw error
                },
              )
            })
        })
      }
      editor.add({
        name: "contract_handoff",
        description:
          "Hand off this execution. submit requests independent acceptance; checkpoint retains work and refreshes context; propose requests independent evaluation of a new method; blocked retains unresolved responsibility. Put continuation notes in summary. Only propose accepts instructions, which must be a complete replacement method, not a message to the next worker or grader. None grants acceptance or deployment. The original deadline does not change.",
        input: Schema.Struct({
          action: input.allowPropose
            ? Schema.Literals(["submit", "checkpoint", "propose", "blocked"])
            : Schema.Literals(["submit", "checkpoint", "blocked"]),
          summary: Schema.NonEmptyString.annotate({
            description: "Honest disposition and continuation notes for every action.",
          }),
          instructions: Schema.optional(Schema.NonEmptyString).annotate({
            description:
              "Only for action=propose: the full replacement method. Omit for submit, checkpoint and blocked; put their continuation notes in summary.",
          }),
        }),
        options: { codemode: false },
        execute: (value, call) =>
          exclusive(async () => {
            active()
            call.signal.throwIfAborted()
            if (result.value) throw new Error("Execution was already handed off")
            if (!input.allowPropose && value.action === "propose")
              throw new Error("Method proposals are not admitted in this allocation")
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
        `Original absolute deadline: ${new Date(input.deadline).toISOString()}. Task execution, adaptation and final verification share this allowance; leave time for verification.`,
        "Your workspace and retained public observations are the task's continuing work. Use contract_handoff explicitly. A final answer is not task acceptance. Do not modify the goal, verifier or original deadline. Public self-checks are observations, not independent acceptance. A new method may change how you investigate, test, checkpoint and learn; it will apply to successors, including their future proposals.",
        !input.allowPropose
          ? "This is a fixed-method allocation; do not propose another method. You may retain public observations, checkpoint, submit, or report blocked."
          : "You may propose a reusable improvement grounded in public experience, or checkpoint to refresh context without changing methods.",
        "The most recent public handoff summaries and feedback follow. Their complete, unmodified list remains readable in /admission/input.json; summaries are not the full tool observations and excerpts do not resolve older obligations.",
        "Native tool observations from this allocation are automatically retained outside your deliverables: /admission/observations/index.jsonl indexes immutable blobs at /admission/observations/blobs/<hash>. Look up earlier commands by native-result input, then match sessionID, messageID and callID for shell-capture bytes. model-visible records preserve the native Session's canonical tool representation; native-result records are pre-display values. Shell captures combine stdout/stderr and may be incomplete after timeout, a signal, unknown exit or the individual capture bound; check capture status, totalBytes, complete and exit rather than treating a preview as complete evidence. This archive continues across checkpoints, but does not retain arbitrary /tmp files or grant acceptance. Save runnable regressions and necessary deliverables in /workspace.",
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
    active()
    // Tool wrappers see pre-normalization results. Replay the native durable
    // terminal events separately so display truncation and errors are not invented.
    const names = new Map<string, string>()
    for await (const event of host.sessions.log({ sessionID: session.id })) {
      if (event.type === "session.tool.input.started") names.set(event.data.id, event.data.name)
      if (event.type !== "session.tool.success" && event.type !== "session.tool.failed") continue
      await ContractObservations.json(
        {
          sessionID: session.id,
          messageID: event.data.assistantMessageID,
          callID: event.data.id,
          tool: names.get(event.data.id) ?? "unknown",
        },
        "model-visible",
        { id: event.id, type: event.type, created: event.created, data: event.data },
        input.deadline,
      )
    }
    await Bun.write("/state/result.json", JSON.stringify(result.value))
  } finally {
    clearTimeout(timer)
  }
} finally {
  await host.close()
}
