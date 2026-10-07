import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// The agent runs as the orchestrator runs it: a subprocess against a scripted OpenAI Responses endpoint and a
// Streamable-HTTP MCP server, so provider loading, MCP admission and the JSON-line contract are all exercised.
type Step = { text: string } | { tool: string; input: Record<string, unknown> } | { hang: true }
const script: Step[] = []
const bodies: Array<{ model?: string; reasoning?: { effort?: string }; tools?: Array<{ name: string }> }> = []
const calls: Array<{ name: string; arguments: unknown }> = []
const headers: string[] = []
let model: ReturnType<typeof Bun.serve>
let mcp: ReturnType<typeof Bun.serve>

beforeAll(() => {
  model = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      bodies.push(await request.json())
      headers.push(request.headers.get("authorization") ?? "")
      const step = script.shift() ?? { text: "Still working." }
      if ("hang" in step) return new Promise<Response>(() => undefined)
      if (new URL(request.url).pathname === "/anthropic/v1/messages") return messages("text" in step ? step.text : "")
      const index = bodies.length
      const events =
        "text" in step
          ? [
              {
                type: "response.output_item.added",
                item: { type: "message", id: `msg_${index}`, role: "assistant", status: "in_progress", content: [] },
              },
              {
                type: "response.output_text.delta",
                item_id: `msg_${index}`,
                output_index: 0,
                content_index: 0,
                delta: step.text,
              },
              {
                type: "response.output_text.done",
                item_id: `msg_${index}`,
                output_index: 0,
                content_index: 0,
                text: step.text,
              },
              {
                type: "response.output_item.done",
                item: {
                  type: "message",
                  id: `msg_${index}`,
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: step.text, annotations: [] }],
                },
              },
            ]
          : [
              {
                type: "response.output_item.added",
                item: {
                  type: "function_call",
                  id: `item_${index}`,
                  call_id: `call_${index}`,
                  name: step.tool,
                  arguments: "",
                },
              },
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  id: `item_${index}`,
                  call_id: `call_${index}`,
                  name: step.tool,
                  arguments: JSON.stringify(step.input),
                },
              },
            ]
      const completed = { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } }
      return new Response([...events, completed].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  mcp = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      if (request.headers.get("authorization") !== "Bearer mcp-secret") return new Response(null, { status: 401 })
      const message = await request.json()
      if (message.id === undefined) return new Response(null, { status: 202 })
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result })
      if (message.method === "initialize")
        return reply({
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "orchestrator", version: "1" },
        })
      if (message.method === "tools/list")
        return reply({
          tools: ["submit_candidate", "finish", "run_train"].map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object", properties: { candidate: { type: "string" } } },
          })),
        })
      if (message.method === "tools/call") {
        calls.push({ name: message.params.name, arguments: message.params.arguments })
        return reply({ content: [{ type: "text", text: `${message.params.name} done` }], isError: false })
      }
      if (message.method === "ping") return reply({})
      return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })
    },
  })
})

afterAll(() => {
  model.stop(true)
  mcp.stop(true)
})

