import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractExport } from "@opencode-ai/core/pro-contract/export"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("ProContract export", () => {
  it.live("exports the frozen subject even when the candidate no longer has Git metadata", () =>
    fixture((input) =>
      Effect.gen(function* () {
        const exports = yield* ProContractExport.Service
        yield* Effect.promise(async () => {
          await fs.rm(path.join(input.project, ".git"), { recursive: true })
          await Bun.write(path.join(input.project, "artifact.txt"), "live replacement\n")
        })
        expect(yield* exports.materialize(input)).toMatchObject({ subjectHash: input.subjectHash })
        expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "artifact.txt")).text())).toBe(
          "frozen\n",
        )
      }),
    ),
  )

  it.live("does not replace an invalid retained snapshot reference with a live tree", () =>
    fixture((input) =>
      Effect.gen(function* () {
        const exports = yield* ProContractExport.Service
        yield* Effect.promise(() =>
          Bun.write(
            path.join(
              input.root,
              "snapshot",
              "references",
              Hash.fast(input.project),
              `${Hash.fast(input.subjectHash)}.json`,
            ),
            '{"version":1,"snapshot":"different-subject"}',
          ),
        )
        const result = yield* exports.materialize(input).pipe(Effect.flip)
        expect(result).toBeInstanceOf(Snapshot.Error)
        expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "artifact.txt")).exists())).toBe(false)
      }),
    ),
  )

  for (const field of ["snapshot", "directory"] as const) {
    it.live(`rejects a complete retained reference with a different ${field}`, () =>
      fixture((input) =>
        Effect.gen(function* () {
          const exports = yield* ProContractExport.Service
          yield* Effect.promise(async () => {
            const target = path.join(
              input.root,
              "snapshot",
              "references",
              Hash.fast(input.project),
              `${Hash.fast(input.subjectHash)}.json`,
            )
            const reference: Record<string, unknown> = await Bun.file(target).json()
            await Bun.write(
              target,
              JSON.stringify({ ...reference, [field]: field === "snapshot" ? "a".repeat(40) : input.root }),
            )
          })
          const result = yield* exports.materialize(input).pipe(Effect.flip)
          expect(result).toBeInstanceOf(Snapshot.Error)
          expect(result.message).toContain("identity does not match")
          expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "artifact.txt")).exists())).toBe(false)
        }),
      ),
    )
  }

  it.live("rejects a retained repository symlink escaping native storage", () =>
    fixture((input) =>
      Effect.gen(function* () {
        const exports = yield* ProContractExport.Service
        yield* Effect.promise(async () => {
          const reference: { repository: { gitDirectory: string } } = await Bun.file(
            path.join(
              input.root,
              "snapshot",
              "references",
              Hash.fast(input.project),
              `${Hash.fast(input.subjectHash)}.json`,
            ),
          ).json()
          const outside = path.join(input.root, "outside-storage")
          await fs.rename(reference.repository.gitDirectory, outside)
          await fs.symlink(outside, reference.repository.gitDirectory)
        })
        const result = yield* exports.materialize(input).pipe(Effect.flip)
        expect(result).toBeInstanceOf(Snapshot.Error)
        expect(result.message).toContain("escapes native storage")
        expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "artifact.txt")).exists())).toBe(false)
      }),
    ),
  )

  it.live("does not publish a repeated capture over a damaged existing reference", () =>
    fixture((input) =>
      Effect.gen(function* () {
        const snapshots = yield* Snapshot.Service
        const target = path.join(
          input.root,
          "snapshot",
          "references",
          Hash.fast(input.project),
          `${Hash.fast(input.subjectHash)}.json`,
        )
        const original = yield* Effect.promise(() => Bun.file(target).text())
        yield* Effect.promise(() => Bun.write(target, "damaged reference"))
        expect(yield* snapshots.capture()).toBeUndefined()
        expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("damaged reference")
        yield* Effect.promise(() => Bun.write(target, original))
        expect(yield* snapshots.capture()).toBe(input.subjectHash)
      }),
    ),
  )

  it.live("exports the original handoff after the candidate Git repository is recreated", () =>
    fixture((input) =>
      Effect.gen(function* () {
        const exports = yield* ProContractExport.Service
        const contracts = yield* ProContract.Service
        const history = yield* contracts.history({ contractID: input.contractID })
        yield* Effect.promise(async () => {
          const original = (await $`git rev-list --max-parents=0 HEAD`.cwd(input.project).quiet()).stdout
            .toString()
            .trim()
          const storage = path.join(input.root, "snapshot", original, `${Hash.fast(input.project)}.owned`)
          // Isolate namespace loss from borrowed objects: this seed is already self-contained.
          await $`git --git-dir ${storage} --work-tree ${input.project} repack -a`.cwd(input.project).quiet()
          await fs.rm(path.join(storage, "objects", "info", "alternates"), { force: true })
          expect(
            (await $`git --git-dir ${storage} cat-file -t ${input.subjectHash}`.cwd(input.project).quiet()).stdout
              .toString()
              .trim(),
          ).toBe("tree")
          await fs.rm(path.join(input.project, ".git"), { recursive: true })
          await Bun.write(path.join(input.project, "artifact.txt"), "replacement repository\n")
          await $`git init`.cwd(input.project).quiet()
          await $`git -c user.name=Recreated -c user.email=new@opencode.test add .`.cwd(input.project).quiet()
          await $`git -c user.name=Recreated -c user.email=new@opencode.test -c commit.gpgsign=false commit -m recreated`
            .cwd(input.project)
            .quiet()
          expect(
            (await $`git rev-list --max-parents=0 HEAD`.cwd(input.project).quiet()).stdout.toString().trim(),
          ).not.toBe(original)
          expect(
            (await $`git --git-dir ${storage} cat-file -t ${input.subjectHash}`.cwd(input.project).quiet()).stdout
              .toString()
              .trim(),
          ).toBe("tree")
        })
        expect(yield* exports.materialize(input)).toMatchObject({ subjectHash: input.subjectHash })
        expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "artifact.txt")).text())).toBe(
          "frozen\n",
        )
        expect(yield* contracts.history({ contractID: input.contractID })).toEqual(history)
      }),
    ),
  )

  it.live("exports the frozen subject without an executor or a valid model catalog", () =>
    fixture((input) =>
      Effect.gen(function* () {
        const exports = yield* ProContractExport.Service
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const history = yield* contracts.history({ contractID: input.contractID })
        const binding = yield* bindings.get(input.contractID)
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(input.project, "artifact.txt"), "unverified replacement\n")
          await fs.writeFile(path.join(input.project, "extra.txt"), "not in the handoff\n")
        })

        expect(yield* exports.materialize(input)).toEqual({
          contractID: input.contractID,
          subjectHash: input.subjectHash,
          directory: input.directory,
        })
        expect(yield* Effect.promise(() => fs.readFile(path.join(input.directory, "artifact.txt"), "utf8"))).toBe(
          "frozen\n",
        )
        expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "extra.txt")).exists())).toBe(false)
        expect(
          (yield* Effect.promise(() => $`git write-tree`.cwd(input.directory).quiet())).stdout.toString().trim(),
        ).toBe(input.subjectHash)
        expect(
          (yield* Effect.promise(() => $`git status --porcelain`.cwd(input.directory).quiet())).stdout.toString(),
        ).toBe("")
        expect(yield* bindings.get(input.contractID)).toEqual(binding)
        expect(yield* contracts.history({ contractID: input.contractID })).toEqual(history)
        expect(yield* contracts.get(input.contractID)).toMatchObject({ status: "verification" })
        expect(yield* contracts.quiet("export-test")).toMatchObject({ quiet: false, outstanding: [input.contractID] })
      }),
    ),
  )

  it.live("does not overwrite an existing destination", () =>
    fixture((input) =>
      Effect.gen(function* () {
        const exports = yield* ProContractExport.Service
        yield* Effect.promise(async () => {
          await fs.mkdir(input.directory)
          await fs.writeFile(path.join(input.directory, "keep.txt"), "keep\n")
        })
        const result = yield* exports.materialize(input).pipe(Effect.flip)
        expect(result).toBeInstanceOf(Snapshot.Error)
        expect(result.message).toContain("Directory already exists")
        expect(yield* Effect.promise(() => fs.readdir(input.directory))).toEqual(["keep.txt"])
      }),
    ),
  )

  it.live("rejects a missing contract before creating a directory", () =>
    fixture((input) =>
      Effect.gen(function* () {
        const exports = yield* ProContractExport.Service
        const result = yield* exports
          .materialize({ ...input, contractID: ProContract.ID.make("pct_missing") })
          .pipe(Effect.flip)
        expect(result).toBeInstanceOf(ProContractExport.Error)
        expect(result.message).toContain("Contract not found")
        expect(yield* Effect.promise(() => fs.readdir(input.root))).not.toContain("export")
      }),
    ),
  )

  it.live("does not export a handoff cleared by challenge", () =>
    fixture((input) =>
      Effect.gen(function* () {
        const exports = yield* ProContractExport.Service
        const contracts = yield* ProContract.Service
        expect(
          (yield* contracts.challenge({
            contractID: input.contractID,
            revision: 1,
            subjectHash: input.subjectHash,
            evidenceHash: "counterevidence",
            disclosure: "executor",
            summary: "The frozen subject lost its support",
            time: 2,
          })).decision,
        ).toEqual({ type: "accepted" })
        const result = yield* exports.materialize(input).pipe(Effect.flip)
        expect(result.message).toContain("Contract has no current handoff")
        expect(yield* Effect.promise(() => fs.readdir(input.root))).not.toContain("export")
      }),
    ),
  )

  it.live("requires a persisted execution binding", () =>
    fixture((input) =>
      Effect.gen(function* () {
        const exports = yield* ProContractExport.Service
        const contracts = yield* ProContract.Service
        const contractID = ProContract.ID.make("pct_unbound")
        yield* contracts.issue({
          id: contractID,
          scope: "export-test",
          spec: ProContract.defaultSpec("Export", 0),
          executor: "opencode",
        })
        yield* contracts.activate(contractID, 1, 0)
        yield* contracts.reportReady({
          contractID,
          revision: 1,
          summary: "ready",
          uncertainties: [],
          subjectHash: input.subjectHash,
          time: 1,
        })
        const result = yield* exports.materialize({ ...input, contractID }).pipe(Effect.flip)
        expect(result.message).toContain("OpenCode execution not found")
        expect(yield* Effect.promise(() => fs.readdir(input.root))).not.toContain("export")
      }),
    ),
  )

  it.live("honors snapshot disabling instead of bypassing location policy", () =>
    fixture((input) =>
      Effect.gen(function* () {
        const exports = yield* ProContractExport.Service
        yield* Effect.promise(() =>
          fs.writeFile(path.join(input.project, "opencode.json"), JSON.stringify({ snapshots: false })),
        )
        const result = yield* exports.materialize(input).pipe(Effect.flip)
        expect(result.message).toBe("Snapshots are disabled")
        expect(yield* Effect.promise(() => fs.readdir(input.root))).not.toContain("export")
      }),
    ),
  )

  it.live("never substitutes the live workspace for a missing snapshot", () =>
    fixture((input) =>
      Effect.gen(function* () {
        const exports = yield* ProContractExport.Service
        const contracts = yield* ProContract.Service
        yield* contracts.challenge({
          contractID: input.contractID,
          revision: 1,
          subjectHash: input.subjectHash,
          evidenceHash: "counterevidence",
          disclosure: "executor",
          summary: "Replace the prior handoff",
          time: 2,
        })
        yield* contracts.activate(input.contractID, 1, 3)
        yield* contracts.reportReady({
          contractID: input.contractID,
          revision: 1,
          summary: "missing snapshot",
          uncertainties: [],
          subjectHash: "a".repeat(40),
          time: 4,
        })
        const history = yield* contracts.history({ contractID: input.contractID })
        const result = yield* exports.materialize(input).pipe(Effect.flip)
        expect(result).toBeInstanceOf(Snapshot.Error)
        expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "artifact.txt")).exists())).toBe(false)
        expect(yield* contracts.history({ contractID: input.contractID })).toEqual(history)
        expect(yield* contracts.get(input.contractID)).toMatchObject({ status: "verification" })
      }),
    ),
  )
})

