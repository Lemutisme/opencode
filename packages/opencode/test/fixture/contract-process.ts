import { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import { ProContract } from "@opencode-ai/schema/pro-contract"
import { Permission } from "@opencode-ai/schema/permission"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { OpenCodeExecution } from "@opencode-ai/protocol/groups/pro-contract"
import type { Binding } from "@opencode-ai/core/pro-contract/open-code"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import type { Command, Decision } from "@opencode-ai/core/pro-contract/kernel"
import { mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { pollWithTimeout } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { tmpdirScoped } from "./fixture"

const authorization = `Basic ${btoa("opencode:contract-process-test")}`

export const contractProcess = Effect.gen(function* () {
  const upstream = yield* TestLLMServer
  const storage = yield* tmpdirScoped()
  const candidate = yield* tmpdirScoped({ git: true })
  const database = path.join(storage, "opencode.db")
  yield* Effect.promise(async () => {
    await mkdir(path.join(storage, "tmp"))
    await Bun.write(
      path.join(candidate, "opencode.json"),
      JSON.stringify({
        providers: {
          local: {
            api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: upstream.url },
            models: { researcher: { limit: { context: 100_000, output: 4_000 } } },
          },
        },
        permissions: [{ action: "edit", resource: "*", effect: "allow" }],
      }),
    )
  })

  const env = {
    PATH: process.env.PATH ?? "",
    LANG: "C.UTF-8",
    TMPDIR: path.join(storage, "tmp"),
    XDG_DATA_HOME: path.join(storage, "data"),
    XDG_CONFIG_HOME: path.join(storage, "config"),
    XDG_CACHE_HOME: path.join(storage, "cache"),
    XDG_STATE_HOME: path.join(storage, "state"),
    OPENCODE_TEST_HOME: path.join(storage, "home"),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(storage, "managed"),
    OPENCODE_DB: database,
    OPENCODE_SERVER_PASSWORD: "contract-process-test",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_MODELS_PATH: path.join(import.meta.dir, "../tool/fixtures/models-api.json"),
  }

  const start = Effect.fnUntraced(function* () {
    const id = crypto.randomUUID()
    const ready = path.join(storage, `${id}.ready`)
    const log = Bun.file(path.join(storage, `${id}.log`))
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn([process.execPath, path.join(import.meta.dir, "contract-server-process.ts"), ready], {
          cwd: candidate,
          // Allowlist the environment: provider credentials and user configuration must not reach the child.
          env,

          stdin: "ignore",
          stdout: log,
          stderr: log,
        }),
      ),
      (child) =>
        Effect.promise(async () => {
          if (child.exitCode === null) child.kill("SIGKILL")
          await child.exited
        }),
    )
    const url = yield* pollWithTimeout(
      Effect.promise(async () => {
        if (child.exitCode !== null) throw new Error(`Server exited: ${await log.text()}`)
        // BunFile caches a missing stat; each readiness poll must reopen the path.
        return (await Bun.file(ready).exists()) ? new URL(await Bun.file(ready).text()) : undefined
      }),
      "Production server never published its listening address",
      "30 seconds",
    ).pipe(Effect.tapError(() => Effect.promise(async () => console.error(await log.text()))))

    const request = Effect.fnUntraced(function* (route: string, body?: unknown) {
      const response = yield* Effect.promise(() =>
        fetch(new URL(route, url), {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        }),
      )
      const text = yield* Effect.promise(() => response.text())
      if (!response.ok) return yield* Effect.fail(new Error(`${route}: ${response.status} ${text}`))
      return text ? (JSON.parse(text) as unknown) : undefined
    })
    const get = (id: string) =>
      request(`/api/contract/${id}`).pipe(
        Effect.map(Schema.decodeUnknownSync(Schema.Struct({ data: ProContract.Info }))),
        Effect.map((result) => result.data),
      )
    const execution = (id: string) =>
      request(`/api/contract/${id}/execution`).pipe(Effect.map(Schema.decodeUnknownSync(OpenCodeExecution)))
    const context = (sessionID: string) =>
      request(`/api/session/${sessionID}/context`).pipe(
        Effect.map(Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(SessionMessage.Message) }))),
        Effect.map((result) => result.data),
      )
    const permissions = (sessionID: string) =>
      request(`/api/session/${sessionID}/permission`).pipe(
        Effect.map(Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Permission.Request) }))),
        Effect.map((result) => result.data),
      )
    const idle = (sessionID: string) =>
      pollWithTimeout(
        request("/api/session/active").pipe(
          Effect.map(Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) }))),
          Effect.map((result) => (sessionID in result.data ? undefined : true)),
        ),
        `Session ${sessionID} never became inactive`,
        "20 seconds",
      )
    return {
      url,
      authorization,
      child,
      request,
      get,
      execution,
      context,
      idle,
      permissions,
      kill: Effect.promise(async () => {
        child.kill("SIGKILL")
        await child.exited
      }),
      issue: (id: string, evidence?: ProContract.Evidence, trigger?: ProContract.Trigger) =>
        request("/api/contract", {
          id,
          scope: "process-e2e",
          goal: "Implement and check answer.ts",
          location: { directory: candidate },
          model: { providerID: "local", id: "researcher" },
          authority: ["filesystem.read", "filesystem.write", ...(evidence?.replay ? ["process.execute"] : [])],
          budget: { deadline: Date.now() + 180_000 },
          resolution: { maxAttempts: 3, retryDelay: 60_000 },
          evidence,
          trigger,
        }).pipe(Effect.asVoid),
      status: (id: string, status: ProContract.Status) =>
        pollWithTimeout(
          get(id).pipe(Effect.map((contract) => (contract.status === status ? contract : undefined))),
          `Contract ${id} never reached ${status}`,
          "20 seconds",
        ).pipe(Effect.tapError(() => Effect.promise(async () => console.error(await log.text())))),
      permission: (sessionID: string) =>
        pollWithTimeout(
          permissions(sessionID).pipe(Effect.map((items) => items.find((item) => item.action === "contract_revision"))),
          "Revision never requested approval",
          "20 seconds",
        ),
      settled: (sessionID: string, count: number) =>
        pollWithTimeout(
          context(sessionID).pipe(
            Effect.map((messages) => {
              const tools = messages.flatMap((message) =>
                message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
              )
              return tools.length === count && tools.every((tool) => ["error", "completed"].includes(tool.state.status))
                ? tools
                : undefined
            }),
          ),
          `Session ${sessionID} did not settle ${count} tools`,
          "20 seconds",
        ).pipe(
          Effect.tap(() => idle(sessionID)),
          Effect.tapError(() => Effect.promise(async () => console.error(await log.text()))),
        ),
    }
  })

  const startHost = Effect.fnUntraced(function* (
    loaded: boolean,
    options?: {
      readonly actionFusion?: boolean
      readonly research?: boolean
      readonly nativeAdvisory?: boolean
      readonly nativeCheckpoints?: boolean
      readonly checkpoints?: boolean
      readonly sandbox?: ReadonlyArray<string>
    },
  ) {
    const ready = Promise.withResolvers<string>()
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
    const log = Bun.file(path.join(storage, `${crypto.randomUUID()}.host.log`))
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn(
          [
            ...(options?.sandbox ?? []),
            process.execPath,
            path.join(
              import.meta.dir,
              options?.nativeCheckpoints
                ? "native-advisory-checkpoint-process.ts"
                : options?.checkpoints
                  ? "research-checkpoint-process.ts"
                  : "contract-driver-process.ts",
            ),
            loaded ? "loaded" : "missing",
            options?.research ? "research" : "",
            // Explicit test-run switch exercises legacy Research handlers in the combined SDK graph.
            options?.nativeAdvisory || process.env.OPENCODE_TEST_NATIVE_ADVISORY === "1" ? "native-advisory" : "",
          ],
          {
            cwd: candidate,
            env: {
              ...env,
              ...(options?.sandbox
                ? { HOME: path.join(storage, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
                : {}),
              OPENCODE_ACTION_FUSION: options?.actionFusion ? "1" : "0",
            },
            stdin: "ignore",
            stdout: log,
            stderr: log,
            ipc(message: { ready?: boolean; owner?: string; id?: string; result?: unknown; error?: string }) {
              if (message.ready) {
                ready.resolve(message.owner!)
                return
              }
              const response = pending.get(message.id!)
              if (!response) return
              pending.delete(message.id!)
              if (message.error) response.reject(new Error(message.error))
              else response.resolve(message.result)
            },
          },
        ),
      ),
      (child) =>
        Effect.promise(async () => {
          if (child.exitCode === null) child.kill("SIGKILL")
          await child.exited
          pending.forEach((response) => response.reject(new Error("Host stopped")))
          pending.clear()
        }),
    )
    void child.exited.then(async () =>
      ready.reject(new Error(`Host exited with ${child.exitCode}, signal ${child.signalCode}: ${await log.text()}`)),
    )
    const owner = yield* Effect.promise(() => ready.promise).pipe(
      Effect.timeout("30 seconds"),
      Effect.tapError(() => Effect.promise(async () => console.error(await log.text()))),
    )
    return {
      owner,
      child,
      log: () => Effect.promise(() => log.text()),
      command: (action: string, contractID: string, input?: unknown) =>
        Effect.promise(() => {
          const id = crypto.randomUUID()
          return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
              pending.delete(id)
              reject(new Error(`Host command ${action} timed out`))
            }, 10_000)
            pending.set(id, {
              resolve: (value) => {
                clearTimeout(timer)
                resolve(value)
              },
              reject: (error) => {
                clearTimeout(timer)
                reject(error)
              },
            })
            child.send({ id, action, contractID, input })
          })
        }),
      kill: Effect.promise(async () => {
        child.kill("SIGKILL")
        await child.exited
      }),
    }
  })

  // The production API has no ledger/generation endpoint. Inspect committed disk data read-only;
  // never mutate the binding or replace the scheduler to manufacture a takeover.
  const inspect = <A>(read: (db: Database) => A) =>
    Effect.sync(() => {
      using db = new Database(database, { readonly: true })
      db.exec("PRAGMA busy_timeout = 5000")
      return read(db)
    })
  return {
    start,
    startHost,
    cli: (args: ReadonlyArray<string>) =>
      Effect.promise(async () => {
        const child = Bun.spawn(
          [process.execPath, path.join(import.meta.dir, "../../src/index.ts"), "contract", ...args],
          {
            cwd: candidate,
            env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const timer = setTimeout(() => child.kill("SIGKILL"), 30_000)
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        clearTimeout(timer)
        return { exit, stdout, stderr }
      }),
    directory: candidate,
    storage,
    researchRun: (id: string) =>
      inspect((db) => {
        const row = db.query<{ data: string }, [string]>("SELECT data FROM sdk_research_run_v1 WHERE id = ?").get(id)
        if (!row) throw new Error(`Missing research: ${id}`)
        return JSON.parse(row.data) as ResearchModel.Run
      }),
    reports: Effect.promise(async () => {
      const directory = path.join(storage, "data/opencode/pro-contract/replay")
      return Promise.all(
        (await readdir(directory)).map((name) => Bun.file(path.join(directory, name)).json() as Promise<unknown>),
      )
    }),
    binding: (id: string) =>
      inspect((db) => {
        const row = db
          .query<{ data: string }, [string]>("SELECT data FROM pro_contract_opencode WHERE contract_id = ?")
          .get(id)
        if (!row) throw new Error(`Missing binding: ${id}`)
        return JSON.parse(row.data) as Binding
      }),
    operations: (id: string) =>
      inspect((db) =>
        db
          .query<{ data: string }, [string]>("SELECT data FROM pro_contract_operation_usage WHERE contract_id = ?")
          .all(id)
          .map((row) => JSON.parse(row.data) as ProContractJob.Operation),
      ),
    ledger: (id: string) =>
      inspect((db) =>
        db
          .query<{ seq: number; command: string; decision: string; previous_hash: string; hash: string }, [string]>(
            "SELECT seq, command, decision, previous_hash, hash FROM pro_contract_event WHERE contract_id = ? ORDER BY seq",
          )
          .all(id)
          .map((row) => ({
            ...row,
            command: JSON.parse(row.command) as Command,
            decision: JSON.parse(row.decision) as Decision,
          })),
      ),
  }
})
