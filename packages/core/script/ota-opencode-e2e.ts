// Native full-runtime OTA qualification. Provider responses are scripted;
// no paid model call, benchmark score or recursive-intelligence claim is made.
import { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { OTA } from "./ota-rsi"
import { Artifacts, supervise } from "./ota-supervisor"
import { driver } from "./ota-opencode"
import type { Supplies } from "./ota-opencode"
import { artifact, reference } from "./ota-native"
import type { Release } from "./ota-native"

const [rootArg, suppliesArg, seedArg, mode = "healthy"] = process.argv.slice(2)
if (!rootArg || !suppliesArg || !seedArg || !["healthy", "rollback"].includes(mode))
  throw new Error("ROOT SUPPLIES_JSON SEED_BUILD {healthy|rollback}")
const root = path.resolve(rootArg)
await mkdir(root, { recursive: false, mode: 0o700 })
const supplies = (await Bun.file(suppliesArg).json()) as Supplies
const seed = path.resolve(seedArg)
const seedReceipt = path.join(root, "seed-build.json")
await Bun.write(
  seedReceipt,
  JSON.stringify({
    supplies,
    source: await reference(path.join(seed, "source.tar")),
    binary: await reference(path.join(seed, "opencode")),
    log: await reference(path.join(seed, "build.log")),
  }),
)
const initial: Release = {
  kind: "opencode-release-v1",
  source: await reference(path.join(seed, "source.tar")),
  binary: await reference(path.join(seed, "opencode")),
  image: supplies.image,
  build: await reference(seedReceipt),
}

const mutate = `import pathlib,subprocess,sqlite3
root=next(p for p in pathlib.Path('/state/work').glob('source-*') if (p/'packages/core/src/database/database.ts').exists())
db=sqlite3.connect('/state/data/opencode.db')
db.execute('CREATE TABLE IF NOT EXISTS ota_user_memory (key TEXT PRIMARY KEY, value TEXT)')
db.execute("INSERT OR REPLACE INTO ota_user_memory VALUES ('user-note','preserve-me')");db.commit();db.close()
changes={
'packages/core/src/session/runner/llm.ts':('system: [agent.info?.system, system.baseline]', 'system: [agent.info?.system, system.baseline, "OTA_CONTEXT_V1"]'),
'packages/core/src/tool/bash.ts':('const output = result.output?.toString("utf8") || "(no output)"', ${JSON.stringify(String.raw`const output = (result.output?.toString("utf8") || "(no output)") + "\nOTA_TOOL_V1"`)}),
'packages/core/src/database/database.ts':('yield* DatabaseMigration.apply(db)', ${JSON.stringify(`yield* DatabaseMigration.apply(db)
    yield* db.run("CREATE TABLE IF NOT EXISTS ota_memory_v1 (value TEXT)")
    yield* db.run("INSERT INTO ota_memory_v1 VALUES ('migrated')")
    ${
      mode === "rollback"
        ? `yield* db.run("CREATE TABLE IF NOT EXISTS ota_user_memory (key TEXT PRIMARY KEY, value TEXT)")
    const before = yield* db.all<{ value: string }>("SELECT value FROM ota_user_memory WHERE key = 'user-note'")
    if (before.some((row) => row.value === "preserve-me")) {
      yield* db.run("UPDATE ota_user_memory SET value = 'trial-damaged' WHERE key = 'user-note'")
      yield* Effect.promise(() => new Promise<never>(() => {}))
    }`
        : ""
    }`)})}
for name,(before,after) in changes.items():
 p=root/name;s=p.read_text();assert s.count(before)==1,(name,s.count(before));p.write_text(s.replace(before,after))
with open('/state/work/h','wb') as out:subprocess.run(['git','diff','--binary','HEAD'],cwd=root,stdout=out,check=True)
print('CHANGED_CONTEXT_TOOL_MEMORY')
`
const defense = `import pathlib,socket
for name in ['/runtime/opencode','/release/strategy']:
 try:
  pathlib.Path(name).write_text('forged')
  raise AssertionError('active release writable')
 except OSError:pass
assert not pathlib.Path(${JSON.stringify(path.join(root, "ota.sqlite"))}).exists()
s=socket.socket(socket.AF_UNIX);s.connect('/channel/provider.sock')
s.sendall(b'POST /v1/responses HTTP/1.1\\r\\nHost: programbench-provider.invalid\\r\\nContent-Length: 2\\r\\n\\r\\n{}')
assert b'403' in s.recv(4096);s.close()
print('AUTHORITY_AND_CHANNEL_ISOLATED')
`
const observation = { count: 0, resumed: false, errors: [] as string[] }
const sessions = new Map<string, number>()
const state = { ota: undefined as OTA | undefined }
await mkdir(path.join(root, "wire"))
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses")
      return new Response("not found", { status: 404 })
    const body = (await request.json()) as {
      input: { role?: string; content?: { text?: string }[] }[]
      prompt_cache_key?: string
    }
    const text = JSON.stringify(body)
    await Bun.write(path.join(root, "wire", `${observation.count++}.json`), JSON.stringify(body))
    const key = body.prompt_cache_key ?? JSON.stringify(body.input.find((item) => item.role === "user"))
    const index = sessions.get(key) ?? 0
    sessions.set(key, index + 1)
    const epoch = state.ota?.read().epoch ?? 0
    const generation = text.includes("Active mode ")
    const system = JSON.stringify(body.input.filter((item) => item.role === "system"))
    if (generation && epoch >= 3 && index === 0) {
      observation.resumed = true
      if (mode === "healthy" && (!text.includes("STRATEGY_V1") || !system.includes("OTA_CONTEXT_V1")))
        observation.errors.push("new policy/runtime not used after second switch")
      if (mode === "rollback" && (system.includes("OTA_CONTEXT_V1") || text.includes("STRATEGY_V1")))
        observation.errors.push("failed runtime not actually rolled back")
      await Bun.write(
        path.join(root, "CANCEL"),
        "explicit e2e cancellation after observing successor/restored provider request",
      )
    }
    const script =
      generation && epoch >= 3
        ? "print('successor-or-restored-execution-observed')"
        : generation && text.includes("only propose h")
          ? mutate
          : generation
            ? "import pathlib;pathlib.Path('/state/work/s').write_text('STRATEGY_V1: preserve full passes, test causal changes, keep evidence separate from authority.\\n')"
            : "import pathlib;pathlib.Path('/state/work/answer').write_text('native-ok\\n')"
    const name = index === 0 ? "bash" : index === 1 ? "contract_check" : "contract_report_ready"
    const arguments_ =
      index === 0
        ? {
            command: `python3 -I -c ${quote(defense)}\npython3 -I -c ${quote(script)}`,
            workdir: "/state/work",
            timeout: 60_000,
          }
        : index === 1
          ? {}
          : { summary: "Native scripted OTA artifact handoff", uncertainties: ["No model-quality claim"] }
    const item = {
      type: "function_call",
      id: `fc_${observation.count}_${index}`,
      call_id: `call_${observation.count}_${index}`,
      name,
    }
    const frames = [
      { type: "response.output_item.added", item },
      { type: "response.function_call_arguments.delta", item_id: item.id, delta: JSON.stringify(arguments_) },
      { type: "response.output_item.done", item: { ...item, arguments: JSON.stringify(arguments_) } },
      {
        type: "response.completed",
        response: {
          id: `resp_${observation.count}`,
          usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } },
        },
      },
    ]
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })
  },
})

