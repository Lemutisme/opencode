export * as NativeAdvisoryMaterials from "./native-advisory-materials"

import path from "node:path"
import { Effect, Result, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { ProContractDelivery } from "@opencode-ai/core/pro-contract/delivery"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Hash } from "@opencode-ai/core/util/hash"
import { NativeAdvisoryStore } from "./native-advisory-store"
import { ResearchReviewer } from "./research/reviewer"

export function key(
  registration: NativeAdvisoryStore.Registration,
  subjectHash: string,
  trigger?: NativeAdvisoryStore.Trigger,
) {
  return ProContractRecognition.fingerprint({
    contractID: registration.contractID,
    revision: registration.revision,
    specHash: registration.specHash,
    context: registration.context,
    subjectHash,
    configuration: registration.hash,
    materials: registration.configuration.materials,
    evidence: registration.configuration.evidence,
    ...(trigger?.type === "submission" ? { executorStatement: trigger.statement } : {}),
  })
}

export const make = Effect.gen(function* () {
  const state = yield* NativeAdvisoryStore.Service
  const fs = yield* FSUtil.Service
  const locations = yield* LocationServiceMap.Service
  const sessions = yield* SessionV2.Service
  const reviewer = yield* ResearchReviewer.makeWith(state)
  const inventory = Effect.fnUntraced(function* (directory: string, names: ReadonlyArray<string>) {
    const root = yield* fs.realPath(directory)
    const files = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const source = path.resolve(root, name)
        // A dangling symlink is an unsupported material, not an absent file.
        if (!FSUtil.contains(root, source) || (yield* fs.readLink(source).pipe(Effect.isSuccess)))
          return yield* new ProContractDelivery.Denied({
            message: `Review material is not a contained regular file: ${name}`,
          })
        if (!(yield* fs.exists(source))) return undefined
        if ((yield* fs.realPath(source)) !== source || (yield* fs.stat(source)).type !== "File")
          return yield* new ProContractDelivery.Denied({
            message: `Review material is not a contained regular file: ${name}`,
          })
        return { path: name, source }
      }),
    )
    if (files.every((file) => file === undefined))
      return yield* new ProContractDelivery.Denied({ message: "No approved review material files are present" })
    return {
      files: files.filter((file) => file !== undefined),
      missing: names.filter((_, index) => files[index] === undefined),
    }
  })
  const capture = Effect.fnUntraced(function* (
    registration: NativeAdvisoryStore.Registration,
    trigger?: NativeAdvisoryStore.Trigger,
  ) {
    // Snapshot.capture skips absent force-included paths. Do not pause when all
    // approved material is absent; actual missing-path claims come from the snapshot.
    yield* inventory(registration.location.directory, registration.configuration.materials)
    const snapshots = yield* Snapshot.Service.pipe(Effect.provide(locations.get(registration.location)))
    const subjectHash = yield* snapshots.capture({ include: registration.configuration.materials })
    if (!subjectHash) return yield* new ProContractDelivery.Denied({ message: "Review snapshot is unavailable" })
    return { subjectHash, key: key(registration, subjectHash, trigger) }
  })
  const prepare = Effect.fnUntraced(function* (request: NativeAdvisoryStore.Request) {
    const registration = request.registration
    const snapshot = request.actual
    if (!snapshot) return yield* new ProContractDelivery.Denied({ message: "Review has no fixed snapshot" })
    const snapshots = yield* Snapshot.Service.pipe(Effect.provide(locations.get(registration.location)))
    const directory = path.join(registration.directory, "requests", request.id, "review")
    const staging = path.join(registration.directory, "requests", request.id, "snapshot")
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    yield* snapshots.materialize({
      snapshot: Snapshot.ID.make(snapshot.subjectHash),
      directory: AbsolutePath.make(staging),
    })
    const selected = yield* inventory(staging, registration.configuration.materials)
    const files = yield* Effect.forEach(selected.files, (file) =>
      Effect.gen(function* () {
        const bytes = yield* fs.readFile(file.source)
        const blob = yield* state.blob(bytes)
        yield* fs.writeWithDirs(path.join(directory, "candidate", file.path), bytes, 0o400)
        return { path: file.path, blob }
      }),
    )
    yield* Effect.forEach(
      registration.configuration.evidence,
      (reference) =>
        Effect.gen(function* () {
          const bytes = yield* state.bytes(reference.hash)
          if (bytes.length !== reference.bytes)
            return yield* new ProContractDelivery.Denied({
              message: "Review evidence size does not match its registration",
            })
          yield* fs.writeWithDirs(path.join(directory, "evidence", reference.hash), bytes, 0o400)
        }),
      { discard: true },
    )
    const environment = yield* reviewer.environment(registration.configuration.reviewer, directory)
    if (!ProContractRecognition.same(environment, registration.environment))
      return yield* new ProContractDelivery.Denied({ message: "Reviewer configuration or instructions changed" })
    const materials = {
      version: 1,
      contractID: request.contractID,
      revision: registration.revision,
      context: registration.context,
      task: registration.task,
      subjectHash: snapshot.subjectHash,
      files,
      missing: selected.missing,
      evidence: registration.configuration.evidence,
      reviewer: registration.configuration.reviewer,
      environment,
      ...(request.trigger?.type === "submission"
        ? { executorStatement: { trust: "untrusted-executor-statement", ...request.trigger.statement } }
        : {}),
    }
    const hash = yield* state.put(materials)
    yield* fs.writeWithDirs(
      path.join(directory, "materials.json"),
      render(ProContractRecognition.canonical(materials)),
      0o400,
    )
    return {
      ...snapshot,
      hash,
      directory,
      files,
      missing: selected.missing,
      evidence: registration.configuration.evidence,
      environment,
    }
  })
  const verify = Effect.fnUntraced(function* (request: NativeAdvisoryStore.Request) {
    if (!request.materials)
      return yield* new ProContractDelivery.Denied({ message: "Review materials are unavailable" })
    const materials = request.materials
    const canonical = Buffer.from(yield* state.bytes(materials.hash))
    const copy = Buffer.from(yield* fs.readFile(path.join(materials.directory, "materials.json")))
    if (!copy.equals(canonical) && !copy.equals(Buffer.from(render(canonical.toString("utf8")))))
      return yield* new ProContractDelivery.Denied({ message: "Review materials copy is corrupt" })
    const selected = yield* inventory(
      path.join(materials.directory, "candidate"),
      request.registration.configuration.materials,
    )
    if (
      !ProContractRecognition.same(selected.missing, materials.missing ?? []) ||
      !ProContractRecognition.same(
        selected.files.map((file) => file.path),
        materials.files.map((file) => file.path),
      )
    )
      return yield* new ProContractDelivery.Denied({ message: "Review material availability is corrupt" })
    yield* Effect.forEach(
      [
        ...materials.files.map((file) => ({
          path: path.join(materials.directory, "candidate", file.path),
          blob: file.blob,
        })),
        ...materials.evidence.map((blob) => ({ path: path.join(materials.directory, "evidence", blob.hash), blob })),
      ],
      (file) =>
        Effect.gen(function* () {
          const bytes = yield* state.bytes(file.blob.hash)
          if (
            bytes.length !== file.blob.bytes ||
            (yield* fs.realPath(file.path)) !== file.path ||
            Hash.sha256(Buffer.from(yield* fs.readFile(file.path))) !== file.blob.hash
          )
            return yield* new ProContractDelivery.Denied({ message: "Review material or evidence copy is corrupt" })
        }),
      { discard: true },
    )
    if (request.outcome?.archiveHash) yield* state.bytes(request.outcome.archiveHash)
    if (request.outcome?.systemHash) yield* state.bytes(request.outcome.systemHash)
    if (request.outcome?.rawHash) return Buffer.from(yield* state.bytes(request.outcome.rawHash)).toString("utf8")
  })
  const collect = Effect.fnUntraced(function* (
    request: NativeAdvisoryStore.Request,
    job?: ProContractJob.Job,
    reason?: string,
  ): Effect.fn.Return<NativeAdvisoryStore.Outcome, unknown> {
    const messages = request.job ? yield* sessions.messages({ sessionID: request.job.sessionID }) : []
    const archiveHash = yield* state.put({
      job,
      messages: Schema.encodeSync(Schema.Array(SessionMessage.Message))(messages),
    })
    const partialHash = (yield* state.blob(
      Buffer.from(
        messages
          .flatMap((message) =>
            message.type === "assistant"
              ? message.content.filter((part) => part.type === "text").map((part) => part.text)
              : [],
          )
          .join("\n"),
      ),
    )).hash
    const captured = yield* Effect.gen(function* () {
      if (!job || !request.materials || reason)
        return yield* new ProContractDelivery.Denied({ message: reason ?? "Review did not produce complete materials" })
      yield* verify(request)
      if (
        !ProContractRecognition.same(
          yield* reviewer.environment(request.registration.configuration.reviewer, request.materials.directory),
          request.materials.environment,
        )
      )
        return yield* new ProContractDelivery.Denied({ message: "Reviewer environment changed during execution" })
      const captured = yield* reviewer.capture(
        request.registration.configuration.reviewer,
        job,
        request.materials.directory,
      )
      if (!captured.raw.trim())
        return yield* new ProContractDelivery.Denied({ message: "Reviewer returned no opinion text" })
      return captured
    }).pipe(Effect.result)
    return {
      status: Result.isSuccess(captured) ? "complete" : "unavailable",
      reason: Result.isFailure(captured) ? String(captured.failure) : undefined,
      archiveHash,
      partialHash,
      jobStatus: job?.status,
      ...(Result.isSuccess(captured)
        ? {
            rawHash: captured.success.rawHash,
            messageID: captured.success.messageID,
            systemHash: captured.success.systemHash,
          }
        : {}),
    }
  })
  return { capture, prepare, verify, collect, environment: reviewer.environment }
})

function render(canonical: string) {
  let depth = 0
  // Preserve canonical key order (including integer-like keys) and string bytes.
  return `${canonical.replace(/"(?:[^"\\]|\\.)*"|\{\}|\[\]|[{}\[\],:]/g, (token) => {
    if (token === "{" || token === "[") return `${token}\n${"  ".repeat(++depth)}`
    if (token === "}" || token === "]") return `\n${"  ".repeat(--depth)}${token}`
    if (token === ",") return `,\n${"  ".repeat(depth)}`
    if (token === ":") return ": "
    return token
  })}\n`
}
