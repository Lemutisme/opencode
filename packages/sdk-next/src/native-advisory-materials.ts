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
    yield* Effect.forEach(
      presentation(ProContractRecognition.canonical(materials)),
      (file) => fs.writeWithDirs(path.join(directory, file.path), file.content, 0o400),
      { discard: true },
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
    const legacy = copy.equals(canonical) || copy.equals(Buffer.from(render(canonical.toString("utf8"))))
    const files = legacy ? [{ path: "materials.json", content: copy }] : presentation(canonical.toString("utf8"))
    const entries = (yield* fs.readDirectoryEntries(materials.directory)).filter(
      (entry) => entry.name !== "candidate" && entry.name !== "evidence",
    )
    if (
      entries.length !== (legacy ? 1 : 2) ||
      entries.some((entry) =>
        entry.name === "materials.json"
          ? entry.type !== "file"
          : legacy || entry.name !== "context" || entry.type !== "directory",
      )
    )
      return yield* new ProContractDelivery.Denied({ message: "Review materials copy is corrupt" })
    if (!legacy) {
      const context = yield* fs.readDirectoryEntries(path.join(materials.directory, "context"))
      if (
        context.length !== files.length - 1 ||
        context.some((entry) => entry.type !== "file" || !files.some((file) => file.path === `context/${entry.name}`))
      )
        return yield* new ProContractDelivery.Denied({ message: "Review materials copy is corrupt" })
    }
    yield* Effect.forEach(
      files,
      (file) =>
        Effect.gen(function* () {
          const bytes =
            file.path === "materials.json"
              ? copy
              : Buffer.from(yield* fs.readFile(path.join(materials.directory, file.path)))
          if (!bytes.equals(Buffer.from(file.content)))
            return yield* new ProContractDelivery.Denied({ message: "Review materials copy is corrupt" })
        }),
      { discard: true },
    )
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

function presentation(canonical: string) {
  // These are hash-verified canonical bytes, never the editable materials.json copy.
  const materials = JSON.parse(canonical) as {
    task: NativeAdvisoryStore.Registration["task"]
    reviewer: NativeAdvisoryStore.Registration["configuration"]["reviewer"]
    executorStatement?: Pick<ProContractDelivery.Request, "summary" | "uncertainties"> & { trust: string }
  }
  const files = [
    {
      path: "context/task.md",
      content: context("Task", [
        ["goal", materials.task.goal],
        ["brief", materials.task.brief],
      ]),
    },
    {
      path: "context/reviewer-instructions.md",
      content: context("Reviewer instructions", [["instructions", materials.reviewer.instructions]]),
    },
    ...(materials.executorStatement
      ? [
          {
            path: "context/executor-statement.md",
            content: context("Executor statement", [
              ["source", materials.executorStatement.trust],
              ["summary", materials.executorStatement.summary],
              ...materials.executorStatement.uncertainties.map((text, index): [string, string] => [
                `uncertainty ${index + 1}`,
                text,
              ]),
            ]),
          },
        ]
      : []),
  ]
  const references = files.map((file) => ({
    path: file.path,
    hash: Hash.sha256(file.content),
    bytes: Buffer.byteLength(file.content),
  }))
  return [
    {
      path: "materials.json",
      content: render(
        ProContractRecognition.canonical({
          ...materials,
          task: { ...materials.task, goal: undefined, brief: undefined, text: references[0] },
          reviewer: { ...materials.reviewer, instructions: references[1] },
          ...(materials.executorStatement ? { executorStatement: references[2] } : {}),
        }),
      ),
    },
    ...files,
  ]
}

function context(title: string, fields: ReadonlyArray<readonly [string, string]>) {
  return `# ${title}\n\nText blocks have a "> " prefix on each line. After removing that prefix, an unpaired backslash at line end joins the next line without a newline. Double backslashes encode a literal backslash; \\r encodes a carriage return; \\uXXXX encodes a UTF-16 code unit. Other line breaks are original.\n\n${fields
    .map(([name, text]) => {
      const lines = text.split("\n").flatMap((line) => {
        // Keep escape sequences and Unicode code points intact. Count UTF-16 units
        // (as the read tool does), including the prefix and continuation marker.
        const characters = Array.from(line, (character) => ({
          text:
            character === "\\"
              ? "\\\\"
              : character === "\r"
                ? "\\r"
                : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(character)
                  ? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
                  : character,
          space: /\s/u.test(character),
        }))
        const result: string[] = []
        let start = 0
        while (start < characters.length) {
          let end = start
          let size = 2
          let space = start
          while (
            end < characters.length &&
            size + characters[end].text.length <= (end === characters.length - 1 ? 1000 : 999)
          ) {
            size += characters[end].text.length
            if (characters[end].space) space = end + 1
            end++
          }
          const stop = end === characters.length ? end : space > start ? space : end
          result.push(
            `> ${characters
              .slice(start, stop)
              .map((character) => character.text)
              .join("")}${stop < characters.length ? "\\" : ""}`,
          )
          start = stop
        }
        return result.length ? result : ["> "]
      })
      return `## ${name}\n\n${lines.join("\n")}\n`
    })
    .join("\n")}`
}
