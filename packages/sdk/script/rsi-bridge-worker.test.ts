import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { PromiseSdk } from "../src/promise"
import { bridgeProfile } from "./rsi-bridge-worker"
import { tauProfile } from "./rsi-tau-worker"

for (const mode of ["tau", "bridge"] as const)
  test(`${mode} terminal interrupts the actual SDK Session before another model request`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-worker-"))
    const socket = path.join(root, "tools.sock")
    const deadline = Date.now() + 60000
    const requests: unknown[] = []
    const actions: unknown[] = []
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = Schema.decodeUnknownSync(
          Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
        )(await request.json())
        requests.push(body)
        const name = mode === "tau" ? "tau_turn" : requests.length === 1 ? "environment_echo" : "task_handoff"
        expect(body.tools.map((tool) => tool.name).sort()).toEqual(
          mode === "tau" ? ["tau_turn"] : ["environment_echo", "task_blocked", "task_handoff"],
        )
        if (requests.length > (mode === "tau" ? 1 : 2))
          return new Response("unexpected post-terminal model request", { status: 409 })
        const args =
          mode === "tau"
            ? { speak: "Done." }
            : requests.length === 1
              ? { value: "public action" }
              : { summary: "Ready for independent grading." }
        const item = {
          type: "function_call",
          id: `fc_${requests.length}`,
          call_id: `call_${requests.length}`,
          name,
          arguments: JSON.stringify(args),
        }
        const response = {
          id: `resp_${requests.length}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 5 },
        }
        const events = [
          { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response },
        ]
        return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), {
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })
    const environment = Bun.serve({
      unix: socket,
      async fetch(request) {
        const body = await request.json()
        if (mode === "bridge") {
          actions.push(body)
          return Response.json({ result: { stdout: "public action" } })
        }
        const terminal = new URL(request.url).pathname === "/turn"
        if (terminal) actions.push(body)
        return Response.json({
          kind: "tau-public-v1",
          sequence: terminal ? 1 : 0,
          terminal,
          termination: terminal ? "user_stop" : null,
          steps: terminal ? 3 : 1,
          maxSteps: 100,
          deadline,
          policy: "Fixture public policy.",
          tools: [],
          messages: [
            { role: "user", content: "Please help." },
            ...(terminal ? [{ role: "user", content: "###STOP###" }] : []),
          ],
        })
      },
    })
    const tools = path.join(root, "tools.json")
    await Bun.write(
      tools,
      JSON.stringify({
        tools: [
          {
            name: "environment_echo",
            description: "Fixture environment operation",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ],
      }),
    )
    const profile =
      mode === "tau"
        ? await tauProfile({ deadline, standing: async () => {}, socket })
        : await bridgeProfile({ deadline, standing: async () => {}, socket, file: tools })
    const host = await PromiseSdk.create({
      app: { name: `rsi-${mode}-worker-test` },
      database: { path: path.join(root, "session.sqlite") },
      events: { persist: true },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
      plugins: [profile.plugin],
      config: {
        directory: path.join(root, "config"),
        project: false,
        content: JSON.stringify({
          model: "openai/fixture-model",
          permissions: [
            { action: "*", resource: "*", effect: "allow" },
            { action: "execute", resource: "*", effect: "deny" },
          ],
          providers: {
            openai: {
              package: "@opencode/ai/providers/openai",
              canonical: "openai",
              env: [],
              settings: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "scripted", transport: "http" },
              models: {
                "fixture-model": {
                  limit: { context: 10000, output: 1000 },
                  capabilities: { tools: true, reasoning: true, input: ["text"], output: ["text"] },
                },
              },
            },
          },
        }),
      },
    })
    try {
      const session = await host.sessions.create({
        title: "Qualification",
        location: { directory: root },
        model: { providerID: "openai", id: "fixture-model" },
      })
      await host.sessions.prompt({ sessionID: session.id, text: profile.instructions })
      await host.sessions.wait({ sessionID: session.id })
      await Bun.sleep(100)
      const events = await Array.fromAsync(host.sessions.log({ sessionID: session.id }))
      expect(profile.status().state).toBe("ready")
      expect(requests.length).toBe(mode === "tau" ? 1 : 2)
      expect(actions.length).toBe(1)
      expect(events.some((event) => event.type === "session.execution.interrupted")).toBe(true)
      expect(events.some((event) => event.type === "session.execution.failed")).toBe(false)
    } finally {
      await host.close()
      provider.stop(true)
      environment.stop(true)
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 90000)
