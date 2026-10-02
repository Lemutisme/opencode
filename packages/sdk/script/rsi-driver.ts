// Trusted adapter. This module and the grader are never loaded from candidate H.
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { hash } from "../../core/script/ota-rsi"
import type { Protocol, State } from "../../core/script/ota-rsi"
import type { Continuation, Driver, Job } from "../../core/script/ota-supervisor"
import { RSIRuntime } from "./rsi-runtime"
import { RSINative } from "./rsi-native"
import type { NativeBridge } from "./rsi-bridge"

export type NativeTask = {
  identity?: string
  goal: string
  artifact: string
  files?: Record<string, RSIRuntime.File>
  image?: string
  mode?: "programbench" | "bridge" | "tau"
  bridge?: NativeBridge
  allowRevise?: boolean
}
export type NativeObservation = {
  artifact: Uint8Array
  state: string
  run: string
  release: RSIRuntime.Release
  deadline: number
  signal: AbortSignal
}
export type NativeConfiguration = {
  root: string
  provider: RSINative.Provider
  authority: RSIRuntime.File[]
  dispose?(): Promise<void>
  development?: { goal: string; files: Record<string, RSIRuntime.File> }
  task(test: Protocol["tests"][number], task?: Job["task"]): NativeTask | Promise<NativeTask>
  grade(
    input: NativeObservation & { test: Protocol["tests"][number] },
  ): Promise<{ passed: number; total: number; valid: boolean }>
  continuation?: {
    task(job: Job): Promise<NativeTask>
    settle(input: NativeObservation & { job: Job }): Promise<Continuation>
  }
}

