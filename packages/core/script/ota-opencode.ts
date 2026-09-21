import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { hash } from "./ota-rsi"
import type { Protocol } from "./ota-rsi"
import type { Driver, Job } from "./ota-supervisor"
import { artifact, checked, fence, Native, reference, release, run } from "./ota-native"
import type { FileRef, Provider, Release } from "./ota-native"

export type Supplies = { image: string; files: { "dependencies.tar": FileRef; bun: FileRef; "models.json": FileRef } }
export type Task = { goal: string; brief: string; artifact: string }
export type Configuration = {
  root: string
  supplies: Supplies
  provider: Provider
  // Hash of the operator-owned task/grader/profile closure, not candidate code.
  authority: FileRef[]
  task(test: Protocol["tests"][number]): Task
  grade(input: {
    test: Protocol["tests"][number]
    state: string
    run: string
    harness: Release
  }): Promise<{ passed: number; total: number; valid: boolean }>
}

const shell = path.join(import.meta.dir, "ota-release.sh")
class BuildRejected extends Error {
  constructor(
    message: string,
    readonly receipt: string,
  ) {
    super(message)
  }
}

export async function build(root: string, supplies: Supplies, parent: Release, patch: string, signal?: AbortSignal) {
  await Promise.all([checked(parent.source), ...Object.values(supplies.files).map(checked)])
  const directory = path.join(root, "builds", crypto.randomUUID())
  await mkdir(path.dirname(directory), { recursive: true })
  const cancel = () => {
    void fence(root)
  }
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    if (signal?.aborted) throw new Error("build cancelled")
    await run(
      [
        "bash",
        shell,
        "build",
        root,
        supplies.image,
        parent.source.path,
        supplies.files["dependencies.tar"].path,
        supplies.files.bun.path,
        supplies.files["models.json"].path,
        patch,
        directory,
      ],
      undefined,
      1_260_000,
    ).catch(async (error) => {
      const result = path.join(directory, "result.json")
      const outcome = (await Bun.file(result)
        .json()
        .catch(() => undefined)) as
        | { phase: string; exit_code: number; container_state: string; cleanup_confirmed: boolean }
        | undefined
      if (
        outcome &&
        ["source", "compile"].includes(outcome.phase) &&
        (outcome.exit_code === 1 || (outcome.phase === "source" && outcome.exit_code === 128)) &&
        outcome.container_state === "true false" &&
        outcome.cleanup_confirmed
      ) {
        const log = path.join(directory, outcome.phase === "source" ? "source.log" : "build.log")
        const receipt = path.join(directory, "rejection.json")
        await Bun.write(
          receipt,
          JSON.stringify({
            outcome: await reference(result),
            log: await reference(log),
            patch: await reference(patch),
            parent: parent.source,
            performanceEvaluated: false,
          }),
        )
        throw new BuildRejected((await Bun.file(log).text()).slice(-6000), (await reference(receipt)).sha256)
      }
      throw error
    })
    if (signal?.aborted) throw new Error("build cancelled")
    const artifact = {
      source: await reference(path.join(directory, "source.tar")),
      binary: await reference(path.join(directory, "opencode")),
    }
    const receipt = path.join(directory, "build.json")
    await Bun.write(
      receipt,
      JSON.stringify({
        ...artifact,
        parent: parent.source,
        patch: await reference(patch),
        supplies,
        sandbox: "offline-nonroot",
        deadlineOnly: true,
      }),
    )
    const value: Release = {
      kind: "opencode-release-v1",
      ...artifact,
      image: supplies.image,
      build: await reference(receipt),
    }
    await Bun.write(path.join(directory, "release.json"), JSON.stringify(value))
    return new TextEncoder().encode(JSON.stringify(value))
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
}

