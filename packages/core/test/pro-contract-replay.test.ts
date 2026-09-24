import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer, Schedule } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractReplay } from "@opencode-ai/core/pro-contract/replay"
import { ProContractObservation } from "@opencode-ai/core/pro-contract/observation"
import { ProContractExecutor } from "@opencode-ai/core/pro-contract/executor"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

describe("ProContract replay verifier", () => {
  testEffect(Layer.empty).live("retains scratch and reports missing evidence when observation archiving fails", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const data = path.join(tmp.path, "data")
          const started = path.join(tmp.path, "started")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await fs.writeFile(path.join(project, "source.txt"), "frozen input")
            await fs.mkdir(path.join(data, "pro-contract"), { recursive: true })
            // A file blocks the observation directory while leaving report publication available.
            await fs.writeFile(path.join(data, "pro-contract", "observations"), "archive unavailable")
          })
          yield* Effect.gen(function* () {
            const replay = yield* ProContractReplay.Service
            const snapshots = yield* Snapshot.Service
            const subject = yield* snapshots.capture()
            expect(subject).toBeDefined()
            if (!subject) return
            const verify = replay
              .verify({
                contractID: ProContract.ID.make("pct_replay_archive_failure"),
                subjectHash: subject,
                policy: {
                  checks: [
                    {
                      argv: [
                        process.execPath,
                        "-e",
                        `require('fs').writeFileSync(${JSON.stringify(started)}, process.cwd()); process.stdout.write('not archived')`,
                      ],
                      timeout: 10_000,
                      exit: 0,
                    },
                  ],
                  protected: [],
                  artifacts: [],
                },
              })
              .pipe(Effect.flip)
            const failed = yield* verify
            expect(failed).toMatchObject({
              _tag: "ProContractReplayUnavailable",
              message: "Observation archive is unavailable or failed integrity validation",
            })
            // The zero-receipt incomplete report has the same digest on retry.
            expect(yield* verify).toEqual(failed)
            const files = yield* Effect.promise(() => fs.readdir(path.join(data, "pro-contract", "replay")))
            expect(files).toHaveLength(1)
            expect(
              yield* Effect.promise(() => Bun.file(path.join(data, "pro-contract", "replay", files[0]!)).json()),
            ).toMatchObject({
              passed: false,
              checks: [],
              incomplete: { reason: "failed", expectedChecks: 1, observationArchiveFailed: true },
            })
            const scratch = yield* Effect.promise(() => Bun.file(started).text())
            expect(yield* Effect.promise(() => fs.stat(scratch).then((info) => info.isDirectory()))).toBe(true)
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(LayerNode.group([ProContractReplay.node, Snapshot.node]), [
                [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))],
                [Global.node, Global.layerWith({ data, tmp: path.join(tmp.path, "scratch") })],
              ]),
            ),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live(
    "archives completed and interrupted observations before removing replay scratch",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const data = path.join(tmp.path, "data")
            const started = path.join(tmp.path, "started")
            const unrun = path.join(tmp.path, "unrun")
            yield* Effect.promise(async () => {
              await fs.mkdir(project)
              await $`git init`.cwd(project).quiet()
              await $`git config core.fsmonitor false`.cwd(project).quiet()
              await fs.writeFile(path.join(project, "source.txt"), "frozen input")
            })
            yield* Effect.gen(function* () {
              const replay = yield* ProContractReplay.Service
              const snapshots = yield* Snapshot.Service
              const observations = yield* ProContractObservation.Service
              const subject = yield* snapshots.capture()
              expect(subject).toBeDefined()
              if (!subject) return
              const contractID = ProContract.ID.make("pct_replay_interrupt")
              const run = yield* replay
                .verify({
                  contractID,
                  subjectHash: subject,
                  policy: {
                    checks: [
                      {
                        argv: [process.execPath, "-e", "process.stdout.write('completed evidence')"],
                        timeout: 10_000,
                        exit: 0,
                      },
                      {
                        argv: [
                          process.execPath,
                          "-e",
                          `setInterval(() => {}, 1000); process.stdout.write('x'.repeat(2 * 1024 * 1024), () => process.stderr.write('y'.repeat(2 * 1024 * 1024), () => require('fs').writeFileSync(${JSON.stringify(started)}, JSON.stringify({ cwd: process.cwd(), pid: process.pid }))));`,
                        ],
                        timeout: 30_000,
                        exit: 0,
                        observations: [
                          {
                            id: "partial-match",
                            stream: "stdout",
                            hash: Hash.sha256(Buffer.from("x".repeat(ProContractExecutor.MAX_OUTPUT_BYTES))),
                          },
                        ],
                      },
                      {
                        argv: [
                          process.execPath,
                          "-e",
                          `require('fs').writeFileSync(${JSON.stringify(unrun)}, 'should not run')`,
                        ],
                        timeout: 10_000,
                        exit: 0,
                      },
                    ],
                    protected: [{ path: RelativePath.make("source.txt"), hash: Hash.sha256("frozen input") }],
                    artifacts: [RelativePath.make("source.txt")],
                  },
                })
                .pipe(Effect.forkChild)
              yield* Effect.promise(() => Bun.file(started).exists()).pipe(
                Effect.repeat({ while: (value) => !value, schedule: Schedule.spaced("10 millis") }),
                Effect.timeout("10 seconds"),
              )
              const processInfo = yield* Effect.promise(
                () => Bun.file(started).json() as Promise<{ cwd: string; pid: number }>,
              )
              yield* Fiber.interrupt(run)
              const exit = yield* Fiber.await(run)
              expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
              const files = yield* Effect.promise(() => fs.readdir(path.join(data, "pro-contract", "replay")))
              expect(files).toHaveLength(1)
              const bytes = yield* Effect.promise(() =>
                Bun.file(path.join(data, "pro-contract", "replay", files[0]!)).text(),
              )
              expect(files[0]).toBe(`${Hash.sha256(bytes)}.json`)
              expect(JSON.parse(bytes)).toMatchObject({
                version: 2,
                contractID,
                subjectHash: subject,
                passed: false,
                incomplete: { reason: "interrupted", expectedChecks: 3, expectedProtected: 1, expectedArtifacts: 1 },
                protected: [],
                artifacts: [],
              })
              const checks = yield* replay.read({ contractID, evidenceHash: Hash.sha256(bytes) })
              expect(checks).toHaveLength(2)
              expect(checks[0]!.receipt).toMatchObject({ execution: "completed", exit: 0, stdout: { complete: true } })
              expect(checks[1]!.receipt).toMatchObject({
                execution: "unavailable",
                error: "Replay check interrupted; captured output may be incomplete",
                targetExecution: "unobserved",
                stdout: { bytes: ProContractExecutor.MAX_OUTPUT_BYTES, complete: false },
                stderr: { bytes: ProContractExecutor.MAX_OUTPUT_BYTES, complete: false },
                predicates: [{ id: "partial-match", status: "unobserved" }],
              })
              expect(checks[1]!.receipt.exit).toBeUndefined()
              for (const [index, stream, expected] of [
                [0, "stdout", "completed evidence"],
                [1, "stdout", "xxxxxxxxxxxxxxxxxx"],
                [1, "stderr", "yyyyyyyyyyyyyyyyyy"],
              ] as const) {
                const raw = yield* observations.read({ handle: checks[index]!.handle, stream, offset: 0, length: 18 })
                expect(Buffer.from(raw.data, "base64").toString()).toBe(expected)
              }
              expect(yield* Effect.promise(() => Bun.file(unrun).exists())).toBe(false)
              expect(
                yield* Effect.promise(() =>
                  fs.stat(processInfo.cwd).then(
                    () => true,
                    () => false,
                  ),
                ),
              ).toBe(false)
              expect(() => process.kill(processInfo.pid, 0)).toThrow()
            }).pipe(
              Effect.provide(
                AppNodeBuilder.build(
                  LayerNode.group([ProContractReplay.node, Snapshot.node, ProContractObservation.node]),
                  [
                    [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))],
                    [Global.node, Global.layerWith({ data, tmp: path.join(tmp.path, "scratch") })],
                  ],
                ),
              ),
            )
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    20_000,
  )

  testEffect(Layer.empty).live("replays one frozen subject outside the candidate Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const data = path.join(tmp.path, "data")
          const replay = path.join(tmp.path, "replay")
          const replayAlias = process.platform === "win32" ? replay : path.join(tmp.path, "replay-alias")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.mkdir(replay)
            if (replayAlias !== replay) await fs.symlink(replay, replayAlias)
            await fs.writeFile(path.join(tmp.path, "outside.txt"), "outside\n")
            await fs.writeFile(path.join(project, "verify.txt"), "pass\n")
            await fs.writeFile(path.join(project, "artifact.txt"), "artifact\n")
            await fs.chmod(path.join(project, "artifact.txt"), 0o400)
            await fs.writeFile(path.join(project, "diagnostic.txt"), "replay-diagnostic-secret")
            await fs.symlink(path.join(tmp.path, "outside.txt"), path.join(project, "escape.txt"))
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })
          yield* Effect.gen(function* () {
            const replay = yield* ProContractReplay.Service
            const snapshots = yield* Snapshot.Service
            const subject = yield* snapshots.capture()
            expect(subject).toBeDefined()
            if (!subject) return
            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(project, "verify.txt"), "mutated\n")
              await fs.rm(path.join(project, "artifact.txt"))
            })
            const policy = {
              checks: [
                {
                  argv: [
                    process.execPath,
                    "-e",
                    "const fs=require('fs');fs.appendFileSync('artifact.txt','built in writable copy');fs.writeFileSync('built.txt','built');process.exit(fs.readFileSync('verify.txt','utf8').trim()==='pass'?0:1)",
                  ],
                  timeout: 10_000,
                  exit: 0,
                },
              ],
              protected: [{ path: RelativePath.make("verify.txt"), hash: Hash.sha256(Buffer.from("pass\n")) }],
              artifacts: [RelativePath.make("artifact.txt"), RelativePath.make("built.txt")],
            } satisfies ProContract.ReplayPolicy

            const passed = yield* replay.verify({
              contractID: ProContract.ID.make("pct_replay"),
              policy,
              subjectHash: subject,
            })

            expect(passed).toMatchObject({ passed: true, subjectHash: subject })
            expect(yield* Effect.promise(() => fs.readFile(path.join(project, "verify.txt"), "utf8"))).toBe("mutated\n")
            expect(
              yield* Effect.promise(() =>
                Bun.file(path.join(data, "pro-contract", "replay", `${passed.evidenceHash}.json`)).exists(),
              ),
            ).toBe(true)

            const unavailable = yield* replay
              .verify({
                contractID: ProContract.ID.make("pct_replay_unavailable"),
                policy: { ...policy, checks: [{ ...policy.checks[0], argv: [path.join(tmp.path, "missing")] }] },
                subjectHash: subject,
              })
              .pipe(Effect.flip)
            expect(unavailable).toMatchObject({ _tag: "ProContractReplayUnavailable" })
            expect(unavailable.message).toContain("retained report:")
            const unavailableRecords = yield* replay.read({
              contractID: ProContract.ID.make("pct_replay_unavailable"),
              evidenceHash: unavailable.message.split("retained report: ")[1]!,
            })
            expect(unavailableRecords[0]?.receipt).toMatchObject({
              execution: "unavailable",
              targetExecution: "unobserved",
            })

            // The inner parser fails before std.print; the outer wrapper still exits zero.
            const probe = yield* replay.verify({
              contractID: ProContract.ID.make("pct_inner_probe"),
              policy: {
                checks: [
                  {
                    argv: [
                      process.execPath,
                      "-e",
                      "const r=require('child_process').spawnSync(process.execPath,['-e','std.print(\"observed\"'],{encoding:'utf8'});process.stderr.write(r.stderr);process.exit(0)",
                    ],
                    timeout: 10_000,
                    exit: 0,
                    observations: [
                      { id: "std.print-output", stream: "stdout", hash: Hash.sha256(Buffer.from("observed\n")) },
                    ],
                  },
                  {
                    argv: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
                    stdin: "actual\n",
                    timeout: 10_000,
                    exit: 0,
                    observations: [{ id: "echo", stream: "stdout", hash: Hash.sha256(Buffer.from("actual\n")) }],
                  },
                  {
                    argv: [process.execPath, "-e", "process.exit(0)"],
                    timeout: 10_000,
                    exit: 0,
                    observations: [
                      {
                        id: "bypassed-interface",
                        stream: "stdout",
                        hash: Hash.sha256(Buffer.from("required interface output")),
                      },
                    ],
                  },
                ],
                protected: [],
                artifacts: [],
              },
              subjectHash: subject,
            })
            expect(probe.passed).toBe(false)
            expect(probe.summary).toContain("exited 0; expected 0")
            expect(probe.summary).toContain("std.print-output (stdout): mismatched")
            const records = yield* replay.read({
              contractID: ProContract.ID.make("pct_inner_probe"),
              evidenceHash: probe.evidenceHash,
            })
            expect(records.map((record) => record.receipt.predicates[0]?.status)).toEqual([
              "mismatched",
              "matched",
              "mismatched",
            ])
            expect(records.every((record) => record.receipt.targetExecution === "unobserved")).toBe(true)
            expect(records.every((record) => record.receipt.subject.identity === subject)).toBe(true)
            const observations = yield* ProContractObservation.Service
            const raw = yield* observations.read({
              handle: records[0]!.handle,
              stream: "stderr",
              offset: 0,
              length: 4096,
            })
            expect(Buffer.from(raw.data, "base64").toString()).toContain("std.print")
            expect(raw.bytes).toBeGreaterThan(0)
            expect(
              (yield* replay
                .read({ contractID: ProContract.ID.make("pct_other"), evidenceHash: probe.evidenceHash })
                .pipe(Effect.flip)).message,
            ).toContain("another Contract")

            const tampered = yield* replay.verify({
              contractID: ProContract.ID.make("pct_replay_tampered"),
              policy: {
                ...policy,
                checks: [
                  {
                    argv: [process.execPath, "-e", "require('fs').writeFileSync('verify.txt','tampered')"],
                    timeout: 10_000,
                    exit: 0,
                  },
                ],
                artifacts: [],
              },
              subjectHash: subject,
            })
            expect(tampered).toMatchObject({
              passed: false,
              summary: "Protected file changed after replay checks: verify.txt",
            })

            const failed = yield* replay.verify({
              contractID: ProContract.ID.make("pct_replay_failed"),
              policy: { ...policy, artifacts: [RelativePath.make("missing.txt")] },
              subjectHash: subject,
            })
            expect(failed).toMatchObject({
              passed: false,
              summary: "Required artifact missing after replay checks: missing.txt",
            })

            const escaped = yield* replay.verify({
              contractID: ProContract.ID.make("pct_replay_escaped"),
              policy: { ...policy, artifacts: [RelativePath.make("escape.txt")] },
              subjectHash: subject,
            })
            expect(escaped).toMatchObject({
              passed: false,
              summary: "Required artifact missing after replay checks: escape.txt",
            })

            const credentialName = "PROCONTRACT_REPLAY_TEST_SECRET"
            const credential = "replay-diagnostic-secret"
            const stderr = "failure-" + "x".repeat(4 * 1024)
            const diagnostic = yield* Effect.acquireUseRelease(
              Effect.sync(() => {
                const previous = process.env[credentialName]
                process.env[credentialName] = credential
                return previous
              }),
              () =>
                replay.verify({
                  contractID: ProContract.ID.make("pct_replay_diagnostic"),
                  policy: {
                    checks: [
                      {
                        argv: [
                          process.execPath,
                          "-e",
                          `if (process.env.${credentialName}) process.exit(99); process.stdout.write("visible:" + require('fs').readFileSync('diagnostic.txt','utf8')); process.stderr.write(${JSON.stringify(stderr)}); process.exit(7)`,
                        ],
                        timeout: 10_000,
                        exit: 0,
                      },
                    ],
                    protected: [],
                    artifacts: [],
                  },
                  subjectHash: subject,
                }),
              (previous) =>
                Effect.sync(() => {
                  if (previous === undefined) {
                    delete process.env[credentialName]
                    return
                  }
                  process.env[credentialName] = previous
                }),
            )
            const report = yield* Effect.promise(() =>
              Bun.file(path.join(data, "pro-contract", "replay", `${diagnostic.evidenceHash}.json`)).json(),
            )
            const check = report.checks[0]
            const summary = String(diagnostic.summary)
            expect(diagnostic.passed).toBe(false)
            expect(summary).toContain("(cwd .) exited 7; expected 0")
            expect(summary).toContain('candidate-controlled non-authoritative stdout="visible:[REDACTED]"')
            expect(summary).toContain("candidate-controlled non-authoritative stderr=")
            expect(summary).toContain("(truncated)")
            expect(summary).not.toContain(credential)
            expect(check).toMatchObject({
              cwd: ".",
              exit: 7,
              expectedExit: 0,
              stdoutHash: Hash.sha256(Buffer.from(`visible:${credential}`)),
              stderrHash: Hash.sha256(Buffer.from(stderr)),
              stdoutDiagnostic: {
                source: "candidate-controlled",
                authority: "non-authoritative",
                encoding: "utf8-lossy-escaped",
                capturedBytes: Buffer.byteLength(`visible:${credential}`),
                truncated: false,
                excerpt: "visible:[REDACTED]",
              },
              stderrDiagnostic: {
                source: "candidate-controlled",
                authority: "non-authoritative",
                encoding: "utf8-lossy-escaped",
                capturedBytes: Buffer.byteLength(stderr),
                truncated: true,
              },
            })
            expect(check.stderrDiagnostic.excerpt.length).toBe(2 * 1024)
            expect(JSON.stringify(report)).not.toContain(credential)
            expect(Hash.sha256(JSON.stringify(report))).toBe(diagnostic.evidenceHash)
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(
                LayerNode.group([ProContractReplay.node, Snapshot.node, ProContractObservation.node]),
                [
                  [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))],
                  [Global.node, Global.layerWith({ data, tmp: replayAlias })],
                ],
              ),
            ),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
