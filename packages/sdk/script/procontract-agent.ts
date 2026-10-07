// Headless ProContract agent for external orchestrators: one native V2 Session per process, JSON lines out
// (specs/procontract-agent.md). The Contract is scoped to this run. No issuer, ledger or attestation lives here, and
// a delivery is permission to submit, never proof of correctness: the orchestrator's own verifier stays the judge.
import fs from "node:fs/promises"
import { spawn } from "node:child_process"
import { Deferred, Effect, Fiber, Schema, Semaphore, Stream } from "effect"
import type { Plugin } from "@opencode/plugin/effect/plugin"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { OpenCode, Tool } from "../src/effect"

declare const PROCONTRACT_AGENT_VERSION: string
const VERSION = typeof PROCONTRACT_AGENT_VERSION === "string" ? PROCONTRACT_AGENT_VERSION : "dev"
// OpenCode offers patch to GPT models and edit/write to the rest (tool/plugin/patch.ts); admitting all three lets it choose.
const TOOLS = ["glob", "grep", "read", "patch", "edit", "write", "shell"]
const MUTATING = new Set(["patch", "shell", "edit", "write"])
const SHELL_TIMEOUT = 600_000
const OUTPUT_LIMIT = 64 * 1024
const MCP_STARTUP = 60_000
const CONTINUE =
  'The session stopped, but delivery is still open and no completion was accepted. Continue the work and deliver, or call contract_delivery(action="blocked", reason=...) with the concrete reason you cannot.'

const Check = Schema.Struct({
  title: Schema.String,
  argv: Schema.NonEmptyArray(Schema.String),
  timeout_seconds: Schema.optional(Schema.Number),
})
const Config = Schema.Struct({
  workspace: Schema.String,
  state: Schema.String,
  system_prompt: Schema.optional(Schema.String),
  deadline_seconds: Schema.optional(Schema.Number),
  model: Schema.Struct({
    api: Schema.Literals(["openai-responses", "openai-chat", "anthropic-messages"]),
    base_url: Schema.String,
    api_key_env: Schema.String,
    id: Schema.String,
    reasoning_effort: Schema.optional(Schema.String),
    context: Schema.optional(Schema.Int),
    output: Schema.optional(Schema.Int),
  }),
  mcp: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        url: Schema.String,
        bearer_token_env: Schema.optional(Schema.String),
        timeout_seconds: Schema.optional(Schema.Number),
      }),
    ),
  ),
  tools: Schema.optional(Schema.Array(Schema.String)),
  delivery: Schema.optional(
    Schema.Struct({
      submit_tools: Schema.optional(Schema.Array(Schema.String)),
      finish_tools: Schema.optional(Schema.Array(Schema.String)),
      checks: Schema.optional(Schema.Array(Check)),
      max_continuations: Schema.optional(Schema.Int),
    }),
  ),
})
type Config = typeof Config.Type

// One flat object: Anthropic refuses a tool input schema with a top-level oneOf/anyOf, which a union would produce.
const Action = Schema.Struct({
  action: Schema.Literals(["status", "check", "handoff", "blocked"]),
  summary: Schema.optional(Schema.String).annotate({
    description: "handoff: what was done and what remains uncertain",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "blocked: the concrete reason the work cannot finish",
  }),
})

type Delivery = { state: "open" | "delivered" | "finished" | "blocked"; reason?: string }
type CheckResult = { title: string; passed: boolean; detail?: string }
type Tokens = { input: number; output: number; reasoning: number; cache_read: number; cache_write: number }

const emit = (line: Record<string, unknown>) => process.stdout.write(JSON.stringify(line) + "\n")
// stdout carries only the JSON lines; libraries that log through the console (the MCP client does) go to stderr.
console.log = console.error
console.info = console.error
console.debug = console.error