export function payload(id: string, strategy: string, deadline: number, task: Task, provider: Provider) {
  if (!/^[a-z][a-z0-9_.-]*$/.test(task.artifact)) throw new Error("task artifact must be a plain basename")
  return {
    id,
    scope: id,
    goal: task.goal,
    brief: task.brief,
    executionPolicy: strategy,
    requires: [],
    location: { directory: "/state/work" },
    model: { providerID: "openai", id: provider.model, variant: provider.effort },
    trigger: { type: "immediate" },
    authority: ["filesystem.read", "filesystem.write", "process.execute"],
    budget: { deadline },
    evidence: {
      type: "principal",
      claim: "Artifact handoff only; external qualification and promotion remain outside this worker.",
      replay: {
        checks: [
          {
            argv: [
              "python3",
              "-I",
              "-c",
              `import pathlib,stat;p=pathlib.Path(${JSON.stringify(task.artifact)});s=p.lstat();assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and 0<s.st_size<=16777216`,
            ],
            cwd: ".",
            timeout: 10_000,
            exit: 0,
          },
        ],
        protected: [],
        artifacts: [task.artifact],
      },
    },
    resolution: { maxAttempts: 3, retryDelay: 0 },
  }
}

/** The same full-release driver serves both real providers and native wire tests.
 * Only task definitions, the external provider, and external grading differ.
 */