function messages(text: string) {
  const events = [
    { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

async function setup(delivery: Record<string, unknown>, api = { api: "openai-responses", base_url: "v1" }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "procontract-agent-"))
  const workspace = path.join(root, "workspace")
  await fs.mkdir(workspace)
  const config = path.join(root, "config.json")
  await Bun.write(
    config,
    JSON.stringify({
      workspace,
      state: path.join(root, "state"),
      model: {
        api: api.api,
        base_url: `http://127.0.0.1:${model.port}/${api.base_url}`,
        api_key_env: "TEST_MODEL_KEY",
        id: "test-model",
        reasoning_effort: "high",
      },
      mcp: { dune: { url: `http://127.0.0.1:${mcp.port}/mcp`, bearer_token_env: "TEST_MCP_TOKEN" } },
      delivery: { submit_tools: ["dune_submit_candidate"], finish_tools: ["dune_finish"], ...delivery },
    }),
  )
  return { root, workspace, config }
}

function start(args: string[]) {
  // PROCONTRACT_AGENT_BIN qualifies a compiled release binary against the same cases.
  const agent = process.env.PROCONTRACT_AGENT_BIN
    ? [process.env.PROCONTRACT_AGENT_BIN]
    : ["bun", path.join(import.meta.dir, "procontract-agent.ts")]
  return Bun.spawn([...agent, ...args], {
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), TEST_MODEL_KEY: "model-secret", TEST_MCP_TOKEN: "mcp-secret" },
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function lines(child: ReturnType<typeof start>) {
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const output = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown> & { type: string })
  return { output, code, result: output.at(-1) }
}

function reset(...steps: Step[]) {
  script.splice(0, script.length, ...steps)
  bodies.splice(0)
  headers.splice(0)
  calls.splice(0)
}

test("failing preflight checks reject a submission before it reaches the orchestrator; a passing one delivers", async () => {
  const run = await setup({ checks: [{ title: "ready marker", argv: ["test", "-f", "READY"] }] })
  reset(
    { tool: "dune_submit_candidate", input: { candidate: "cand" } },
    { tool: "shell", input: { command: "touch READY && env > environment", workdir: run.workspace } },
    { tool: "dune_submit_candidate", input: { candidate: "cand" } },
    { text: "Submitted." },
  )
  const { output, code, result } = await lines(start(["run", "--config", run.config, "--", "Improve the solver."]))
  expect(code).toBe(0)
  expect(calls).toEqual([{ name: "submit_candidate", arguments: { candidate: "cand" } }])
  const submits = output.filter((line) => line.type === "tool_result" && line.name === "dune_submit_candidate")
  expect(submits.map((line) => line.ok)).toEqual([false, true])
  expect(String(submits[0].output)).toContain("ready marker")
  expect(result).toMatchObject({ type: "result", delivery: { state: "delivered" }, final_text: "Submitted.", exit: 0 })
  expect(result?.usage).toMatchObject({ tokens: { input: 40, output: 20 }, cost_usd: null })
  // the session saw one model, its effort, the admitted tools and the orchestrator's tools; nothing else
  expect(bodies[0]).toMatchObject({ model: "test-model", reasoning: { effort: "high" } })
  // providers refuse tool schemas that are not a top-level object (Anthropic rejects oneOf/anyOf outright)
  for (const tool of bodies[0].tools ?? []) expect(tool).toMatchObject({ parameters: { type: "object" } })
  expect(bodies[0].tools?.map((tool) => tool.name).sort()).toEqual([
    "contract_delivery",
    "dune_finish",
    "dune_run_train",
    "dune_submit_candidate",
    "edit",
    "glob",
    "grep",
    "read",
    "shell",
    "write",
  ])
  // the model key and the MCP token never reach the agent's commands
  const environment = await Bun.file(path.join(run.workspace, "environment")).text()
  expect(environment).not.toContain("model-secret")
  expect(environment).not.toContain("mcp-secret")
  const usage = await Bun.file(path.join(run.root, "state", `usage-${output[0].session_id}.json`)).json()
  expect(usage).toEqual(result?.usage)
}, 60_000)

test("stopping with delivery open prompts the agent to continue until it reports blocked", async () => {
  const run = await setup({})
  reset(
    { text: "All done, it works." },
    { tool: "contract_delivery", input: { action: "blocked", reason: "the training data is missing" } },
    { text: "Blocked." },
  )
  const { output, code, result } = await lines(start(["run", "--config", run.config, "--", "Improve the solver."]))
  expect(code).toBe(0)
  expect(output.filter((line) => line.type === "continuation")).toEqual([{ type: "continuation", count: 1 }])
  expect(result).toMatchObject({ delivery: { state: "blocked", reason: "the training data is missing" } })
  expect(calls).toEqual([])
}, 60_000)

test("an agent that never delivers stops after max_continuations with delivery still open", async () => {
  const run = await setup({ max_continuations: 2 })
  reset()
  const { output, code, result } = await lines(start(["run", "--config", run.config, "--", "Improve the solver."]))
  expect(code).toBe(0)
  expect(bodies).toHaveLength(3)
  expect(output.filter((line) => line.type === "continuation")).toHaveLength(2)
  expect(result).toMatchObject({ delivery: { state: "open" } })
}, 60_000)

test("resume continues the same session with a fresh obligation and reports only new events", async () => {
  const run = await setup({ max_continuations: 0 })
  reset({ tool: "dune_finish", input: {} }, { text: "Stopping here." })
  const first = await lines(start(["run", "--config", run.config, "--", "Improve the solver."]))
  expect(first.result).toMatchObject({ delivery: { state: "finished" } })
  const sessionID = String(first.output[0].session_id)
  reset({ text: "Scores noted." })
  const second = await lines(start(["resume", "--config", run.config, "--session", sessionID, "--", "New scores."]))
  expect(second.code).toBe(0)
  expect(second.output[0]).toMatchObject({ type: "session", session_id: sessionID, resumed: true })
  expect(second.output.filter((line) => line.type === "text").map((line) => line.text)).toEqual(["Scores noted."])
  expect(second.result).toMatchObject({ delivery: { state: "open" } })
}, 60_000)

test("SIGTERM interrupts the session and still writes the result line", async () => {
  const run = await setup({})
  reset({ hang: true })
  const child = start(["run", "--config", run.config, "--", "Improve the solver."])
  while (bodies.length === 0) await Bun.sleep(25)
  child.kill("SIGTERM")
  const { code, result } = await lines(child)
  expect(code).toBe(143)
  expect(result).toMatchObject({ type: "result", ended: "terminated", exit: 143 })
}, 60_000)

test("Anthropic Messages endpoints get the key as a bearer token and the model's adaptive thinking effort", async () => {
  const run = await setup({ max_continuations: 0 }, { api: "anthropic-messages", base_url: "anthropic/v1" })
  reset({ text: "Hello from Claude." })
  const { code, result } = await lines(start(["run", "--config", run.config, "--", "Improve the solver."]))
  expect(code).toBe(0)
  expect(result).toMatchObject({ final_text: "Hello from Claude.", delivery: { state: "open" } })
  expect(headers[0]).toBe("Bearer model-secret")
  expect(bodies[0]).toMatchObject({ model: "test-model", thinking: { type: "adaptive" } })
  const tools = (bodies[0] as { tools?: Array<{ name: string; input_schema: Record<string, unknown> }> }).tools ?? []
  expect(tools.map((tool) => tool.name)).toContain("contract_delivery")
  for (const tool of tools) {
    expect(tool.input_schema.type).toBe("object")
    expect(["oneOf", "anyOf", "allOf"].filter((key) => key in tool.input_schema)).toEqual([])
  }
}, 60_000)

test("an invalid config is rejected with exit status 2", async () => {
  const run = await setup({ unknown: true })
  const { code, result } = await lines(start(["run", "--config", run.config, "--", "x"]))
  expect(code).toBe(2)
  expect(result?.type).toBe("error")
})