function fixture(
  run: (input: {
    root: string
    project: string
    contractID: ProContract.ID
    directory: AbsolutePath
    subjectHash: Snapshot.ID
  }) => Effect.Effect<
    void,
    unknown,
    ProContractExport.Service | ProContract.Service | ProContractOpenCode.Service | Snapshot.Service
  >,
) {
  return Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const project = path.join(tmp.path, "project")
        yield* Effect.promise(async () => {
          await fs.mkdir(project)
          await fs.writeFile(path.join(project, "artifact.txt"), "frozen\n")
          await fs.writeFile(path.join(tmp.path, "models.json"), JSON.stringify({ irrelevant: null }))
          await $`git init`.cwd(project).quiet()
          await $`git config core.fsmonitor false`.cwd(project).quiet()
          await $`git config commit.gpgsign false`.cwd(project).quiet()
          await $`git config user.email test@opencode.test`.cwd(project).quiet()
          await $`git config user.name Test`.cwd(project).quiet()
          await $`git add .`.cwd(project).quiet()
          await $`git commit -m initial`.cwd(project).quiet()
        })
        yield* Effect.gen(function* () {
          const snapshots = yield* Snapshot.Service
          const contracts = yield* ProContract.Service
          const bindings = yield* ProContractOpenCode.Service
          const contractID = ProContract.ID.make("pct_export")
          const subjectHash = yield* snapshots.capture()
          if (!subjectHash) return yield* Effect.die("Fixture snapshot was not captured")
          yield* bindings.issue({
            id: contractID,
            scope: "export-test",
            spec: ProContract.defaultSpec("Export the frozen candidate", 0),
            location: { directory: AbsolutePath.make(project) },
            model: ModelV2.Ref.make({
              providerID: ProviderV2.ID.make("unavailable"),
              id: ModelV2.ID.make("never-execute"),
            }),
            now: 0,
          })
          yield* contracts.activate(contractID, 1, 0)
          yield* contracts.reportReady({
            contractID,
            revision: 1,
            summary: "ready",
            uncertainties: [],
            subjectHash,
            time: 1,
          })
          yield* run({
            root: tmp.path,
            project,
            contractID,
            subjectHash,
            directory: AbsolutePath.make(path.join(tmp.path, "export")),
          })
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([ProContractExport.node, ProContract.node, ProContractOpenCode.node, Snapshot.node]),
              [
                [Database.node, Database.layerFromPath(path.join(tmp.path, "export.db"))],
                [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))],
                [
                  Global.node,
                  Global.layerWith({ data: tmp.path, config: path.join(tmp.path, "config"), cache: tmp.path }),
                ],
              ],
            ),
          ),
        )
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
}
