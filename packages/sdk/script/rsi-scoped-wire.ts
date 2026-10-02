// Scripted Responses oracle for real native containment/Session qualification.
// The reference wrapper and revision counter are fixtures, never task-solving evidence.
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"

const Request = Schema.Struct({
  model: Schema.String,
  input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
})

export const scopedProbe = { title: "Scripted public reference help; not a benchmark solution", args: ["--help"] }
export const scopedStrategy = "Next generation policy."

export function scopedWire(root: string, ending: "closure" | "delivery" = "delivery") {
  const records: {
    request: number
    revision: number
    strategy: boolean
    mode: "h" | "s" | "continuation" | "evaluate"
    step: number
    tools: string[]
  }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses")
        return new Response("Not found", { status: 404 })
      const body = Schema.decodeUnknownSync(Request)(await request.json())
      const prompt = JSON.stringify(body.input.find((item) => item.role === "user"))
      const revision = Number(prompt.match(/RSI_FIXTURE_REVISION=(\d+)/)?.[1] ?? -1)
      const strategy = prompt.includes(scopedStrategy)
      const tools = body.tools.map((tool) => tool.name)
      const outputs = body.input.filter((item) => item.type === "function_call_output")
      const mode = prompt.includes("Improve the inactive complete")
        ? "h"
        : prompt.includes("Improve the inactive strategy")
          ? "s"
          : tools.some((name) => name.endsWith("rsi_revise"))
            ? "continuation"
            : "evaluate"
      const record = {
        request: records.length + 1,
        revision,
        strategy,
        mode,
        step: outputs.length,
        tools,
      } satisfies (typeof records)[number]
      records.push(record)
      await fs.appendFile(path.join(root, "WIRE.jsonl"), JSON.stringify({ record, body }) + "\n")
      if (!Number.isSafeInteger(revision) || revision < 0 || revision > 2)
        return new Response("fixture release revision missing or unexpected", { status: 400 })
      const task = mode === "continuation" || mode === "evaluate"
      const deliver = ending === "delivery" && mode === "continuation" && revision === 1 && strategy
      const last = JSON.stringify(outputs.at(-1) ?? {}).replaceAll("\\", "")
      if (outputs.length === 1 && !last.includes("RSI_SCOPED_CONTAINMENT_OK"))
        return new Response("real containment or workspace setup failed", { status: 400 })
      if (task && outputs.length === 2 && !/"matches"\s*:\s*true/.test(last))
        return new Response("actual public reference probe did not match", { status: 400 })
      if ((mode === "evaluate" || deliver) && outputs.length === 3 && !/"state"\s*:\s*"ready"/.test(last))
        return new Response("contract delivery was not closed", { status: 400 })
      if (!task && outputs.length === 2 && !/"submitted"\s*:/.test(last))
        return new Response("actual source proposal handoff failed", { status: 400 })
      if (mode === "continuation" && !deliver && outputs.length === 3 && !last.includes("Task revision requested"))
        return new Response("actual task revision handoff failed", { status: 400 })
      if (outputs.length > (task ? 3 : 2))
        return new Response("unexpected fixture continuation; do not retry to success", { status: 400 })
      const allocation = prompt.match(/Allocation: (job-[0-9]+-[0-9]+)/)?.[1] ?? "task"
      const containment = `set -e
python3 - <<'PY'
import os, socket
assert os.listdir('/sys/class/net') == ['lo']
assert not os.path.exists('/var/run/docker.sock')
assert not os.path.exists(${JSON.stringify(path.join(root, "ota.sqlite"))})
assert not os.environ.get('OPENAI_API_KEY')
s=socket.socket(socket.AF_UNIX); s.connect('/channel/provider.sock')
s.sendall(b'POST /v1/responses HTTP/1.1\\r\\nHost: programbench-provider.invalid\\r\\nContent-Length: 2\\r\\n\\r\\n{}')
assert b'403' in s.recv(4096)
print('RSI_SCOPED_CONTAINMENT_OK')
PY
`
      const command =
        mode === "h"
          ? `python3 - <<'PY'
from pathlib import Path
import re
p=Path('/candidate/source/packages/sdk/script/rsi-fixture-logic.ts')
v=int(re.search(r'revision = (\\d+)', p.read_text())[1])
assert v == ${revision}, 'source is not the active fixture root'
p.write_text('export const revision = '+str(v+1)+'\\n// '+${JSON.stringify(allocation)}+'\\n')
PY
git -C /candidate/source diff --binary > /candidate/h
test -s /candidate/h`
          : mode === "s"
            ? `cat /task/parent-strategy > /candidate/s; printf '\\n${scopedStrategy}\\n' >> /candidate/s`
            : `test -x /workspace/executable
cat > /candidate/workspace/compile.sh <<'SH'
#!/bin/sh
set -eu
printf '#!/bin/sh\\nexec /workspace/executable "$@"\\n' > executable
chmod +x executable
SH
cat > /candidate/workspace/validate.sh <<'SH'
#!/bin/sh
set -eu
test -x ./executable
SH
chmod +x /candidate/workspace/compile.sh /candidate/workspace/validate.sh
cd /candidate/workspace
./compile.sh
printf '%s\\n' '${JSON.stringify({ kind: "scripted-mechanics-only", revision, strategy })}' > rsi-fixture-public.json`
      const step = outputs.length
      const name =
        step === 0
          ? "shell"
          : task
            ? step === 1 || mode === "evaluate" || deliver
              ? "contract_delivery"
              : "rsi_revise"
            : "rsi_handoff"
      const terminal = task ? step >= 3 : step >= 2
      const tool = body.tools.find((tool) => tool.name.endsWith(name))
      if (!terminal && !tool) return new Response("qualified fixture tool missing", { status: 400 })
      const argumentsValue =
        step === 0
          ? { command: containment + command, workdir: "/candidate", timeout: 120000 }
          : task && step === 1
            ? { action: "probe", probe: scopedProbe }
            : mode === "continuation" && !deliver
              ? { reason: "Scripted mechanics: checkpoint this public task and test the next S/H generation." }
              : mode === "evaluate" || deliver
                ? {
                    action: "handoff",
                    summary: "Scripted reference wrapper; no benchmark-solving or model-improvement claim.",
                  }
                : { summary: "Scripted S/H proposal; only external mechanics qualification may select it." }
      const item = terminal
        ? {
            type: "message",
            id: `answer_${record.request}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Scripted operation submitted.", annotations: [] }],
          }
        : {
            type: "function_call",
            id: `fc_${record.request}`,
            call_id: `call_${record.request}`,
            name: tool!.name,
            arguments: JSON.stringify(argumentsValue),
            status: "completed",
          }
      const response = {
        id: `resp_${record.request}`,
        object: "response",
        model: body.model,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      }
      const events = [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: terminal ? item : { ...item, arguments: "" } },
        ...(!terminal
          ? [
              {
                type: "response.function_call_arguments.delta",
                item_id: item.id,
                output_index: 0,
                delta: JSON.stringify(argumentsValue),
              },
              {
                type: "response.function_call_arguments.done",
                item_id: item.id,
                output_index: 0,
                arguments: JSON.stringify(argumentsValue),
              },
            ]
          : [
              {
                type: "response.output_text.delta",
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                delta: "Scripted operation submitted.",
              },
            ]),
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
      ]
      await fs.appendFile(path.join(root, "WIRE.jsonl"), JSON.stringify({ request: record.request, response }) + "\n")
      return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), {
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })
  return { server, records, url: `http://127.0.0.1:${server.port}/v1` }
}
