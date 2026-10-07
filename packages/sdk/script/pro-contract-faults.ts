#!/usr/bin/env bun
import fs from "node:fs/promises"
import path from "node:path"
import { ProContract } from "@opencode/schema/pro-contract"
import { ProContractRSI } from "../src/pro-contract"
import { fixture } from "../test/pro-contract/wire"

const [root, release, bun = process.execPath] = process.argv.slice(2)
if (!root || !release) throw new Error("Usage: bun script/pro-contract-faults.ts NEW_ROOT FROZEN_RELEASE [BUN]")
await fs.mkdir(root, { mode: 0o700 })
const input = path.join(root, "input")
const verifier = path.join(root, "verifier")
await fs.mkdir(input)
await fs.mkdir(verifier)
await Bun.write(path.join(input, "public.txt"), "Public task input")
await Bun.write(path.join(verifier, "judge.py"), 'print(\'{"passed":1,"total":1,"valid":true}\')')
const wire = fixture({ block: true })
const config: ProContractRSI.Configuration = {
  runtime: { directory: release, bun, bwrap: "/usr/bin/bwrap", python: "/usr/bin/python3" },
  model: { id: "scripted", effort: "max", upstream: wire.url },
  seed: { instructions: "METHOD_STAGE=0\nRetain responsibility." },
  tests: (["safety", "development", "confirmation"] as const).map((panel) => ({
    id: panel,
    panel,
    repeats: panel === "safety" ? 1 : 2,
    total: 1,
    goal: "Fault qualification",
    directory: input,
    verifier: { directory: verifier, command: ["/usr/bin/python3", "/verifier/judge.py"] },
  })),
}
const results: unknown[] = []
try {
  for (const mode of ["cancel", "expiry", "withdrawal"] as const) {
    const campaign = path.join(root, mode)
    const host = await ProContractRSI.open(campaign, config)
    const id = ProContract.ID.make(`pct_${mode}`)
    const deadline = Date.now() + (mode === "expiry" ? 6000 : 21600000)
    const controller = new AbortController()
    const before = wire.records.length
    const work = host
      .run(
        {
          id,
          goal: "MECHANICS_ORIGINAL: wait for the fault probe",
          total: 1,
          directory: input,
          verifier: { directory: verifier, command: ["/usr/bin/python3", "/verifier/judge.py"] },
          deadline,
        },
        { signal: controller.signal },
      )
      .then(
        () => undefined,
        (error: unknown) => String(error),
      )
    while (wire.records.length === before && Date.now() < deadline) await Bun.sleep(20)
    if (mode === "cancel") controller.abort(new Error("Qualification cancellation"))
    if (mode === "withdrawal") host.store.withdraw(host.store.read().active.grant, "Qualification withdrawal")
    const error = await work
    const state = host.store.read()
    const executions = await fs.readdir(path.join(campaign, "executions"))
    const fenced = await Promise.all(
      executions.map((execution) => Bun.file(path.join(campaign, "executions", execution, "FENCED.json")).json()),
    )
    if (
      !error ||
      state.kernel.contracts[id].status !== "escalated" ||
      state.kernel.contracts[id].spec.budget.deadline !== deadline ||
      state.tasks[id].execution ||
      !fenced.length
    )
      throw new Error(`Fault did not preserve responsibility and fence: ${mode}`)
    results.push({ mode, error, deadline, finished: Date.now(), status: state.kernel.contracts[id].status, fenced })
    host.store.verify()
    host.close()
  }
  await Bun.write(
    path.join(root, "RESULT.json"),
    JSON.stringify({ kind: "native-fault-qualification", realModel: false, results }, null, 2),
  )
  console.log(JSON.stringify(results, null, 2))
} finally {
  await Bun.write(path.join(root, "WIRE.json"), JSON.stringify(wire.records))
  wire.server.stop(true)
}
