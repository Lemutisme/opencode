// Trusted host adapter. The native candidate supplies the agent; the official
// environment, user state and deterministic grader never enter candidate H.
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { RSIRuntime } from "./rsi-runtime"
import type { NativeObservation } from "./rsi-driver"
import type { Protocol } from "../../core/script/ota-rsi"
import type { Job } from "../../core/script/ota-supervisor"

const Manifest = Schema.Struct({
  kind: Schema.Literal("native-rsi-tau3-v1"),
  scoringTrust: Schema.Literal("official-tau3-deterministic"),
  python: Schema.String,
  interpreter: RSIRuntime.File,
  vendor: Schema.String,
  supplies: Schema.Array(RSIRuntime.File),
  userModel: Schema.Literal("gpt-5.2-2025-12-11"),
  userEffort: Schema.Literal("low"),
  seed: Schema.Int,
  scriptedQualification: Schema.optional(Schema.Literal(true)),
  tasks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      domain: Schema.Literals(["airline", "retail", "mock"]),
      task: Schema.String,
      tests: Schema.Array(Schema.String),
    }),
  ),
})

const Tools = {
  tools: [
    {
      name: "tau_turn",
      description:
        "One official tau assistant turn: speech OR an ordered batch of public official business tools OR stop.",
      inputSchema: {
        anyOf: [
          {
            type: "object",
            properties: { speak: { type: "string" } },
            required: ["speak"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              calls: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  properties: { name: { type: "string" }, arguments: { type: "object" } },
                  required: ["name", "arguments"],
                  additionalProperties: false,
                },
              },
            },
            required: ["calls"],
            additionalProperties: false,
          },
          { type: "object", properties: { stop: { const: true } }, required: ["stop"], additionalProperties: false },
        ],
      },
    },
  ],
}

