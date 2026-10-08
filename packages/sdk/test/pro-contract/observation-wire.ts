import { Schema } from "effect"

const Request = Schema.Struct({
  model: Schema.String,
  input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
})

export const continuation = "OBS_CONTINUITY_CHECKPOINT: continue from the public observation archive."
export const recovered = "OBS_CONTINUITY_RETRIEVED"

/** Real native tool calls driven by a scripted provider, never model-performance evidence. */
export function observationFixture(recover: string) {
  const marker = `OBS_COUNTEREXAMPLE_${crypto.randomUUID()}`
  const prefix = Buffer.concat([Buffer.from(`${marker}\n公共观测🧪\n`), Buffer.from([0, 255, 254, 10])])
  const bytes = Buffer.concat([prefix, Buffer.from("unrelated filler without counterexample\n".repeat(3000))])
  const command = `python3 - <<'PY'\nimport base64, os\nos.write(1, base64.b64decode('${prefix.toString("base64")}') + b'unrelated filler without counterexample\\n' * 3000)\nPY`
  const records: { continued: boolean; step: number; request: typeof Request.Type }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = Schema.decodeUnknownSync(Request)(await request.json())
      const continued = JSON.stringify(body.input).includes(continuation)
      const outputs = body.input.filter((item) => item.type === "function_call_output")
      const step = outputs.length
      records.push({ continued, step, request: body })
      if (!continued && outputs.length && JSON.stringify(outputs[0]).includes(marker))
        return new Response("Counterexample was not outside the native display tail", { status: 400 })
      if (continued && step > 0 && !JSON.stringify(outputs.at(-1)).includes(recovered))
        return new Response("Fresh native Session failed the observation recovery probe", { status: 400 })
      const name = continued
        ? step === 0
          ? "shell"
          : "contract_handoff"
        : step === 30
          ? "read"
          : step === 31
            ? "contract_handoff"
            : "shell"
      const tool = body.tools.find((tool) => tool.name.endsWith(name))
      if (!tool) return new Response(`Native tool missing: ${name}`, { status: 400 })
      const arguments_ = continued
        ? step === 0
          ? { command: recover, workdir: "/workspace", timeout: 30000 }
          : { action: "submit", summary: "Recovered the public bytes; request independent artifact verification." }
        : step === 31
          ? { action: "checkpoint", summary: continuation }
          : step === 30
            ? { path: "/workspace/intentionally-missing-observation-test.txt" }
            : {
                command:
                  step === 0
                    ? command
                    : step === 27
                      ? "printf 'OBS_EXPECTED_NONZERO\\n'; exit 7"
                      : step === 28
                        ? "python3 -u -c 'import time; print(\"OBS_EXPECTED_TIMEOUT\", flush=True); time.sleep(30)'"
                        : step === 29
                          ? "printf 'OBS_EXPECTED_SIGNAL\\n'; kill -KILL $$"
                          : `printf 'unrelated-shell-${step}\\n'`,
                workdir: "/workspace",
                timeout: step === 28 ? 200 : 30000,
              }
      const item = {
        type: "function_call",
        id: `fc_observation_${records.length}`,
        call_id: `call_observation_${records.length}`,
        name: tool.name,
        arguments: JSON.stringify(arguments_),
        status: "completed",
      }
      const response = {
        id: `resp_observation_${records.length}`,
        object: "response",
        model: body.model,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      }
      const events = [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
        { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
      ]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })
  return { server, records, marker, bytes, command, url: `http://127.0.0.1:${server.port}/v1` }
}