export function nativeDriver(config: NativeConfiguration): Driver {
  const workers = new Set<RSINative.Process>()
  const state = (): State => {
    const db = new Database(path.join(config.root, "ota.sqlite"), { readonly: true })
    try {
      return JSON.parse(db.query<{ value: string }, []>("SELECT value FROM ota_state WHERE id=1").get()!.value)
    } finally {
      db.close()
    }
  }
  const scope = (phase: "running" | "evaluating"): RSINative.OTAScope => {
    const current = state()
    if (current.stopped || !current.job || current.job.phase !== phase) throw new Error("no current issuer admission")
    return {
      database: path.join(config.root, "ota.sqlite"),
      protocol: current.protocol,
      epoch: current.epoch,
      job: current.job.id,
      phase,
      incumbent: current.active.pair,
      purpose: current.job.purpose,
      task: current.task ? { id: current.task.id, checkpoint: current.task.checkpoint } : undefined,
    }
  }
  const create = () => {
    const worker = new RSINative.Process(config.root, config.provider)
    workers.add(worker)
    return worker
  }
  return {
    fingerprint: async () => {
      const development = Object.values(config.development?.files ?? {})
      await Promise.all([...config.authority, ...development, config.provider.gateway].map(RSIRuntime.checked))
      const files = [
        "rsi-driver.ts",
        "rsi-native.ts",
        "rsi-runtime.ts",
        "rsi-gateway.py",
        "rsi-bridge.ts",
        "rsi-safety.ts",
        "rsi-files.py",
        "rsi-task.ts",
        "contract-delivery.ts",
        "../../core/script/ota-rsi.ts",
        "../../core/script/ota-supervisor.ts",
        "../../core/script/ota-run.ts",
        "../../core/src/pro-contract/kernel.ts",
        "../../schema/src/pro-contract.ts",
        "../../schema/src/schema.ts",
        "../../schema/src/identifier.ts",
        "../../util/src/hash.ts",
      ]
      const sources = await Promise.all(files.map((file) => RSIRuntime.ref(path.join(import.meta.dir, file))))
      const inputs = {
        files: sources,
        authority: config.authority,
        gateway: config.provider.gateway,
        model: config.provider.model,
        effort: config.provider.effort,
        upstream: config.provider.upstream,
        fixture: config.provider.fixture ?? false,
        development: config.development,
      }
      const directory = path.join(config.root, "authority")
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      for (const file of [...sources, ...config.authority, ...development, config.provider.gateway]) {
        const bytes = await Bun.file(file.path).bytes()
        if (hash(bytes) !== file.sha256) throw new Error("authority changed while sealing")
        const target = path.join(directory, file.sha256)
        if (!(await Bun.file(target).exists())) await fs.writeFile(target, bytes, { flag: "wx", mode: 0o400 })
      }
      const digest = hash(JSON.stringify(inputs))
      const manifest = path.join(directory, digest + ".json")
      if (!(await Bun.file(manifest).exists()))
        await fs.writeFile(manifest, JSON.stringify(inputs), { flag: "wx", mode: 0o400 })
      return digest
    },
    fence: async () => {
      await RSIRuntime.fence(config.root)
      await Promise.all(
        [...workers].map(async (worker) => {
          await worker.close()
          workers.delete(worker)
        }),
      )
    },
    prepare: async (input) => {
      if (input.job.mutable === "s") {
        const bytes = await Bun.file(input.proposal).bytes()
        const text = Buffer.from(bytes).toString("utf8")
        if (
          !text.trim() ||
          text.includes("\0") ||
          bytes.length > 65536 ||
          !Buffer.from(text).equals(Buffer.from(bytes))
        )
          return { rejected: true, reason: "strategy must be nonempty UTF-8 and at most 64 KiB", receipt: hash(bytes) }
        return bytes
      }
      return RSIRuntime.build(
        config.root,
        await RSIRuntime.release((input.job.source?.pair ?? input.job.pair).h),
        input.proposal,
        input.signal,
      ).catch((error: unknown) => {
        if (error instanceof RSIRuntime.Rejected)
          return { rejected: true as const, reason: error.message, receipt: error.receipt }
        throw error
      })
    },
    start: async (job) => {
      const execution = scope("running")
      if (job.id !== execution.job || job.epoch !== execution.epoch) throw new Error("stale native job")
      const parent = job.source?.pair ?? job.pair
      const release = await RSIRuntime.release(job.pair.h)
      const worker = create()
      const task = job.task ? await config.continuation?.task(job) : undefined
      if (job.task && !task) throw new Error("task scope requires a trusted continuation adapter")
      if (job.purpose === "continuation") {
        if (!task || !config.continuation) throw new Error("missing task continuation adapter")
        const completed: { handoff?: Awaited<ReturnType<RSINative.Process["complete"]>>; stopped: boolean } = {
          stopped: false,
        }
        await worker
          .launch({
            ...task,
            release,
            strategy: job.pair.s,
            deadline: job.deadline,
            scope: execution,
            allowRevise: true,
          })
          .catch(async (error) => {
            await worker.close()
            await worker.accounting()
            throw error
          })
        const result = worker.complete().then((handoff) => {
          completed.handoff = handoff
        })
        void result.catch(() => undefined)
        return {
          result,
          progress: () => worker.progress(),
          stop: async () => {
            await worker.close()
            completed.stopped = true
            workers.delete(worker)
            return worker.accounting()
          },
          continuation: async (signal) => {
            if (!completed.stopped || !completed.handoff || Date.now() >= job.deadline)
              throw new Error("no fenced live task handoff")
            return config.continuation!.settle({
              job,
              artifact: await worker.artifact(task.artifact, completed.handoff.digest),
              run: worker.directory,
              state: path.join(worker.directory, "state"),
              release,
              deadline: job.deadline,
              signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, job.deadline - Date.now()))]),
            })
          },
        }
      }
      const source = job.mutable === "h" ? await RSIRuntime.release(parent.h) : undefined
      const checkpoint = job.memory.checkpoint ?? job.memory.origin
      const memory = checkpoint ? await Bun.file(path.join(config.root, "memory", checkpoint)).bytes() : undefined
      if (memory && hash(memory) !== checkpoint) throw new Error("public checkpoint changed")
      const goal =
        `Improve the inactive ${job.mutable === "h" ? "complete native V2 harness" : "strategy"} partition. The active harness and strategy remain read-only.\n` +
        (source
          ? "Parent source is in /candidate/source, with a clean Git baseline. Change execution behavior there and export a nonempty git diff --binary (including new files) to /candidate/h. The release includes the entire source and fixed dependency/toolchain closure, not a prompt-only shim. External Kernel, gateway, grader and supervisor are not mutable H.\n"
          : "Parent strategy is /task/parent-strategy. Write an improved UTF-8 policy to /candidate/s (at most 64 KiB).\n") +
        `Prior public handoff (advisory, not authority): ${memory ? new TextDecoder().decode(memory) : "none"}. Allocation: ${job.id}. Source parent: ${job.source?.id ?? "active root"}. Development-only feedback: ${JSON.stringify(job.feedback ?? null)}. Original deadline: ${job.deadline}. Do not claim evaluation or promotion authority.` +
        (config.development
          ? `\nFrozen development-only context: ${config.development.goal}. Public inputs: ${Object.keys(
              config.development.files,
            )
              .map((name) => "/task/" + name)
              .join(", ")}.`
          : "") +
        (task
          ? `\nThis is a task-local replacement, never a global default. Continue improving the agent for this SAME task: ${task.goal}. Its sealed public workspace and obligations are read-only /task files. Task identity: ${job.task!.id}; checkpoint: ${job.task!.checkpoint}. Task output changes alone are not an S/H improvement.`
          : "")
      await worker
        .launch({
          release,
          strategy: job.pair.s,
          deadline: job.deadline,
          artifact: job.mutable,
          goal,
          scope: execution,
          source,
          files: {
            ...config.development?.files,
            ...task?.files,
            ...(!source ? { "parent-strategy": await RSIRuntime.ref(parent.s) } : {}),
          },
        })
        .catch(async (error) => {
          await worker.close()
          await worker.accounting()
          throw error
        })
      const completed: { handoff?: Awaited<ReturnType<RSINative.Process["complete"]>> } = {}
      const result = worker.complete().then((handoff) => {
        completed.handoff = handoff
      })
      void result.catch(() => undefined)
      return {
        result,
        progress: () => worker.progress(),
        stop: async () => {
          await worker.close()
          workers.delete(worker)
          if (completed.handoff)
            await fs.writeFile(
              path.join(job.output, job.mutable),
              await worker.artifact(job.mutable, completed.handoff.digest),
              { flag: "wx", mode: 0o600 },
            )
          const accounting = await worker.accounting()
          if (!completed.handoff) return accounting
          const memory = JSON.stringify({
            summary: completed.handoff.summary,
            proposal: completed.handoff.digest,
            parent: job.source?.id,
          })
          const checkpoint = hash(memory)
          await fs.mkdir(path.join(config.root, "memory"), { recursive: true, mode: 0o700 })
          const file = path.join(config.root, "memory", checkpoint)
          if (!(await Bun.file(file).exists())) await fs.writeFile(file, memory, { flag: "wx", mode: 0o400 })
          return { ...accounting, checkpoint }
        },
      }
    },
    evaluate: (input) => evaluateNative(config, input, scope("evaluating")),
  }
}

