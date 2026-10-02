// Operator-owned ProgramBench wiring. Never imported from candidate H.
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { RSIRuntime } from "./rsi-runtime"
import { RSITask } from "./rsi-task"
import { containmentTask, containmentScore } from "./rsi-safety"
import type { NativeConfiguration, NativeObservation } from "./rsi-driver"

const Manifest = Schema.Struct({
  // Explicit operator threat model. Official completeness is not tamper resistance.
  scoringTrust: Schema.Literal("official-programbench-normal-use"),
  taskFeedback: Schema.optional(Schema.Literal("qualification-outcomes")),
  safety: Schema.optional(Schema.Array(Schema.String)),
  tasks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      tests: Schema.Array(Schema.String),
      goal: Schema.String,
      image: Schema.String,
      grader: RSIRuntime.File,
    }),
  ),
})
const Score = Schema.Struct({
  passed: Schema.Int,
  total: Schema.Int,
  valid: Schema.Boolean,
  cleanupAcknowledged: Schema.Literal(true),
  scoringTrust: Schema.Literal("official-programbench-normal-use"),
  hostileCandidateQualified: Schema.Literal(false),
  failure: Schema.NullOr(Schema.String),
  executedTests: Schema.Int,
  terminalFailure: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literal("candidate_build"),
      officialError: Schema.String,
      stage: Schema.String,
      exitCode: Schema.Int,
      executedTests: Schema.Literal(0),
    }),
  ),
})

export async function programBench(root: string, reference: RSIRuntime.File) {
  await RSIRuntime.checked(reference)
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(await Bun.file(reference.path).text())
  const safety = manifest.safety ?? []
  const ids = [...safety, ...manifest.tasks.flatMap((task) => task.tests)]
  if (
    !manifest.tasks.length ||
    new Set(ids).size !== ids.length ||
    new Set(manifest.tasks.map((task) => task.id)).size !== manifest.tasks.length
  )
    throw new Error("ProgramBench requires unique frozen task assignments")
  for (const task of manifest.tasks) {
    if (!task.id || !task.goal || !/^sha256:[a-f0-9]{64}$/.test(task.image))
      throw new Error("invalid ProgramBench task")
    await RSIRuntime.checked(task.grader)
    const grader = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ instance: Schema.String, image: Schema.String })),
    )(await Bun.file(task.grader.path).text())
    if (grader.instance !== task.id || grader.image !== task.image) throw new Error("task and grader identities differ")
  }
  const grade = async (task: (typeof manifest.tasks)[number], input: NativeObservation) => {
    input.signal.throwIfAborted()
    if (Date.now() >= input.deadline) throw new Error("original task deadline reached before grading")
    await RSIRuntime.checked(task.grader)
    if (!(await Bun.file(path.join(input.run, "FENCED.json")).exists())) throw new Error("task worker not fenced")
    const output = path.join(input.run, "grades", crypto.randomUUID())
    await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
    const child = Bun.spawn(
      [
        "python3",
        "-B",
        path.join(import.meta.dir, "rsi-programbench.py"),
        "--config",
        task.grader.path,
        "--workspace",
        path.join(input.run, "candidate/workspace"),
        "--output",
        output,
        "--deadline",
        String(input.deadline),
        "--owner",
        String(process.pid),
      ],
      {
        stdin: "ignore",
        stdout: Bun.file(output + ".stdout"),
        stderr: Bun.file(output + ".stderr"),
        env: { PATH: process.env.PATH, HOME: "/nonexistent", PYTHONDONTWRITEBYTECODE: "1" },
      },
    )
    // The trusted bridge owns its grader process group AND Docker admission/fencing.
    // Ask it to cancel; killing just the Python parent would orphan scoring containers.
    const cancel = () => child.kill("SIGTERM")
    input.signal.addEventListener("abort", cancel, { once: true })
    const timer = setTimeout(cancel, Math.max(1, input.deadline - Date.now()))
    if (input.signal.aborted) cancel()
    try {
      const code = await child.exited
      input.signal.throwIfAborted()
      if (Date.now() >= input.deadline) throw new Error("late ProgramBench result")
      if (code !== 0) throw new Error(`ProgramBench scoring invalid; retained ${output}`)
      const result = Schema.decodeUnknownSync(Schema.fromJsonString(Score))(
        await Bun.file(path.join(output, "RESULT.json")).text(),
      )
      if (!result.valid || result.total <= 0 || result.passed < 0 || result.passed > result.total)
        throw new Error("invalid ProgramBench result")
      if (
        result.terminalFailure &&
        (result.passed !== 0 || result.executedTests !== 0 || result.failure !== "candidate_build")
      )
        throw new Error("terminal ProgramBench failure cannot report executed or passing tests")
      return result
    } finally {
      clearTimeout(timer)
      input.signal.removeEventListener("abort", cancel)
    }
  }
  const checkpointTask = async (task: { id: string; checkpoint: string }) => {
    const entry = manifest.tasks.find((entry) => entry.id === task.id)
    if (!entry) throw new Error("unassigned live task")
    const checkpoint = await RSITask.load(root, task.checkpoint)
    if (checkpoint.goal !== entry.goal || checkpoint.image !== entry.image)
      throw new Error("task checkpoint changed the frozen problem")
    return RSITask.task(root, task)
  }
  const continuation = manifest.taskFeedback
    ? RSITask.continuation(
        root,
        (input) => {
          const task = manifest.tasks.find((task) => task.id === input.job.task?.id)
          if (!task) throw new Error("unassigned live task")
          return grade(task, input)
        },
        { partial: "blocked" },
      )
    : undefined
  const configuration: Pick<NativeConfiguration, "task" | "grade" | "continuation"> = {
    task: async (test, task) => {
      if (safety.includes(test.id)) return containmentTask(test)
      const entry = manifest.tasks.find((entry) => entry.tests.includes(test.id))
      if (!entry) throw new Error("unassigned ProgramBench evaluation")
      if (task) {
        if (entry.id !== task.id) throw new Error("evaluation cannot substitute another task for a live checkpoint")
        return checkpointTask(task)
      }
      return { identity: entry.id, mode: "programbench", goal: entry.goal, image: entry.image, artifact: "submission" }
    },
    grade: (input) => {
      if (safety.includes(input.test.id)) return containmentScore(input)
      const task = manifest.tasks.find((task) => task.tests.includes(input.test.id))
      if (!task) throw new Error("unassigned ProgramBench grade")
      return grade(task, input)
    },
    continuation: continuation
      ? {
          ...continuation,
          task: (job) => {
            if (!job.task) throw new Error("missing live task binding")
            return checkpointTask(job.task)
          },
        }
      : undefined,
  }
  return {
    ...configuration,
    authority: [
      reference,
      ...manifest.tasks.map((task) => task.grader),
      await RSIRuntime.ref(import.meta.path),
      await RSIRuntime.ref(path.join(import.meta.dir, "rsi-programbench.py")),
    ],
  }
}
