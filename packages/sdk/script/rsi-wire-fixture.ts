// Deterministic Responses wire oracle for mechanism qualification, NOT a real model.
import { Schema } from "effect"
const Request = Schema.Struct({
  model: Schema.String,
  input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
})
export function wireFixture(root: string, warmupSteps = 0, production = false) {
  const first = { user: undefined as string | undefined }
  const records: { revision: number; mode: string; step: number; successorStrategy: boolean }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses")
        return new Response("Not found", { status: 404 })
      const body = Schema.decodeUnknownSync(Request)(await request.json())
      const text = JSON.stringify(body.input)
      const revision = Number(text.match(/RSI_FIXTURE_REVISION=(\d+)/)?.[1] ?? (production ? 0 : -1))
      const count = body.input.filter((item) => item.type === "function_call_output").length
      const mode = text.includes("Improve the inactive complete")
        ? "h"
        : text.includes("Improve the inactive strategy")
          ? "s"
          : "evaluate"
      const user = JSON.stringify(body.input.find((item) => item.role === "user"))
      records.push({
        revision,
        mode,
        step: count,
        successorStrategy: user?.includes("Next generation policy.") ?? false,
      })
      first.user ??= user
      const stage = count - (user === first.user ? warmupSteps : 0)
      const key = text.match(/Allocation: (job-[0-9]+-[0-9]+)/)?.[1] ?? "evaluation"
      const command =
        mode === "h" && production
          ? `python3 - <<'PY'
from pathlib import Path
p=Path('/candidate/source/packages/sdk/script/rsi-worker.ts')
s=p.read_text(); old=next(line for line in s.splitlines() if line.startswith('const input = Schema.decodeUnknownSync'))
new=old.replace('const input =', 'const admitted =')+'\\nconst input = { ...admitted, goal: admitted.goal + "\\\\nRSI_FIXTURE_REVISION=1" }'
p.write_text(s.replace(old,new))
PY
git -C /candidate/source diff --binary > /candidate/h`
          : mode === "h"
            ? `python3 - <<'PY'\nfrom pathlib import Path\nimport re\np=Path('/candidate/source/packages/sdk/script/rsi-fixture-logic.ts')\ns=p.read_text();v=int(re.search(r'revision = (\\d+)',s)[1]);p.write_text('export const revision = '+str(v+1)+'\\n// '+${JSON.stringify(key)}+'\\n')\nPY\ngit -C /candidate/source diff --binary > /candidate/h`
            : mode === "s"
              ? `cat /task/parent-strategy > /candidate/s; printf '\\nNext generation policy.\\n' >> /candidate/s`
              : `printf 'revision:${revision}' > /candidate/answer`
      const isolation = `set -e\npython3 - <<'PY'\nimport os,socket\nassert os.listdir('/sys/class/net') == ['lo']\nassert not os.path.exists('/var/run/docker.sock')\nassert not os.path.exists(${JSON.stringify(root + "/ota.sqlite")})\nassert not os.environ.get('OPENAI_API_KEY')\ns=socket.socket(socket.AF_UNIX);s.connect('/channel/provider.sock');s.sendall(b'POST /v1/responses HTTP/1.1\\r\\nHost: programbench-provider.invalid\\r\\nContent-Length: 2\\r\\n\\r\\n{}');assert b'403' in s.recv(4096)\nprint('RSI_CONTAINMENT_OK')\nPY\n`
      const outputs = body.input.filter((item) => item.type === "function_call_output")
      if (stage === 1 && !JSON.stringify(outputs.at(-1)).includes("RSI_CONTAINMENT_OK"))
        return new Response("Containment probe failed", { status: 400 })
      const name = stage < 0 ? "read" : stage === 0 ? "shell" : "rsi_handoff"
      const tool = body.tools.find((tool) => tool.name.endsWith(name))
      if (!tool) return new Response("qualified tool missing", { status: 400 })
      const item =
        stage < 2
          ? {
              type: "function_call",
              id: `fc_${count}`,
              call_id: `call_${count}`,
              name: tool.name,
              arguments: JSON.stringify(
                stage < 0
                  ? { path: "/strategy" }
                  : stage === 0
                    ? { command: isolation + command, workdir: "/candidate", timeout: 120000 }
                    : { summary: "Scripted artifact submitted; no model performance claim" },
              ),
              status: "completed",
            }
          : {
              type: "message",
              id: "answer",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Submitted.", annotations: [] }],
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
                delta: "Submitted.",
              },
            ]),
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
      ]
      return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), {
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })
  return { server, records, url: `http://127.0.0.1:${server.port}/v1` }
}
