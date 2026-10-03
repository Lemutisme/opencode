import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProposalMetadata, proposalCheck, proposalKind, proposalOperation } from "./rsi-proposal-check"
import { Schema } from "effect"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await fs.chmod(path.join(directory, "runtime/node_modules/fixed"), 0o755).catch(() => undefined)
      await fs.rm(directory, { recursive: true, force: true })
    }),
  )
})
const env = { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }

test("only explicit host metadata selects proposal checks, never an h/s artifact basename", () => {
  expect(proposalKind({ artifact: "h" })).toBeUndefined()
  expect(proposalKind({ artifact: "s" })).toBeUndefined()
  expect(
    proposalKind({ artifact: "h", proposal: { kind: "h", entry: "entry.ts", parentSource: "a".repeat(64) } }),
  ).toBe("h")
  expect(proposalKind({ artifact: "s", proposal: { kind: "s" } })).toBe("s")
  expect(() => proposalKind({ artifact: "h", proposal: { kind: "s" } })).toThrow("conflicts")
  expect(() => proposalKind({ artifact: "s", mode: "programbench", proposal: { kind: "s" } })).toThrow("conflicts")
  expect(() => Schema.decodeUnknownSync(ProposalMetadata)({ kind: "h" })).toThrow()
})

async function command(argv: string[], cwd: string) {
  const result = await proposalOperation(argv, {
    cwd,
    env,
    deadline: Date.now() + 60000,
    signal: new AbortController().signal,
  })
  if (result.exit !== 0) throw new Error(result.stderr)
  return result.stdout
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-check-"))
  directories.push(root)
  const parent = path.join(root, "parent")
  const source = path.join(root, "source")
  const runtime = path.join(root, "runtime")
  await fs.mkdir(parent)
  await fs.mkdir(path.join(runtime, "node_modules/fixed"), { recursive: true })
  await fs.writeFile(path.join(runtime, "node_modules/fixed/index.js"), "export const fixed = 7\n", { mode: 0o444 })
  await fs.chmod(path.join(runtime, "node_modules/fixed"), 0o555)
  await fs.writeFile(
    path.join(parent, "entry.ts"),
    "import { value } from './value'; import { fixed } from './node_modules/fixed/index.js'; console.log(value + fixed)\n",
  )
  await fs.writeFile(path.join(parent, "value.ts"), "export const value = 1\n")
  await command(["tar", "-cf", path.join(root, "parent.tar"), "-C", parent, "."], root)
  await fs.cp(parent, source, { recursive: true })
  await command(["git", "-c", "core.hooksPath=/dev/null", "init", "-q"], source)
  await command(["git", "-c", "core.hooksPath=/dev/null", "add", "--all"], source)
  await command(
    [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-qm",
      "parent",
    ],
    source,
  )
  const options = {
    kind: "h" as const,
    artifact: path.join(root, "h"),
    source,
    state: path.join(root, "checks"),
    runtime,
    bun: process.execPath,
    parentArchive: path.join(root, "parent.tar"),
    metadata: {
      kind: "h" as const,
      entry: "entry.ts",
      parentSource: Bun.SHA256.hash(await Bun.file(path.join(root, "parent.tar")).bytes(), "hex"),
    },
    deadline: Date.now() + 120000,
    signal: new AbortController().signal,
    standing: async () => {},
  }
  return {
    root,
    source,
    options,
    export: async () =>
      fs.writeFile(
        options.artifact,
        await command(["git", "-c", "core.hooksPath=/dev/null", "diff", "--binary", "HEAD"], source),
      ),
  }
}

test("real Bun rejects the historical duplicate-binding pattern, then accepts repair in the same allocation", async () => {
  const input = await fixture()
  const check = await proposalCheck(input.options)
  await fs.writeFile(
    path.join(input.source, "value.ts"),
    "export const value = [1].flatMap((value) => { const value = 2; return value })\n",
  )
  await input.export()
  const rejected = await check()
  expect(rejected).toMatchObject({
    ok: false,
    phase: "compile",
    authoritativeCompletion: false,
    performanceEvaluated: false,
    deadline: input.options.deadline,
  })
  expect(rejected.diagnostics).toContain('"value" has already been declared')
  await fs.writeFile(path.join(input.source, "value.ts"), "export const value = 2\n")
  await input.export()
  const accepted = await check()
  expect(accepted.ok).toBe(true)
  expect(accepted.entry).toBe("entry.ts")
  expect(accepted.bundleHash).toMatch(/^[a-f0-9]{64}$/)
  expect(accepted.deadline).toBe(rejected.deadline)
  expect(await Bun.file(path.join(input.options.runtime, "node_modules/fixed/index.js")).text()).toBe(
    "export const fixed = 7\n",
  )
  expect((await fs.stat(path.join(input.options.runtime, "node_modules/fixed/index.js"))).mode & 0o222).toBe(0)
})

