import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { ContractDelivery } from "./contract-delivery"

export function contractProfile(
  delivery: Awaited<ReturnType<typeof ContractDelivery.create>>,
  deadline: number,
  revise?: (reason: string) => void,
) {
  return Plugin.define({
    id: "procontract.native-worker",
    async setup(context) {
      await context.tool.transform((editor) => {
        for (const tool of editor.list()) {
          if (!["glob", "grep", "patch", "read", "shell"].includes(tool.name)) {
            editor.remove(tool.id)
            continue
          }
          editor.update(tool.id, (current) => {
            current.options = { ...current.options, codemode: false, pinned: undefined }
            const execute = current.execute
            current.execute = (value, call) =>
              delivery.exclusive(async () => {
                call.signal.throwIfAborted()
                return execute(
                  tool.name === "shell"
                    ? {
                        ...value,
                        background: false,
                        timeout: Math.min(value.timeout || 600000, 600000, deadline - Date.now()),
                      }
                    : value,
                  call,
                )
              })
          })
        }
        editor.add({
          name: "contract_delivery",
          description:
            "Retain public reference probes and close delivery obligations. Probe stdout/stderr/file bytes are base64. Handoff rebuilds and replays all evidence; it does not attest correctness. Block explicitly if unable to continue.",
          input: ContractDelivery.Input,
          options: { codemode: false },
          execute: (input, call) =>
            delivery.exclusive(async () => {
              call.signal.throwIfAborted()
              return { content: JSON.stringify(await delivery.act(input, call.signal)) }
            }),
        })
        if (revise)
          editor.add({
            name: "rsi_revise",
            description:
              "Checkpoint this task and request a separately evaluated S/H improvement. This does not authorize replacement or complete the task.",
            input: Schema.Struct({ reason: Schema.String }),
            options: { codemode: false },
            execute: (input, call) =>
              delivery.exclusive(async () => {
                call.signal.throwIfAborted()
                if (!input.reason.trim()) throw new Error("A concrete revision reason is required")
                revise(input.reason)
                // A revision request is a handoff barrier, not advice to the
                // model. Interrupt only this Session; the worker drains it and
                // the host fences the allocation before sealing its checkpoint.
                await context.session.interrupt({ sessionID: call.sessionID })
                return {
                  content: "Task revision requested; host qualification and original deadline remain authoritative.",
                }
              }),
          })
      })
    },
  })
}

export async function drainDelivery(input: {
  wait: () => Promise<unknown>
  prompt: (text: string) => Promise<unknown>
  status: () => ReturnType<Awaited<ReturnType<typeof ContractDelivery.create>>["status"]>
  assertActive: () => Promise<void>
  revision?: () => string | undefined
}) {
  while (true) {
    await input.wait()
    await input.assertActive()
    const revision = input.revision?.()
    if (revision) return { state: "revise" as const, reason: revision }
    const disposition = await input.status()
    if (disposition.state !== "open") return disposition
    // A new durable inbox item, not a legacy or in-memory model/tool loop.
    await input.prompt(
      "The Session stopped, but Contract delivery is still open. No completion was accepted. Inspect contract_delivery status, retain and resolve public behavioral counterexamples, then request handoff. If you cannot resolve an obligation, report blocked with the concrete reason. The original deadline is unchanged. Hidden grading results are unavailable.",
    )
  }
}
