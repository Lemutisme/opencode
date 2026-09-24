import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { ProContract } from "@opencode-ai/schema/pro-contract"
import { Schema } from "effect"
import { runOracle, tasks } from "./pro-contract-feedback-tasks"

const repository = path.resolve(import.meta.dir, "../../..")
const sources = [
  "packages/core/src/pro-contract/replay.ts",
  "packages/core/src/pro-contract/scheduler.ts",
  "packages/core/src/session/runner/llm.ts",
  "packages/core/src/tool/contract-control.ts",
]
const bounds = { turns: 24, actions: 96, seconds: 240, attempts: 3, outputTokens: 8192, cost: 5 }
const image = "sha256:f8c373c898c983bbe5609e8b48356886d8fe852d55a8c46748fe6c8fbdd1c951"
const hash = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"

async function command(argv: string[], cwd: string, env?: NodeJS.ProcessEnv, seconds = 30) {
  const started = performance.now()
  const child = Bun.spawn(argv, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), seconds * 1000)
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timer)
  return { exit, stdout, stderr, seconds: (performance.now() - started) / 1000 }
}

async function prepare(root: string) {
  await mkdir(root, { mode: 0o700 })
  await mkdir(path.join(root, "empty"))
  const revision = await command(["git", "rev-parse", "HEAD"], repository)
  const diff = await command(["git", "diff", "--binary"], repository)
  const models = await readFile(path.join(process.env.HOME!, ".cache/opencode/models.json"))
  const catalog = JSON.parse(models.toString())
  const model = catalog.openai.models["gpt-5.6-luna"]
  if (!model?.cost) throw new Error("Cached model and accounting rates are required")
  const prior = process.env.PROCONTRACT_SCREEN_PRIOR
    ? JSON.parse(await readFile(path.join(process.env.PROCONTRACT_SCREEN_PRIOR, "results.json"), "utf8"))
    : undefined
  if (prior?.accounting.unknown) throw new Error("Prior provider accounting is unresolved")
  await writeFile(path.join(root, "models.json"), models, { mode: 0o600 })
  await writeFile(path.join(root, "working-tree.patch"), diff.stdout)
  for (const arm of ["baseline", "candidate"]) {
    const files = []
    for (const source of sources) {
      const contents =
        arm === "baseline"
          ? (await command(["git", "show", `HEAD:${source}`], repository)).stdout
          : await readFile(path.join(repository, source), "utf8")
      const destination = path.join(root, arm, source)
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, contents)
      files.push({ path: source, sha256: hash(contents) })
    }
    await writeFile(path.join(root, arm, "manifest.json"), json({ repository, files }))
  }
  const order = [
    { task: tasks[0].id, arm: "baseline", repeat: 1 },
    { task: tasks[0].id, arm: "candidate", repeat: 1 },
    { task: tasks[1].id, arm: "candidate", repeat: 1 },
    { task: tasks[1].id, arm: "baseline", repeat: 1 },
    { task: tasks[0].id, arm: "candidate", repeat: 2 },
    { task: tasks[0].id, arm: "baseline", repeat: 2 },
    { task: tasks[1].id, arm: "baseline", repeat: 2 },
    { task: tasks[1].id, arm: "candidate", repeat: 2 },
  ]
  await writeFile(
    path.join(root, "protocol.json"),
    json({
      version: 3,
      createdAt: new Date().toISOString(),
      repository,
      baseline: revision.stdout.trim(),
      patchHash: hash(diff.stdout),
      model: "openai/gpt-5.6-luna",
      variant: "max",
      modelCatalogHash: hash(models),
      rates: model.cost,
      prior: prior
        ? {
            directory: process.env.PROCONTRACT_SCREEN_PRIOR,
            cost: prior.accounting.cost,
            reason:
              "Superseded apparatus: noexec replay mount and false proxy continuation rejection; all records retained, no capability comparison admitted",
          }
        : undefined,
      image,
      bounds,
      order,
      tasks,
      scope: "Synthetic native-agent feedback/recovery screen, not ProgramBench or a leaderboard result",
      hypothesis:
        "The combined check/diagnostic interface improves independently verified delivery or reduces recovery cost",
      rivals: [
        "Both arms already recover equally well",
        "Additional checks and prompt/tool overhead make the candidate slower or more expensive",
      ],
      primary: "Intention-to-treat independent-oracle-passing authorized deliveries, all eight frozen trajectories",
      decision:
        "No promotion without repeat-consistent delivery or resource benefit and no control regression; do not replace negative trajectories",
      limitations: [
        "Two synthetic tasks do not estimate ProgramBench generalization",
        "Combined interface/diagnostic/prompt treatment does not identify each component",
        "Estimated cost uses the frozen local catalog, not a billing receipt",
        "Worker has no evaluator corpus, provider credential, other arm, or external network access",
        "Worker runtime and executor still share private state; this is not an adversarial kernel-isolation test",
        "Inference requires a newly reserved native turn; failed transports are not retried by the apparatus",
      ],
    }),
  )
  console.log(json({ prepared: root, protocolHash: hash(await readFile(path.join(root, "protocol.json"))) }))
}