export function driver(config: Configuration): Driver {
  const accounting = () => ({
    source: config.provider.fixture ? "scripted-provider-no-model" : "host-gateway-usage-ledger",
    knownCost: config.provider.fixture ? "0" : null,
    incomplete: !config.provider.fixture,
  })
  const memory = async (job: Job) => {
    const directory = path.join(config.root, "memory", job.memory.id)
    if (!/^e[0-9]+$/.test(job.memory.id) || (job.memory.parent && !/^e[0-9]+$/.test(job.memory.parent)))
      throw new Error("invalid state identity")
    const receipt = directory + ".json"
    if (await Bun.file(receipt).exists()) return directory
    await mkdir(path.dirname(directory), { recursive: true })
    if (job.memory.parent) {
      if (!job.memory.origin) throw new Error("missing parent memory attestation")
      await run(
        [
          "bash",
          shell,
          "fork-state",
          config.root,
          path.join(config.root, "memory", job.memory.parent),
          directory,
          receipt,
        ],
        undefined,
        120_000,
      )
      if ((await Bun.file(receipt).json()).tree_sha256 !== job.memory.origin)
        throw new Error("checkpoint does not match Kernel boot binding")
      return directory
    }
    await mkdir(directory, { recursive: false, mode: 0o700 })
    await Bun.write(receipt, JSON.stringify({ bootstrap: true, directory }))
    return directory
  }
  return {
    fingerprint: async () => {
      await Promise.all(config.authority.map(checked))
      const files = [
        "ota-rsi.ts",
        "ota-supervisor.ts",
        "ota-native.ts",
        "ota-opencode.ts",
        "ota-release.sh",
        "ota-files.py",
        "../src/pro-contract/kernel.ts",
        "../../schema/src/pro-contract.ts",
      ]
      return hash(
        JSON.stringify({
          source: await Promise.all(
            files.map(async (file) => hash(await Bun.file(path.join(import.meta.dir, file)).bytes())),
          ),
          authority: config.authority,
          supplies: config.supplies,
          gateway: config.provider.gateway,
          model: config.provider.model,
          effort: config.provider.effort,
          upstream: config.provider.upstream,
        }),
      )
    },
    fence: () => fence(config.root),
    prepare: async (input) => {
      if (input.job.mutable === "s") {
        const bytes = await readFile(input.proposal)
        if (!bytes.toString().trim() || bytes.includes(0) || bytes.length > 65_536)
          throw new Error("strategy must be bounded nonempty UTF-8")
        return bytes
      }
      return build(config.root, config.supplies, await release(input.job.pair.h), input.proposal, input.signal).catch(
        (error: unknown) => {
          if (error instanceof BuildRejected)
            return { rejected: true as const, reason: error.message, receipt: error.receipt }
          throw error
        },
      )
    },
    start: async (job) => {
      const state = await memory(job)
      const harness = await release(job.pair.h)
      const source = `/state/work/source-${harness.source.sha256.slice(0, 16)}`
      const task: Task = {
        goal: `Improve the inactive ${job.mutable === "h" ? "complete OpenCode harness" : "strategy"} partition`,
        brief:
          `Active mode ${job.slot}; only propose ${job.mutable}. Current strategy is read-only at /release/strategy. ` +
          (job.mutable === "h"
            ? `The full current source is at ${source}. All OpenCode execution components may change: context/compaction, memory/schema, tools, scheduling, dependencies, and implementation. Export a nonempty git diff --binary against its original HEAD to /state/work/h; include new files. Do not edit the external Kernel, grader, gateway or supervisor, which are not mounted. `
            : "Write the improved nonempty strategy to /state/work/s. Do not propose a harness change. ") +
          `Only the opposite artifact is admitted. Original deadline: ${job.deadline}. External development feedback: ${JSON.stringify(job.feedback ?? null)}. ` +
          "Use contract_check, then contract_report_ready for the artifact handoff. Do not claim test, performance or promotion authority.",
        artifact: job.mutable,
      }
      const issue = payload(
        `pct_ota_job_${hash(job.id + ":" + job.epoch)}`,
        await Bun.file(job.pair.s).text(),
        job.deadline,
        task,
        config.provider,
      )
      const native = new Native(
        config.root,
        path.join(config.root, "native", `${job.id}-e${job.epoch}`),
        config.provider,
      )
      await native.launch({ release: harness, state, policy: job.pair.s, payload: issue, deadline: job.deadline })
      const status = { completed: false }
      const result = (async () => {
        // Import into the worker, never into a privileged host checkout.
        await run(
          [
            "docker",
            "exec",
            native.name,
            "/bin/sh",
            "-eu",
            "-c",
            `
          rm -f -- /state/work/${job.mutable}
          if [ ! -d '${source}' ]; then
            mkdir '${source}'; tar -xf /release/source.tar -C '${source}'; cd '${source}'
            git -c core.hooksPath=/dev/null init -q
            git -c core.hooksPath=/dev/null add --force --all
            git -c core.hooksPath=/dev/null -c user.name=OTA -c user.email=ota@localhost -c commit.gpgsign=false commit -qm parent
          fi
        `,
          ],
          undefined,
          120_000,
        )
        await native.execute(issue, job.deadline)
        status.completed = true
      })()
      void result.catch(() => undefined)
      return {
        result,
        progress: () => native.progress(),
        stop: async () => {
          await native.close()
          // Copy only after acknowledgement. No model-supplied host paths.
          if (status.completed)
            await writeFile(path.join(job.output, job.mutable), await artifact(path.join(state, "work"), job.mutable), {
              flag: "wx",
              mode: 0o600,
            })
          return {
            ...accounting(),
            ...(status.completed
              ? {
                  checkpoint: (
                    await run(
                      ["python3", "-I", path.join(import.meta.dir, "ota-files.py"), "digest", state],
                      undefined,
                      120_000,
                    )
                  ).trim(),
                }
              : {}),
          }
        },
      }
    },
    evaluate: async (input) => {
      const harness = await release(input.pair.h)
      const name = `eval-${crypto.randomUUID()}`
      const state = path.join(config.root, "evaluation-state", name)
      await mkdir(state, { recursive: true, mode: 0o700 })
      const task = config.task(input.test)
      const issue = payload(`pct_${name}`, await Bun.file(input.pair.s).text(), input.deadline, task, config.provider)
      const native = new Native(config.root, path.join(config.root, "native", name), config.provider)
      const cancel = () => {
        void native.close()
      }
      input.signal.addEventListener("abort", cancel, { once: true })
      try {
        if (input.signal.aborted) throw new Error("evaluation cancelled")
        await native.launch({ release: harness, state, policy: input.pair.s, payload: issue, deadline: input.deadline })
        await native.execute(issue, input.deadline)
        await native.close()
        if (input.signal.aborted) throw new Error("evaluation cancelled")
        return {
          ...(await config.grade({ test: input.test, state, run: native.directory, harness })),
          accounting: accounting(),
          release: harness,
        }
      } finally {
        input.signal.removeEventListener("abort", cancel)
        await native.close()
      }
    },
  }
}
