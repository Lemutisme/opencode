export * as ProContractReplay from "./replay"

import { ProContract } from "@opencode-ai/schema/pro-contract"
import path from "path"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { AppProcess } from "../process"
import { AbsolutePath } from "../schema"
import { Snapshot } from "../snapshot"
import { Hash } from "../util/hash"
import { ProContractKernel } from "./kernel"

const MAX_OUTPUT_BYTES = 1024 * 1024

type CheckResult = {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly expectedExit: number
  readonly exit?: number
  readonly stdoutHash?: string
  readonly stderrHash?: string
  readonly stdoutTruncated?: boolean
  readonly stderrTruncated?: boolean
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
  const check = checks.find((item) => item.exit !== item.expectedExit)
  if (check) return `Replay check ${check.argv.join(" ")} exited ${check.exit}; expected ${check.expectedExit}`
  const protectedFile = protectedFiles.find((item) => !item.exists || item.hash !== item.expectedHash)
  if (protectedFile)
    return `Protected file ${protectedFile.exists ? "changed" : "missing"} after replay checks: ${protectedFile.path}`
  const artifact = artifacts.find((item) => !item.exists)
  if (artifact) return `Required artifact missing after replay checks: ${artifact.path}`
  return "Unknown replay failure"
}

type Report = {
  readonly version: 1
  readonly contractID: ProContract.ID
  readonly policyHash: string
  readonly subjectHash: string
  readonly passed: boolean
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
    const processes = yield* AppProcess.Service
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
              const [command, ...args] = check.argv
              const selected = path.resolve(root, check.cwd ?? ".")
              const cwd = yield* fs.realPath(selected).pipe(Effect.catch(() => Effect.succeed(selected)))
              if (!command) return yield* new Unavailable({ message: "Replay check command is missing" })
              if (!FSUtil.contains(root, cwd))
                return yield* new Unavailable({
                  message: `Replay check escapes the candidate root: ${check.cwd ?? "."}`,
                })
              return yield* processes
                .run(
                  ChildProcess.make(command, args, {
                    cwd,
                    stdin: "ignore",
                    extendEnv: true,
                    detached: process.platform !== "win32",
                    forceKillAfter: Duration.seconds(3),
                  }),
                  {
                    timeout: check.timeout,
                    maxOutputBytes: MAX_OUTPUT_BYTES,
                    maxErrorBytes: MAX_OUTPUT_BYTES,
                  },
                )
                .pipe(
                  Effect.map(
                    (result): CheckResult => ({
                      argv: check.argv,
                      cwd: path.relative(root, cwd) || ".",
                      expectedExit: check.exit,
                      exit: result.exitCode,
                      stdoutHash: Hash.sha256(result.stdout),
                      stderrHash: Hash.sha256(result.stderr),
                      stdoutTruncated: result.stdoutTruncated,
                      stderrTruncated: result.stderrTruncated,
                    }),
                  ),
                  Effect.mapError(
                    (error) =>
                      new Unavailable({ message: `Replay check could not run: ${error.message}`, cause: error }),
                  ),
                )
            }),
          { concurrency: 1 },
        )
        const protectedFiles = yield* Effect.forEach(input.policy.protected, (item: { path: string; hash: string }) =>
          inspect(root, item.path).pipe(Effect.map((result) => ({ ...result, expectedHash: item.hash }))),
        )
        const artifacts = yield* Effect.forEach(input.policy.artifacts, (item: string) => inspect(root, item))
        const passed =
          checks.every((check) => check.exit === check.expectedExit) &&
          protectedFiles.every((item) => item.exists && item.hash === item.expectedHash) &&
          artifacts.every((item) => item.exists)
        const report: Report = {
          version: 1,
          contractID: input.contractID,
          policyHash,
          subjectHash: input.subjectHash,
          passed,
          checks,
          protected: protectedFiles,
          artifacts,
        }
        const evidenceHash = Hash.sha256(JSON.stringify(report))
        yield* fs.ensureDir(path.join(global.data, "pro-contract", "replay")).pipe(Effect.orDie)
        yield* fs
          .writeJson(path.join(global.data, "pro-contract", "replay", `${evidenceHash}.json`), report)
          .pipe(Effect.orDie)
        return ProContract.ReplayResult.make({
          policyHash,
          subjectHash: input.subjectHash,
          evidenceHash,
          passed,
          summary: passed ? "Replay verification passed" : failureSummary(checks, protectedFiles, artifacts),
        })
      }).pipe(Effect.ensuring(fs.remove(run, { recursive: true, force: true }).pipe(Effect.catch(() => Effect.void))))
    })

    return Service.of({ verify })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, AppProcess.node, Snapshot.node],
})