if (process.argv[2] === "--version") {
  process.stdout.write(VERSION + "\n")
  process.exit(0)
}
const args = parseArgs(process.argv.slice(2))
const config = await readConfig(args.config)
const prompt = args.promptFile ? await Bun.file(args.promptFile).text() : args.prompt
if (!prompt?.trim()) fail("A prompt is required: --prompt-file FILE or -- PROMPT")
const model = provider(config.model)
const submit = new Set(config.delivery?.submit_tools ?? [])
const finish = new Set(config.delivery?.finish_tools ?? [])
const checks = config.delivery?.checks ?? []
await fs.mkdir(`${config.state}/config`, { recursive: true })
// The host config carries the model key and MCP tokens; neither the shell tool nor the checks may inherit them.
const content = JSON.stringify(settings())
for (const name of [
  config.model.api_key_env,
  ...Object.values(config.mcp ?? {}).flatMap((server) => server.bearer_token_env ?? []),
])
  delete process.env[name]

const delivery: Delivery = { state: "open" }
// No prices are configured, so cost is unknown here; the orchestrator's model proxy knows the spend.
const totals = { tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 }, cost_usd: null }
const names = new Map<string, string>()
let sessionID: Session.ID | undefined
let lastSeq = -1
let finalText = ""
let failed = false
let ending: { code: number; reason: string } | undefined
let interrupt = () => {}
const end = (code: number, reason: string) => {
  ending ??= { code, reason }
  interrupt()
}
process.on("SIGTERM", () => end(143, "terminated"))
process.on("SIGINT", () => end(143, "interrupted"))
const deadline = config.deadline_seconds
  ? setTimeout(() => end(124, "deadline reached"), config.deadline_seconds * 1000)
  : undefined

const program = Effect.gen(function* () {
  const host = yield* OpenCode.create({
    app: { name: "procontract-agent" },
    database: { path: `${config.state}/session.sqlite` },
    events: { persist: true },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
    log: { level: "warn", emit: (entry) => process.stderr.write(`[${entry.level}] ${entry.message}\n`) },
    config: { directory: `${config.state}/config`, project: false, content },
  })
  const agent = profile()
  yield* host.plugin(agent.plugin)
  // A process killed mid-turn leaves its execution claimed; startup recovery would resume it beside this run.
  const active = yield* host.sessions.active()
  for (const id of Object.keys(active)) yield* host.sessions.interrupt({ sessionID: Session.ID.make(id) })
  const session = args.session
    ? yield* host.sessions.get({ sessionID: Session.ID.make(args.session) })
    : yield* host.sessions.create({
        title: "procontract-agent",
        location: { directory: AbsolutePath.make(config.workspace) },
        model: {
          providerID: Provider.ID.make(model.id),
          id: Model.ID.make(config.model.id),
          ...(model.variant ? { variant: Model.VariantID.make(model.variant.id) } : {}),
        },
      })
  const id = session.id
  sessionID = id
  interrupt = () => void Effect.runPromise(host.sessions.interrupt({ sessionID: id })).catch(() => undefined)
  if (args.session)
    yield* Stream.runForEach(host.sessions.log({ sessionID: id }), (event) => Effect.sync(() => skip(event)))
  emit({ type: "session", session_id: id, resumed: !!args.session, version: VERSION, model: config.model.id })
  const follower = yield* Stream.runForEach(host.sessions.log({ sessionID: id, follow: true }), (event) =>
    Effect.sync(() => project(event)),
  ).pipe(Effect.forkScoped)
  // Location services start lazily and MCP servers register their tools asynchronously; the first prompt must already
  // see the orchestrator's tools, so connect them now and wait for their registration.
  for (let waited = 0; ; waited += 100) {
    const listed = yield* host.mcp.list({ location: { directory: config.workspace } })
    const statuses = new Map(listed.data.map((server) => [server.name, server.status]))
    const pending = Object.keys(config.mcp ?? {}).filter((name) => statuses.get(name)?.status !== "connected")
    const broken = pending.flatMap((name) => {
      const status = statuses.get(name)
      return status?.status === "failed" ? [`${name}: ${status.error}`] : []
    })
    if (broken.length) return yield* Effect.die(new Error(`MCP servers failed to connect: ${broken.join("; ")}`))
    if (!pending.length) break
    if (waited >= MCP_STARTUP) return yield* Effect.die(new Error(`MCP servers did not connect: ${pending.join(", ")}`))
    yield* Effect.sleep(100)
  }
  yield* agent.ready
  if (ending) return
  yield* host.sessions.prompt({
    sessionID: id,
    text: [prompt, instructions(), config.system_prompt ?? ""].join("\n\n"),
  })
  for (let count = 1; ; count++) {
    yield* host.sessions.wait({ sessionID: id })
    if (ending || failed || delivery.state !== "open") break
    if (count > (config.delivery?.max_continuations ?? 10)) break
    emit({ type: "continuation", count })
    yield* host.sessions.prompt({ sessionID: id, text: CONTINUE })
  }
  // The follower may trail the durable log; project whatever it has not reached yet.
  yield* Fiber.interrupt(follower)
  yield* Stream.runForEach(host.sessions.log({ sessionID: id }), (event) => Effect.sync(() => project(event)))
})

