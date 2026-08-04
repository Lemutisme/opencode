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
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(tmp.path, "outside.txt"), "outside\n")
            await fs.writeFile(path.join(project, "verify.txt"), "pass\n")
            await fs.writeFile(path.join(project, "artifact.txt"), "artifact\n")
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
                    "const fs=require('fs');process.exit(fs.readFileSync('verify.txt','utf8').trim()==='pass'?0:1)",
                  ],
                  timeout: 10_000,
                  exit: 0,
                },
              ],
              protected: [{ path: RelativePath.make("verify.txt"), hash: Hash.sha256(Buffer.from("pass\n")) }],
              artifacts: [RelativePath.make("artifact.txt")],
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

            const failed = yield* replay.verify({
              contractID: ProContract.ID.make("pct_replay_failed"),
              policy: { ...policy, artifacts: [RelativePath.make("missing.txt")] },
              subjectHash: subject,
            })
            expect(failed).toMatchObject({ passed: false, summary: "Replay verification failed: missing.txt" })

            const escaped = yield* replay.verify({
              contractID: ProContract.ID.make("pct_replay_escaped"),
              policy: { ...policy, artifacts: [RelativePath.make("escape.txt")] },
              subjectHash: subject,
            })
            expect(escaped).toMatchObject({ passed: false, summary: "Replay verification failed: escape.txt" })
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(LayerNode.group([ProContractReplay.node, Snapshot.node]), [
                [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))],
                [Global.node, Global.layerWith({ data, tmp: path.join(tmp.path, "tmp") })],
              ]),
            ),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
