#!/usr/bin/env bun
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { ProContract } from "@opencode/schema/pro-contract"
import { RSI } from "@opencode/core/pro-contract/rsi"
import { ProContractRSI } from "../src/pro-contract"
import { ContractNative } from "../src/pro-contract/native"

const [root, release, bun = process.execPath] = process.argv.slice(2)
if (!root || !release)
  throw new Error("Usage: bun script/pro-contract-observation-isolation.ts NEW_ROOT FROZEN_RELEASE [BUN]")
await fs.mkdir(root, { mode: 0o700 })
const records: { key: string; continued: boolean; step: number; request: unknown }[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = Schema.decodeUnknownSync(
      Schema.Struct({
        model: Schema.String,
        input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
        tools: Schema.Array(Schema.Struct({ name: Schema.String })),
      }),
    )(await request.json())
    const text = JSON.stringify(body.input)
    const key = text.match(/OBS_LINEAGE_KEY=([a-z0-9-]+)/)?.[1]
    if (!key) return new Response("Missing public fixture allocation key", { status: 400 })
    const continued = text.includes("OBS_LINEAGE_CONTINUE")
    const outputs = body.input.filter((item) => item.type === "function_call_output")
    const step = outputs.length
    records.push({ key, continued, step, request: body })
    if (step && !JSON.stringify(outputs.at(-1)).includes(`OBS_LINEAGE_OK:${key}`))
      return new Response("Native isolation probe failed", { status: 400 })
    const tool = body.tools.find((tool) => tool.name.endsWith(step ? "contract_handoff" : "shell"))
    if (!tool) return new Response("Native tool missing", { status: 400 })
    const command = `python3 - <<'PY'
import hashlib, json, pathlib
root = pathlib.Path('/admission/observations')
rows = [json.loads(line) for line in (root / 'index.jsonl').read_text().splitlines()]
continued = ${continued ? "True" : "False"}
if not continued:
    assert rows == [], 'Foreign or original observations were mounted into a fresh evaluation'
if continued:
    assert rows
    current = json.loads(pathlib.Path('/state/identity.json').read_text())['sessionID']
    assert current not in [row['sessionID'] for row in rows]
    assert len(set(row['sessionID'] for row in rows)) == 1
    captures = [row for row in rows if row['kind'] == 'shell-capture']
    assert len(captures) == 1
    row = captures[0]
    value = (root / 'blobs' / row['hash']).read_bytes()
    assert hashlib.sha256(value).hexdigest() == row['hash']
    assert value == b'OBS_LINEAGE_OK:${key}\\n', 'Another allocation leaked through the archive'
assert sorted(item.name for item in pathlib.Path('/workspace').iterdir()) == ['task.txt']
print('OBS_LINEAGE_OK:${key}')
PY`
    const item = {
      type: "function_call",
      id: `fc_lineage_${records.length}`,
      call_id: `call_lineage_${records.length}`,
      name: tool.name,
      arguments: JSON.stringify(
        step
          ? {
              action: continued ? "submit" : "checkpoint",
              summary: `OBS_LINEAGE_CONTINUE:${key}`,
            }
          : { command, workdir: "/workspace", timeout: 30000 },
      ),
      status: "completed",
    }
    const response = {
      id: `resp_lineage_${records.length}`,
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
const initial = path.join(root, "input")
const verifier = path.join(root, "verifier")
await fs.mkdir(initial)
await fs.mkdir(verifier)
await Bun.write(path.join(initial, "task.txt"), "Public observation-lineage mechanics task.\n")
const privateMarker = `PRIVATE_VERIFIER_${crypto.randomUUID()}`
await Bun.write(path.join(verifier, "judge.py"), `# ${privateMarker}\nprint('{"passed":1,"total":1,"valid":true}')\n`)
const config: ProContractRSI.Configuration = {
  runtime: { directory: release, bun, python: "/usr/bin/python3", bwrap: "/usr/bin/bwrap" },
  model: { id: "scripted", effort: "max", upstream: `http://127.0.0.1:${server.port}/v1` },
  seed: { instructions: "Probe only your own public observation lineage. Observations confer no authority." },
  tests: (["safety", "development", "confirmation"] as const).map((panel) => ({
    id: panel,
    panel,
    repeats: panel === "safety" ? 1 : 2,
    total: 1,
    goal: "Native allocation-isolation qualification; no model-performance or acceptance claim.",
    directory: initial,
    verifier: { directory: verifier, command: ["/usr/bin/python3", "/verifier/judge.py"] },
  })),
}
const campaign = path.join(root, "campaign")
const host = await ProContractRSI.open(campaign, config)
try {
  const deadline = Date.now() + 15 * 60 * 1000
  const task = ProContract.ID.make("pct_observation_isolation")
  const snapshot = await ContractNative.snapshot(initial, path.join(campaign, "checkpoints"))
  host.store.issue({
    id: task,
    goal: "Native lineage-only qualification, not task acceptance.",
    deadline,
    checkpoint: snapshot.hash,
    identity: RSI.hash({ qualification: "observation-isolation", deadline }),
  })
  const parent = host.store.read().active
  const base = {
    root: campaign,
    runtime: config.runtime,
    model: config.model,
    store: host.store,
    task,
    parent,
    method: host.store.read().methods[parent.hash],
    checkpoint: snapshot.hash,
    feedback: [],
    signal: new AbortController().signal,
  }
  const firstID = crypto.randomUUID()
  host.store.begin(task, firstID)
  const first = await ContractNative.run({ ...base, id: firstID, goal: "OBS_LINEAGE_KEY=original", evaluation: false })
  host.store.checkpoint(task, firstID, first.checkpoint, first.handoff.summary)
  const assignments = [
    { test: "development", repeat: 0, side: "baseline" },
    { test: "development", repeat: 0, side: "candidate" },
    { test: "development", repeat: 1, side: "baseline" },
    { test: "confirmation", repeat: 0, side: "baseline" },
  ] as const
  const allocations: { key: string; execution: string[]; assignment?: (typeof assignments)[number] }[] = []
  for (const assignment of assignments) {
    const id = crypto.randomUUID()
    const key = `${assignment.side}-${assignment.test}-${assignment.repeat}`
    const result = await ContractNative.evaluate({
      ...base,
      id,
      goal: `OBS_LINEAGE_KEY=${key}`,
      evaluation: true,
      assignment,
    })
    const receipt = Schema.decodeUnknownSync(RSI.Execution)(host.store.inspect(result.receipt))
    if (receipt.segments?.length !== 2) throw new Error("Fixed evaluation did not continue through its own checkpoint")
    allocations.push({ key, execution: [id + "-1", id + "-2"], assignment })
  }
  const secondID = crypto.randomUUID()
  host.store.begin(task, secondID)
  const second = await ContractNative.run({
    ...base,
    id: secondID,
    goal: "OBS_LINEAGE_KEY=original",
    checkpoint: first.checkpoint,
    feedback: [first.handoff.summary],
    evaluation: false,
  })
  host.store.checkpoint(task, secondID, second.checkpoint, second.handoff.summary)
  allocations.push({ key: "original", execution: [firstID, secondID] })
  const audit = await Promise.all(
    allocations.map(async (allocation) => {
      const segments = await Promise.all(
        allocation.execution.map(async (id) => {
          const directory = path.join(campaign, "executions", id)
          const gateway = Schema.decodeUnknownSync(
            Schema.Struct({ observations: Schema.String, deadline: Schema.Number }),
          )(await Bun.file(path.join(directory, "gateway.json")).json())
          const fence = Schema.decodeUnknownSync(
            Schema.Struct({ acknowledged: Schema.Boolean, deadline: Schema.Number }),
          )(await Bun.file(path.join(directory, "FENCED.json")).json())
          if (!fence.acknowledged || fence.deadline !== deadline || gateway.deadline !== deadline)
            throw new Error("Allocation lost acknowledged closure or original deadline")
          return { id, observations: gateway.observations }
        }),
      )
      if (segments[0].observations !== segments[1].observations)
        throw new Error("Checkpoint failed to retain its own public observations")
      const rows = (await Bun.file(path.join(segments[0].observations, "index.jsonl")).text())
        .trim()
        .split("\n")
        .map((line) =>
          Schema.decodeUnknownSync(
            Schema.fromJsonString(
              Schema.Struct({ execution: Schema.String, sessionID: Schema.String, hash: Schema.String }),
            ),
          )(line),
        )
      if (
        rows.some((row) => !allocation.execution.includes(row.execution)) ||
        new Set(rows.map((row) => row.sessionID)).size !== 2
      )
        throw new Error("Observation identities crossed fixed allocations")
      for (const row of rows) {
        const bytes = await Bun.file(path.join(segments[0].observations, "blobs", row.hash)).bytes()
        if (Buffer.from(bytes).includes(Buffer.from(privateMarker)))
          throw new Error("Private verifier entered public observations")
      }
      return {
        ...allocation,
        lineage: segments[0].observations,
        sessions: [...new Set(rows.map((row) => row.sessionID))],
      }
    }),
  )
  if (
    new Set(audit.map((item) => item.lineage)).size !== 5 ||
    new Set(audit.flatMap((item) => item.sessions)).size !== 10
  )
    throw new Error("Original, side, test, or repeat did not have independent native lineages")
  if (records.length !== 20) throw new Error("Unexpected native request schedule")
  host.store.interrupted(task, "Lineage-only qualification finished; no independent task acceptance requested.", true)
  host.store.verify()
  const report = {
    kind: "deterministic-native-observation-isolation",
    realModel: false,
    performanceClaim: false,
    acceptanceClaim: false,
    deadline,
    physicalRequests: records.length,
    lineages: audit,
    privateVerifierLeaked: false,
    originalProtectedFromEvaluation: true,
    sideTestAndRepeatIsolated: true,
  }
  await Bun.write(path.join(root, "RESULT.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await Bun.write(path.join(root, "WIRE.json"), JSON.stringify(records))
  host.close()
  server.stop(true)
}