const exit = await Effect.runPromise(Effect.scoped(program).pipe(Effect.exit))
clearTimeout(deadline)
if (exit._tag === "Failure") {
  failed = true
  emit({ type: "error", message: String(exit.cause) })
}
const code = ending?.code ?? (failed ? 1 : 0)
emit({
  type: "result",
  session_id: sessionID ?? null,
  delivery: { state: delivery.state, ...(delivery.reason ? { reason: delivery.reason } : {}) },
  final_text: finalText,
  usage: totals,
  exit: code,
  ...(ending ? { ended: ending.reason } : {}),
})
process.exit(code)

// The ProContract profile: admitted built-in tools and MCP servers only, a delivery tool, and a gate that runs the
// preflight checks before any submit tool reaches the orchestrator.
function profile() {
  const lock = Semaphore.makeUnsafe(1)
  const admitted = new Set(config.tools ?? TOOLS)
  const servers = new Set(Object.keys(config.mcp ?? {}).map(namespace))
  const preflight = (input: unknown) => lock.withPermit(Effect.promise(() => runChecks(input)))
  const registry = Deferred.makeUnsafe<Parameters<Plugin["effect"]>[0]["tool"]>()
  const ready = Effect.gen(function* () {
    const tools = yield* Deferred.await(registry)
    for (let waited = 0; ; waited += 100) {
      const listed = new Set((yield* tools.list()).map((tool) => tool.options?.namespace))
      const missing = [...servers].filter((server) => !listed.has(server))
      if (!missing.length) return
      if (waited >= MCP_STARTUP)
        return yield* Effect.die(new Error(`MCP servers exposed no tools: ${missing.join(", ")}`))
      yield* Effect.sleep(100)
    }
  })
  const plugin: Plugin = {
    id: "procontract.agent",
    effect: (context) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(registry, context.tool)
        yield* context.tool.transform((editor) => {
          for (const tool of editor.list()) {
            if (tool.options?.namespace !== undefined && servers.has(tool.options.namespace)) {
              editor.update(tool.id, (current) => {
                current.options = {
                  namespace: current.options?.namespace,
                  permission: current.options?.permission,
                  codemode: false,
                }
              })
              continue
            }
            if (!admitted.has(tool.name)) {
              editor.remove(tool.id)
              continue
            }
            editor.update(tool.id, (current) => {
              current.options = {
                namespace: current.options?.namespace,
                permission: current.options?.permission,
                codemode: false,
              }
              const execute = current.execute
              current.execute = (input, call) => {
                // Background shells would outlive the delivery they belong to.
                const shaped =
                  tool.name === "shell"
                    ? { ...input, background: false, timeout: Math.min(input.timeout || SHELL_TIMEOUT, SHELL_TIMEOUT) }
                    : input
                return MUTATING.has(tool.name) ? lock.withPermit(execute(shaped, call)) : execute(shaped, call)
              }
            })
          }
          editor.add({
            name: "contract_delivery",
            description:
              "Inspect delivery status, run the public preflight checks, hand off (only when no submit tool is configured), or report a concrete blocking reason. Passing checks guide your work; they never prove correctness.",
            input: Action,
            options: { codemode: false },
            execute: (action) =>
              Effect.gen(function* () {
                if (action.action === "status")
                  return { content: JSON.stringify({ ...delivery, checks: checks.map((check) => check.title) }) }
                if (action.action === "blocked") {
                  if (!action.reason?.trim()) return yield* new Tool.Error({ message: "A concrete reason is required" })
                  settle({ state: "blocked", reason: action.reason })
                  return { content: JSON.stringify(delivery) }
                }
                if (delivery.state !== "open")
                  return yield* new Tool.Error({ message: `Delivery is already ${delivery.state} in this run` })
                const results = yield* preflight({})
                if (action.action === "check") return { content: JSON.stringify({ state: "open", checks: results }) }
                if (submit.size)
                  return yield* new Tool.Error({ message: `Deliver by calling ${[...submit].join(" or ")}` })
                if (!action.summary?.trim()) return yield* new Tool.Error({ message: "A handoff summary is required" })
                if (results.some((result) => !result.passed))
                  return {
                    content: JSON.stringify({ state: "open", reason: "Preflight checks failed", checks: results }),
                  }
                settle({ state: "delivered" })
                return { content: JSON.stringify({ ...delivery, checks: results, authoritativeCompletion: false }) }
              }),
          })
        })
        yield* context.tool.hook("execute.before", (event) =>
          Effect.gen(function* () {
            if (!submit.has(event.tool)) return
            if (delivery.state !== "open")
              return yield* new Tool.Error({ message: `Delivery is already ${delivery.state} in this run` })
            const results = yield* preflight(event.input)
            emit({ type: "delivery", state: "open", checks: results })
            const failures = results.filter((result) => !result.passed)
            if (failures.length)
              return yield* new Tool.Error({
                message: `Preflight checks failed, so nothing was submitted. Fix them and submit again.\n${failures
                  .map((result) => `- ${result.title}: ${result.detail ?? "failed"}`)
                  .join("\n")}`,
              })
          }),
        )
        yield* context.tool.hook("execute.after", (event) =>
          Effect.sync(() => {
            if (event.status !== "completed" || delivery.state !== "open") return
            if (submit.has(event.tool)) settle({ state: "delivered" })
            if (finish.has(event.tool)) settle({ state: "finished" })
          }),
        )
      }),
  }
  return { plugin, ready }
}

