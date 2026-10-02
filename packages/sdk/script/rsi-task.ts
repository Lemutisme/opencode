// Host-owned public task checkpoints. Neither a candidate handoff nor its
// private Session database can authorize completion or become execution state.
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { hash } from "../../core/script/ota-rsi"
import { Artifacts } from "../../core/script/ota-supervisor"
import type { Job } from "../../core/script/ota-supervisor"
import { ContractDelivery } from "./contract-delivery"
import type { NativeConfiguration, NativeObservation, NativeTask } from "./rsi-driver"
import { RSIRuntime } from "./rsi-runtime"

export namespace RSITask {
  export const Checkpoint = Schema.Struct({
    kind: Schema.Literal("native-rsi-task-v1"),
    task: Schema.String,
    goal: Schema.String,
    image: Schema.String,
    workspace: RSIRuntime.File,
    obligations: Schema.Array(ContractDelivery.Obligation),
    summary: Schema.String,
    parent: Schema.optional(Schema.String),
  })
  export type Checkpoint = typeof Checkpoint.Type

  const Handoff = Schema.Struct({
    kind: Schema.Literal("programbench-handoff"),
    result: Schema.Struct({
      state: Schema.Literals(["revise", "ready", "blocked"]),
      summary: Schema.optional(Schema.String),
      reason: Schema.optional(Schema.String),
      snapshot: Schema.optional(Schema.String),
      probes: Schema.optional(Schema.Int),
      authoritativeCompletion: Schema.optional(Schema.Literal(false)),
    }),
    obligations: Schema.Array(ContractDelivery.Obligation),
  })

