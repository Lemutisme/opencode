export * as ProContractReplay from "./replay"

import { ProContract } from "@opencode-ai/schema/pro-contract"
import path from "path"
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { AbsolutePath } from "../schema"
import { Snapshot } from "../snapshot"
import { Hash } from "../util/hash"
import { ProContractKernel } from "./kernel"
import { ProContractExecutor } from "./executor"
import { ProContractObservation } from "./observation"
import { ProContractOpenCode } from "./open-code"
import { ProContractRecognition } from "./recognition"
import { ProContractBlob } from "./blob"
import { ExecutionContext } from "../session/execution-context"

const MAX_DIAGNOSTIC_CHARACTERS = 2 * 1024
const SENSITIVE_ENVIRONMENT_NAME = /key|token|secret|password|credential|auth|cookie/i

type OutputDiagnostic = {
  readonly source: "candidate-controlled"
  readonly authority: "non-authoritative"
  readonly encoding: "utf8-lossy-escaped"
  readonly capturedBytes: number
  readonly truncated: boolean
  readonly excerpt: string
}

type CheckResult = {
  readonly observation: ProContractObservation.Recorded
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly expectedExit: number
  readonly exit?: number
  readonly stdoutHash?: string
  readonly stderrHash?: string
  readonly stdoutTruncated?: boolean
  readonly stderrTruncated?: boolean
  readonly stdoutDiagnostic?: OutputDiagnostic
  readonly stderrDiagnostic?: OutputDiagnostic
}

export type FileResult = {
  readonly captured?: ProContractBlob.Ref
  readonly captureError?: string
  readonly before?: {
    readonly exists: boolean
    readonly hash?: string
    readonly captured?: ProContractBlob.Ref
    readonly captureError?: string
  }
  readonly beforeHash?: string
  readonly generated?: boolean
  readonly path: string
  readonly exists: boolean
  readonly hash?: string
}

function failureSummary(
  checks: ReadonlyArray<CheckResult>,
  protectedFiles: ReadonlyArray<FileResult & { readonly expectedHash: string }>,
  artifacts: ReadonlyArray<FileResult>,
) {
  const check = checks.find(
    (item) =>
      item.exit !== item.expectedExit ||
      item.observation.receipt.predicates.some((predicate) => predicate.status !== "matched"),
  )
  if (check)
    return [
      `Replay check ${check.argv.join(" ")} (cwd ${check.cwd}) exited ${check.exit}; expected ${check.expectedExit}`,
      ...check.observation.receipt.predicates
        .filter((predicate) => predicate.status !== "matched")
        .map((predicate) => `Observation ${predicate.id} (${predicate.stream}): ${predicate.status}`),
      `Raw observation: ${check.observation.handle}; target execution unobserved`,
      `candidate-controlled non-authoritative stdout=${JSON.stringify(check.stdoutDiagnostic?.excerpt ?? "")}${check.stdoutDiagnostic?.truncated ? " (truncated)" : ""}`,
      `candidate-controlled non-authoritative stderr=${JSON.stringify(check.stderrDiagnostic?.excerpt ?? "")}${check.stderrDiagnostic?.truncated ? " (truncated)" : ""}`,
    ].join("; ")
  const protectedFile = protectedFiles.find((item) => !item.exists || item.hash !== item.expectedHash)
  if (protectedFile)
    return `Protected file ${protectedFile.exists ? "changed" : "missing"} after replay checks: ${protectedFile.path}`
  const artifact = artifacts.find((item) => !item.exists || item.captureError)
  if (artifact) return `Required artifact missing after replay checks: ${artifact.path}`
  return "Unknown replay failure"
}

function outputDiagnostic(output: Buffer, capturedTruncated: boolean): OutputDiagnostic {
  const redacted = Object.entries(process.env)
    .filter(([name, value]) => value && SENSITIVE_ENVIRONMENT_NAME.test(name))
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length)
    .reduce((text, secret) => text.split(secret).join("[REDACTED]"), output.toString("utf8"))
  const escaped = redacted
    .replaceAll("\\", "\\\\")
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
      (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
  return {
    source: "candidate-controlled",
    authority: "non-authoritative",
    encoding: "utf8-lossy-escaped",
    capturedBytes: output.length,
    truncated: capturedTruncated || escaped.length > MAX_DIAGNOSTIC_CHARACTERS,
    excerpt: escaped.slice(0, MAX_DIAGNOSTIC_CHARACTERS),
  }
}