function settle(next: Delivery) {
  delivery.state = next.state
  delivery.reason = next.reason
  emit({ type: "delivery", ...delivery })
}

function instructions() {
  const titles = checks.map((check) => check.title).join("; ")
  return [
    "Delivery is not authorized by a final text response or by a passing self-written check.",
    submit.size
      ? `You deliver by calling ${[...submit].join(" or ")}. The preflight checks run first; if one fails the call is rejected and you see why.`
      : 'When the work is ready, call contract_delivery(action="handoff", summary=...). The preflight checks run first; if one fails the handoff is refused.',
    titles ? `Preflight checks: ${titles}. Run them at any time with contract_delivery(action="check").` : "",
    finish.size ? `Calling ${[...finish].join(" or ")} ends this run without a delivery.` : "",
    'If you cannot finish, call contract_delivery(action="blocked", reason=...) with a concrete reason instead of claiming completion. Stopping without a delivery does not end the run: you will be asked to continue. A delivery is permission to submit for independent evaluation, never proof of correctness.',
  ]
    .filter(Boolean)
    .join("\n")
}

// One durable log event as at most one output line. Replayed events (seq at or below the last one) are dropped.
function project(event: LogEvent) {
  if (skip(event)) return
  if (event.type === "session.text.ended") {
    finalText = event.data.text
    return emit({ type: "text", text: event.data.text })
  }
  if (event.type === "session.reasoning.ended") return emit({ type: "reasoning", text: event.data.text })
  if (event.type === "session.tool.input.started") return void names.set(event.data.id, event.data.name)
  if (event.type === "session.tool.called")
    return emit({ type: "tool_call", id: event.data.id, name: names.get(event.data.id), input: event.data.input })
  if (event.type === "session.tool.success")
    return emit({ type: "tool_result", ...call(event.data.id), ok: true, output: text(event.data.content) })
  if (event.type === "session.tool.failed")
    return emit({
      type: "tool_result",
      ...call(event.data.id),
      ok: false,
      output: [event.data.error.message, text(event.data.content ?? [])].filter(Boolean).join("\n"),
    })
  if (event.type === "session.step.ended") return usage("step", event.data.tokens)
  if (event.type === "session.usage.recorded") return usage(event.data.source, event.data.tokens)
  // A step the orchestrator's own SIGTERM interrupted is how a delivered run normally ends, not an error.
  if (event.type === "session.step.failed")
    return ending ? undefined : emit({ type: "error", message: event.data.error.message })
  if (event.type === "session.execution.failed") {
    failed = true
    return emit({ type: "error", message: event.data.error.message })
  }
}