  export async function load(root: string, digest: string) {
    const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Checkpoint))(
      await Bun.file(await new Artifacts(path.join(root, "objects")).get(digest)).text(),
      { onExcessProperty: "error" },
    )
    if (
      !manifest.task.trim() ||
      !manifest.goal.trim() ||
      !/^sha256:[a-f0-9]{64}$/.test(manifest.image) ||
      (manifest.parent !== undefined && !/^[a-f0-9]{64}$/.test(manifest.parent))
    )
      throw new Error("invalid task checkpoint identity")
    await RSIRuntime.checked(manifest.workspace)
    const info = await fs.lstat(manifest.workspace.path)
    if (info.size <= 0 || info.size > 1024 ** 3) throw new Error("invalid task workspace size")
    retained([], manifest.obligations)
    return manifest
  }

  export async function task(root: string, input: { id: string; checkpoint: string }): Promise<NativeTask> {
    const manifest = await load(root, input.checkpoint)
    if (manifest.task !== input.id) throw new Error("task checkpoint belongs to another task")
    const artifacts = new Artifacts(path.join(root, "objects"))
    const obligations = await artifacts.put(new TextEncoder().encode(JSON.stringify(manifest.obligations)))
    return {
      identity: manifest.task,
      mode: "programbench",
      artifact: "submission",
      goal: `${manifest.goal}\n\nPublic predecessor summary (advisory, not a replacement goal or completion authority):\n${manifest.summary}`,
      image: manifest.image,
      files: {
        "workspace.tar": manifest.workspace,
        "obligations.json": await RSIRuntime.ref(await artifacts.get(obligations)),
      },
    }
  }

  export function continuation(
    root: string,
    verify: (input: NativeObservation & { job: Job }) => Promise<{ passed: number; total: number; valid: boolean }>,
    options?: { partial: "revise" | "blocked" },
  ): NonNullable<NativeConfiguration["continuation"]> {
    return {
      task: async (job) => {
        if (!job.task) throw new Error("task continuation requires a bound task")
        return task(root, job.task)
      },
      settle: async (input) => {
        if (!input.job.task || input.job.purpose !== "continuation" || input.deadline !== input.job.deadline)
          throw new Error("task continuation admission mismatch")
        live(input)
        const signal = AbortSignal.any([input.signal, AbortSignal.timeout(Math.max(1, input.deadline - Date.now()))])
        if (
          !path.isAbsolute(input.run) ||
          (await fs.realpath(input.run)) !== input.run ||
          path.dirname(input.run) !== path.join(root, "native")
        )
          throw new Error("task run must be a host-owned native allocation")
        await fenced(path.join(input.run, "FENCED.json"))
        const previous = await load(root, input.job.task.checkpoint)
        if (previous.task !== input.job.task.id) throw new Error("task checkpoint belongs to another task")
        if (input.artifact.length > 16 * 1024 * 1024) throw new Error("task handoff exceeds artifact bound")
        const handoff = Schema.decodeUnknownSync(Schema.fromJsonString(Handoff))(
          new TextDecoder("utf-8", { fatal: true }).decode(input.artifact),
          { onExcessProperty: "error" },
        )
        retained(previous.obligations, handoff.obligations)
        live({ ...input, signal })
        const verification = handoff.result.state === "ready" ? await verify({ ...input, signal }) : null
        if (
          handoff.result.state === "ready" &&
          (!verification ||
            verification.valid !== true ||
            !Number.isSafeInteger(verification.passed) ||
            !Number.isSafeInteger(verification.total) ||
            verification.total <= 0 ||
            verification.passed < 0 ||
            verification.passed > verification.total)
        )
          throw new Error("invalid independent task verification")
        live({ ...input, signal })
        const outcome =
          handoff.result.state === "blocked" ||
          (verification && verification.passed < verification.total && options?.partial === "blocked")
            ? "blocked"
            : verification && verification.passed === verification.total
              ? "delivered"
              : "revise"
        const directory = path.join(root, "task-objects")
        await fs.mkdir(directory, { recursive: true, mode: 0o700 })
        const temporary = path.join(directory, `snapshot-${crypto.randomUUID()}.tar`)
        await RSIRuntime.run(
          [
            "python3",
            path.join(import.meta.dir, "rsi-files.py"),
            "snapshot",
            path.join(input.run, "candidate/workspace"),
            temporary,
          ],
          { signal, timeout: Math.min(300_000, Math.max(1, input.deadline - Date.now())) },
        )
        live({ ...input, signal })
        const snapshot = await RSIRuntime.ref(temporary)
        const workspace = { path: path.join(directory, snapshot.sha256), sha256: snapshot.sha256 }
        // Exclusive linking followed by unlinking avoids replacing an existing
        // sealed archive; a canonical duplicate is checked rather than rewritten.
        await fs.link(temporary, workspace.path).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error
          await RSIRuntime.checked(workspace)
        })
        await fs.unlink(temporary)
        await RSIRuntime.checked(workspace)
        const sealed = await fs.open(directory, "r")
        try {
          await sealed.sync()
        } finally {
          await sealed.close()
        }
        const artifacts = new Artifacts(path.join(root, "objects"))
        const checkpoint = await artifacts.put(
          new TextEncoder().encode(
            JSON.stringify({
              ...previous,
              workspace,
              obligations: handoff.obligations,
              summary: handoff.result.summary ?? handoff.result.reason ?? previous.summary,
              parent: input.job.task.checkpoint,
            } satisfies Checkpoint),
          ),
        )
        const receipt = await artifacts.put(
          new TextEncoder().encode(
            JSON.stringify({
              previous: input.job.task.checkpoint,
              checkpoint,
              producer: input.job.pair,
              job: input.job.id,
              deadline: input.deadline,
              outcome,
              verification,
            }),
          ),
        )
        live({ ...input, signal })
        return { previous: input.job.task.checkpoint, checkpoint, receipt, outcome }
      },
    }
  }

  function live(input: Pick<NativeObservation, "signal" | "deadline">) {
    input.signal.throwIfAborted()
    if (Date.now() >= input.deadline) throw new Error("original task deadline reached")
  }

  async function fenced(file: string) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 65536)
        throw new Error("host fence acknowledgement must be a bounded regular file")
      const value = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ name: Schema.String, time: Schema.Int })),
      )((await handle.readFile()).toString("utf8"), { onExcessProperty: "error" })
      if (!value.name || value.time < 0 || value.time > Date.now())
        throw new Error("invalid host fence acknowledgement")
    } finally {
      await handle.close()
    }
  }

  function retained(
    previous: readonly (typeof ContractDelivery.Obligation.Type)[],
    next: readonly (typeof ContractDelivery.Obligation.Type)[],
  ) {
    const obligations = new Map(next.map((item) => [hash(canonical(item.probe)), canonical(item.expected)]))
    if (obligations.size !== next.length) throw new Error("duplicate public obligation")
    for (const item of previous) {
      if (obligations.get(hash(canonical(item.probe))) !== canonical(item.expected))
        throw new Error("retained public obligation was removed or redefined")
    }
  }

  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    if (value !== null && typeof value === "object")
      return `{${Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left === right ? 0 : 1))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error("public obligation must contain only JSON values")
    return encoded
  }
}