const adapter = driver({
  root,
  supplies,
  provider: {
    gateway: await reference(path.join(path.dirname(path.resolve(suppliesArg)), "provider-gateway.py")),
    model: "gpt-5.6-sol",
    effort: "max",
    upstream: `http://127.0.0.1:${server.port}/v1`,
    key: "local-scripted-only",
    fixture: true,
  },
  authority: [await reference(import.meta.path)],
  task: () => ({
    goal: "Native roundtrip safety",
    brief:
      "Write native-ok followed by a newline to /state/work/answer, check and report the handoff. This is a mechanics test, not performance evidence.",
    artifact: "answer",
  }),
  grade: async (input) => ({
    passed:
      new TextDecoder().decode(await artifact(path.join(input.state, "work"), "answer")) === "native-ok\n" ? 1 : 0,
    total: 1,
    valid: true,
  }),
})
const artifacts = new Artifacts(path.join(root, "objects"))
const ota = new OTA(
  path.join(root, "ota.sqlite"),
  {
    trusted: await adapter.fingerprint(),
    scope: "mechanics",
    minimumMeanGainBps: 200,
    tests: [{ id: "native-roundtrip", total: 1 }],
    startupMs: 60_000,
    heartbeatMs: 20_000,
    probationMs: 1_000,
  },
  {
    s: await artifacts.put(
      new TextEncoder().encode("STRATEGY_V0: improve the permitted inactive partition; do not self-certify."),
    ),
    h: await artifacts.put(new TextEncoder().encode(JSON.stringify(initial))),
  },
)
state.ota = ota
const timer = setTimeout(() => {
  void Bun.write(path.join(root, "CANCEL"), "offline qualification infrastructure timeout")
}, 240_000)
try {
  const result = await supervise(root, ota, artifacts, adapter)
  await Bun.write(path.join(root, "STATUS.json"), JSON.stringify(result, null, 2))
  if (result.epoch !== 3 || !observation.resumed) throw new Error(`native OTA incomplete: ${result.stopped}`)
  const memory = path.join(root, "memory", result.active.memory.id, "data/opencode.db")
  const db = new Database(memory, { readonly: true })
  const note = db.query<{ value: string }, []>("SELECT value FROM ota_user_memory WHERE key='user-note'").get()?.value
  const migrated = db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE name='ota_memory_v1'")
    .get()!.n
  db.close()
  const passed =
    result.epoch === 3 &&
    observation.resumed &&
    !observation.errors.length &&
    result.stopped === "cancelled" &&
    note === "preserve-me" &&
    migrated === (mode === "healthy" ? 1 : 0)
  await Bun.write(
    path.join(root, "E2E.json"),
    JSON.stringify(
      {
        passed,
        mode,
        result,
        providerRequests: observation.count,
        errors: observation.errors,
        restoredOrSuccessorActuallyExecuted: observation.resumed,
        note,
        migrated,
        realModelCalls: 0,
        scope:
          "Actual full OpenCode builds, native Sessions/tools, independent evaluation, memory migration and cold-boot rollback. Scripted provider only; no performance-improvement claim.",
      },
      null,
      2,
    ),
  )
  if (!passed) throw new Error(`full native OTA qualification failed: ${result.stopped}`)
  process.stdout.write(
    JSON.stringify({ passed, mode, providerRequests: observation.count, epoch: result.epoch, note, migrated }) + "\n",
  )
} finally {
  clearTimeout(timer)
  await adapter.fence()
  ota.db.close()
  server.stop(true)
}

function quote(text: string) {
  return "'" + text.replaceAll("'", "'\\''") + "'"
}
