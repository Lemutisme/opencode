// Scripted model responses + real native V2 + official Harbor containers/verifier.
// This checks transport and isolation, not solver intelligence or RSI gains.
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { OTA, hash } from "../../core/script/ota-rsi"
import type { Protocol } from "../../core/script/ota-rsi"
import { Artifacts } from "../../core/script/ota-supervisor"
import { evaluateNative } from "./rsi-driver"
import { RSIRuntime } from "./rsi-runtime"
import { terminalBench } from "./rsi-terminal"

const [directory, releaseFile, gatewayFile, manifestFile, testID = "audit-r1"] = process.argv.slice(2)
if (!directory || !releaseFile || !gatewayFile || !manifestFile)
  throw new Error("usage: bun script/rsi-terminal-qualify.ts NEW_ROOT RELEASE GATEWAY MANIFEST [TEST_ID]")
const root = path.resolve(directory)
await fs.mkdir(root, { mode: 0o700 })
const release = await RSIRuntime.release(path.resolve(releaseFile))
const benchmark = await terminalBench(root, await RSIRuntime.ref(path.resolve(manifestFile)))
const Request = Schema.Struct({
  model: Schema.String,
  input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
})
const requests: unknown[] = []
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses")
      return new Response("not found", { status: 404 })
    const body = Schema.decodeUnknownSync(Request)(await request.json())
    requests.push(body)
    await Bun.write(path.join(root, "REQUESTS.json"), JSON.stringify(requests, null, 2))
    const outputs = body.input.filter((item) => item.type === "function_call_output")
    const count = outputs.length
    if (count === 1 && !JSON.stringify(outputs.at(-1)).includes("native-rsi-terminal-qualified"))
      return new Response("actual original-environment terminal action did not succeed", { status: 400 })
    const name = count === 0 ? "terminal" : "task_handoff"
    const tool = body.tools.find((tool) => tool.name === name)
    if (!tool) return new Response("frozen benchmark tool missing", { status: 400 })
    const item =
      count < 2
        ? {
            type: "function_call",
            id: `fc_${count}`,
            call_id: `call_${count}`,
            name: tool.name,
            arguments: JSON.stringify(
              count === 0
                ? {
                    command:
                      "set -eu; test ! -e /var/run/docker.sock; test -z \"${OPENAI_API_KEY:-}\"; printf '%s\\n' native-rsi-terminal-qualified > /tmp/rsi-public-marker; printf '%s\\n' qualification-only-invalid-answer > /app/results.txt; cat /tmp/rsi-public-marker; id -u; id -g",
                  }
                : { summary: "Scripted qualification artifact only; no performance claim" },
            ),
            status: "completed",
          }
        : {
            type: "message",
            id: "answer",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Submitted scripted qualification.", annotations: [] }],
          }
    const response = {
      id: `resp_${requests.length}`,
      object: "response",
      model: body.model,
      status: "completed",
      output: [item],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    }
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: item.type === "function_call" ? { ...item, arguments: "" } : item,
      },
      ...(item.type === "function_call"
        ? [
            {
              type: "response.function_call_arguments.delta",
              item_id: item.id,
              output_index: 0,
              delta: item.arguments,
            },
            {
              type: "response.function_call_arguments.done",
              item_id: item.id,
              output_index: 0,
              arguments: item.arguments,
            },
          ]
        : [
            {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: "Submitted scripted qualification.",
            },
          ]),
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ]
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "Content-Type": "text/event-stream" },
    })
  },
})
const artifacts = new Artifacts(path.join(root, "objects"))
const seed = {
  s: await artifacts.put(new TextEncoder().encode("Use official benchmark tools; hand off honestly.")),
  h: await artifacts.put(new TextEncoder().encode(JSON.stringify(release))),
}
const test = { id: testID, total: 1 }
const protocol: Protocol = {
  trusted: hash("native-terminal-scripted-qualification-not-performance"),
  scope: "mechanics",
  performanceRule: "task-pareto",
  tests: [test],
  startupMs: 120000,
  heartbeatMs: 120000,
  probationMs: 60000,
}
const ota = new OTA(path.join(root, "ota.sqlite"), protocol, seed)
ota.begin(0, Date.now())
const admission = ota.read()
if (!admission.job) throw new Error("missing fixture admission")
try {
  const score = await evaluateNative(
    {
      root,
      ...benchmark,
      provider: {
        gateway: await RSIRuntime.ref(path.resolve(gatewayFile)),
        model: "gpt-5.6-luna",
        effort: "max",
        upstream: `http://127.0.0.1:${fixture.port}/v1`,
        key: "scripted-no-credential",
        fixture: true,
      },
    },
    {
      pair: { s: await artifacts.get(seed.s), h: await artifacts.get(seed.h) },
      test,
      deadline: admission.job.deadline,
      signal: AbortSignal.timeout(900000),
    },
    {
      database: path.join(root, "ota.sqlite"),
      protocol: admission.protocol,
      epoch: admission.epoch,
      job: admission.job.id,
      phase: "running",
      incumbent: admission.active.pair,
    },
  )
  const runs = await fs.readdir(path.join(root, "native"))
  if (runs.length !== 1 || !score.valid || score.total !== 1 || requests.length < 2)
    throw new Error("scripted native benchmark allocation did not complete")
  const execution = await Bun.file(path.join(root, "native", runs[0]!, "EXECUTION.json")).json()
  if (execution.release.source.sha256 !== release.source.sha256 || execution.mode !== "bridge")
    throw new Error("official task did not execute the supplied native H")
  await Bun.write(
    path.join(root, "RESULT.json"),
    JSON.stringify(
      { qualified: true, scope: "engineering-only", realModelCalls: 0, requests: requests.length, score, release },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ qualified: true, score, requests: requests.length, realModelCalls: 0 }))
} finally {
  await benchmark.dispose()
  fixture.stop(true)
  ota.db.close()
}