type LogEvent = Stream.Success<ReturnType<OpenCode.Interface["sessions"]["log"]>>

function skip(event: LogEvent) {
  if (!("durable" in event) || !event.durable) return event.type === "log.synced"
  if (event.durable.seq <= lastSeq) return true
  lastSeq = event.durable.seq
  return false
}

function call(id: string) {
  return { id, name: names.get(id) }
}

function text(content: ReadonlyArray<{ type: string; text?: string; mime?: string }>) {
  const joined = content.map((part) => (part.type === "text" ? part.text : `[${part.mime ?? "file"}]`)).join("\n")
  return joined.length > OUTPUT_LIMIT ? joined.slice(0, OUTPUT_LIMIT) + "\n[truncated]" : joined
}

function usage(
  source: string,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
) {
  const step: Tokens = {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cache_read: tokens.cache.read,
    cache_write: tokens.cache.write,
  }
  for (const key of Object.keys(step) as Array<keyof Tokens>) totals.tokens[key] += step[key]
  emit({ type: "usage", source, tokens: step, cost_usd: null })
  // An orchestrator that kills this process still finds the totals.
  if (sessionID) void Bun.write(`${config.state}/usage-${sessionID}.json`, JSON.stringify(totals))
}

function settings() {
  return {
    model: `${model.id}/${config.model.id}`,
    // Local model discovery would probe ports on this host every 30 seconds; this run has exactly one endpoint.
    plugins: ["-opencode.provider.ollama", "-opencode.provider.lmstudio", "-opencode.provider.vllm"],
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "execute", resource: "*", effect: "deny" },
    ],
    providers: {
      [model.id]: {
        package: model.package,
        canonical: model.id,
        env: [],
        settings: model.settings,
        models: {
          [config.model.id]: {
            limit: { context: config.model.context ?? 200_000, output: config.model.output ?? 32_000 },
            capabilities: { tools: true, reasoning: !!model.variant, input: ["text"], output: ["text"] },
            ...(model.variant ? { variants: [model.variant] } : {}),
          },
        },
      },
    },
    mcp: {
      servers: Object.fromEntries(
        Object.entries(config.mcp ?? {}).map(([name, server]) => [
          name,
          {
            type: "remote",
            url: server.url,
            oauth: false,
            codemode: false,
            timeout: { execution: (server.timeout_seconds ?? 3300) * 1000 },
            ...(server.bearer_token_env
              ? { headers: { Authorization: `Bearer ${requireEnv(server.bearer_token_env)}` } }
              : {}),
          },
        ]),
      ),
    },
  }
}

