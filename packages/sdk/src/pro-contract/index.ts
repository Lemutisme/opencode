export * as ProContractRSI from "./index"
export { ProContract } from "@opencode/schema/pro-contract"

import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { ProContract } from "@opencode/schema/pro-contract"
import { ContractLedger } from "@opencode/core/pro-contract/ledger"
import { RSI } from "@opencode/core/pro-contract/rsi"
import { ContractNative } from "./native"

const Verifier = Schema.Struct({ directory: Schema.String, command: Schema.Array(Schema.String) })
export const Configuration = Schema.Struct({
  runtime: Schema.Struct({ directory: Schema.String, bun: Schema.String, python: Schema.String, bwrap: Schema.String }),
  model: Schema.Struct({
    id: Schema.NonEmptyString,
    effort: Schema.NonEmptyString,
    upstream: Schema.NonEmptyString,
    credential: Schema.optional(Schema.NonEmptyString),
  }),
  seed: RSI.Method,
  tests: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      panel: Schema.Literals(["safety", "development", "confirmation"]),
      repeats: Schema.Int,
      total: Schema.Int,
      goal: Schema.NonEmptyString,
      directory: Schema.String,
      verifier: Verifier,
    }),
  ),
})
export type Configuration = typeof Configuration.Type
export const Task = Schema.Struct({
  id: ProContract.ID,
  goal: Schema.NonEmptyString,
  directory: Schema.String,
  total: Schema.Int.check(Schema.isGreaterThan(0)),
  verifier: Verifier,
  deadline: Schema.optional(Schema.Number),
})
export type Task = typeof Task.Type

/** A transparent starting method, not a claim of measured superiority. Freeze its exact text in the profile. */
export const initialMethod: RSI.Method = {
  instructions: [
    "Work toward the actual task goal, not merely a plausible final answer. Keep the implementation as simple as the observed behavior permits.",
    "Use public specifications and executable observations to identify uncertain behavior. Seek discriminating counterexamples, repair their causes, and rerun affected checks. Your own passing checks are not independent acceptance.",
    "Retain useful observations, failed cases, assumptions and unfinished work in the workspace. When context becomes unproductive, checkpoint with an honest summary; a fresh Session can continue the same responsibility.",
    "When experience suggests a reusable improvement, propose a complete replacement method with contract_handoff. A method includes how to investigate, test, checkpoint, continue and propose future improvements. Preserve useful strengths instead of adding ceremony.",
    "Do not change the task, verifier, permissions or deadline. Do not request a new method merely to evade an obligation. If work is ready, submit it; if genuinely blocked, explain the unresolved reason. Completed work need not consume the remaining time.",
  ].join("\n\n"),
}