test("missing new files are refused before compilation and a complete patch is accepted", async () => {
  const input = await fixture()
  const check = await proposalCheck(input.options)
  await fs.writeFile(path.join(input.source, "entry.ts"), "import { added } from './added'; console.log(added)\n")
  await fs.writeFile(path.join(input.source, "added.ts"), "export const added = 42\n")
  await input.export()
  expect(await check()).toMatchObject({ ok: false, phase: "binding" })
  expect((await check()).diagnostics).toContain("added.ts")
  await command(["git", "-c", "core.hooksPath=/dev/null", "add", "-N", "added.ts"], input.source)
  await input.export()
  expect((await check()).ok).toBe(true)
})

test("a previous successful check cannot accept stale patch bytes or a false parent", async () => {
  const input = await fixture()
  const check = await proposalCheck(input.options)
  await fs.writeFile(path.join(input.source, "value.ts"), "export const value = 2\n")
  await input.export()
  const accepted = await check()
  expect(accepted.ok).toBe(true)
  await fs.writeFile(path.join(input.source, "value.ts"), "export const value = 3\n")
  const stale = await check()
  expect(stale).toMatchObject({ ok: false, phase: "binding", artifactHash: accepted.artifactHash })
  const other = await proposalCheck({
    ...input.options,
    metadata: { ...input.options.metadata, parentSource: "f".repeat(64) },
  })
  expect(await other()).toMatchObject({ ok: false, phase: "parent" })
  await fs.writeFile(input.options.artifact, "not a git patch")
  expect(await check()).toMatchObject({ ok: false, phase: "patch" })
})

test("source dependency edits and escaping source links cannot become local success receipts", async () => {
  const input = await fixture()
  const check = await proposalCheck(input.options)
  await fs.writeFile(path.join(input.source, "value.ts"), "export const value = 2\n")
  await fs.mkdir(path.join(input.source, "node_modules"))
  await fs.writeFile(path.join(input.source, "node_modules/extra.ts"), "not a mutable supply")
  await command(["git", "-c", "core.hooksPath=/dev/null", "add", "-N", "node_modules/extra.ts"], input.source)
  await input.export()
  expect(await check()).toMatchObject({ ok: false, phase: "patch" })
  await fs.symlink("/etc/passwd", path.join(input.source, "escape"))
  expect((await check()).diagnostics).toContain("escapes")
})

test("S validates exact UTF-8 bytes, nonempty/NUL/bounds and refuses symlink artifacts", async () => {
  const input = await fixture()
  const file = path.join(input.root, "s")
  const check = await proposalCheck({ ...input.options, kind: "s", artifact: file, metadata: { kind: "s" } })
  await fs.writeFile(file, "A complete strategy.\n")
  expect((await check()).ok).toBe(true)
  for (const bytes of [
    Buffer.from("  \n"),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("no\0nul"),
    Buffer.alloc(65537, 65),
  ]) {
    await fs.writeFile(file, bytes)
    expect((await check()).ok).toBe(false)
  }
  await fs.unlink(file)
  await fs.symlink(input.options.parentArchive, file)
  expect((await check()).ok).toBe(false)
})

test("cancelled and expired checks never renew the original deadline", async () => {
  const input = await fixture()
  const controller = new AbortController()
  const check = await proposalCheck({ ...input.options, signal: controller.signal })
  controller.abort()
  await expect(check()).rejects.toThrow()
  const expired = await proposalCheck({ ...input.options, deadline: Date.now() - 1 })
  await expect(expired()).rejects.toThrow("deadline")
})

test("local operation cancellation kills and acknowledges the whole actual child group", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-check-process-"))
  directories.push(root)
  const controller = new AbortController()
  const pending = proposalOperation(["/bin/sh", "-c", "sleep 30 & echo $! > descendant; wait"], {
    cwd: root,
    env,
    deadline: Date.now() + 60000,
    signal: controller.signal,
  }).then(
    () => undefined,
    (error: unknown) => error,
  )
  const until = Date.now() + 10000
  while (!(await Bun.file(path.join(root, "descendant")).exists())) {
    if (Date.now() >= until) throw new Error("actual descendant did not start")
    await Bun.sleep(10)
  }
  const pid = Number(await Bun.file(path.join(root, "descendant")).text())
  controller.abort()
  expect(await pending).toBeInstanceOf(Error)
  const state = await fs.readFile(`/proc/${pid}/stat`, "utf8").then(
    (value) =>
      value
        .slice(value.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/)[0],
    () => "gone",
  )
  expect(["gone", "Z", "X"]).toContain(state)
})