export async function tauBench(root: string, reference: RSIRuntime.File) {
  await RSIRuntime.checked(reference)
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(await Bun.file(reference.path).text(), {
    onExcessProperty: "error",
  })
  await RSIRuntime.checked(manifest.interpreter)
  if ((await fs.realpath(manifest.python)) !== manifest.interpreter.path) throw new Error("tau interpreter changed")
  if (!path.isAbsolute(manifest.vendor) || !manifest.supplies.some((item) => item.path === manifest.vendor))
    throw new Error("tau vendor must be an explicitly pinned supply")
  const tests = manifest.tasks.flatMap((task) => task.tests)
  if (manifest.tasks.some((task) => task.domain === "mock") && !manifest.scriptedQualification)
    throw new Error("the mock domain is only a scripted engineering qualification")
  if (
    !manifest.tasks.length ||
    new Set(tests).size !== tests.length ||
    new Set(manifest.tasks.map((task) => task.id)).size !== manifest.tasks.length
  )
    throw new Error("tau tasks require unique frozen assignments")
  const script = await RSIRuntime.ref(path.join(import.meta.dir, "rsi-tau.py"))
  const gateway = await RSIRuntime.ref(path.join(import.meta.dir, "rsi-gateway.py"))
  const allocations = new Map<string, Awaited<ReturnType<typeof create>>>()
  const daemons = new Set<Awaited<ReturnType<typeof create>>>()

  const create = async (task: (typeof manifest.tasks)[number], deadline: number, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (Date.now() >= deadline) throw new Error("original tau deadline reached")
    await Promise.all([reference, manifest.interpreter, script, gateway].map(RSIRuntime.checked))
    if ((await fs.realpath(manifest.python)) !== manifest.interpreter.path) throw new Error("tau interpreter changed")
    const directory = path.join(root, "tau", crypto.randomUUID())
    await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 })
    const config = directory + ".json"
    await fs.writeFile(
      config,
      JSON.stringify({
        ...manifest,
        domain: task.domain,
        task: task.task,
        split: task.domain === "mock" ? null : "base",
        deadline,
        fixture: manifest.scriptedQualification ?? false,
      }),
      { flag: "wx", mode: 0o400 },
    )
    const child = Bun.spawn(
      [manifest.python, "-B", script.path, "--config", config, "--root", directory, "--owner", String(process.pid)],
      {
        stdin: "ignore",
        stdout: Bun.file(directory + ".stdout"),
        stderr: Bun.file(directory + ".stderr"),
        env: {
          PATH: process.env.PATH,
          HOME: "/nonexistent",
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
          PYTHONDONTWRITEBYTECODE: "1",
        },
      },
    )
    const stop = async () => {
      if (child.exitCode !== null) return
      child.kill("SIGTERM")
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000)
      try {
        await child.exited
      } finally {
        clearTimeout(timeout)
      }
      if (!(await Bun.file(path.join(directory, "FENCED.json")).exists()))
        throw new Error("tau environment fence unacknowledged")
    }
    const abort = () => {
      void stop().catch(() => undefined)
    }
    signal.addEventListener("abort", abort, { once: true })
    const until = Math.min(deadline, Date.now() + 120_000)
    try {
      while (!(await Bun.file(path.join(directory, "READY.json")).exists())) {
        signal.throwIfAborted()
        if (child.exitCode !== null || Date.now() >= until)
          throw new Error(`tau environment startup failed: ${directory}.stderr`)
        await Bun.sleep(25)
      }
    } catch (error) {
      await stop()
      throw error
    } finally {
      signal.removeEventListener("abort", abort)
    }
    const file = path.join(directory, "channel/tools.json")
    await fs.writeFile(file, JSON.stringify(Tools), { flag: "wx", mode: 0o444 })
    const tools = await RSIRuntime.ref(file)
    const daemon = { directory, deadline, stop, tools, child, task, generation: "" }
    daemons.add(daemon)
    return daemon
  }

  return {
    authority: [reference, script, gateway, manifest.interpreter, await RSIRuntime.ref(import.meta.path)],
    task: async (test: Protocol["tests"][number], continuation?: Job["task"]) => {
      if (continuation)
        throw new Error("tau task-local evaluation forks require separately qualified private user-state continuation")
      const task = manifest.tasks.find((task) => task.tests.includes(test.id))
      if (!task || test.total !== 1) throw new Error("tau test is not a frozen binary assignment")
      const state = { daemon: undefined as Awaited<ReturnType<typeof create>> | undefined }
      return {
        identity: task.id,
        mode: "tau" as const,
        artifact: "submission",
        goal: "Complete the official tau3 customer conversation, following its public policy. Host-owned official evaluation is independent; do not self-certify.",
        bridge: {
          prepare: async (input: { run: string; deadline: number; signal: AbortSignal }) => {
            state.daemon ??= await create(task, input.deadline, input.signal)
            const daemon = state.daemon
            if (daemon.deadline !== input.deadline || daemon.child.exitCode !== null)
              throw new Error("tau conversation cannot be restarted or receive a renewed deadline")
            daemon.generation = crypto.randomUUID()
            const file = path.join(daemon.directory, "binding.json")
            await fs.writeFile(file + ".new", JSON.stringify({ run: input.run, generation: daemon.generation }), {
              mode: 0o600,
            })
            await fs.rename(file + ".new", file)
            await Bun.write(
              path.join(input.run, "TAU.json"),
              JSON.stringify({
                trial: daemon.directory,
                generation: daemon.generation,
                task: task.id,
                deadline: input.deadline,
              }),
            )
            allocations.set(input.run, daemon)
            return { directory: path.join(daemon.directory, "channel"), tools: daemon.tools }
          },
          revoke: async (input: { run: string }) => {
            const daemon = allocations.get(input.run)
            if (!daemon || daemon.child.exitCode !== null) return
            const record = Schema.decodeUnknownSync(Schema.Struct({ generation: Schema.String }))(
              await Bun.file(path.join(input.run, "TAU.json")).json(),
            )
            await Bun.write(
              path.join(daemon.directory, "REVOKE.json"),
              JSON.stringify({ run: input.run, generation: record.generation }),
            )
            const until = Date.now() + 30_000
            while (true) {
              const file = Bun.file(path.join(daemon.directory, "REVOKED.json"))
              if (await file.exists()) {
                const result = Schema.decodeUnknownSync(
                  Schema.Struct({ run: Schema.String, generation: Schema.String }),
                )(await file.json())
                if (result.run === input.run && result.generation === record.generation) break
              }
              if (daemon.child.exitCode !== null || Date.now() >= until)
                throw new Error("tau business lease revocation unacknowledged")
              await Bun.sleep(25)
            }
          },
          finish: async () => {
            if (!state.daemon) return
            await state.daemon.stop()
            daemons.delete(state.daemon)
          },
        },
      }
    },
    grade: async (input: NativeObservation & { test: Protocol["tests"][number] }) => {
      const daemon = allocations.get(input.run)
      if (!daemon || !daemon.task.tests.includes(input.test.id) || daemon.deadline !== input.deadline)
        throw new Error("tau grader is not bound to this native allocation")
      input.signal.throwIfAborted()
      if (!(await Bun.file(path.join(input.run, "FENCED.json")).exists()))
        throw new Error("native tau worker not fenced")
      // Handoff bytes are advisory only. The official terminal host transcript
      // and official grader, never a candidate-written score, determine reward.
      await Bun.write(path.join(daemon.directory, "GRADE"), "grade")
      const until = Math.min(input.deadline, Date.now() + 300_000)
      while (!(await Bun.file(path.join(daemon.directory, "RESULT.json")).exists())) {
        input.signal.throwIfAborted()
        if (
          Date.now() >= until ||
          daemon.child.exitCode !== null ||
          (await Bun.file(path.join(daemon.directory, "GRADE-ERROR.json")).exists())
        )
          throw new Error(`official tau grading failed: ${daemon.directory}`)
        await Bun.sleep(25)
      }
      input.signal.throwIfAborted()
      if (Date.now() >= input.deadline) throw new Error("late tau grade")
      const result = Schema.decodeUnknownSync(
        Schema.Struct({
          passed: Schema.Int,
          total: Schema.Literal(1),
          valid: Schema.Literal(true),
          scoringTrust: Schema.Literal("official-tau3-deterministic"),
        }),
      )(await Bun.file(path.join(daemon.directory, "RESULT.json")).json())
      if (result.passed !== 0 && result.passed !== 1) throw new Error("invalid binary tau grade")
      return result
    },
    dispose: async () => {
      await Promise.all([...daemons].map((daemon) => daemon.stop()))
      daemons.clear()
    },
  }
}