/** The host composes authority, native execution and verification; it is not a model tool. */
export async function open(root: string, configuration: Configuration) {
  if (!path.isAbsolute(root)) throw new Error("An absolute private ledger directory is required")
  const config = Schema.decodeUnknownSync(Configuration)(configuration, { onExcessProperty: "error" })
  RSI.method(config.seed)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const checkpoints = path.join(root, "checkpoints")
  await fs.mkdir(checkpoints, { recursive: true, mode: 0o700 })
  const release = await releaseIdentity(config.runtime)
  const tests = await Promise.all(
    config.tests.map(async (test) => {
      nonoverlapping(root, test.directory)
      nonoverlapping(root, test.verifier.directory)
      if (!test.verifier.command.length) throw new Error("Explicit verifier command required")
      const initial = await ContractNative.snapshot(test.directory, checkpoints)
      const verifier = await ContractNative.snapshot(test.verifier.directory, checkpoints)
      return {
        ...test,
        checkpoint: initial.hash,
        verifier: { directory: verifier.directory, command: test.verifier.command },
        verifierHash: verifier.hash,
      }
    }),
  )
  const protocol = RSI.protocol({
    version: 1,
    performanceRule: "task-pareto",
    environment: RSI.hash({ release, model: config.model, tests }),
    tests: tests.map((test) => ({
      id: test.id,
      panel: test.panel,
      repeats: test.repeats,
      total: test.total,
      checkpoint: test.checkpoint,
      verifier: RSI.hash({ source: test.verifierHash, command: test.verifier.command }),
    })),
  })
  const store = new ContractLedger.Store(path.join(root, "ledger.sqlite"), protocol, config.seed)
  const frozen = { release, protocol, seed: config.seed, tests, model: config.model }
  const manifest = path.join(root, "FROZEN.json")
  if (await Bun.file(manifest).exists()) {
    if (RSI.hash(await Bun.file(manifest).json()) !== RSI.hash(frozen)) throw new Error("Frozen configuration differs")
  } else await Bun.write(manifest, JSON.stringify(frozen, null, 2))
  const owner = { busy: false }
  return {
    store,
    close: () => store.close(),
    async run(task: Task, options: { resume?: boolean; signal?: AbortSignal } = {}) {
      if (owner.busy) throw new Error("This scope already owns an execution")
      owner.busy = true
      const lock = path.join(root, "RUNNING")
      const claimed = await fs.open(lock, "wx", 0o600).catch((error) => {
        owner.busy = false
        throw new Error(
          `Scope already claimed; inspect and fence the previous process before removing RUNNING: ${error}`,
        )
      })
      await claimed.writeFile(JSON.stringify({ pid: process.pid, task: task.id, started: Date.now() }))
      const controller = new AbortController()
      const abort = () => controller.abort(options.signal?.reason)
      options.signal?.addEventListener("abort", abort, { once: true })
      if (options.signal?.aborted) abort()
      const cancel = setInterval(() => {
        if (existsSync(path.join(root, "CANCEL"))) controller.abort(new Error("Explicit cancellation"))
      }, 100)
      const check = async () => {
        controller.signal.throwIfAborted()
        if (existsSync(path.join(root, "CANCEL"))) throw new Error("Explicit cancellation")
        store.assertTask(store.read(), task.id)
        if ((await releaseIdentity(config.runtime)) !== release) throw new Error("Runtime release changed")
      }
      const current: { execution?: string } = {}
      try {
        nonoverlapping(root, task.directory)
        nonoverlapping(root, task.verifier.directory)
        const initial = await ContractNative.snapshot(task.directory, checkpoints)
        const verifier = await ContractNative.snapshot(task.verifier.directory, checkpoints)
        const before = store.read()
        const deadline =
          task.deadline ?? before.kernel.contracts[task.id]?.spec.budget.deadline ?? Date.now() + 6 * 60 * 60 * 1000
        if (deadline > Date.now() + 6 * 60 * 60 * 1000) throw new Error("Task exceeds the six-hour admission ceiling")
        store.issue({
          id: task.id,
          goal: task.goal,
          deadline,
          checkpoint: initial.hash,
          identity: RSI.hash({ ...task, deadline, verifier: verifier.hash, initial: initial.hash }),
        })
        if (options.resume) store.resume(task.id)
        while (store.read().kernel.contracts[task.id].status === "active") {
          await check()
          const state = store.read()
          const binding = state.tasks[task.id]
          current.execution = crypto.randomUUID()
          const admitted = store.begin(task.id, current.execution)
          const result = await ContractNative.run({
            root,
            id: current.execution,
            runtime: config.runtime,
            model: config.model,
            store,
            task: task.id,
            parent: admitted.method,
            method: state.methods[admitted.method.hash],
            checkpoint: binding.checkpoint,
            goal: task.goal,
            feedback: binding.feedback,
            evaluation: false,
            signal: controller.signal,
          })
          store.checkpoint(task.id, current.execution, result.checkpoint, result.handoff.summary)
          delete current.execution
          await check()
          if (result.handoff.action === "blocked") {
            store.interrupted(task.id, result.handoff.summary, true)
            break
          }
          if (result.handoff.action === "checkpoint") continue
          if (result.handoff.action === "submit") {
            const grade = await ContractNative.grade({
              root,
              runtime: config.runtime,
              verifier: { directory: verifier.directory, command: task.verifier.command },
              checkpoint: result.checkpoint,
              deadline,
              signal: controller.signal,
            })
            if (grade.result.total !== task.total) throw new Error("Original task verifier denominator changed")
            store.settleTask(task.id, grade.result)
            continue
          }
          const method = RSI.method(result.handoff.method)
          const candidate = RSI.hash(method)
          const key = RSI.hash({ parent: admitted.method, candidate, protocol: state.protocol })
          if (candidate === admitted.method.hash || store.read().proposals[key]) {
            store.note(task.id, "No new method was admitted: unchanged or already compared under this incumbent.")
            continue
          }
          store.propose(task.id, admitted.method, method, result.receipt)
          const measurements: RSI.Measurement[] = []
          const publicFeedback: string[] = []
          // Fixed repeats are experimental assignments, never an execution allowance.
          for (const test of tests)
            for (let repeat = 0; repeat < test.repeats; repeat++) {
              for (const side of ["baseline", "candidate"] as const) {
                await check()
                const observation = await ContractNative.run({
                  root,
                  id: crypto.randomUUID(),
                  runtime: config.runtime,
                  model: config.model,
                  store,
                  task: task.id,
                  parent: admitted.method,
                  method: side === "baseline" ? state.methods[admitted.method.hash] : method,
                  checkpoint: test.checkpoint,
                  goal: test.goal,
                  feedback: [],
                  evaluation: true,
                  signal: controller.signal,
                  assignment: { side, test: test.id, repeat },
                })
                const grade = await ContractNative.grade({
                  root,
                  runtime: config.runtime,
                  verifier: test.verifier,
                  checkpoint: observation.checkpoint,
                  deadline,
                  signal: controller.signal,
                })
                const measurement: RSI.Measurement = {
                  side,
                  test: test.id,
                  repeat,
                  passed: grade.result.passed,
                  total: grade.result.total,
                  valid: grade.result.valid,
                  artifact: observation.checkpoint,
                  execution: observation.receipt,
                  verification: store.object({
                    artifact: observation.checkpoint,
                    verifier: RSI.hash({ source: test.verifierHash, command: test.verifier.command }),
                    ...grade.result,
                  }),
                }
                measurements.push(measurement)
                store.object({ protocol, parent: admitted.method, candidate, measurement })
                if (test.panel === "development")
                  publicFeedback.push(
                    `${side} development ${test.id}, repeat ${repeat}: ${grade.result.passed}/${grade.result.total}. ${grade.result.feedback ?? ""}`,
                  )
              }
            }
          await check()
          const decision = store.select(admitted.method, method, measurements)
          store.note(
            task.id,
            [
              decision.eligible
                ? "A successor method was authorized; use it for continuing work and future proposals."
                : "No successor was selected; continue using the incumbent method. Negative evidence is retained.",
              ...publicFeedback,
            ].join("\n"),
          )
          // The next admission reads the actual selected method, never a proposed pointer.
        }
        return {
          contract: store.read().kernel.contracts[task.id],
          task: store.read().tasks[task.id],
          method: store.read().active,
          root,
        }
      } catch (error) {
        const state = store.read()
        if (state.tasks[task.id] && state.kernel.contracts[task.id].status !== "discharged") {
          const fenced =
            !current.execution ||
            (await Bun.file(path.join(root, "executions", current.execution, "FENCED.json")).exists())
          store.interrupted(task.id, String(error), fenced)
        }
        throw error
      } finally {
        clearInterval(cancel)
        options.signal?.removeEventListener("abort", abort)
        await claimed.close()
        await fs.unlink(lock)
        owner.busy = false
      }
    },
  }
}