export type Report = {
  readonly protectedBefore?: ReadonlyArray<FileResult & { readonly expectedHash: string }>
  readonly version: 2
  readonly contractID: ProContract.ID
  readonly policyHash: string
  readonly subjectHash: string
  readonly passed: boolean
  readonly executor: { readonly identity: string; readonly isolation: "local" | "isolated" }
  readonly checks: ReadonlyArray<CheckResult>
  readonly protected: ReadonlyArray<FileResult & { readonly expectedHash: string }>
  readonly artifacts: ReadonlyArray<FileResult>
  readonly incomplete?: {
    readonly reason: "interrupted" | "failed"
    readonly expectedChecks: number
    readonly expectedProtected: number
    readonly expectedArtifacts: number
    readonly observationArchiveFailed?: true
  }
}

const BeforeReport = Schema.Struct({
  exists: Schema.Boolean,
  hash: Schema.optional(Schema.String),
  captured: Schema.optional(ProContractBlob.Ref),
  captureError: Schema.optional(Schema.String),
})
const FileReport = Schema.Struct({
  ...BeforeReport.fields,
  path: Schema.String,
  before: Schema.optional(BeforeReport),
  beforeHash: Schema.optional(Schema.String),
  generated: Schema.optional(Schema.Boolean),
})
export const ReportSchema = Schema.Struct({
  version: Schema.Literal(2),
  contractID: ProContract.ID,
  policyHash: Schema.String,
  subjectHash: Schema.String,
  passed: Schema.Boolean,
  executor: Schema.Struct({ identity: Schema.String, isolation: Schema.Literals(["local", "isolated"]) }),
  checks: Schema.Array(
    Schema.Struct({
      observation: ProContractObservation.Recorded,
      argv: Schema.Array(Schema.String),
      cwd: Schema.String,
      expectedExit: Schema.Number,
      exit: Schema.optional(Schema.Number),
    }),
  ),
  protected: Schema.Array(Schema.Struct({ ...FileReport.fields, expectedHash: Schema.String })),
  protectedBefore: Schema.optional(Schema.Array(Schema.Struct({ ...FileReport.fields, expectedHash: Schema.String }))),
  artifacts: Schema.Array(FileReport),
  incomplete: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["interrupted", "failed"]),
      expectedChecks: Schema.Number,
      expectedProtected: Schema.Number,
      expectedArtifacts: Schema.Number,
      observationArchiveFailed: Schema.optional(Schema.Literal(true)),
    }),
  ),
})

type VerifyInput = {
  readonly freshArtifacts?: ReadonlyArray<string>
  readonly additionalProtected?: ProContract.ReplayPolicy["protected"]
  readonly contractID: ProContract.ID
  readonly policy: ProContract.ReplayPolicy
  readonly subjectHash: string
}

