import { Plugin } from "@opencode/plugin"
import { ContractDelivery } from "./contract-delivery"
import type { ContractAdvisory } from "./contract-advisory"

export function contractProfile(
  delivery: Awaited<ReturnType<typeof ContractDelivery.create>>,
  deadline: number,
  advisory?: ContractAdvisory.Service,
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
            current.execute = (value, call) => {
              const reviewer = advisory?.reviewer(call.sessionID)
              if (reviewer === "closed") return Promise.reject(new Error("Advisory reviewer is closed"))
              if (reviewer === "running")
                return advisory!.assertReviewer(call.sessionID, call.signal).then(() => execute(value, call))
              return delivery.exclusive(async () => {
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
            }
          })
        }
        editor.add({
          name: "contract_delivery",
          description:
            "Retain public reference probes and close delivery obligations. Probe stdout/stderr/file bytes are base64. Handoff rebuilds and replays all evidence; it does not attest correctness. Block explicitly if unable to continue.",
          input: ContractDelivery.Input,
          options: { codemode: false },
          execute: (input, call) => {
            if (advisory?.reviewer(call.sessionID))
              return Promise.reject(new Error("Advisory reviewers cannot call contract_delivery"))
            return delivery.exclusive(async () => {
              call.signal.throwIfAborted()
              if (
                input.action === "blocked" &&
                input.reason.trim() &&
                advisory?.eligible("blocked") &&
                (await delivery.status()).state !== "blocked"
              ) {
                const review = await advisory.review({ node: "blocked", statement: input.reason }, call.signal)
                await advisory.assertActive(call.signal)
                const result =
                  review?.outcome === "completed" ? await delivery.status() : await delivery.act(input, call.signal)
                await advisory.assertActive(call.signal)
                return { content: review ? advisory.render("blocked", result, review) : JSON.stringify(result) }
              }
              const result = await delivery.act(input, call.signal)
              if (
                input.action === "handoff" &&
                "snapshot" in result &&
                result.state === "ready" &&
                advisory?.eligible("submission")
              ) {
                const review = await advisory.review(
                  {
                    node: "submission",
                    statement: input.summary,
                    snapshot: result.snapshot,
                  },
                  call.signal,
                )
                await advisory.assertActive(call.signal)
                if (review) return { content: advisory.render("submission", result, review) }
              }
              return { content: JSON.stringify(result) }
            })
          },
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
  beforePrompt?: (text: string) => Promise<string | undefined>
}) {
  while (true) {
    await input.wait()
    await input.assertActive()
    const disposition = await input.status()
    if (disposition.state !== "open") return disposition
    // A new durable inbox item, not a legacy or in-memory model/tool loop.
    const text =
      "The Session stopped, but Contract delivery is still open. No completion was accepted. Inspect contract_delivery status, retain and resolve public behavioral counterexamples, then request handoff. If you cannot resolve an obligation, report blocked with the concrete reason. The original deadline is unchanged. Hidden grading results are unavailable."
    const extra = await input.beforePrompt?.(text)
    if (input.beforePrompt) await input.assertActive()
    await input.prompt(text + (extra ? "\n\n" + extra : ""))
  }
}
