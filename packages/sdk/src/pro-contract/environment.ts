export * as ContractEnvironment from "./environment"

import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { RSI } from "@opencode/core/pro-contract/rsi"

/** Operator-prepared, read-only task environment; never provided by a candidate. */
export const Input = Schema.Struct({
  directory: Schema.String,
  manifest: Schema.Struct({ path: Schema.String, sha256: Schema.String }),
})
export type Input = typeof Input.Type

const Manifest = Schema.Struct({
  kind: Schema.Literal("programbench-cleanroom-rootfs-v1"),
  image: Schema.String,
  reference: Schema.Struct({ path: Schema.String, sha256: Schema.String, size: Schema.Int }),
  environment: Schema.Record(Schema.String, Schema.String),
})

export async function checked(input: Input) {
  if (!path.isAbsolute(input.directory) || (await fs.realpath(input.directory)) !== input.directory)
    throw new Error("Task environment must be a canonical operator-owned directory")
  const bytes = await Bun.file(input.manifest.path).bytes()
  if (Bun.SHA256.hash(bytes, "hex") !== input.manifest.sha256) throw new Error("Task environment manifest changed")
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(new TextDecoder().decode(bytes), {
    onExcessProperty: "error",
  })
  if (
    !/^sha256:[a-f0-9]{64}$/.test(manifest.image) ||
    !/^[a-f0-9]{64}$/.test(manifest.reference.sha256) ||
    manifest.reference.path !== "workspace/executable"
  )
    throw new Error("Unknown task image/reference identity")
  const reference = path.join(input.directory, manifest.reference.path)
  const info = await fs.lstat(reference)
  // Execute-only bytes were hashed by the trusted preparer before sealing the
  // supply. Do not temporarily make a shared reference readable during admission.
  if (!info.isFile() || info.size !== manifest.reference.size || (info.mode & 0o777) !== 0o111)
    throw new Error("Reference must remain a sealed execute-only regular file")
  const allowed = ["PATH", "CARGO_HOME", "RUSTUP_HOME", "GOPATH", "GOCACHE", "GOMODCACHE"]
  if (Object.keys(manifest.environment).some((key) => !allowed.includes(key)))
    throw new Error("Unknown task environment variable")
  return { manifest, reference, identity: RSI.hash({ manifest: input.manifest.sha256, directory: input.directory }) }
}