// The one model this run may use, through the API its endpoint speaks. Reasoning effort is the model's only variant.
function provider(input: Config["model"]) {
  const key = requireEnv(input.api_key_env)
  const effort = input.reasoning_effort
  if (input.api === "anthropic-messages")
    return {
      id: "anthropic",
      package: "@opencode/ai/providers/anthropic",
      settings: { baseURL: input.base_url, authToken: key },
      variant: effort
        ? { id: effort, settings: { thinking: { type: "adaptive", display: "summarized" }, effort } }
        : undefined,
    }
  if (input.api === "openai-chat")
    return {
      id: "openai-compatible",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: input.base_url, apiKey: key },
      variant: effort ? { id: effort, body: { reasoning_effort: effort } } : undefined,
    }
  return {
    id: "openai",
    package: "@opencode/ai/providers/openai",
    settings: { baseURL: input.base_url, apiKey: key, transport: "http" },
    variant: effort ? { id: effort, body: { reasoning: { effort } } } : undefined,
  }
}

// Every check runs in the workspace as its own process group, bounded, with the submit call's input in its env.
async function runChecks(input: unknown): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const check of checks) {
    const result = await run(
      [...check.argv],
      { ...process.env, PROCONTRACT_SUBMIT_INPUT: JSON.stringify(input ?? {}) },
      (check.timeout_seconds ?? 600) * 1000,
    )
    results.push({
      title: check.title,
      passed: result.exit === 0,
      ...(result.exit === 0 ? {} : { detail: result.tail.trim() || `exit status ${result.exit}` }),
    })
  }
  return results
}

async function run(argv: string[], env: NodeJS.ProcessEnv, timeout: number) {
  const child = spawn(argv[0], argv.slice(1), {
    cwd: config.workspace,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const output: Buffer[] = []
  const collect = (chunk: Buffer) => void output.push(chunk)
  child.stdout.on("data", collect)
  child.stderr.on("data", collect)
  const kill = () => {
    if (!child.pid) return
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {}
  }
  const timer = setTimeout(kill, timeout)
  const exit = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(127))
    child.once("close", (code) => resolve(code ?? 137))
  })
  clearTimeout(timer)
  kill()
  return { exit, tail: Buffer.concat(output).toString("utf8").slice(-4000) }
}

function namespace(server: string) {
  return server.replace(/[^a-zA-Z0-9_-]/g, "_")
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) fail(`Environment variable ${name} is not set`)
  return value
}

async function readConfig(file: string) {
  const text = await Bun.file(file)
    .text()
    .catch(() => fail(`Cannot read config ${file}`))
  const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(Config))(text, { onExcessProperty: "error" })
  if (decoded._tag === "Failure") fail(`Invalid config ${file}: ${decoded.cause}`)
  return decoded.value
}

function parseArgs(argv: string[]) {
  const command = argv[0]
  if (command !== "run" && command !== "resume") fail("Usage: procontract-agent run|resume --config FILE ...")
  const split = argv.indexOf("--")
  const flags = split < 0 ? argv.slice(1) : argv.slice(1, split)
  const flag = (name: string) => {
    const index = flags.indexOf(name)
    return index < 0 ? undefined : flags[index + 1]
  }
  const config = flag("--config")
  if (!config) fail("--config FILE is required")
  const session = flag("--session")
  if (command === "resume" && !session) fail("resume requires --session ID")
  return {
    config,
    session: command === "resume" ? session : undefined,
    promptFile: flag("--prompt-file"),
    prompt: split < 0 ? undefined : argv.slice(split + 1).join(" "),
  }
}

function fail(message: string): never {
  emit({ type: "error", message })
  process.exit(2)
}
