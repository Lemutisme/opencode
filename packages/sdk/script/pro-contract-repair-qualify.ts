#!/usr/bin/env bun
/** Scripted provider, real native Sessions/tools/fences. No model-quality claim. */
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { ProContract } from "@opencode/schema/pro-contract"
import { ProContractTask } from "../src/pro-contract/task"
import { Endpoint } from "../../../research/programbench/endpoint"

const [root, release, bun = process.execPath] = process.argv.slice(2)
if (!root || !release) throw new Error("Usage: bun script/pro-contract-repair-qualify.ts NEW_ROOT RELEASE [BUN]")
await fs.mkdir(root, { mode: 0o700 })
const initial = path.join(root, "input")
const verifier = path.join(root, "verifier")
await fs.mkdir(initial)
await fs.mkdir(verifier)
await Bun.write(path.join(initial, "public.txt"), "Repair mechanics only")
await Bun.write(
  path.join(verifier, "judge.py"),
  `import json,pathlib
print(json.dumps({"passed": int(pathlib.Path('/workspace/answer.txt').read_text() == 'recovered\\n'), "total": 1, "valid": True}))`,
)
const bridge = path.join(root, "never-admitted.py")
const configuration = path.join(root, "programbench-fixture.json")
await Bun.write(bridge, "raise RuntimeError('A refused task must never admit this verifier')")
await Bun.write(configuration, JSON.stringify({ instance: "fixture__repair.123", image: "scripted-unused" }))
const reference = async (file: string) => ({ path: file, sha256: Bun.SHA256.hash(await Bun.file(file).bytes(), "hex") })
const Request = Schema.Struct({
  input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
})
const results: unknown[] = []
for (const mode of ["nul-shell", "refusal-sse", "refusal-json", "auth-sse", "malformed-sse"] as const) {
  const requests: (typeof Request.Type)[] = []
  const wire = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = Schema.decodeUnknownSync(Request)(await request.json())
      requests.push(body)
      if (mode !== "nul-shell") {
        const error =
          mode === "auth-sse"
            ? { error: { type: "authentication_error", message: "Expired test credential" } }
            : mode === "malformed-sse"
              ? { unexpected: "malformed test frame" }
              : {
                  error: {
                    message:
                      "Invalid prompt: flagged as potentially violating our usage policy. Please try again with a different prompt",
                    type: null,
                    code: "400",
                  },
                  preserved: "host-only refusal evidence",
                }
        return new Response(mode === "refusal-json" ? JSON.stringify(error) : `data: ${JSON.stringify(error)}\n\n`, {
          headers: {
            "content-type": mode === "refusal-json" ? "application/json" : "text/event-stream",
            "x-should-retry": "true",
          },
        })
      }
      const step = body.input.filter((item) => item.type === "function_call_output").length
      if (step === 1 && !JSON.stringify(body.input).includes("ChildProcess.spawn"))
        throw new Error("Synchronous startup error was not returned to the native Session")
      if (step > 2) throw new Error("Repair fixture made unexpected provider work")
      const name = body.tools.find((tool) => tool.name.endsWith(step < 2 ? "shell" : "contract_handoff"))?.name
      if (!name) throw new Error("Missing real native tool")
      const item = {
        type: "function_call",
        id: `fc_repair_${step}`,
        call_id: `call_repair_${step}`,
        name,
        arguments: JSON.stringify(
          step === 0
            ? { command: "printf 'before\0after'", timeout: 1000 }
            : step === 1
              ? { command: "printf 'recovered\\n' > /workspace/answer.txt", timeout: 1000 }
              : {
                  action: "submit",
                  summary: "Request independent artifact verification after the native startup repair.",
                },
        ),
      }
      const events = [
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
        { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `resp_repair_${step}`,
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const cohortRoot = path.join(root, mode)
  const directory = path.join(cohortRoot, "runs", "0-rsi-r1")
  await fs.mkdir(directory, { recursive: true })
  await Bun.write(path.join(cohortRoot, "FROZEN.json"), JSON.stringify({ sdkDirectory: release }))
  const started = Date.now()
  const admission = {
    version: 1,
    id: "0-rsi-r1",
    admissionID: crypto.randomUUID().replaceAll("-", ""),
    cohortToken: crypto.randomUUID().replaceAll("-", ""),
    cohortRoot,
    started,
    deadline: started + 21600000,
  }
  const config = {
    runtime: { directory: release, bun, python: "/usr/bin/python3", bwrap: "/usr/bin/bwrap" },
    model: { id: "scripted", effort: "max", upstream: `http://127.0.0.1:${wire.port}/v1` },
    method: ProContractTask.evidenceMethod,
  }
  const task = {
    id: ProContract.ID.make("pct_repair"),
    goal: "Scripted native startup/refusal qualification, not a benchmark result.",
    directory: initial,
    total: 1,
    deadline: admission.deadline,
    verification: "terminal" as const,
    verifier:
      mode === "nul-shell"
        ? { directory: verifier, command: ["/usr/bin/python3", "/verifier/judge.py"] }
        : {
            programbench: {
              bridge: await reference(bridge),
              configuration: await reference(configuration),
              python: await reference("/usr/bin/python3"),
              instance: "fixture__repair.123",
              total: 1,
              scoringTrust: "official-programbench-normal-use" as const,
            },
          },
  }
  await Bun.write(path.join(directory, "PROFILE.json"), JSON.stringify(config))
  await Bun.write(path.join(directory, "TASK.json"), JSON.stringify(task))
  const assignment = {
    id: admission.id,
    instance: "fixture__repair.123",
    profile: await reference(path.join(directory, "PROFILE.json")),
    task: await reference(path.join(directory, "TASK.json")),
  }
  await Bun.write(path.join(directory, "ADMISSION.json"), JSON.stringify(admission))
  await Bun.write(
    path.join(directory, "ADMITTED.json"),
    JSON.stringify({ ...admission, task, profile: assignment.profile, taskReference: assignment.task }),
  )
  const host = await ProContractTask.open(path.join(directory, "campaign"), config)
  try {
    const error = await host.run(task).then(
      () => undefined,
      (error: unknown) => String(error),
    )
    await Bun.write(
      path.join(directory, "HOST-RETURN.json"),
      JSON.stringify({ error: error ?? null, physicalRequests: requests.length }),
    )
    const state = host.store.read()
    const executions = await fs.readdir(path.join(directory, "campaign", "executions"))
    if (executions.length !== 1 || requests.length !== (mode === "nul-shell" ? 3 : 1))
      throw new Error(`Unexpected retry, continuation or stalled repair: ${mode}`)
    const execution = path.join(directory, "campaign", "executions", executions[0]!)
    const fence = await Bun.file(path.join(execution, "FENCED.json")).json()
    if (!fence.acknowledged || !fence.wrapperExited || !fence.runtimeExited || !fence.gatewayExited)
      throw new Error("Native ownership was not fenced")
    const journal = (await Bun.file(path.join(execution, "requests.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    if (mode === "nul-shell" && (error || state.kernel.contracts[task.id]?.status !== "discharged"))
      throw new Error(`Native repair failed: ${error}`)
    if (mode !== "nul-shell") {
      if (
        !error ||
        state.kernel.contracts[task.id]?.status !== "escalated" ||
        (await fs.stat(path.join(directory, "campaign", "verifications")).catch(() => undefined))
      )
        throw new Error("A refused/faulted execution was accepted or admitted a verifier")
      const finished = journal.find((event) => event.type === "finished")
      if (
        !finished ||
        finished.complete !== false ||
        finished.usage !== null ||
        finished.usageIncomplete !== true ||
        finished.cost !== null
      )
        throw new Error("Unknown provider usage was not preserved")
    }
    const endpoint =
      task.verifier.programbench !== undefined && mode.startsWith("refusal")
        ? await Endpoint.finish({
            directory,
            admission,
            assignment,
            task: { ...task, verifier: { programbench: task.verifier.programbench } },
            aborted: false,
            hostError: error,
            summary: {
              contract: state.kernel.contracts[task.id]!.status,
              proposals: Object.keys(state.proposals).length,
              comparisons: state.compared.length,
              selectedMethod: state.active.hash,
              seedMethod: state.seed,
            },
          })
        : undefined
    if (endpoint && (endpoint.endpoint.outcome !== "provider-refusal" || endpoint.classification.errors.length))
      throw new Error(`Native refusal endpoint failed: ${JSON.stringify(endpoint.classification)}`)
    host.store.verify()
    results.push({
      mode,
      physicalRequests: requests.length,
      executions: executions.length,
      contract: state.kernel.contracts[task.id]?.status,
      deadline: admission.deadline,
      fence,
      endpoint: endpoint?.endpoint,
      error: error ?? null,
    })
  } finally {
    host.close()
    await Bun.write(path.join(directory, "WIRE.json"), JSON.stringify(requests))
    wire.stop(true)
  }
}
await Bun.write(
  path.join(root, "RESULT.json"),
  JSON.stringify(
    {
      realModel: false,
      performanceClaim: false,
      release: await reference(path.join(release, "RELEASE.json")),
      source: await reference(import.meta.path),
      results,
    },
    null,
    2,
  ),
)
console.log(JSON.stringify({ realModel: false, performanceClaim: false, results }))
