export * as ProContractReplay from "./replay"

import { ProContract } from "@opencode-ai/schema/pro-contract"
import path from "path"
import { Context, Effect, Layer } from "effect"
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
  readonly error?: string
}

type FileResult = {
  readonly path: string
  readonly exists: boolean
  readonly hash?: string
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
  readonly verify: (input: VerifyInput) => Effect.Effect<ProContract.ReplayResult, Snapshot.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractReplay") {}

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
      const info = yield* fs.stat(target).pipe(Effect.orDie)
      if (info.type !== "File") return { path: relative, exists: true }
      return {
        path: relative,
        exists: true,
        hash: Hash.sha256(Buffer.from(yield* fs.readFile(target).pipe(Effect.orDie))),
      }
    })

    const verify = Effect.fn("ProContractReplay.verify")(function* (input: VerifyInput) {
      const run = path.join(global.tmp, "pro-contract-replay", `${input.contractID}-${crypto.randomUUID()}`)
      const project = AbsolutePath.make(path.join(run, "project"))
      const relative = path.relative(location.project.directory, location.directory)
      const root = path.resolve(project, relative)
      const policyHash = ProContractKernel.hashReplay(input.policy)
      return yield* Effect.gen(function* () {
        yield* snapshots.materialize({ snapshot: Snapshot.ID.make(input.subjectHash), directory: project })
        const protectedFiles = yield* Effect.forEach(input.policy.protected, (item: { path: string; hash: string }) =>
          inspect(root, item.path).pipe(Effect.map((result) => ({ ...result, expectedHash: item.hash }))),
        )
        const artifacts = yield* Effect.forEach(input.policy.artifacts, (item: string) => inspect(root, item))
        const checks = yield* Effect.forEach(
          input.policy.checks,
          (check: ProContract.ReplayCheck) =>
            Effect.gen(function* () {
              const [command, ...args] = check.argv
              const cwd = path.resolve(root, check.cwd ?? ".")
              if (!command || !FSUtil.contains(root, cwd))
                return {
                  argv: check.argv,
                  cwd,
                  expectedExit: check.exit,
                  error: "Replay check escapes the candidate root",
                } satisfies CheckResult
              return yield* processes
                .run(ChildProcess.make(command, args, { cwd, stdin: "ignore", extendEnv: true }), {
                  timeout: check.timeout,
                  maxOutputBytes: MAX_OUTPUT_BYTES,
                  maxErrorBytes: MAX_OUTPUT_BYTES,
                })
                .pipe(
                  Effect.map(
                    (result): CheckResult => ({
                      argv: check.argv,
                      cwd: path.relative(root, cwd) || ".",
                      expectedExit: check.exit,
                      exit: result.exitCode,
                      stdoutHash: Hash.sha256(result.stdout),
                      stderrHash: Hash.sha256(result.stderr),
                    }),
                  ),
                  Effect.catch((error) =>
                    Effect.succeed({
                      argv: check.argv,
                      cwd: path.relative(root, cwd) || ".",
                      expectedExit: check.exit,
                      error: error.message,
                    } satisfies CheckResult),
                  ),
                )
            }),
          { concurrency: 1 },
        )
        const passed =
          checks.every((check) => check.error === undefined && check.exit === check.expectedExit) &&
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
        const failure =
          checks.find((check) => check.error !== undefined || check.exit !== check.expectedExit)?.argv.join(" ") ??
          protectedFiles.find((item) => !item.exists || item.hash !== item.expectedHash)?.path ??
          artifacts.find((item) => !item.exists)?.path
        return ProContract.ReplayResult.make({
          policyHash,
          subjectHash: input.subjectHash,
          evidenceHash,
          passed,
          summary: passed ? "Replay verification passed" : `Replay verification failed: ${failure ?? "unknown"}`,
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
