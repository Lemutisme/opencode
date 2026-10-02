// Trusted Terminal-Bench adapter. The mutable H remains the native V2 agent;
// Harbor, the original task container, private verifier and scores stay outside H.
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { RSIRuntime } from "./rsi-runtime"
import type { NativeConfiguration, NativeObservation } from "./rsi-driver"

const Manifest = Schema.Struct({
  scoringTrust: Schema.Literal("official-harbor-normal-use"),
  python: Schema.String,
  pythonRuntime: RSIRuntime.File,
  authority: Schema.Array(RSIRuntime.File),
  tasks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      tests: Schema.Array(Schema.String),
      goal: Schema.String,
      config: RSIRuntime.File,
    }),
  ),
})
const Ready = Schema.Struct({
  deadline: Schema.Number,
  identity: Schema.String,
  instruction: Schema.String,
  socket: Schema.String,
  tools: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String, inputSchema: Schema.Unknown })),
})
const Score = Schema.Struct({
  passed: Schema.Int,
  total: Schema.Literal(1),
  valid: Schema.Literal(true),
  cleanupAcknowledged: Schema.Literal(true),
  officialArtifactCollection: Schema.Literal(true),
  separateVerifier: Schema.Literal(true),
  scoringTrust: Schema.Literal("official-harbor-normal-use"),
  hostileCandidateQualified: Schema.Literal(false),
  nativePeerBound: Schema.Literal(true),
  deadline: Schema.Number,
  late: Schema.Literal(false),
})
type Session = {
  directory: string
  child: ReturnType<typeof Bun.spawn>
  deadline: number
  finished?: Promise<void>
}

