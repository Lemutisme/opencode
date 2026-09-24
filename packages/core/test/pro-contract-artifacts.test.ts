import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { ProContract } from "../src/pro-contract"
import { ProContractReplay } from "../src/pro-contract/replay"
import { ProContractBlob } from "../src/pro-contract/blob"
import { ProContractKernel } from "../src/pro-contract/kernel"
import { AbsolutePath, RelativePath } from "../src/schema"
import { Snapshot } from "../src/snapshot"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
describe("Retained replay artifact provenance", () => {
  for (const before of ["missing", "normal", "oversized", "escape"] as const) {
    it.live(
      `retains the ${before} pre-execution receipt before generating a fresh artifact`,
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) =>
            Effect.gen(function* () {
              const project = path.join(tmp.path, "project")
              const data = path.join(tmp.path, "data")
              yield* Effect.promise(async () => {
                await fs.mkdir(project)
                await $`git init`.cwd(project).quiet()
                await $`git config core.fsmonitor false`.cwd(project).quiet()
                await Bun.write(path.join(project, "harness.txt"), "approved")
                await Bun.write(path.join(project, "data.txt"), "plan input")
                if (before === "normal") await Bun.write(path.join(project, "output.txt"), "previous bytes")
                if (before === "oversized")
                  await Bun.write(path.join(project, "output.txt"), new Uint8Array(ProContractBlob.maximumBytes + 1))
                if (before === "escape") {
                  await Bun.write(path.join(tmp.path, "outside.txt"), "do not overwrite")
                  await fs.symlink(path.join(tmp.path, "outside.txt"), path.join(project, "output.txt"))
                }
              })
              yield* Effect.gen(function* () {
                const snapshots = yield* Snapshot.Service
                const replay = yield* ProContractReplay.Service
                const blobs = yield* ProContractBlob.Service
                const subject = yield* snapshots.capture({
                  include: [
                    RelativePath.make("harness.txt"),
                    RelativePath.make("data.txt"),
                    ...(before === "missing" ? [] : [RelativePath.make("output.txt")]),
                  ],
                })
                expect(subject).toBeDefined()
                const id = ProContract.ID.create()
                const result = yield* replay.verify({
                  contractID: id,
                  subjectHash: subject!,
                  freshArtifacts: ["output.txt"],
                  additionalProtected: [{ path: RelativePath.make("data.txt"), hash: Hash.sha256("plan input") }],
                  policy: {
                    checks: [
                      {
                        argv: [process.execPath, "-e", 'require("fs").writeFileSync("output.txt","fresh bytes")'],
                        exit: 0,
                        timeout: 5000,
                      },
                    ],
                    protected: [{ path: RelativePath.make("harness.txt"), hash: Hash.sha256("approved") }],
                    artifacts: [RelativePath.make("output.txt")],
                  },
                })
                const report = yield* replay.report({ contractID: id, evidenceHash: result.evidenceHash })
                const artifact = report.artifacts[0]
                expect(artifact.generated).toBe(true)
                expect(Buffer.from(yield* blobs.get(artifact.captured!.hash)).toString()).toBe("fresh bytes")
                expect(artifact.before?.exists).toBe(before !== "missing")
                if (before === "normal")
                  expect(Buffer.from(yield* blobs.get(artifact.before!.captured!.hash)).toString()).toBe(
                    "previous bytes",
                  )
                if (["oversized", "escape"].includes(before)) expect(artifact.before?.captureError).toBeTruthy()
                if (before === "escape")
                  expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "outside.txt")).text())).toBe(
                    "do not overwrite",
                  )
                expect(report.protectedBefore?.[0].hash).toBe(Hash.sha256("approved"))
                expect(report.protectedBefore?.[1].hash).toBe(Hash.sha256("plan input"))
                expect(report.protected[1].hash).toBe(Hash.sha256("plan input"))
                expect(report.policyHash).toBe(
                  ProContractKernel.hashReplay({
                    checks: [
                      {
                        argv: [process.execPath, "-e", 'require("fs").writeFileSync("output.txt","fresh bytes")'],
                        exit: 0,
                        timeout: 5000,
                      },
                    ],
                    protected: [{ path: RelativePath.make("harness.txt"), hash: Hash.sha256("approved") }],
                    artifacts: [RelativePath.make("output.txt")],
                  }),
                )
                expect(yield* Effect.promise(() => Bun.file(path.join(project, "output.txt")).exists())).toBe(
                  before !== "missing",
                )
              }).pipe(
                Effect.provide(
                  AppNodeBuilder.build(LayerNode.group([ProContractReplay.node, Snapshot.node, ProContractBlob.node]), [
                    [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))],
                    [Global.node, Global.layerWith({ data, tmp: path.join(tmp.path, "scratch") })],
                  ]),
                ),
              )
            }),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ),
      20_000,
    )
  }
})
