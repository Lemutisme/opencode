export * as ProContractBlob from "./blob"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Hash } from "../util/hash"

export const maximumBytes = 16 * 1024 * 1024
export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Ref = Schema.Struct({ hash: Digest, bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
export type Ref = typeof Ref.Type

export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("ProContractBlob.Unavailable", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly put: (bytes: Uint8Array) => Effect.Effect<Ref, Unavailable>
  readonly get: (hash: string) => Effect.Effect<Uint8Array, Unavailable>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractBlob") {}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const directory = path.join(global.data, "pro-contract", "blobs")
      const failure = () => new Unavailable({ message: "Evidence blob is missing, oversized or corrupt" })
      const get = Effect.fnUntraced(function* (hash: string) {
        if (!Schema.is(Digest)(hash)) return yield* failure()
        const file = path.join(directory, hash)
        const stat = yield* fs.stat(file).pipe(Effect.mapError(failure))
        if (stat.type !== "File" || stat.size > maximumBytes) return yield* failure()
        const bytes = yield* fs.readFile(file).pipe(Effect.mapError(failure))
        if (bytes.length > maximumBytes || Hash.sha256(Buffer.from(bytes)) !== hash) return yield* failure()
        return bytes
      })
      return Service.of({
        get,
        put: Effect.fnUntraced(function* (bytes) {
          if (bytes.length > maximumBytes) return yield* failure()
          const hash = Hash.sha256(Buffer.from(bytes))
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(failure))
          const temporary = path.join(directory, `.pending-${crypto.randomUUID()}`)
          yield* Effect.gen(function* () {
            yield* fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o400 })
            yield* fs
              .link(temporary, path.join(directory, hash))
              .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => get(hash).pipe(Effect.asVoid)))
          }).pipe(Effect.mapError(failure), Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)))
          return { hash, bytes: bytes.length }
        }),
      })
    }),
  ),
  deps: [FSUtil.node, Global.node],
})