export async function terminalBench(root: string, reference: RSIRuntime.File) {
  await RSIRuntime.checked(reference)
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(await Bun.file(reference.path).text())
  if ((await fs.realpath(manifest.python)) !== manifest.pythonRuntime.path)
    throw new Error("Terminal-Bench Python executable does not match its pinned runtime")
  const assigned = manifest.tasks.flatMap((task) => task.tests)
  if (
    !manifest.tasks.length ||
    new Set(assigned).size !== assigned.length ||
    new Set(manifest.tasks.map((task) => task.id)).size !== manifest.tasks.length ||
    manifest.tasks.some((task) => !task.id.trim() || !task.goal.trim() || !task.tests.length)
  )
    throw new Error("Terminal-Bench requires unique frozen instance assignments")
  const authority = [
    reference,
    manifest.pythonRuntime,
    ...manifest.authority,
    ...manifest.tasks.map((task) => task.config),
    await RSIRuntime.ref(import.meta.path),
    await RSIRuntime.ref(path.join(import.meta.dir, "rsi-terminal.py")),
  ]
  await Promise.all(authority.map(RSIRuntime.checked))
  for (const task of manifest.tasks) {
    const config = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ id: Schema.String, binding: RSIRuntime.File, authority: Schema.Array(RSIRuntime.File) }),
      ),
    )(await Bun.file(task.config.path).text())
    if (config.id !== task.id) throw new Error("Terminal-Bench task and official configuration identities differ")
    await Promise.all([config.binding, ...config.authority].map(RSIRuntime.checked))
    authority.push(config.binding, ...config.authority)
  }
  const sessions = new Map<string, Session>()
  const finish = (session: Session) => {
    session.finished ??= (async () => {
      if (session.child.exitCode === null) session.child.kill("SIGTERM")
      const deadline = Date.now() + 180000
      while (session.child.exitCode === null && Date.now() < deadline) await Bun.sleep(100)
      if (session.child.exitCode === null) throw new Error("Terminal-Bench cleanup has not acknowledged termination")
      if (
        (await Bun.file(path.join(session.directory, "READY.json")).exists()) &&
        !(await Bun.file(path.join(session.directory, "CLEANUP.json")).exists())
      )
        throw new Error("Terminal-Bench environment cleanup is unacknowledged")
    })()
    return session.finished
  }
  const configuration: Pick<NativeConfiguration, "task" | "grade"> = {
    task: (test, checkpoint) => {
      if (checkpoint)
        throw new Error("Terminal-Bench task-local evaluation needs qualified environment forks, not artifact archives")
      const task = manifest.tasks.find((task) => task.tests.includes(test.id))
      if (!task || test.total !== 1) throw new Error("unassigned Terminal-Bench evaluation or denominator")
      const allocations = new Set<Session>()
      return {
        identity: task.id,
        goal: task.goal,
        artifact: "submission",
        mode: "bridge",
        bridge: {
          prepare: async (input: { run: string; deadline: number; signal: AbortSignal }) => {
            input.signal.throwIfAborted()
            if (Date.now() >= input.deadline) throw new Error("original Terminal-Bench deadline reached")
            if (sessions.has(input.run)) throw new Error("Terminal-Bench allocation already prepared")
            await Promise.all(authority.map(RSIRuntime.checked))
            const directory = path.join(root, "terminal", crypto.randomUUID())
            await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 })
            const child = Bun.spawn(
              [
                manifest.python,
                "-B",
                path.join(import.meta.dir, "rsi-terminal.py"),
                "--config",
                task.config.path,
                "--run",
                directory,
                "--deadline",
                String(input.deadline),
                "--owner",
                String(process.pid),
                "--native-run",
                input.run,
              ],
              {
                stdin: "ignore",
                stdout: Bun.file(directory + ".stdout"),
                stderr: Bun.file(directory + ".stderr"),
                env: { PATH: process.env.PATH, HOME: "/nonexistent", PYTHONDONTWRITEBYTECODE: "1" },
              },
            )
            const session = { directory, child, deadline: input.deadline }
            sessions.set(input.run, session)
            allocations.add(session)
            const cancel = () => child.kill("SIGTERM")
            input.signal.addEventListener("abort", cancel, { once: true })
            try {
              while (!(await Bun.file(path.join(directory, "READY.json")).exists())) {
                input.signal.throwIfAborted()
                if (Date.now() >= input.deadline || child.exitCode !== null)
                  throw new Error(`Terminal-Bench environment unavailable; retained ${directory}`)
                await Bun.sleep(100)
              }
              const ready = Schema.decodeUnknownSync(Schema.fromJsonString(Ready))(
                await Bun.file(path.join(directory, "READY.json")).text(),
              )
              if (
                ready.identity !== task.id ||
                ready.instruction !== task.goal ||
                ready.deadline !== input.deadline ||
                !path.isAbsolute(ready.socket) ||
                path.basename(ready.socket) !== "tools.sock" ||
                !(await fs.lstat(ready.socket)).isSocket()
              )
                throw new Error("Terminal-Bench bridge admission coordinates differ")
              const tools = path.join(directory, "TOOLS.json")
              await fs.writeFile(tools, JSON.stringify({ tools: ready.tools }), { flag: "wx", mode: 0o400 })
              return {
                directory: path.dirname(ready.socket),
                tools: await RSIRuntime.ref(tools),
                goal: "Use terminal for every task filesystem and shell operation. It targets the original official task environment, not the native agent container. Keep all required deliverables at their original paths. When finished call task_handoff; official verification is host-only and happens only after your execution is fenced.",
              }
            } catch (error) {
              await finish(session)
              throw error
            } finally {
              input.signal.removeEventListener("abort", cancel)
            }
          },
          revoke: async (input: { run: string }) => {
            const session = sessions.get(input.run)
            if (!session || session.child.exitCode !== null) return
            await Bun.write(path.join(session.directory, "control/REVOKE.json"), JSON.stringify({ run: input.run }))
            while (!(await Bun.file(path.join(session.directory, "REVOKED.json")).exists())) {
              if (session.child.exitCode !== null) return
              if (Date.now() >= session.deadline) return finish(session)
              await Bun.sleep(100)
            }
          },
          finish: () => Promise.all([...allocations].map(finish)).then(() => undefined),
        },
      }
    },
    grade: async (input: NativeObservation) => {
      input.signal.throwIfAborted()
      const session = sessions.get(input.run)
      if (!session || session.deadline !== input.deadline || Date.now() >= input.deadline)
        throw new Error("Terminal-Bench grading requires the exact live allocation")
      const fence = path.join(input.run, "FENCED.json")
      if (!(await Bun.file(fence).exists()) || !(await Bun.file(path.join(session.directory, "REVOKED.json")).exists()))
        throw new Error("Terminal-Bench native generation and terminal calls are not fenced")
      await Bun.write(path.join(session.directory, "control/SETTLE.json"), JSON.stringify({ fence }))
      const cancel = () => session.child.kill("SIGTERM")
      input.signal.addEventListener("abort", cancel, { once: true })
      try {
        const code = await session.child.exited
        input.signal.throwIfAborted()
        if (code !== 0 || Date.now() >= input.deadline)
          throw new Error(`Terminal-Bench official verification failed; retained ${session.directory}`)
        const result = Schema.decodeUnknownSync(Schema.fromJsonString(Score))(
          await Bun.file(path.join(session.directory, "RESULT.json")).text(),
        )
        if (result.deadline !== input.deadline || ![0, 1].includes(result.passed))
          throw new Error("Terminal-Bench result coordinates differ")
        return result
      } finally {
        input.signal.removeEventListener("abort", cancel)
      }
    },
  }
  return {
    ...configuration,
    authority,
    dispose: () => Promise.all([...sessions.values()].map(finish)).then(() => undefined),
  }
}
