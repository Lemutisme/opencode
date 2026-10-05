import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractReplay } from "@opencode-ai/core/pro-contract/replay"
import { ProContractObservation } from "@opencode-ai/core/pro-contract/observation"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

describe("ProContract replay verifier", () => {
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
