import type { ResearchModel } from "../../../sdk-next/src/research/model"
import type { Packet } from "./corpus"
import { bindPlan } from "./driver"
import path from "node:path"
import { open } from "node:fs/promises"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import type { Admission } from "./provider"

export type Bootstrap = {
  version: number
  status: string
  origin: string
  identity: Admission["identity"]
  context: ResearchModel.Run["context"]
  protocol: string
  plan: ResearchModel.Plan
  planHash: string
  at: number
}

/** The durable attempt precedes the response. Reopening it can never reseed a worker. */
export function bootstrap(input: { packet: Packet; file: string; protocol: string }) {
  return async (run: ResearchModel.Run, admission: Admission) => {
    if (run.plan || admission.role !== "worker" || (await Bun.file(input.file).exists())) return undefined
    if (run.stage !== "exploration" || run.id !== admission.identity.contractID)
      throw new Error("Bootstrap does not bind the active exploration")
    const plan = bindPlan(input.packet, run)
    const record = {
      version: 1,
      status: "attempted",
      origin: "script:initial-plan-only",
      identity: admission.identity,
      context: run.context,
      protocol: input.protocol,
      plan,
      planHash: ProContractRecognition.fingerprint(plan),
      at: Date.now(),
    }
    const file = await open(input.file, "wx", 0o600)
    await file.writeFile(JSON.stringify(record, null, 2) + "\n")
    await file.sync()
    await file.close()
    const directory = await open(path.dirname(input.file), "r")
    await directory.sync()
    await directory.close()
    const id = crypto.randomUUID()
    const call = { name: "contract_request", arguments: JSON.stringify({ kind: "plan", payload: plan }) }
    const events =
      input.protocol === "/v1/responses"
        ? [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "function_call", id: "fc_" + id, call_id: "call_" + id, name: call.name, arguments: "" },
            },
            {
              type: "response.function_call_arguments.delta",
              output_index: 0,
              item_id: "fc_" + id,
              delta: call.arguments,
            },
            {
              type: "response.function_call_arguments.done",
              output_index: 0,
              item_id: "fc_" + id,
              arguments: call.arguments,
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: { type: "function_call", id: "fc_" + id, call_id: "call_" + id, ...call },
            },
            {
              type: "response.completed",
              response: { id: "resp_" + id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
            },
          ]
        : [
            {
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "scripted-initial-plan",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [{ index: 0, id: "call_" + id, type: "function", function: call }],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            },
          ]
    return new Response(
      events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") +
        (input.protocol === "/v1/responses" ? "" : "data: [DONE]\n\n"),
      { headers: { "content-type": "text/event-stream" } },
    )
  }
}

// Only probe workers use these scripted canonical tool calls. Reviewers and R workers never do.
export function probe(packet: Packet, entry: "plan" | "final") {
  const pending = Object.entries(packet.preparation)
  const state = { experiment: false }
  return (run: ResearchModel.Run) => {
    const next = !run.plan
      ? { name: "contract_request", arguments: { kind: "plan", payload: bindPlan(packet, run) } }
      : entry === "plan" || !run.plan.approved
        ? undefined
        : pending.length
          ? (() => {
              const item = pending.shift()!
              return { name: "write", arguments: { path: item[0], content: item[1] } }
            })()
          : !state.experiment
            ? { name: "contract_request", arguments: { kind: "experiment", payload: {} } }
            : run.experiment
              ? {
                  name: "contract_report_ready",
                  arguments: { summary: "Frozen probe candidate prepared", uncertainties: [] },
                }
              : undefined
    if (next?.name === "contract_request" && "kind" in next.arguments && next.arguments.kind === "experiment")
      state.experiment = true
    const id = crypto.randomUUID()
    const chunk = (delta: unknown, finish_reason: string | null) =>
      "data: " +
      JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "scripted-probe-worker",
        choices: [{ index: 0, delta, finish_reason }],
      }) +
      "\n\n"
    return new Response(
      chunk(
        next
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_" + id,
                  type: "function",
                  function: { name: next.name, arguments: JSON.stringify(next.arguments) },
                },
              ],
            }
          : { role: "assistant", content: "Probe worker complete." },
        null,
      ) +
        chunk({}, next ? "tool_calls" : "stop") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  }
}