type Usage = {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

function usageFrom(text: string): Usage | undefined {
  const values = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)))
  const found = values.map((value) => value.response?.usage ?? value.usage).filter(Boolean)
  return found.at(-1)
}

async function run(root: string, smoke: boolean) {
  const protocol = JSON.parse(await readFile(path.join(root, "protocol.json"), "utf8"))
  const verify = async () => {
    if (smoke) return
    const sealed = JSON.parse(await readFile(path.join(root, "sealed.json"), "utf8"))
    for (const file of sealed.files as Array<{ path: string; sha256: string }>)
      if (hash(await readFile(file.path)) !== file.sha256) throw new Error(`Frozen apparatus changed: ${file.path}`)
  }
  await verify()
  if (hash(await readFile(path.join(root, "models.json"))) !== protocol.modelCatalogHash)
    throw new Error("Frozen model catalog changed")
  if (JSON.stringify(tasks) !== JSON.stringify(protocol.tasks)) throw new Error("Frozen tasks changed")
  const started = Date.now()
  const accounting = {
    cost: smoke ? 0 : (protocol.prior?.cost ?? 0),
    input: 0,
    cached: 0,
    output: 0,
    requests: 0,
    unknown: false,
    stop: "",
  }
  const results: Array<Record<string, unknown>> = []
  const save = () =>
    writeFile(
      path.join(root, smoke ? "smoke-results.json" : "results.json"),
      json({
        protocolHash: hash(JSON.stringify(protocol, null, 2) + "\n"),
        accounting,
        results,
        elapsedSeconds: (Date.now() - started) / 1000,
      }),
    )
  const selected = smoke ? protocol.order.slice(0, 2) : protocol.order
  const upstream = process.env.OPENAI_BASE_URL
  const credential = process.env.OPENAI_API_KEY
  if (!smoke && (!upstream || !credential)) throw new Error("Existing provider configuration is required")
  for (const entry of selected) {
    const task = tasks.find((item) => item.id === entry.task)!
    const identifier = `${smoke ? "smoke-" : ""}${entry.task}-${entry.arm}-${entry.repeat}`
    const directory = path.join(root, identifier)
    await mkdir(directory, { mode: 0o700 })
    if (accounting.cost >= bounds.cost || accounting.unknown || accounting.stop) {
      const result = {
        ...entry,
        identifier,
        status:
          accounting.unknown || accounting.stop === "infrastructure" ? "not_run_infrastructure" : "not_run_budget",
        delivery: false,
        correct: false,
        cost: 0,
        modelRequests: 0,
      }
      await writeFile(path.join(directory, "result.json"), json(result))
      results.push(result)
      await save()
      continue
    }
    await verify()
    await mkdir(path.join(directory, "runtime"))
    const workspace = path.join(directory, "workspace")
    await mkdir(workspace)
    for (const file of task.files) {
      const destination = path.join(workspace, file.path)
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, file.content)
      if (file.executable) await chmod(destination, 0o755)
    }
    for (const argv of [
      ["git", "init", "-q"],
      ["git", "add", "."],
      [
        "git",
        "-c",
        "user.name=Screen",
        "-c",
        "user.email=screen@local",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "frozen task",
      ],
    ]) {
      const result = await command(argv, workspace)
      if (result.exit !== 0) throw new Error(`Fixture preparation failed: ${result.stderr}`)
    }
    const pending = new Set<Promise<void>>()
    const requests: Array<{
      index: number
      status?: number
      tools: string[]
      model: string
      reasoning: unknown
      seconds?: number
      usage?: Usage
      cost?: number
      error?: string
    }> = []
    const startCost = accounting.cost
    const network = `procontract-${crypto.randomUUID()}`
    const created = await command(["docker", "network", "create", "--internal", network], repository)
    if (created.exit !== 0) throw new Error(`Container network failed: ${created.stderr}`)
    const gateway = await command(
      ["docker", "network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", network],
      repository,
    )
    if (gateway.exit !== 0) throw new Error(`Container network inspection failed: ${gateway.stderr}`)
    const control = { url: "" }
    const password = crypto.randomUUID()
    const contractID = `pct_${crypto.randomUUID().replaceAll("-", "")}`
    const api = async (route: string, body?: unknown) => {
      const response = await fetch(`${control.url}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Basic ${btoa(`opencode:${password}`)}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok)
        throw new Error(`Control API ${route}: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
      return response.json()
    }
    const rejected: Array<{ reason: string; turnsUsed?: number }> = []
    const forwarding = { active: false }
    const proxy = Bun.serve({
      hostname: gateway.stdout.trim(),
      port: 0,
      async fetch(request) {
        if (request.method !== "POST")
          return Response.json({ error: "Only inference requests are allowed" }, { status: 400 })
        if (forwarding.active) {
          rejected.push({ reason: "Concurrent request admission" })
          accounting.stop = "infrastructure"
          return Response.json({ error: "Concurrent request admission" }, { status: 400 })
        }
        forwarding.active = true
        await Promise.all([...pending])
        if (requests.length >= bounds.turns || accounting.cost >= bounds.cost || accounting.unknown)
          return Response.json({ error: "Frozen screen budget exhausted" }, { status: 400 })
        const execution = await api(`/api/contract/${contractID}/execution`).catch(() => undefined)
        if (execution?.turnsUsed !== requests.length + 1) {
          rejected.push({
            reason: "Inference without a fresh native turn reservation",
            turnsUsed: execution?.turnsUsed,
          })
          forwarding.active = false
          accounting.stop = "infrastructure"
          return Response.json({ error: "Inference requires a fresh native turn reservation" }, { status: 400 })
        }
        const body = await request.json()
        const url = new URL(request.url)
        const responses = url.pathname.endsWith("/responses")
        if (responses)
          body.max_output_tokens = Math.min(body.max_output_tokens ?? bounds.outputTokens, bounds.outputTokens)
        if (!responses) body.max_tokens = Math.min(body.max_tokens ?? bounds.outputTokens, bounds.outputTokens)
        const ceiling =
          ((Buffer.byteLength(JSON.stringify(body)) + 4096) * protocol.rates.input +
            bounds.outputTokens * protocol.rates.output) /
          1_000_000
        if (!smoke && accounting.cost + ceiling > bounds.cost) {
          accounting.stop = "budget"
          forwarding.active = false
          return Response.json({ error: "Insufficient remaining inference budget" }, { status: 400 })
        }
        const record = {
          index: requests.length,
          tools: (body.tools ?? []).map(
            (tool: { name?: string; function?: { name?: string } }) => tool.name ?? tool.function?.name ?? "unknown",
          ),
          model: body.model,
          reasoning: body.reasoning ?? body.reasoning_effort,
        } as (typeof requests)[number]
        requests.push(record)
        forwarding.active = false
        await writeFile(path.join(directory, `request-${record.index}.json`), json(body), { mode: 0o600 })
        if (
          record.tools.includes("contract_check") !== (entry.arm === "candidate") ||
          record.model !== "gpt-5.6-luna" ||
          !record.tools.includes("contract_report_ready") ||
          (typeof record.reasoning === "string"
            ? record.reasoning
            : (record.reasoning as { effort?: string })?.effort) !== "max"
        ) {
          record.error = "Experimental request does not match the frozen arm/model"
          accounting.unknown = true
          forwarding.active = false
          return Response.json({ error: record.error }, { status: 400 })
        }
        if (smoke) {
          const tool =
            record.index === 0
              ? { name: "bash", arguments: JSON.stringify({ command: "sh ./compile.sh" }) }
              : entry.arm === "candidate" && record.index === 1
                ? { name: "contract_check", arguments: "{}" }
                : {
                    name: "contract_report_ready",
                    arguments: JSON.stringify({ summary: "Deterministic no-model apparatus probe", uncertainties: [] }),
                  }
          const item = {
            ...tool,
            type: "function_call",
            id: `fc_probe_${record.index}`,
            call_id: `call_probe_${record.index}`,
            status: "completed",
          }
          const response = {
            id: `resp_probe_${record.index}`,
            object: "response",
            model: "gpt-5.6-luna",
            created_at: Math.floor(Date.now() / 1000),
            status: "completed",
            output: [item],
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          }
          const events = [
            { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress", arguments: "" },
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: item.id,
              output_index: 0,
              delta: item.arguments,
            },
            {
              type: "response.function_call_arguments.done",
              item_id: item.id,
              output_index: 0,
              arguments: item.arguments,
            },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response },
          ]
          record.status = 200
          const text =
            events
              .map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`)
              .join("") + "data: [DONE]\n\n"
          await writeFile(path.join(directory, `probe-response-${record.index}.txt`), text)
          const audited = Bun.sleep(200)
          pending.add(audited)
          void audited.finally(() => pending.delete(audited))
          return new Response(text, { headers: { "content-type": "text/event-stream" } })
        }
        accounting.requests++
        const invoked = performance.now()
        const response = await fetch(`${upstream!.replace(/\/$/, "")}/${url.pathname.replace(/^\/v1\//, "")}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        }).catch((error) => {
          record.error = error instanceof Error ? error.message : String(error)
          accounting.unknown = true
          return Response.json({ error: "Upstream request failed; screen stopped" }, { status: 502 })
        })
        record.status = response.status
        if (!response.ok) {
          record.error ??= `Provider HTTP ${response.status}`
          accounting.unknown = true
        }
        if (!response.body) throw new Error("Provider returned no body")
        const [client, audit] = response.body.tee()
        const saved = new Response(audit)
          .text()
          .then(async (text) => {
            await writeFile(path.join(directory, `response-${record.index}.txt`), text, { mode: 0o600 })
            record.seconds = (performance.now() - invoked) / 1000
            record.usage = usageFrom(text)
            if (!record.usage) {
              if (response.ok) accounting.unknown = true
              return
            }
            const input = record.usage.input_tokens ?? record.usage.prompt_tokens ?? 0
            const output = record.usage.output_tokens ?? record.usage.completion_tokens ?? 0
            const cached =
              record.usage.input_tokens_details?.cached_tokens ?? record.usage.prompt_tokens_details?.cached_tokens ?? 0
            record.cost =
              ((input - cached) * protocol.rates.input +
                cached * protocol.rates.cache_read +
                output * protocol.rates.output) /
              1_000_000
            accounting.cost += record.cost
            accounting.input += input
            accounting.cached += cached
            accounting.output += output
          })
          .catch((error) => {
            accounting.unknown = true
            record.error = error instanceof Error ? error.message : String(error)
          })
        pending.add(saved)
        void saved.finally(() => pending.delete(saved))
        return new Response(client, {
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") ?? "text/event-stream" },
        })
      },
    })
    const env = {
      HOME: "/state/home",
      USER: "screen",
      SHELL: "/bin/bash",
      XDG_DATA_HOME: "/state/data",
      XDG_CACHE_HOME: "/state/cache",
      XDG_CONFIG_HOME: "/state/config",
      XDG_STATE_HOME: "/state/state",
      OPENAI_API_KEY: "non-secret-screen-placeholder",
      OPENAI_BASE_URL: `http://${gateway.stdout.trim()}:${proxy.port}/v1`,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_MODELS_PATH: "/models.json",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      PROCONTRACT_SCREEN_OVERLAY: "/overlay",
      PROCONTRACT_SCREEN_LOAD_LOG: "/state/loaded-sources.jsonl",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          openai: {
            options: {
              baseURL: `http://${gateway.stdout.trim()}:${proxy.port}/v1`,
              apiKey: "non-secret-screen-placeholder",
            },
          },
        },
        permission: { "*": "allow", contract_revision: "deny" },
      }),
    }
    const prefix = [
      "/usr/local/bin/bun",
      "--preload",
      "/runner/overlay.ts",
      "--conditions=browser",
      path.join(repository, "packages/opencode/src/index.ts"),
    ]
    const container = `procontract-worker-${crypto.randomUUID()}`
    const isolation = [
      "--read-only",
      `--user=${process.getuid!()}:${process.getgid!()}`,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=256",
      "--memory=2g",
      "--cpus=2",
      "--tmpfs=/tmp:rw,exec,size=256m",
    ]
    const server = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "--name",
        container,
        ...isolation,
        "--network",
        network,
        "--workdir",
        "/work",
        "--entrypoint",
        prefix[0]!,
        ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        "--mount",
        `type=bind,src=${repository},dst=${repository},readonly`,
        ...[".git", "specs", "packages/opencode/script"].flatMap((hidden) => [
          "--mount",
          `type=bind,src=${path.join(root, "empty")},dst=${path.join(repository, hidden)},readonly`,
        ]),
        "--mount",
        `type=bind,src=${process.execPath},dst=/usr/local/bin/bun,readonly`,
        "--mount",
        `type=bind,src=${path.join(import.meta.dir, "pro-contract-feedback-overlay.ts")},dst=/runner/overlay.ts,readonly`,
        "--mount",
        `type=bind,src=${path.join(root, entry.arm)},dst=/overlay,readonly`,
        "--mount",
        `type=bind,src=${path.join(root, "models.json")},dst=/models.json,readonly`,
        "--mount",
        `type=bind,src=${workspace},dst=/work`,
        "--mount",
        `type=bind,src=${path.join(directory, "runtime")},dst=/state`,
        image,
        ...prefix.slice(1),
        "serve",
        "--hostname",
        "0.0.0.0",
        "--port",
        "4096",
      ],
      {
        cwd: workspace,
        stdin: "ignore",
        stdout: Bun.file(path.join(directory, "server.stdout")),
        stderr: Bun.file(path.join(directory, "server.stderr")),
      },
    )
    const result: Record<string, unknown> = {
      ...entry,
      identifier,
      status: "apparatus_failed",
      delivery: false,
      correct: false,
    }
    try {
      const startup = Date.now()
      while (true) {
        if (!control.url) {
          const address = await command(
            [
              "docker",
              "inspect",
              "--format",
              `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
              container,
            ],
            repository,
          )
          if (address.exit === 0 && address.stdout.trim()) control.url = `http://${address.stdout.trim()}:4096`
        }
        const ready = await fetch(`${control.url}/api/contract?scope=screen`, {
          headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` },
          signal: AbortSignal.timeout(1000),
        }).then(
          (response) => response.ok,
          () => false,
        )
        if (ready) break
        if (Date.now() - startup > 30_000 || server.exitCode !== null) throw new Error("Server did not become ready")
        await Bun.sleep(250)
      }
      const admitted = Date.now()
      const issue = {
        id: contractID,
        scope: "screen",
        goal: task.brief,
        brief: task.brief,
        executionPolicy:
          "Inspect the existing implementation, preserve correct behavior, repair only what the documented task requires, and verify before handoff. Use no network or external packages.",
        location: { directory: "/work" },
        model: { providerID: "openai", id: "gpt-5.6-luna", variant: "max" },
        trigger: { type: "immediate" },
        authority: ["filesystem.read", "filesystem.write", "process.execute"],
        budget: { turns: bounds.turns, actions: bounds.actions, deadline: admitted + bounds.seconds * 1000 },
        resolution: { maxAttempts: bounds.attempts, retryDelay: 0 },
        evidence: {
          type: "principal",
          claim:
            "This exact self-contained CLI satisfies the documented behavior and the independent frozen oracle cases",
          replay: {
            checks: task.replay.checks,
            artifacts: task.replay.artifacts,
            protected: await Promise.all(
              task.replay.protectedFiles.map(async (file) => ({
                path: file,
                hash: hash(await readFile(path.join(workspace, file))),
              })),
            ),
          },
        },
      }
      await writeFile(path.join(directory, "issue.json"), json(issue))
      const receipt = await api("/api/contract", issue)
      await writeFile(path.join(directory, "issue-response.json"), json(receipt))
      result.status = "admitted"
      const sessions = new Set<string>()
      while (Date.now() - admitted < (bounds.seconds + 5) * 1000) {
        const observed = await api(`/api/contract/${contractID}`)
        const execution = await api(`/api/contract/${contractID}/execution`)
        sessions.add(execution.sessionID)
        await writeFile(path.join(directory, "contract.json"), json(observed))
        await writeFile(path.join(directory, "execution.json"), json(execution))
        result.contract = observed.data
        result.execution = execution
        result.seconds = (Date.now() - admitted) / 1000
        result.status = observed.data.status
        if (
          accounting.unknown ||
          accounting.stop ||
          ["verification", "escalated", "discharged", "released"].includes(observed.data.status)
        )
          break
        await Bun.sleep(500)
      }
      for (const sessionID of sessions) {
        const history = await api(`/api/session/${sessionID}/history`).catch((error) => ({ error: String(error) }))
        await writeFile(path.join(directory, `history-${sessionID}.json`), json(history))
      }
      result.sessionCount = sessions.size
      if (result.status === "verification") {
        const exported = path.join(directory, "runtime/exported")
        const captured = await command(
          ["docker", "exec", container, ...prefix, "contract", "export", contractID, "/state/exported"],
          workspace,
        )
        await writeFile(path.join(directory, "export.json"), json(captured))
        if (captured.exit !== 0) throw new Error("Frozen handoff export failed")
        const target = Schema.decodeUnknownSync(Schema.Struct({ target: ProContract.RecognitionTarget }))(
          JSON.parse(captured.stdout),
        ).target
        const operationID = crypto.randomUUID()
        await writeFile(path.join(directory, "recognition-request.json"), json({ operationID, expected: target }))
        await command(["docker", "pause", container], repository)
        const evaluation = [
          "docker",
          "run",
          "--rm",
          ...isolation,
          "--network=none",
          "--workdir=/work",
          "--mount",
          `type=bind,src=${exported},dst=/work`,
          "--entrypoint",
          "timeout",
          image,
          "4",
        ]
        const compiled = await command([...evaluation, "sh", "./compile.sh"], exported)
        const oracle =
          compiled.exit === 0
            ? await runOracle(task, exported, [...evaluation.slice(0, 2), "--interactive", ...evaluation.slice(2)])
            : { passed: false, cases: [] }
        await command(["docker", "unpause", container], repository)
        const report = {
          contractID,
          operationID,
          expected: target,
          revision: target.revision,
          specHash: target.specHash,
          subjectHash: target.subjectHash,
          compiled,
          oracle,
        }
        await writeFile(path.join(directory, "oracle-report.json"), json(report))
        result.correct = oracle.passed
        result.oraclePassed = oracle.cases.filter((item) => item.passed).length
        result.oracleTotal = task.oracle.length
        if (result.correct) {
          const receipt = await api(`/api/contract/${contractID}/attestation`, {
            operationID,
            expected: target,
            evidenceHash: hash(JSON.stringify(report)),
          })
          const final = await api(`/api/contract/${contractID}`)
          const quiet = await api("/api/contract/quiet?scope=screen")
          result.delivery =
            receipt.support?.valid === true && final.data.status === "discharged" && quiet.quiet === true
          result.status = final.data.status
          await writeFile(path.join(directory, "settlement.json"), json({ receipt, final, quiet }))
        }
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
      accounting.stop = "infrastructure"
    } finally {
      await command(["docker", "unpause", container], repository)
      await command(["docker", "stop", "--time=2", container], repository)
      server.kill("SIGTERM")
      const timer = setTimeout(() => server.kill("SIGKILL"), 5000)
      await server.exited
      clearTimeout(timer)
      await proxy.stop(true)
      await Promise.allSettled([...pending])
      await command(["docker", "network", "rm", network], repository)
    }
    await verify()
    const replayDirectory = path.join(directory, "runtime/data/opencode/pro-contract/replay")
    result.replayReports = (await readdir(replayDirectory).catch(() => [])).length
    result.requests = requests
    result.rejectedRequests = rejected
    result.cost = accounting.cost - startCost
    result.modelRequests = requests.length
    await writeFile(path.join(directory, "result.json"), json(result))
    results.push(result)
    await save()
    console.log(
      json({
        identifier,
        status: result.status,
        delivery: result.delivery,
        correct: result.correct,
        modelRequests: requests.length,
        cost: result.cost,
        error: result.error,
      }),
    )
    if (smoke && requests.length === 0) accounting.stop = "infrastructure"
  }
}

async function seal(root: string) {
  const smoke = JSON.parse(await readFile(path.join(root, "smoke-results.json"), "utf8"))
  if (smoke.results.length !== 2 || smoke.accounting.requests !== 0)
    throw new Error("Both no-model arm probes must finish before sealing")
  for (const result of smoke.results) {
    if (
      result.error ||
      !result.delivery ||
      result.rejectedRequests.length > 0 ||
      result.requests.length === 0 ||
      result.requests.some((request: { error?: string }) => request.error)
    )
      throw new Error("Apparatus probe failed")
    const loaded = (await readFile(path.join(root, result.identifier, "runtime/loaded-sources.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    if (sources.some((source) => !loaded.some((item) => item.path === source)))
      throw new Error("A frozen runtime module was not loaded")
    if (
      result.requests.some(
        (request: { model: string; reasoning: { effort?: string } | string }) =>
          request.model !== "gpt-5.6-luna" ||
          (typeof request.reasoning === "string" ? request.reasoning : request.reasoning?.effort) !== "max",
      )
    )
      throw new Error("Model or reasoning coordinate does not match")
  }
  const runtime = await command(
    [
      "git",
      "ls-files",
      "packages/core/src",
      "packages/opencode/src",
      "packages/server/src",
      "packages/protocol/src",
      "packages/schema/src",
      "packages/util",
      "bun.lock",
      "package.json",
    ],
    repository,
  )
  if (runtime.exit !== 0) throw new Error("Could not inventory the shared runtime")
  const files = [
    path.join(root, "protocol.json"),
    path.join(root, "models.json"),
    process.execPath,
    ...runtime.stdout
      .trim()
      .split("\n")
      .map((file) => path.join(repository, file)),
    ...["pro-contract-feedback-screen.ts", "pro-contract-feedback-overlay.ts", "pro-contract-feedback-tasks.ts"].map(
      (file) => path.join(import.meta.dir, file),
    ),
    ...["baseline", "candidate"].flatMap((arm) => [
      path.join(root, arm, "manifest.json"),
      ...sources.map((source) => path.join(root, arm, source)),
    ]),
  ]
  await writeFile(
    path.join(root, "sealed.json"),
    json({
      sealedAt: new Date().toISOString(),
      files: await Promise.all(files.map(async (file) => ({ path: file, sha256: hash(await readFile(file)) }))),
    }),
    { flag: "wx" },
  )
  console.log(json({ sealed: root }))
}

if (import.meta.main) {
  const [mode, directory] = process.argv.slice(2)
  if (!directory || !["prepare", "smoke", "seal", "run"].includes(mode ?? ""))
    throw new Error("Usage: pro-contract-feedback-screen.ts prepare|smoke|seal|run OUTPUT_DIRECTORY")
  const root = path.resolve(directory)
  if (mode === "prepare") await prepare(root)
  if (mode === "smoke" || mode === "run") await run(root, mode === "smoke")
  if (mode === "seal") await seal(root)
}
