import { Schema } from "effect"

const Request = Schema.Struct({
  model: Schema.String,
  instructions: Schema.optional(Schema.String),
  input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
})

/** Scripted Responses provider, not a learned policy or performance claim. */
export function fixture(options: { regression?: boolean; warmup?: number; block?: boolean } = {}) {
  const records: { stage: number; original: boolean; safety: boolean; request: unknown }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = Schema.decodeUnknownSync(Request)(await request.json())
      const text = JSON.stringify(body)
      const stage = Number(text.match(/METHOD_STAGE=(\d+)/)?.[1] ?? -1)
      const original = text.includes("MECHANICS_ORIGINAL")
      const safety = text.includes("MECHANICS_SAFETY")
      const confirmation = text.includes("MECHANICS_CONFIRMATION")
      const outputs = body.input.filter((item) => item.type === "function_call_output")
      records.push({ stage, original, safety, request: body })
      if (stage < 0) return new Response("Selected policy is absent from actual native request", { status: 400 })
      const warmup = original && stage === 0 ? (options.warmup ?? 0) : 0
      const step = outputs.length - warmup
      const name = step <= 0 ? "shell" : "contract_handoff"
      const tool = body.tools.find((tool) => tool.name.endsWith(name))
      if (!tool) return new Response("Native tool missing", { status: 400 })
      const containment = `python3 - <<'PY'
import os, socket
assert os.listdir('/sys/class/net') == ['lo'] if os.path.exists('/sys/class/net') else True
assert not os.environ.get('OPENAI_API_KEY')
assert not os.path.exists('/verifier')
assert not os.path.exists('/var/run/docker.sock')
s=socket.socket(socket.AF_UNIX);s.connect('/channel/provider.sock')
s.sendall(b'POST /v1/responses HTTP/1.0\\r\\nContent-Length: 2\\r\\n\\r\\n{}')
assert b'403' in s.recv(4096)
print('CONTAINMENT_OK')
PY
`
      const resumed = options.regression && original && text.includes("No successor was selected")
      const score = safety ? "safe" : options.regression && confirmation ? String(1 - stage) : String(stage)
      const command = options.block
        ? "printf 'WAITING\\n'; sleep 60"
        : step < 0
          ? "printf warmup"
          : containment +
            (original
              ? `${stage > 0 || resumed ? "test -f public-observation.txt && cat public-observation.txt\n" : ""}printf 'Public counterexample retained across sessions\\n' > public-observation.txt\nprintf '${stage}\\n' >> successors.txt\nprintf '${resumed ? 2 : stage}' > answer.txt`
              : `printf '${score}' > answer.txt`)
      if (step > 0 && !JSON.stringify(outputs.at(-1)).includes("CONTAINMENT_OK"))
        return new Response("Real containment probe failed", { status: 400 })
      const propose = original && stage < 2 && !resumed
      const arguments_ =
        step <= 0
          ? { command, workdir: "/workspace", timeout: 30000 }
          : propose
            ? {
                action: "propose",
                summary: "Retained public experience suggests a different investigation and checkpoint policy.",
                instructions: `METHOD_STAGE=${stage + 1}\nRetain public counterexamples, probe their causes, and carry useful observations through a fresh context. Apply this method to tasks and future method proposals.`,
              }
            : { action: "submit", summary: "Artifact submitted for independent host verification, not self-certified." }
      const item = {
        type: "function_call",
        id: `fc_${records.length}`,
        call_id: `call_${records.length}`,
        name: tool.name,
        arguments: JSON.stringify(arguments_),
        status: "completed",
      }
      const response = {
        id: `resp_${records.length}`,
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
  return { server, records, url: `http://127.0.0.1:${server.port}/v1` }
}
