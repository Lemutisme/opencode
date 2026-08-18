function chunk(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions")
      return new Response("not found", { status: 404 })
    const body = (await request.json()) as { messages?: Array<{ role?: string }> }
    const continued = body.messages?.some((message) => message.role === "tool")
    const id = continued ? "chatcmpl-after-ready" : "chatcmpl-report-ready"
    const lines = continued
      ? [
          { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] },
          {
            id,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "handoff recorded" } }],
          },
          {
            id,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]
      : [
          { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] },
          {
            id,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_report_ready",
                      type: "function",
                      function: { name: "contract_report_ready", arguments: "" },
                    },
                  ],
                },
              },
            ],
          },
          {
            id,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: JSON.stringify({
                          summary: "Loopback executor petitioned verification for the frozen candidate.",
                          uncertainties: [],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            id,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]
    return new Response(lines.map(chunk).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  },
})

console.log(`http://127.0.0.1:${server.port}/v1`)
await new Promise(() => {})
