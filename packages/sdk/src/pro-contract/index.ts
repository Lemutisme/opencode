export * as ProContractRSI from "./index"
export { ProContract } from "@opencode/schema/pro-contract"
export { investigationMethod, researchGoal } from "./method"

import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { ProContract } from "@opencode/schema/pro-contract"
import { ContractLedger } from "@opencode/core/pro-contract/ledger"
import { RSI } from "@opencode/core/pro-contract/rsi"
import { ContractNative } from "./native"
import { ContractEnvironment } from "./environment"
import { ContractProgramBench } from "./programbench"

const Verifier = ContractNative.Verifier
export const Configuration = Schema.Struct({
  runtime: Schema.Struct({
    directory: Schema.String,
    bun: Schema.String,
    python: Schema.String,
    bwrap: Schema.String,
    rg: Schema.optional(Schema.String),
    toolCgroup: Schema.optional(Schema.Boolean),
  }),
  model: Schema.Struct({
    id: Schema.NonEmptyString,
    effort: Schema.NonEmptyString,
    upstream: Schema.NonEmptyString,
    credential: Schema.optional(Schema.NonEmptyString),
  }),
  seed: RSI.Method,
  proposals: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  reserveBytes: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  tests: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      panel: Schema.Literals(["safety", "development", "confirmation"]),
      repeats: Schema.Int,
      total: Schema.Int,
      goal: Schema.NonEmptyString,
      directory: Schema.String,
      verifier: Verifier,
      environment: Schema.optional(ContractEnvironment.Input),
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
  environment: Schema.optional(ContractEnvironment.Input),
  verification: Schema.optional(Schema.Literals(["feedback", "terminal"])),
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
  nonoverlapping(root, config.runtime.directory)
  RSI.method(config.seed)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const checkpoints = path.join(root, "checkpoints")
  await fs.mkdir(checkpoints, { recursive: true, mode: 0o700 })
  const release = await releaseIdentity(config.runtime)
  const tests = await Promise.all(
    config.tests.map(async (test) => {
      nonoverlapping(root, test.directory)
      const initial = await ContractNative.snapshot(test.directory, checkpoints)
      const verifier = await prepareVerifier(root, checkpoints, test.verifier)
      if (test.environment) {
        nonoverlapping(root, test.environment.directory)
        const environment = await ContractEnvironment.checked(test.environment)
        if (
          "programbench" in test.verifier &&
          (await ContractProgramBench.checked(test.verifier.programbench)).image !== environment.manifest.image
        )
          throw new Error("Solver and official evaluator task images differ")
      }
      return {
        ...test,
        checkpoint: initial.hash,
        verifier: verifier.value,
        verifierHash: verifier.hash,
      }
    }),
  )
  const protocol = RSI.protocol({
    version: 1,
    performanceRule: "task-pareto",
    environment: RSI.hash({
      release,
      model: config.model,
      tests,
      proposals: config.proposals,
      reserveBytes: config.reserveBytes,
    }),
    tests: tests.map((test) => ({
      id: test.id,
      panel: test.panel,
      repeats: test.repeats,
      total: test.total,
      checkpoint: test.checkpoint,
      verifier: test.verifierHash,
    })),
  })
  const store = new ContractLedger.Store(path.join(root, "ledger.sqlite"), protocol, config.seed)
  const frozen = {
    release,
    protocol,
    seed: config.seed,
    tests,
    model: config.model,
    proposals: config.proposals,
    reserveBytes: config.reserveBytes,
  }
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
        if (config.reserveBytes !== undefined) {
          const disk = await fs.statfs(root)
          if (disk.bavail * disk.bsize < config.reserveBytes) throw new Error("Disk reserve infrastructure guard")
        }
        if ((await releaseIdentity(config.runtime)) !== release) throw new Error("Runtime release changed")
      }
      const current: { execution?: string } = {}
      try {
        nonoverlapping(root, task.directory)
        const initial = await ContractNative.snapshot(task.directory, checkpoints)
        const verifier = await prepareVerifier(root, checkpoints, task.verifier)
        if (task.environment) {
          nonoverlapping(root, task.environment.directory)
          const environment = await ContractEnvironment.checked(task.environment)
          if (
            "programbench" in task.verifier &&
            (await ContractProgramBench.checked(task.verifier.programbench)).image !== environment.manifest.image
          )
            throw new Error("Original task and evaluator environments differ")
        }
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
            environment: task.environment,
            reserveBytes: config.reserveBytes,
            allowPropose:
              config.proposals === undefined ||
              Object.values(state.proposals).filter((proposal) => proposal.task === task.id).length < config.proposals,
          })
          store.checkpoint(task.id, current.execution, result.checkpoint, result.handoff.summary)
          delete current.execution
          await check()
          if (result.handoff.action === "blocked") {
            if (task.verification === "terminal") {
              const grade = await ContractNative.grade({
                root,
                runtime: config.runtime,
                verifier: verifier.value,
                checkpoint: result.checkpoint,
                deadline,
                signal: controller.signal,
              })
              if (grade.result.total !== task.total) throw new Error("Blocked task verifier denominator changed")
              await Bun.write(
                path.join(root, "FINAL_SCORE.json"),
                JSON.stringify({ task: task.id, checkpoint: result.checkpoint, disposition: "blocked", ...grade }),
              )
            }
            store.interrupted(task.id, result.handoff.summary, true)
            break
          }
          if (result.handoff.action === "checkpoint") continue
          if (result.handoff.action === "submit") {
            const grade = await ContractNative.grade({
              root,
              runtime: config.runtime,
              verifier: verifier.value,
              checkpoint: result.checkpoint,
              deadline,
              signal: controller.signal,
            })
            if (grade.result.total !== task.total) throw new Error("Original task verifier denominator changed")
            await Bun.write(
              path.join(root, "FINAL_SCORE.json"),
              JSON.stringify({ task: task.id, checkpoint: result.checkpoint, disposition: "submitted", ...grade }),
            )
            store.settleTask(task.id, grade.result, task.verification)
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
                const observation = await ContractNative.evaluate({
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
                  environment: test.environment,
                  reserveBytes: config.reserveBytes,
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
                    verifier: test.verifierHash,
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
            (
              await Bun.file(path.join(root, "executions", current.execution, "FENCED.json"))
                .json()
                .catch(() => undefined)
            )?.acknowledged === true
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

async function prepareVerifier(root: string, checkpoints: string, verifier: ContractNative.Verifier) {
  if ("programbench" in verifier) {
    await ContractProgramBench.checked(verifier.programbench)
    return { value: verifier, hash: RSI.hash(verifier) }
  }
  nonoverlapping(root, verifier.directory)
  if (!verifier.command.length) throw new Error("Explicit verifier command required")
  const frozen = await ContractNative.snapshot(verifier.directory, checkpoints)
  return {
    value: { directory: frozen.directory, command: verifier.command },
    hash: RSI.hash({ source: frozen.hash, command: verifier.command }),
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
      [runtime.bun, runtime.python, runtime.bwrap, ...(runtime.rg ? [runtime.rg] : [])].map(async (file) => ({
        path: file,
        hash: Bun.SHA256.hash(await Bun.file(file).bytes(), "hex"),
      })),
    ),
    toolCgroup: runtime.toolCgroup,
  })
}

function nonoverlapping(root: string, directory: string) {
  if (!path.isAbsolute(directory)) throw new Error("Absolute source directories required")
  if (directory === root || directory.startsWith(root + path.sep) || root.startsWith(directory + path.sep))
    throw new Error("Private state must not overlap candidate or verifier inputs")
}
