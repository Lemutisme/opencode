// Production ProgramBench/native startup witness, with a local scripted provider.
// Candidate runtime code runs only inside the existing offline worker sandbox.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { reference, run } from "./ota-native"

const [rootArg, releaseArg, templateArg, mode = "repaired"] = process.argv.slice(2)
if (!rootArg || !releaseArg || !templateArg || !["repaired", "control", "tampered"].includes(mode))
  throw new Error("ROOT RELEASE_JSON FROZEN_BRIDGE_REQUEST {repaired|control|tampered}")
const root = path.resolve(rootArg)
await mkdir(root, { recursive: false, mode: 0o700 })
await mkdir(path.join(root, "wire"))
const observation = { requests: 0, errors: [] as string[], visible: false }
const attestation = { path: undefined as string | undefined, original: undefined as string | undefined }
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/responses"))
      return new Response("not found", { status: 404 })
    const body = (await request.json()) as {
      model: string
      tools?: { name?: string; function?: { name?: string } }[]
      input: { type?: string; call_id?: string; output?: unknown }[]
    }
    const index = observation.requests++
    await Bun.write(path.join(root, "wire", `${index}.json`), JSON.stringify(body))
    const names = body.tools?.map((tool) => tool.name ?? tool.function?.name) ?? []
    if (index === 0) {
      observation.visible = names.includes("reference_contrast")
      if (observation.visible !== (mode !== "control"))
        observation.errors.push("unexpected actual advertised tool catalog")
      if (mode === "tampered") {
        const entries = await Array.fromAsync(
          new Bun.Glob("ota-eval-*/procontract/*/workspace-state/provider-channel/reference.json").scan({
            cwd: output,
            absolute: true,
          }),
        )
        if (entries.length !== 1) throw new Error("ambiguous owned fixture attestation")
        attestation.path = entries[0]
        attestation.original = await readFile(entries[0], "utf8")
        const invalid = { ...JSON.parse(attestation.original), hash: "0".repeat(64) }
        await Bun.write(path.join(root, "injected-attestation.json"), JSON.stringify(invalid))
        await writeFile(entries[0] + ".fixture", JSON.stringify(invalid), { flag: "wx", mode: 0o444 })
        await rename(entries[0] + ".fixture", entries[0])
      }
    }
    if (index > 0) {
      const returned = body.input.findLast(
        (item) => item.type === "function_call_output" && item.call_id === `call_witness_${index - 1}`,
      )
      const output = JSON.stringify(returned?.output)
      if (!returned) observation.errors.push(`missing canonical result for call ${index - 1}`)
      if (
        index === 1 &&
        (mode === "control"
          ? !output?.includes("Unknown tool")
          : mode === "tampered"
            ? !output?.includes("incomplete") || !output.includes("identity validation")
            : !output?.includes("different-exact-outcome"))
      )
        observation.errors.push("first contrast did not demonstrate the expected production path")
      if (mode === "tampered" && index === 1) {
        await writeFile(attestation.path! + ".fixture", attestation.original!, { flag: "wx", mode: 0o444 })
        await rename(attestation.path! + ".fixture", attestation.path!)
      }
      if (mode !== "control" && index === 2 && !output?.includes("same-exact-outcome"))
        observation.errors.push("identical reference inputs were not compared exactly")
      if (index === 3 && !output?.includes("BLACK_BOX_AND_CHANNEL_PROTECTED"))
        observation.errors.push("reference/channel isolation witness failed")
    }
    const name =
      index === 0
        ? "reference_contrast"
        : index === 1 && mode !== "control"
          ? "reference_contrast"
          : index < 3
            ? "bash"
            : index === 3
              ? "contract_check"
              : "contract_report_ready"
    const input =
      name === "reference_contrast"
        ? {
            hypothesis: index === 0 ? "Documented CLI entrypoints differ" : "Repeated version queries agree",
            expected: index === 0 ? "different" : "same",
            left: { label: "left", args: [index === 0 ? "--help" : "--version"], stdin: "" },
            right: { label: "right", args: ["--version"], stdin: "" },
          }
        : name === "bash"
          ? {
              command: `python3 -I -c ${quote(`import pathlib,os
assert os.geteuid()!=0
for name in ['/workspace/executable','/candidate/reference']:
 try:
  pathlib.Path(name).read_bytes()
  raise AssertionError('oracle bytes readable')
 except PermissionError: pass
try:
 pathlib.Path('/run/programbench-provider/reference.json').write_text('{}')
 raise AssertionError('host attestation writable')
except OSError: pass
nl=chr(10)
pathlib.Path('main.sh').write_text(nl.join(['#!/bin/sh','printf smoke-only','']))
pathlib.Path('compile.sh').write_text(nl.join(['#!/bin/sh','set -eu','cd "$(dirname "$0")"','cp main.sh executable','chmod +x executable','']))
pathlib.Path('validate.sh').write_text(nl.join(['#!/bin/sh','set -eu','cd "$(dirname "$0")"','./executable >/dev/null','']))
for name in ['main.sh','compile.sh','validate.sh']:pathlib.Path(name).chmod(0o755)
print('BLACK_BOX_AND_CHANNEL_PROTECTED')`)}\n./compile.sh\n./validate.sh`,
              workdir: "/candidate",
              timeout: 60_000,
            }
          : name === "contract_check"
            ? {}
            : {
                summary: "Scripted production-wiring and black-box-isolation witness, not a task-quality solution",
                uncertainties: ["No real model call and no benchmark improvement claim"],
              }
    const item = { type: "function_call", id: `fc_witness_${index}`, call_id: `call_witness_${index}`, name }
    const frames = [
      { type: "response.output_item.added", item },
      { type: "response.function_call_arguments.delta", item_id: item.id, delta: JSON.stringify(input) },
      { type: "response.output_item.done", item: { ...item, arguments: JSON.stringify(input) } },
      {
        type: "response.completed",
        response: {
          id: `resp_witness_${index}`,
          usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } },
        },
      },
    ]
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
const template = await Bun.file(templateArg).json()
const request = { ...template, deadline: Date.now() + 6 * 60 * 60 * 1_000, harness: await reference(releaseArg) }
const file = path.join(root, "request.json")
await Bun.write(file, JSON.stringify(request))
const output = path.join(root, "execution")
const runner = "/home/duozhou/ProgramBench-ota-rsi"
const python = "/home/duozhou/ProgramBench/.venv/bin/python"
const child = Bun.spawn([python, "-B", "-m", "scripts.ota_benchmark", file, output], {
  cwd: runner,
  stdin: "ignore",
  stdout: Bun.file(path.join(root, "runner.log")),
  stderr: Bun.file(path.join(root, "runner-error.log")),
  env: {
    ...process.env,
    OPENAI_API_KEY: "local-scripted-only",
    OPENCODE_SERVER_PASSWORD: crypto.randomUUID() + crypto.randomUUID(),
    OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
    PYTHONPATH: `${runner}:${runner}/src`,
    PYTHONDONTWRITEBYTECODE: "1",
    PROGRAMBENCH_RIPGREP: "/home/duozhou/run-artifacts/procontract-sol-r2-full-20260919/runtime/rg",
    PROGRAMBENCH_BLOB_DIR: "/home/duozhou/run-artifacts/procontract-sol-ota-rsi-20260921/inputs/test-blobs",
  },
})
const guard = setInterval(() => {
  if (observation.errors.length || Date.now() >= request.deadline) child.kill("SIGTERM")
}, 200)
try {
  const code = await child.exited
  if (code !== 0 || observation.errors.length)
    throw new Error(`native witness failed: ${JSON.stringify(observation.errors)}; exit ${code}`)
  const result = await Bun.file(path.join(output, "result.json")).json()
  if (!result.valid) throw new Error("invalid infrastructure receipt")
  const campaign = (await Array.fromAsync(new Bun.Glob("ota-eval-*").scan({ cwd: output, onlyFiles: false }))).find(
    (name) => !name.includes("/"),
  )!
  const instance = path.join(output, campaign, "procontract", request.instance)
  const native = await Bun.file(path.join(instance, "procontract-result.json")).json()
  const db = new Database(path.join(instance, "workspace-state/opencode-state/data/opencode/opencode-ota.db"), {
    readonly: true,
  })
  const calls = db
    .query<{ data: string }, [string]>("SELECT data FROM session_message WHERE session_id=? ORDER BY seq")
    .all(native.session_id)
    .flatMap((row) => {
      const message = JSON.parse(row.data) as {
        content?: { type: string; name?: string; state?: { status?: string; structured?: unknown } }[]
      }
      return message.content?.filter((part) => part.type === "tool" && part.name === "reference_contrast") ?? []
    })
  db.close()
  if (mode !== "control" && (calls.length !== 2 || calls.some((call) => call.state?.status !== "completed")))
    throw new Error("contrast calls were not durably completed")
  if (mode !== "control") {
    const values = calls.map(
      (call) =>
        call.state?.structured as {
          relation: string
          exactRelationMet?: boolean
          left: { status: string; outcomeHash?: string }
          right: { status: string; outcomeHash?: string }
        },
    )
    if (
      values[1]?.relation !== "same-exact-outcome" ||
      values[1].exactRelationMet !== true ||
      values[1].left.status !== "completed" ||
      values[1].right.status !== "completed" ||
      !values[1].left.outcomeHash ||
      values[1].left.outcomeHash !== values[1].right.outcomeHash
    )
      throw new Error("durable identical-input contrast is not a valid completed comparison")
    if (
      mode === "repaired" &&
      (values[0]?.relation !== "different-exact-outcome" ||
        values[0].exactRelationMet !== true ||
        values[0].left.status !== "completed" ||
        values[0].right.status !== "completed" ||
        !values[0].left.outcomeHash ||
        !values[0].right.outcomeHash ||
        values[0].left.outcomeHash === values[0].right.outcomeHash)
    )
      throw new Error("durable different-input contrast is not a valid completed comparison")
    if (
      mode === "tampered" &&
      (values[0]?.relation !== "incomplete" ||
        values[0].exactRelationMet !== undefined ||
        values[0].left.status !== "unavailable" ||
        values[0].right.status !== "skipped" ||
        values[0].left.outcomeHash)
    )
      throw new Error("invalid attestation produced trusted comparison evidence")
  }
  if (result.admission.deadline !== request.deadline) throw new Error("original deadline changed")
  await Bun.write(
    path.join(root, "E2E.json"),
    JSON.stringify(
      {
        passed: true,
        mode,
        request: await reference(file),
        release: await reference(releaseArg),
        providerRequests: observation.requests,
        realModelCalls: 0,
        advertised: observation.visible,
        contrastCalls: calls,
        admission: result.admission,
        deadlinePreserved: result.admission.deadline === request.deadline,
        nativeActions: native.actions,
        scope:
          "Real production composition, official native Contract/Session/provider tool loop and black-box identity checks. Scripted provider; no capability or benchmark improvement claim.",
      },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify({
      passed: true,
      mode,
      advertised: observation.visible,
      contrastCalls: calls.length,
      realModelCalls: 0,
    }),
  )
} finally {
  clearInterval(guard)
  child.kill("SIGTERM")
  await run([python, "-B", "-m", "scripts.ota_benchmark", file, output, "--fence"], undefined, 90_000, {
    ...process.env,
    PYTHONPATH: `${runner}:${runner}/src`,
  })
  server.stop(true)
}

function quote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}
