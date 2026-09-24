import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { runInstance } from "./instance"
import { corpus } from "./corpus"
import { prepareScoring, sealCandidate, finalizeScoring } from "./evaluate"
import { launcher } from "./isolation"
import { recognize } from "./recognize"
import { digest } from "./ledger"

for (const [entry, protocol] of [
  ["plan", "chat/completions"],
  ["final", "chat/completions"],
  ["plan", "responses"],
] as const)
  test(`isolated ${entry} ${protocol} probe retains completed or not-exposed result`, async () => {
    const calls: unknown[] = []
    const upstream = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      calls.push(JSON.parse(Buffer.concat(chunks).toString()))
      const raw = JSON.stringify({
        version: 1,
        scope: "within_task",
        verdict: entry === "plan" ? "unavailable" : "changes_requested",
        summary: "Local wiring fixture only",
        findings:
          entry === "plan"
            ? []
            : [
                {
                  id: "prerequisite",
                  severity: "blocking",
                  path: "plan.method",
                  reason: "Fixture rejects prerequisite",
                  resolution: "No fixture rewrite",
                },
              ],
        claims: [],
      })
      outgoing.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "fixture-review" })
      outgoing.end(
        protocol === "responses"
          ? responses({ content: raw })
          : "data: " +
              JSON.stringify({
                id: "fixture",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: raw }, finish_reason: "stop" }],
              }) +
              "\n\ndata: [DONE]\n\n",
      )
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const route = {
      endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/${protocol}`,
      model: "local-fixture-reviewer",
      parameters: {},
      credential: protocol === "responses" ? null : "local-fixture-secret",
    }
    const directory = "/tmp/opencode-s6c-instance-" + crypto.randomUUID()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 40_000)
    try {
      const example = corpus("development").find(
        (item) => item.oracle.instance.family === (entry === "plan" ? "P1" : "F1") && !item.oracle.instance.defective,
      )!
      const result = await runInstance({
        mode: "local-fixture",
        directory,
        packet: example.packet,
        entry,
        routes: { worker: route, reviewer: route },
        limits: { worker: { context: 100_000, output: 4000 }, reviewer: { context: 100_000, output: 4000 } },
        timeouts: { provider: 5000, verification: 10000, cleanup: 30000 },
        bun: process.execPath,
        node: "/usr/bin/node",
        signal: controller.signal,
      })
      if (entry === "plan") expect(result.monitored.raw).toContain("Local wiring fixture only")
      else expect(result.monitored.prerequisiteBlocked).toBe(true)
      expect(result.monitored.run.input.spec.budget).toEqual({ deadline: result.issuedAt + 21_600_000 })
      expect(result.monitored.run.input.spec.resolution?.maxAttempts).toBeUndefined()
      expect(result.monitored.observed.exposed).toBe(entry === "plan")
      expect(result.scoring).toBe(entry === "plan" ? "pending_blind_annotations" : "not_exposed")
      expect(result.qualification).toBe("not_run")
      expect(calls).toHaveLength(1)
      const transport = await Bun.file(directory + "/archive/objects/" + result.transportHash).text()
      expect(digest(transport)).toBe(result.transportHash)
      expect(transport).toBe(await Bun.file(directory + "/archive/transport.jsonl").text())
      expect(
        transport
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      ).toContainEqual(
        expect.objectContaining({
          role: "reviewer",
          requestID: expect.any(String),
          hash: expect.any(String),
          bytes: expect.any(Number),
        }),
      )
      expect(JSON.stringify(result)).not.toContain("local-fixture-secret")
      expect(result.usage.filter((item) => item.stage === "worker").every((item) => item.wireRequests === 0)).toBe(true)
      expect(result.usage.filter((item) => item.stage === "plan_review").some((item) => item.wireRequests === 1)).toBe(
        true,
      )
      console.log("S6c local entry evidence:", directory)
    } finally {
      clearTimeout(timeout)
      controller.abort()
      upstream.closeAllConnections()
      upstream.close()
    }
  }, 60_000)

for (const [family, protocol] of [
  ["R3", "chat/completions"],
  ["R3", "responses"],
  ["R5", "chat/completions"],
  ["R6", "chat/completions"],
  ["R1", "chat/completions"],
] as const)
  test(`${family} ${protocol} uses upstream worker/reviewer, recovery and sealed external scoring`, async () => {
    const original = corpus("development").find((item) => item.oracle.instance.family === family)!
    // Only this local fixture slows a real test process to make its fault window deterministic.
    const example =
      family === "R1"
        ? {
            ...original,
            packet: {
              ...original.packet,
              preparation: { ...original.packet.preparation, "analysis.mjs": original.packet.files["analysis.mjs"] },
            },
          }
        : family !== "R6"
          ? original
          : {
              ...original,
              packet: {
                ...original.packet,
                files: {
                  ...original.packet.files,
                  "acceptance.mjs": original.packet.files["acceptance.mjs"].replace(
                    "test('public numeric smoke', () => {",
                    "test('public numeric smoke', async () => { await new Promise(resolve => setTimeout(resolve, 500));",
                  ),
                },
              },
            }
    const calls = { worker: 0, reviewer: 0 }
    const worker = { plan: 0, step: 0, evidenceRead: false }
    const files = Object.entries(example.packet.preparation)
    const upstream = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        model: string
        messages?: unknown[]
        input?: unknown[]
      }
      const prompt = JSON.stringify(body.messages ?? body.input).replaceAll('\\"', '"')
      const tool = (name: string, value: unknown) => ({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "fixture_" + crypto.randomUUID(),
            type: "function",
            function: { name, arguments: JSON.stringify(value) },
          },
        ],
      })
      const delta = (() => {
        if (body.model === "fixture-worker") {
          calls.worker++
          const plan = [...prompt.matchAll(/version=(\d+); agreement=(\{.*?\});/g)].at(-1)
          if (plan && Number(plan[1]) > worker.plan) {
            worker.plan = Number(plan[1])
            worker.step = 0
            return tool("contract_request", {
              kind: "plan",
              payload: {
                version: worker.plan,
                agreement: JSON.parse(plan[2]),
                scope: "within_task",
                ...example.packet.plan,
                protected: [],
              },
            })
          }
          const index = worker.step++
          if (index < files.length) return tool("write", { path: files[index][0], content: files[index][1] })
          if (index === files.length) return tool("contract_request", { kind: "experiment", payload: {} })
          if (index === files.length + 1)
            return tool("contract_request", {
              kind: "read_experiment",
              payload: { path: "artifacts/result.json", offset: 0, length: 16384 },
            })
          const outputs = (body.messages ?? body.input ?? []) as {
            role?: string
            type?: string
            content?: string
            output?: string
          }[]
          const output = outputs.findLast((item) => item.role === "tool" || item.type === "function_call_output")
          const read = JSON.parse(output?.output ?? output?.content ?? "{}") as {
            result?: { eof: boolean; content: string; returnedBytes: number }
          }
          worker.evidenceRead =
            !!read.result?.eof && read.result.returnedBytes > 0 && JSON.parse(read.result.content).observations === 8
          return tool("contract_report_ready", { summary: "Local R task transport fixture", uncertainties: [] })
        }
        calls.reviewer++
        const plan = prompt.includes("Allowed evidence:")
        const hash = /Allowed evidence(?: references)?: ([a-f0-9]{64})/.exec(prompt)![1]
        return {
          role: "assistant",
          content: JSON.stringify({
            version: 1,
            ...(plan ? { scope: "within_task" } : {}),
            verdict: "accept",
            summary: "Local transport fixture",
            findings: [],
            claims: [{ text: "Fixture evidence", evidence: [hash] }],
          }),
        }
      })()
      outgoing.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "fixture-" + crypto.randomUUID() })
      if (family === "R5" && body.model === "fixture-reviewer" && calls.reviewer === 1) {
        outgoing.write("data: ")
        return
      }
      outgoing.end(
        protocol === "responses"
          ? responses(delta)
          : "data: " +
              JSON.stringify({
                id: "fixture",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }],
              }) +
              "\n\ndata: [DONE]\n\n",
      )
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const route = {
      endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/${protocol}`,
      model: "fixture-worker",
      parameters: {},
      credential: protocol === "responses" ? null : "local-only-secret",
    }
    const directory = "/tmp/opencode-s6c-full-" + crypto.randomUUID()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 80_000)
    try {
      const result = await runInstance({
        mode: "local-fixture",
        directory,
        packet: example.packet,
        entry: "research",
        fault: example.oracle.fault,
        routes: { worker: route, reviewer: { ...route, model: "fixture-reviewer" } },
        limits: { worker: { context: 100_000, output: 4000 }, reviewer: { context: 100_000, output: 4000 } },
        timeouts: { provider: 5000, verification: 10000, cleanup: 30000 },
        bun: process.execPath,
        node: "/usr/bin/node",
        signal: controller.signal,
      })
      expect(result.monitored.run.stage).toBe("ready")
      expect(worker.evidenceRead).toBe(true)
      if (protocol === "responses") {
        expect(result.usage.filter((item) => item.turns === 1).every((item) => item.tokens === 13)).toBe(true)
        const transport = await Bun.file(directory + "/archive/transport.jsonl").text()
        expect(transport).toContain('"boundary":"provider"')
        expect(transport).not.toContain("local-only-secret")
      }
      expect(calls.worker).toBeGreaterThan(2)
      const recovered = result.fault?.recovered as { stopped: { replan?: boolean } } | undefined
      // A verifier restart can retain its approved plan; only a replan adds a plan review.
      expect(calls.reviewer).toBe(family === "R5" || recovered?.stopped.replan ? 3 : 2)
      if (example.oracle.fault) {
        expect(result.fault?.status).toBe("injected")
        expect(result.fault?.safe).toBe(true)
        expect(result.usage.some((item) => item.unknown)).toBe(true)
      }
      expect(result.usage.filter((item) => item.stage === "worker").some((item) => item.wireRequests > 0)).toBe(true)
      const scoring = await prepareScoring({
        directory,
        result,
        packet: example.packet,
        oracle: example.oracle,
        launcher: await launcher(directory + "/scorer"),
        timeout: 5000,
      })
      expect(scoring.objective?.boundaries).toBe(family !== "R1")
      expect(await Bun.file(directory + "/blind/reviewer.json").exists()).toBe(false)
      const materials = await Bun.file(directory + "/blind/objects/" + scoring.candidateHash).text()
      expect(materials).not.toContain("Local transport fixture")
      const items = Object.fromEntries(Object.keys(example.oracle.rubric).map((key) => [key, true]))
      const candidate = {
        rater: "fixture-rater-one",
        candidateHash: scoring.candidateHash,
        rubricHash: scoring.rubricHash,
        items,
      }
      const revealed = await sealCandidate({
        directory,
        first: candidate,
        second: { ...candidate, rater: "fixture-rater-two" },
      })
      const reviewer = {
        rater: "fixture-rater-one",
        candidateHash: revealed.candidateHash,
        rubricHash: revealed.rubricHash,
        items: Object.fromEntries(Object.keys(revealed.rubric).map((key) => [key, true])),
      }
      const score = await finalizeScoring({
        directory,
        first: reviewer,
        second: { ...reviewer, rater: "fixture-rater-two" },
      })
      expect(score.verdict).toBe(family === "R1" ? "incorrect" : "correct")
      if (family === "R1") expect(score.measured.label).toBe("false_accept")
      expect(score.attestedAt).toBeNull()
      if (family === "R1")
        await expect(recognize({ directory, bun: process.execPath, timeout: 30000 })).rejects.toThrow(
          "independently correct",
        )
      else {
        const receipt = await recognize({ directory, bun: process.execPath, timeout: 30000 })
        expect(receipt.receipt.decision.type).toBe("accepted")
        expect(receipt.attestedAt).toBeGreaterThanOrEqual(score.scoredAt)
      }
      const preserved = await Bun.file(directory + "/score.json").text()
      await Bun.write(directory + "/score.json", preserved.replace('"verdict":', '"tampered":'))
      await expect(recognize({ directory, bun: process.execPath, timeout: 30000 })).rejects.toThrow(
        "Sealed score changed",
      )
      await Bun.write(directory + "/score.json", preserved)
      await expect(
        finalizeScoring({ directory, first: reviewer, second: { ...reviewer, rater: "fixture-rater-two" } }),
      ).rejects.toThrow()
      console.log("S6c full local entry evidence:", directory)
    } finally {
      clearTimeout(timeout)
      controller.abort()
      upstream.closeAllConnections()
      upstream.close()
    }
  }, 100_000)

function responses(delta: {
  content?: string
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
}) {
  const call = delta.tool_calls?.[0]
  const item = call ? { type: "function_call", id: "fc_" + call.id, call_id: call.id, ...call.function } : undefined
  return [
    ...(item
      ? [
          { type: "response.output_item.added", item: { ...item, arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: item.id, delta: item.arguments },
          { type: "response.output_item.done", item },
        ]
      : [{ type: "response.output_text.delta", item_id: "msg_fixture", delta: delta.content }]),
    {
      type: "response.completed",
      response: { id: "resp_fixture", usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } },
    },
  ]
    .map((event) => "data: " + JSON.stringify(event) + "\n\n")
    .join("")
}