// Both selection and audit execute the supplied release; grading never launches a fixed worker.
export async function evaluateNative(
  config: NativeConfiguration,
  input: Parameters<Driver["evaluate"]>[0],
  scope: RSINative.Scope,
) {
  const task = await config.task(input.test, input.task)
  if (!/^[a-z][a-z0-9_.-]*$/.test(task.artifact)) throw new Error("invalid evaluator output artifact")
  const release = await RSIRuntime.release(input.pair.h)
  const worker = new RSINative.Process(config.root, config.provider)
  const cancel = () => {
    void worker.close().catch(() => undefined)
  }
  input.signal.addEventListener("abort", cancel, { once: true })
  try {
    input.signal.throwIfAborted()
    await worker.launch({
      ...task,
      release,
      strategy: input.pair.s,
      deadline: input.deadline,
      scope,
      allowRevise: false,
    })
    const handoff = await worker.complete()
    await worker.close()
    input.signal.throwIfAborted()
    const artifact = await worker.artifact(task.artifact, handoff.digest)
    return {
      ...(await config.grade({
        test: input.test,
        artifact,
        state: path.join(worker.directory, "state"),
        run: worker.directory,
        release,
        deadline: input.deadline,
        signal: input.signal,
      })),
      accounting: await worker.accounting(),
    }
  } finally {
    input.signal.removeEventListener("abort", cancel)
    try {
      await worker.close()
    } finally {
      try {
        await worker.accounting()
      } finally {
        await task.bridge?.finish()
      }
    }
  }
}