async function releaseIdentity(runtime: ContractNative.Runtime) {
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({
      upstream: Schema.String,
      sourceCommit: Schema.optional(Schema.String),
      files: Schema.Array(
        Schema.Struct({ path: Schema.String, hash: Schema.String, link: Schema.optional(Schema.Boolean) }),
      ),
    }),
  )(await Bun.file(path.join(runtime.directory, "RELEASE.json")).json())
  for (const file of manifest.files) {
    if (path.isAbsolute(file.path) || file.path.split(path.sep).includes(".."))
      throw new Error("Invalid runtime source path")
    const value = file.link
      ? "symlink:" + (await fs.readlink(path.join(runtime.directory, file.path)))
      : await Bun.file(path.join(runtime.directory, file.path)).bytes()
    if (Bun.SHA256.hash(value, "hex") !== file.hash) throw new Error(`Runtime source changed: ${file.path}`)
  }
  return RSI.hash({
    manifest,
    tools: await Promise.all(
      [runtime.bun, runtime.python, runtime.bwrap].map(async (file) => ({
        path: file,
        hash: Bun.SHA256.hash(await Bun.file(file).bytes(), "hex"),
      })),
    ),
  })
}

function nonoverlapping(root: string, directory: string) {
  if (!path.isAbsolute(directory)) throw new Error("Absolute source directories required")
  if (directory === root || directory.startsWith(root + path.sep) || root.startsWith(directory + path.sep))
    throw new Error("Private state must not overlap candidate or verifier inputs")
}
