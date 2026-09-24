export * as ProContractObservation from "./observation"

import path from "path"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { NonNegativeInt, PositiveInt } from "../schema"
import { Hash } from "../util/hash"

export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Blob = Schema.Struct({ hash: Digest, bytes: NonNegativeInt, complete: Schema.Boolean })
export type Blob = typeof Blob.Type

export const Predicate = Schema.Struct({
  id: Schema.NonEmptyString,
  stream: Schema.Literals(["stdout", "stderr"]),
  hash: Digest,
})
export type Predicate = typeof Predicate.Type

export const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.NonEmptyString,
  recordedAt: NonNegativeInt,
  scope: Schema.NonEmptyString,
  subject: Schema.Struct({ kind: Schema.Literals(["reference", "candidate"]), identity: Schema.NonEmptyString }),
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  stdin: Blob,
  execution: Schema.Literals(["completed", "timed-out", "unavailable"]),
  // A process exit or a string printed by the candidate is not a target execution witness.
  targetExecution: Schema.Literal("unobserved"),
  exit: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  stdout: Schema.optional(Blob),
  stderr: Schema.optional(Blob),
  predicates: Schema.Array(
    Schema.Struct({ ...Predicate.fields, status: Schema.Literals(["matched", "mismatched", "unobserved"]) }),
  ),
})
export type Receipt = typeof Receipt.Type

export const Recorded = Schema.Struct({ handle: Digest, receipt: Receipt })
export type Recorded = typeof Recorded.Type

export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("ProContractObservation.Unavailable", {
  message: Schema.String,
}) {}

export const ReadInput = Schema.Struct({
  handle: Digest,
  stream: Schema.Literals(["stdin", "stdout", "stderr"]),
  offset: NonNegativeInt,
  length: PositiveInt.check(Schema.isLessThanOrEqualTo(16 * 1024)),
})

export const ReadOutput = Schema.Struct({
  ...Blob.fields,
  offset: NonNegativeInt,
  readBytes: NonNegativeInt,
  encoding: Schema.Literal("base64"),
  data: Schema.String,
})

export interface Interface {
  readonly record: (input: {
    readonly scope: string
    readonly subject: Receipt["subject"]
    readonly argv: ReadonlyArray<string>
    readonly cwd: string
    readonly stdin: string
    readonly predicates?: ReadonlyArray<Predicate>
    readonly result:
      | {
          readonly execution: "completed" | "timed-out"
          readonly exitCode?: number
          readonly stdout: Uint8Array
          readonly stderr: Uint8Array
          readonly stdoutTruncated: boolean
          readonly stderrTruncated: boolean
        }
      | { readonly error: string; readonly stdout?: Uint8Array; readonly stderr?: Uint8Array }
  }) => Effect.Effect<Recorded, Unavailable>
  readonly get: (handle: string) => Effect.Effect<Receipt, Unavailable>
  readonly read: (input: typeof ReadInput.Type) => Effect.Effect<typeof ReadOutput.Type, Unavailable>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractObservation") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const directory = path.join(global.data, "pro-contract", "observations")
    const failure = () =>
      new Unavailable({ message: "Observation archive is unavailable or failed integrity validation" })

    const getBytes = Effect.fnUntraced(function* (hash: string) {
      if (!Schema.is(Digest)(hash)) return yield* failure()
      const bytes = yield* fs.readFile(path.join(directory, hash)).pipe(Effect.mapError(failure))
      if (Hash.sha256(Buffer.from(bytes)) !== hash) return yield* failure()
      return bytes
    })

    const put = Effect.fnUntraced(function* (bytes: Uint8Array, complete = true) {
      const hash = Hash.sha256(Buffer.from(bytes))
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(failure))
      // Publish only a complete blob, and never overwrite an existing digest (including corrupt bytes).
      const temporary = path.join(directory, `.pending-${crypto.randomUUID()}`)
      yield* Effect.gen(function* () {
        yield* fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o400 })
        yield* fs
          .link(temporary, path.join(directory, hash))
          .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => getBytes(hash).pipe(Effect.asVoid)))
      }).pipe(
        Effect.mapError(failure),
        Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.catch(() => Effect.void))),
      )
      return { hash, bytes: bytes.length, complete }
    })

    const get = Effect.fn("ProContractObservation.get")(function* (handle: string) {
      return yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Receipt)))(
        Buffer.from(yield* getBytes(handle)).toString("utf8"),
      ).pipe(Effect.mapError(failure))
    })

    return Service.of({
      record: Effect.fn("ProContractObservation.record")(function* (input) {
        const stdin = yield* put(Buffer.from(input.stdin))
        const result = "error" in input.result ? undefined : input.result
        const stdout = input.result.stdout
          ? yield* put(input.result.stdout, result?.execution === "completed" && !result.stdoutTruncated)
          : undefined
        const stderr = input.result.stderr
          ? yield* put(input.result.stderr, result?.execution === "completed" && !result.stderrTruncated)
          : undefined
        const receipt = Receipt.make({
          version: 1,
          id: crypto.randomUUID(),
          recordedAt: yield* Clock.currentTimeMillis,
          scope: input.scope,
          subject: input.subject,
          argv: input.argv,
          cwd: input.cwd,
          stdin,
          execution: result?.execution ?? "unavailable",
          targetExecution: "unobserved",
          exit: result?.exitCode,
          error: "error" in input.result ? input.result.error : undefined,
          stdout,
          stderr,
          predicates: (input.predicates ?? []).map((predicate) => {
            const output = predicate.stream === "stdout" ? stdout : stderr
            return {
              ...predicate,
              status: !output?.complete ? "unobserved" : output.hash === predicate.hash ? "matched" : "mismatched",
            }
          }),
        })
        return { handle: (yield* put(Buffer.from(JSON.stringify(receipt)))).hash, receipt }
      }),
      get,
      read: Effect.fn("ProContractObservation.read")(function* (input) {
        yield* Schema.decodeUnknownEffect(ReadInput)(input).pipe(Effect.mapError(failure))
        const blob = (yield* get(input.handle))[input.stream]
        if (!blob) return yield* new Unavailable({ message: `No captured ${input.stream} for this observation` })
        const bytes = yield* getBytes(blob.hash)
        if (bytes.length !== blob.bytes || input.offset > bytes.length) return yield* failure()
        const selected = Buffer.from(bytes.subarray(input.offset, input.offset + input.length))
        return {
          ...blob,
          offset: input.offset,
          readBytes: selected.length,
          encoding: "base64" as const,
          data: selected.toString("base64"),
        }
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })
