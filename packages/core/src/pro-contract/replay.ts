export * as ProContractReplay from "./replay"

import { ProContract } from "@opencode-ai/schema/pro-contract"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
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

type FileResult = {
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
  const artifact = artifacts.find((item) => !item.exists)
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

type Report = {
  readonly version: 2
  readonly contractID: ProContract.ID
  readonly policyHash: string
  readonly subjectHash: string
  readonly passed: boolean
  readonly executor: { readonly identity: string; readonly isolation: "local" | "isolated" }
  readonly checks: ReadonlyArray<CheckResult>
  readonly protected: ReadonlyArray<FileResult & { readonly expectedHash: string }>
  readonly artifacts: ReadonlyArray<FileResult>
}

type VerifyInput = {
  readonly contractID: ProContract.ID
  readonly policy: ProContract.ReplayPolicy
  readonly subjectHash: string
}

export interface Interface {
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

    const inspect = Effect.fnUntraced(function* (root: string, relative: string) {
      const target = path.resolve(root, relative)
      if (!FSUtil.contains(root, target) || !(yield* fs.existsSafe(target))) return { path: relative, exists: false }
      const canonical = yield* fs.realPath(target).pipe(Effect.orDie)
      if (!FSUtil.contains(root, canonical)) return { path: relative, exists: false }
      const info = yield* fs.stat(canonical).pipe(Effect.orDie)
      if (info.type !== "File") return { path: relative, exists: true }
      return {
        path: relative,
        exists: true,
        hash: Hash.sha256(Buffer.from(yield* fs.readFile(canonical).pipe(Effect.orDie))),
      }
    })

    const verify = Effect.fn("ProContractReplay.verify")(function* (input: VerifyInput) {
      const run = path.join(global.tmp, "pro-contract-replay", `${input.contractID}-${crypto.randomUUID()}`)
      const project = AbsolutePath.make(path.join(run, "project"))
      const relative = path.relative(location.project.directory, location.directory)
      const policyHash = ProContractKernel.hashReplay(input.policy)
      return yield* Effect.gen(function* () {
        yield* snapshots.materialize({ snapshot: Snapshot.ID.make(input.subjectHash), directory: project })
        const root = yield* fs.realPath(path.resolve(project, relative)).pipe(Effect.orDie)
        const checks = yield* Effect.forEach(
          input.policy.checks,
          (check: ProContract.ReplayCheck) =>
            Effect.gen(function* () {
              const selected = path.resolve(root, check.cwd ?? ".")
              const cwd = yield* fs.realPath(selected).pipe(Effect.catch(() => Effect.succeed(selected)))
              if (!check.argv[0]) return yield* new Unavailable({ message: "Replay check command is missing" })
              if (!FSUtil.contains(root, cwd))
                return yield* new Unavailable({
                  message: `Replay check escapes the candidate root: ${check.cwd ?? "."}`,
                })
              const result = yield* executor
                .run({ argv: check.argv, cwd, stdin: check.stdin, timeout: check.timeout })
                .pipe(Effect.catch((error) => Effect.succeed({ error: error.message })))
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
                .pipe(Effect.mapError((error) => new Unavailable({ message: error.message })))
              if ("error" in result)
                return {
                  argv: check.argv,
                  cwd: path.relative(root, cwd) || ".",
                  expectedExit: check.exit,
                  observation,
                } satisfies CheckResult
              const failed =
                result.exitCode !== check.exit ||
                observation.receipt.predicates.some((predicate) => predicate.status !== "matched")
              return {
                observation,
                argv: check.argv,
                cwd: path.relative(root, cwd) || ".",
                expectedExit: check.exit,
                exit: result.exitCode,
                stdoutHash: Hash.sha256(result.stdout),
                stderrHash: Hash.sha256(result.stderr),
                stdoutTruncated: result.stdoutTruncated,
                stderrTruncated: result.stderrTruncated,
                stdoutDiagnostic: failed ? outputDiagnostic(result.stdout, result.stdoutTruncated) : undefined,
                stderrDiagnostic: failed ? outputDiagnostic(result.stderr, result.stderrTruncated) : undefined,
              } satisfies CheckResult
            }),
          { concurrency: 1 },
        )
        const protectedFiles = yield* Effect.forEach(input.policy.protected, (item: { path: string; hash: string }) =>
          inspect(root, item.path).pipe(Effect.map((result) => ({ ...result, expectedHash: item.hash }))),
        )
        const artifacts = yield* Effect.forEach(input.policy.artifacts, (item: string) => inspect(root, item))
        const passed =
          checks.every(
            (check) =>
              check.observation.receipt.execution === "completed" &&
              check.exit === check.expectedExit &&
              check.observation.receipt.predicates.every((predicate) => predicate.status === "matched"),
          ) &&
          protectedFiles.every((item) => item.exists && item.hash === item.expectedHash) &&
          artifacts.every((item) => item.exists)
        const report: Report = {
          version: 2,
          contractID: input.contractID,
          policyHash,
          subjectHash: input.subjectHash,
          passed,
          executor: { identity: executor.identity, isolation: executor.isolation },
          checks,
          protected: protectedFiles,
          artifacts,
        }
        const evidenceHash = Hash.sha256(JSON.stringify(report))
        yield* fs
          .ensureDir(path.join(global.data, "pro-contract", "replay"))
          .pipe(Effect.mapError((error) => new Unavailable({ message: String(error) })))
        yield* fs
          .writeFileString(
            path.join(global.data, "pro-contract", "replay", `${evidenceHash}.json`),
            JSON.stringify(report),
            { flag: "wx", mode: 0o400 },
          )
          .pipe(Effect.mapError((error) => new Unavailable({ message: String(error) })))
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
      }).pipe(Effect.ensuring(fs.remove(run, { recursive: true, force: true }).pipe(Effect.catch(() => Effect.void))))
    })

    return Service.of({
      verify,
      read: Effect.fn("ProContractReplay.read")(function* (input) {
        if (!Schema.is(ProContractObservation.Digest)(input.evidenceHash))
          return yield* new Unavailable({ message: "Invalid replay evidence hash" })
        const bytes = yield* fs
          .readFile(path.join(global.data, "pro-contract", "replay", `${input.evidenceHash}.json`))
          .pipe(Effect.mapError(() => new Unavailable({ message: "Replay report is unavailable" })))
        if (Hash.sha256(Buffer.from(bytes)) !== input.evidenceHash)
          return yield* new Unavailable({ message: "Replay report failed integrity validation" })
        const report = yield* Schema.decodeUnknownEffect(
          Schema.UnknownFromJsonString.pipe(
            Schema.decodeTo(
              Schema.Struct({
                contractID: ProContract.ID,
                checks: Schema.Array(Schema.Struct({ observation: ProContractObservation.Recorded })),
              }),
            ),
          ),
        )(Buffer.from(bytes).toString("utf8")).pipe(
          Effect.mapError(() => new Unavailable({ message: "Replay report has no structured observations" })),
        )
        if (report.contractID !== input.contractID)
          return yield* new Unavailable({ message: "Replay report belongs to another Contract" })
        return report.checks.map((check) => check.observation)
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, ProContractExecutor.node, ProContractObservation.node, Snapshot.node],
})