test("a successfully exited parent cannot leave a background descendant alive", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-check-background-"))
  directories.push(root)
  const result = await proposalOperation(["/bin/sh", "-c", "sleep 30 & echo $! > descendant; exit 0"], {
    cwd: root,
    env,
    deadline: Date.now() + 60000,
    signal: new AbortController().signal,
  })
  expect(result.exit).toBe(0)
  const pid = Number(await Bun.file(path.join(root, "descendant")).text())
  const state = await fs.readFile(`/proc/${pid}/stat`, "utf8").then(
    (value) =>
      value
        .slice(value.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/)[0],
    () => "gone",
  )
  expect(["gone", "Z", "X"]).toContain(state)
})

const native =
  process.env.OPENCODE_RSI_CHECK_RELEASE &&
  process.env.OPENCODE_RSI_CHECK_GATEWAY &&
  process.env.OPENCODE_RSI_CHECK_OUTPUT
test.skipIf(!native)(
  "real native SDK rejects a malformed H locally, repairs and hands off under one original admission",
  async () => {
    const { RSINative } = await import("./rsi-native")
    const { RSIRuntime } = await import("./rsi-runtime")
    const { OTA, hash } = await import("../../core/script/ota-rsi")
    const { Artifacts } = await import("../../core/script/ota-supervisor")
    const root = path.resolve(process.env.OPENCODE_RSI_CHECK_OUTPUT!)
    await fs.mkdir(root, { mode: 0o700 })
    const release = await RSIRuntime.release(process.env.OPENCODE_RSI_CHECK_RELEASE!)
    const requests: unknown[] = []
    const errors: string[] = []
    const added = path.posix.join(path.posix.dirname(release.entry), "rsi-check-fixture.ts")
    const fixture = Bun.serve({
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
        const step = requests.length
        requests.push(body)
        await Bun.write(path.join(root, "REQUESTS.json"), JSON.stringify(requests, null, 2))
        const last = JSON.stringify(
          body.input.filter((item) => item.type === "function_call_output").at(-1) ?? {},
        ).replaceAll("\\", "")
        if (
          (step === 2 && !last.includes('"ok":false')) ||
          (step === 3 && !last.includes('"submitted":false')) ||
          (step === 5 && !last.includes('"ok":true')) ||
          (step === 6 && !/"submitted":"[a-f0-9]{64}"/.test(last)) ||
          step > 6
        ) {
          errors.push(`unexpected scripted check boundary at ${step}: ${last.slice(-300)}`)
          return new Response(errors.at(-1), { status: 409 })
        }
        const command =
          step === 0
            ? `set -eu\npython3 - <<'PY'\nfrom pathlib import Path\np=Path('/candidate/source') / ${JSON.stringify(release.entry)}\np.write_text('import "./rsi-check-fixture"\\n'+p.read_text())\n(Path('/candidate/source') / ${JSON.stringify(added)}).write_text('export const result = [1].flatMap((value) => { const value = 2; return value })\\n')\nPY\ngit -C /candidate/source add -N -- ${JSON.stringify(added)}\ngit -C /candidate/source diff --binary HEAD > /candidate/h`
            : `set -eu\npython3 - <<'PY'\nfrom pathlib import Path\n(Path('/candidate/source') / ${JSON.stringify(added)}).write_text('export const result = [1,2].flatMap((value) => [value])\\n')\nPY\ngit -C /candidate/source diff --binary HEAD > /candidate/h`
        const name = step === 0 || step === 3 ? "shell" : step === 1 || step === 4 ? "rsi_check" : "rsi_handoff"
        const args =
          name === "shell"
            ? { command, workdir: "/candidate", timeout: 120000 }
            : name === "rsi_check"
              ? {}
              : { summary: "Scripted local compile feedback qualification; no task performance claim." }
        const item =
          step === 6
            ? {
                type: "message",
                id: "fixture_answer",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "Checked proposal submitted.", annotations: [] }],
              }
            : {
                type: "function_call",
                id: `fc_${step}`,
                call_id: `call_${step}`,
                name,
                arguments: JSON.stringify(args),
                status: "completed",
              }
        if (step !== 6 && !body.tools.some((tool) => tool.name === name))
          return new Response("proposal check tool unavailable", { status: 409 })
        const response = {
          id: `resp_${step}`,
          object: "response",
          model: body.model,
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }
        const events = [
          { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: item.type === "function_call" ? { ...item, arguments: "" } : item,
          },
          ...(item.type === "function_call"
            ? [
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
              ]
            : [
                {
                  type: "response.output_text.delta",
                  item_id: item.id,
                  output_index: 0,
                  content_index: 0,
                  delta: "Checked proposal submitted.",
                },
              ]),
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response },
        ]
        return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), {
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })
    const artifacts = new Artifacts(path.join(root, "objects"))
    const seed = {
      s: await artifacts.put(
        new TextEncoder().encode("Use the advertised local compiler feedback before a final proposal handoff."),
      ),
      h: await artifacts.put(new TextEncoder().encode(JSON.stringify(release))),
    }
    const ota = new OTA(
      path.join(root, "ota.sqlite"),
      {
        trusted: hash("scripted-local-compile-qualification"),
        scope: "mechanics",
        performanceRule: "task-pareto",
        tests: [{ id: "mechanics", total: 1 }],
        startupMs: 120000,
        heartbeatMs: 120000,
        probationMs: 60000,
      },
      seed,
    )
    const state = ota.begin(0, Date.now())
    const worker = new RSINative.Process(root, {
      gateway: await RSIRuntime.ref(process.env.OPENCODE_RSI_CHECK_GATEWAY!),
      model: "gpt-5.6-luna",
      effort: "max",
      upstream: `http://127.0.0.1:${fixture.port}/v1`,
      key: "scripted-no-secret",
      fixture: true,
    })
    const timeout = setTimeout(() => {
      void worker.close().catch(() => undefined)
    }, 300000)
    try {
      await worker.launch({
        release,
        source: release,
        strategy: await artifacts.get(seed.s),
        deadline: state.job!.deadline,
        artifact: "h",
        goal: "Scripted engineering qualification: export source changes, repair local diagnostics, hand off without claiming performance.",
        scope: {
          database: path.join(root, "ota.sqlite"),
          protocol: state.protocol,
          epoch: state.epoch,
          job: state.job!.id,
          phase: "running",
          incumbent: state.active.pair,
        },
      })
      const handoff = await worker.complete()
      await worker.close()
      const proposal = await worker.artifact("h", handoff.digest)
      const file = path.join(root, "proposal.patch")
      await fs.writeFile(file, proposal, { flag: "wx", mode: 0o400 })
      const checks = (await Bun.file(path.join(worker.directory, "state/proposal-check/checks.jsonl")).text())
        .trim()
        .split("\n")
        .map((line) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              ok: Schema.Boolean,
              deadline: Schema.Number,
              artifactHash: Schema.String,
              diagnostics: Schema.String,
            }),
          )(JSON.parse(line)),
        )
      expect(errors).toEqual([])
      expect(requests.length).toBe(7)
      expect(checks.map((check) => check.ok)).toEqual([false, false, true, true])
      expect(checks.every((check) => check.deadline === state.job!.deadline)).toBe(true)
      expect(handoff.deadline).toBe(state.job!.deadline)
      expect(checks[0].diagnostics).toContain("already been declared")
      expect(checks.at(-1)!.artifactHash).toBe(handoff.digest)
      const built = await RSIRuntime.build(root, release, file, AbortSignal.timeout(300000))
      await Bun.write(path.join(root, "BUILT-RELEASE.json"), built)
      await Bun.write(
        path.join(root, "RESULT.json"),
        JSON.stringify(
          {
            qualified: true,
            realModelCalls: 0,
            requests: requests.length,
            admissionJobs: ota.read().epoch,
            originalDeadline: state.job!.deadline,
            checks,
            handoff,
            nativeEntry: release.entry,
            source: release.source,
            hostBuildCompleted: true,
            scope:
              "local parsing/bundling plus exact patch/source binding; not full typecheck, runtime branch coverage, task performance or promotion",
          },
          null,
          2,
        ),
      )
      expect(ota.read().epoch).toBe(1)
    } finally {
      clearTimeout(timeout)
      await worker.close()
      await worker.accounting()
      fixture.stop(true)
      ota.db.close()
    }
  },
  600000,
)
