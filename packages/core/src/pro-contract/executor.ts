export * as ProContractExecutor from "./executor"

import { Context, Duration, Effect, Layer, Option, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeLocationNode } from "../effect/app-node"
import { AppProcess } from "../process"

export interface Request {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly stdin?: string
  readonly timeout: number
}

/** Host-owned seam for an isolated worker. No model, credentials, or ledger is passed to it. */
export interface Interface {
  readonly identity: string
  readonly isolation: "local" | "isolated"
  readonly run: (request: Request) => Effect.Effect<Result, AppProcess.AppProcessError>
}

export interface Result {
  readonly execution: "completed" | "timed-out"
  readonly exitCode?: number
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractExecutor") {}

export const MAX_OUTPUT_BYTES = 1024 * 1024

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const processes = yield* AppProcess.Service
    // Local mode remains cooperative. Do not forward host model/authentication configuration.
    const env = Object.fromEntries(
      ["PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SystemRoot", "COMSPEC"].flatMap(
        (name) => (process.env[name] === undefined ? [] : [[name, process.env[name]!]]),
      ),
    )
    return Service.of({
      identity: "local-process-v1",
      isolation: "local",
      run: Effect.fn("ProContractExecutor.run")(function* (request) {
        const [command, ...args] = request.argv
        if (!command)
          return yield* new AppProcess.AppProcessError({ command: "", cause: new Error("Command is missing") })
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* processes.spawn(
              ChildProcess.make(command, args, {
                cwd: request.cwd,
                stdin: request.stdin === undefined ? "ignore" : Stream.make(Buffer.from(request.stdin)),
                extendEnv: false,
                env,
                detached: process.platform !== "win32",
                forceKillAfter: Duration.seconds(3),
              }),
            )
            const stdout = { chunks: [] as Uint8Array[], bytes: 0 }
            const stderr = { chunks: [] as Uint8Array[], bytes: 0 }
            const collect = (stream: typeof handle.stdout, output: typeof stdout) =>
              Stream.runForEach(stream, (chunk) =>
                Effect.sync(() => {
                  const remaining = MAX_OUTPUT_BYTES - output.bytes
                  if (remaining > 0) output.chunks.push(chunk.slice(0, remaining))
                  output.bytes += chunk.length
                }),
              )
            const completed = yield* Effect.all(
              [collect(handle.stdout, stdout), collect(handle.stderr, stderr), handle.exitCode],
              { concurrency: "unbounded" },
            ).pipe(Effect.timeoutOption(request.timeout))
            const timedOut = Option.isNone(completed)
            return {
              execution: timedOut ? ("timed-out" as const) : ("completed" as const),
              exitCode: Option.isSome(completed) ? completed.value[2] : undefined,
              stdout: Buffer.concat(stdout.chunks),
              stderr: Buffer.concat(stderr.chunks),
              stdoutTruncated: timedOut || stdout.bytes > MAX_OUTPUT_BYTES,
              stderrTruncated: timedOut || stderr.bytes > MAX_OUTPUT_BYTES,
            }
          }),
        ).pipe(Effect.mapError((cause) => new AppProcess.AppProcessError({ command, cause })))
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [AppProcess.node] })