export interface Interface {
  readonly report: (input: {
    readonly contractID: ProContract.ID
    readonly evidenceHash: string
  }) => Effect.Effect<Report, Unavailable>
  readonly artifact: (input: {
    readonly contractID: ProContract.ID
    readonly evidenceHash: string
    readonly path: string
  }) => Effect.Effect<Uint8Array, Unavailable>
  readonly verify: (input: VerifyInput) => Effect.Effect<ProContract.ReplayResult, Snapshot.Error | Unavailable>
  readonly read: (input: {
    readonly contractID: ProContract.ID
    readonly evidenceHash: string
  }) => Effect.Effect<ReadonlyArray<ProContractObservation.Recorded>, Unavailable>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractReplay") {}

export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("ProContractReplayUnavailable", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const executor = yield* ProContractExecutor.Service
    const observations = yield* ProContractObservation.Service
    const snapshots = yield* Snapshot.Service
    const bindings = yield* ProContractOpenCode.Service
    const blobs = yield* ProContractBlob.Service

    const publish = Effect.fnUntraced(function* (report: Report) {
      const bytes = JSON.stringify(report)
      const hash = Hash.sha256(bytes)
      const directory = path.join(global.data, "pro-contract", "replay")
      const temporary = path.join(directory, `.pending-${crypto.randomUUID()}`)
      const target = path.join(directory, `${hash}.json`)
      yield* fs.ensureDir(directory).pipe(Effect.orDie)
      yield* Effect.gen(function* () {
        yield* fs.writeFileString(temporary, bytes, { flag: "wx", mode: 0o400 })
        yield* fs.link(temporary, target).pipe(
          Effect.catchReason("PlatformError", "AlreadyExists", () =>
            Effect.gen(function* () {
              if ((yield* fs.readFileString(target)) !== bytes)
                return yield* new Unavailable({ message: "Replay report failed integrity validation" })
            }),
          ),
        )
      }).pipe(
        Effect.mapError((error) => new Unavailable({ message: String(error) })),
        Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.catch(() => Effect.void))),
      )
      return hash
    })

    const inspect = Effect.fnUntraced(function* (
      root: string,
      relative: string,
      retain = false,
    ): Effect.fn.Return<FileResult, Unavailable> {
      const target = path.resolve(root, relative)
      if (!FSUtil.contains(root, target))
        return { path: relative, exists: true, captureError: "Artifact escapes the candidate" }
      if (!(yield* fs.existsSafe(target))) return { path: relative, exists: false }
      const canonical = yield* fs.realPath(target).pipe(Effect.orDie)
      if (!FSUtil.contains(root, canonical))
        return { path: relative, exists: true, captureError: "Artifact escapes the candidate" }
      const info = yield* fs.stat(canonical).pipe(Effect.orDie)
      if (info.type !== "File") return { path: relative, exists: true, captureError: "Artifact is not a regular file" }
      if (retain && info.size > ProContractBlob.maximumBytes)
        return { path: relative, exists: true, captureError: "Artifact exceeds the individual archive size limit" }
      const bytes = yield* fs.readFile(canonical).pipe(Effect.orDie)
      const captured = retain
        ? yield* blobs.put(bytes).pipe(Effect.mapError((error) => new Unavailable({ message: error.message })))
        : undefined
      return { path: relative, exists: true, hash: Hash.sha256(Buffer.from(bytes)), ...(captured ? { captured } : {}) }
    })

    const verify = Effect.fn("ProContractReplay.verify")(function* (input: VerifyInput) {
      const current = yield* ExecutionContext.Current
      if (yield* bindings.get(input.contractID)) {
        if (
          current?.contractID !== input.contractID ||
          !current.process ||
          (current.replay !== undefined && current.replay !== ProContractRecognition.fingerprint(input))
        )
          return yield* new Unavailable({
            message: "Controlled replay requires its captured execution and frozen input",
          })
        yield* current.check
      }
      const run = path.join(global.tmp, "pro-contract-replay", `${input.contractID}-${crypto.randomUUID()}`)
      const project = AbsolutePath.make(path.join(run, "project"))
      const relative = path.relative(location.project.directory, location.directory)
      const policyHash = ProContractKernel.hashReplay(input.policy)
      const protectedInputs = [...input.policy.protected, ...(input.additionalProtected ?? [])]
      const checks: CheckResult[] = []
      const protectedBefore: (FileResult & { readonly expectedHash: string })[] = []
      const protectedFiles: (FileResult & { readonly expectedHash: string })[] = []
      const artifacts: FileResult[] = []
      const archive = { saved: false, observationFailed: false }
      return yield* Effect.gen(function* () {
        yield* snapshots.materialize({ snapshot: Snapshot.ID.make(input.subjectHash), directory: project })
        const root = yield* fs.realPath(path.resolve(project, relative)).pipe(Effect.orDie)
        yield* Effect.forEach(protectedInputs, (item) =>
          inspect(root, item.path).pipe(
            Effect.map((result) => protectedBefore.push({ ...result, expectedHash: item.hash })),
          ),
        )
        const before = yield* Effect.forEach(input.policy.artifacts, (item) => inspect(root, item, true))
        yield* Effect.forEach(input.freshArtifacts ?? [], (item) =>
          Effect.gen(function* () {
            const target = path.resolve(root, item)
            if (
              !input.policy.artifacts.some((artifact) => artifact === item) ||
              target === root ||
              !FSUtil.contains(root, target) ||
              protectedInputs.some((file) => FSUtil.contains(target, path.resolve(root, file.path)))
            )
              return yield* new Unavailable({ message: "Fresh artifact path is not an approved output" })
            const parent = yield* fs.realPath(path.dirname(target)).pipe(Effect.option)
            if (parent._tag === "Some" && !FSUtil.contains(root, parent.value))
              return yield* new Unavailable({ message: "Fresh artifact parent escapes the candidate" })
            if (yield* fs.existsSafe(target)) {
              const stat = yield* fs.stat(target).pipe(Effect.orDie)
              if (stat.type === "Directory")
                return yield* new Unavailable({ message: "Fresh artifacts must be individual files" })
              yield* fs.remove(target).pipe(Effect.mapError((error) => new Unavailable({ message: error.message })))
            }
          }),
        )
        yield* Effect.forEach(
          protectedBefore.every((file) => file.exists && file.hash === file.expectedHash) ? input.policy.checks : [],
          (check: ProContract.ReplayCheck) =>
            Effect.gen(function* () {
              const selected = path.resolve(root, check.cwd ?? ".")
              const cwd = yield* fs.realPath(selected).pipe(Effect.catch(() => Effect.succeed(selected)))
              if (!check.argv[0]) return yield* new Unavailable({ message: "Replay check command is missing" })
              if (!FSUtil.contains(root, cwd))
                return yield* new Unavailable({
                  message: `Replay check escapes the candidate root: ${check.cwd ?? "."}`,
                })
              // Once an execution ends, publish its receipt before cancellation can clear the scratch tree.
              yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const partial: { stdout?: Buffer; stderr?: Buffer } = {}
                  const executed = yield* restore(
                    executor
                      .run({
                        argv: check.argv,
                        cwd,
                        stdin: check.stdin,
                        timeout: check.timeout,
                        onInterrupt: (output) => Object.assign(partial, output),
                      })
                      .pipe(Effect.catch((error) => Effect.succeed({ error: error.message }))),
                  ).pipe(Effect.exit)
                  const result = Exit.isSuccess(executed)
                    ? executed.value
                    : {
                        error: Cause.hasInterrupts(executed.cause)
                          ? "Replay check interrupted; captured output may be incomplete"
                          : "Replay check failed; output unavailable",
                        ...partial,
                      }
                  const observation = yield* observations
                    .record({
                      scope: input.contractID,
                      subject: { kind: "candidate", identity: input.subjectHash },
                      argv: check.argv,
                      cwd: path.relative(root, cwd) || ".",
                      stdin: check.stdin ?? "",
                      predicates: check.observations,
                      result,
                    })
                    .pipe(
                      Effect.tapCause(() =>
                        Effect.sync(() => {
                          archive.observationFailed = true
                        }),
                      ),
                      Effect.mapError((error) => new Unavailable({ message: error.message })),
                    )
                  const failed =
                    "error" in result ||
                    result.exitCode !== check.exit ||
                    observation.receipt.predicates.some((predicate) => predicate.status !== "matched")
                  checks.push({
                    observation,
                    argv: check.argv,
                    cwd: path.relative(root, cwd) || ".",
                    expectedExit: check.exit,
                    ...("error" in result
                      ? {}
                      : {
                          exit: result.exitCode,
                          stdoutHash: Hash.sha256(result.stdout),
                          stderrHash: Hash.sha256(result.stderr),
                          stdoutTruncated: result.stdoutTruncated,
                          stderrTruncated: result.stderrTruncated,
                          stdoutDiagnostic: failed
                            ? outputDiagnostic(result.stdout, result.stdoutTruncated)
                            : undefined,
                          stderrDiagnostic: failed
                            ? outputDiagnostic(result.stderr, result.stderrTruncated)
                            : undefined,
                        }),
                  })
                  if (Exit.isFailure(executed)) return yield* executed
                }),
              )
            }),
          { concurrency: 1, discard: true },
        )
        yield* Effect.forEach(
          protectedInputs,
          (item) =>
            inspect(root, item.path).pipe(
              Effect.map((result) => protectedFiles.push({ ...result, expectedHash: item.hash })),
            ),
          { discard: true },
        )
        yield* Effect.forEach(
          input.policy.artifacts,
          (item, index) =>
            inspect(root, item, true).pipe(
              Effect.map((result) =>
                artifacts.push({
                  ...result,
                  before: before[index],
                  beforeHash: before[index]?.hash,
                  generated: input.freshArtifacts?.includes(item) ?? false,
                }),
              ),
            ),
          { discard: true },
        )
        const passed =
          checks.every(
            (check) =>
              check.observation.receipt.execution === "completed" &&
              check.exit === check.expectedExit &&
              check.observation.receipt.predicates.every((predicate) => predicate.status === "matched"),
          ) &&
          protectedBefore.every((item) => item.exists && item.hash === item.expectedHash) &&
          protectedFiles.every((item) => item.exists && item.hash === item.expectedHash) &&
          artifacts.every((item) => item.exists && !item.captureError)
        const report: Report = {
          version: 2,
          contractID: input.contractID,
          policyHash,
          subjectHash: input.subjectHash,
          passed,
          executor: { identity: executor.identity, isolation: executor.isolation },
          checks,
          protected: protectedFiles,
          protectedBefore,
          artifacts,
        }
        const evidenceHash = yield* publish(report).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              archive.saved = true
            }),
          ),
          Effect.uninterruptible,
        )
        if (checks.some((check) => check.observation.receipt.execution !== "completed"))
          return yield* new Unavailable({ message: `Replay execution unavailable; retained report: ${evidenceHash}` })
        return ProContract.ReplayResult.make({
          policyHash,
          subjectHash: input.subjectHash,
          evidenceHash,
          passed,
          summary: passed
            ? "Frozen replay predicates passed; target execution and behavioral coverage remain unverified"
            : failureSummary(checks, protectedFiles, artifacts),
        })
      }).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (!archive.saved)
              yield* publish({
                version: 2,
                contractID: input.contractID,
                policyHash,
                subjectHash: input.subjectHash,
                passed: false,
                executor: { identity: executor.identity, isolation: executor.isolation },
                checks,
                protected: protectedFiles,
                protectedBefore,
                artifacts,
                incomplete: {
                  reason: Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed",
                  expectedChecks: input.policy.checks.length,
                  expectedProtected: protectedInputs.length,
                  expectedArtifacts: input.policy.artifacts.length,
                  ...(archive.observationFailed ? { observationArchiveFailed: true as const } : {}),
                },
              }).pipe(Effect.orDie)
            // If either receipt or report archiving fails, retain scratch and propagate the failure.
            if (!archive.observationFailed)
              yield* fs.remove(run, { recursive: true, force: true }).pipe(Effect.catch(() => Effect.void))
          }),
        ),
      )
    })

    const report = Effect.fnUntraced(function* (input: { contractID: ProContract.ID; evidenceHash: string }) {
      if (!Schema.is(ProContractObservation.Digest)(input.evidenceHash))
        return yield* new Unavailable({ message: "Invalid replay evidence hash" })
      const bytes = yield* fs
        .readFile(path.join(global.data, "pro-contract/replay", `${input.evidenceHash}.json`))
        .pipe(Effect.mapError(() => new Unavailable({ message: "Replay report is unavailable" })))
      if (Hash.sha256(Buffer.from(bytes)) !== input.evidenceHash)
        return yield* new Unavailable({ message: "Replay report failed integrity validation" })
      const report = yield* Schema.decodeUnknownEffect(
        Schema.UnknownFromJsonString.pipe(Schema.decodeTo(ReportSchema)),
      )(Buffer.from(bytes).toString("utf8")).pipe(
        Effect.mapError(() => new Unavailable({ message: "Replay report is malformed" })),
      )
      if (report.contractID !== input.contractID)
        return yield* new Unavailable({ message: "Replay report belongs to another Contract" })
      return report
    })
    return Service.of({
      verify,
      report,
      read: (input) => report(input).pipe(Effect.map((value) => value.checks.map((check) => check.observation))),
      artifact: (input) =>
        report(input).pipe(
          Effect.flatMap((value) => {
            const file = value.artifacts.find((file) => file.path === input.path)
            if (!file?.captured || file.captureError || file.hash !== file.captured.hash)
              return Effect.fail(new Unavailable({ message: "Replay artifact is unavailable" }))
            return blobs
              .get(file.captured.hash)
              .pipe(Effect.mapError((error) => new Unavailable({ message: error.message })))
          }),
        ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    FSUtil.node,
    Global.node,
    Location.node,
    ProContractExecutor.node,
    ProContractObservation.node,
    ProContractBlob.node,
    Snapshot.node,
    ProContractOpenCode.node,
  ],
})
