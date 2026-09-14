import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

describe("Snapshot", () => {
  for (const transition of ["legacy", "recreated"] as const) {
    testEffect(Layer.empty).live(`reads and restores snapshots across ${transition} storage`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            yield* Effect.promise(async () => {
              await fs.mkdir(project)
              await Bun.write(path.join(project, "tracked.txt"), "seed\n")
              await $`git init`.cwd(project).quiet()
              await $`git add .`.cwd(project).quiet()
              await $`git -c user.name=Test -c user.email=test@opencode.test -c commit.gpgsign=false commit -m seed`
                .cwd(project)
                .quiet()
              await Bun.write(path.join(project, "tracked.txt"), "old snapshot\n")
            })
            const old = yield* Effect.gen(function* () {
              const snapshots = yield* Snapshot.Service
              return yield* snapshots.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
            expect(old).toBeDefined()
            if (!old) return
            yield* Effect.promise(async () => {
              if (transition === "legacy") {
                const id = (await $`git rev-list --max-parents=0 HEAD`.cwd(project).quiet()).stdout.toString().trim()
                const legacy = path.join(tmp.path, "snapshot", id, Hash.fast(project))
                await fs.rename(`${legacy}.owned`, legacy)
                await fs.rm(path.join(tmp.path, "snapshot", "references"), { recursive: true })
              }
              await Bun.write(path.join(project, "tracked.txt"), "new snapshot\n")
              await Bun.write(path.join(project, "added.txt"), "added\n")
              if (transition === "recreated") {
                await fs.rm(path.join(project, ".git"), { recursive: true })
                await $`git init`.cwd(project).quiet()
                await $`git add .`.cwd(project).quiet()
                await $`git -c user.name=New -c user.email=new@opencode.test -c commit.gpgsign=false commit -m recreated`
                  .cwd(project)
                  .quiet()
              }
            })
            yield* Effect.gen(function* () {
              const snapshots = yield* Snapshot.Service
              const current = yield* snapshots.capture()
              expect(current).toBeDefined()
              if (!current) return
              expect(yield* snapshots.files({ from: old, to: current })).toEqual([
                RelativePath.make("added.txt"),
                RelativePath.make("tracked.txt"),
              ])
              expect((yield* snapshots.diff({ from: old, to: current })).map((item) => item.path)).toEqual([
                RelativePath.make("added.txt"),
                RelativePath.make("tracked.txt"),
              ])
              expect(yield* snapshots.files({ from: current, to: old })).toEqual([
                RelativePath.make("added.txt"),
                RelativePath.make("tracked.txt"),
              ])
              expect((yield* snapshots.diff({ from: current, to: old })).map((item) => item.path)).toEqual([
                RelativePath.make("added.txt"),
                RelativePath.make("tracked.txt"),
              ])
              const selected = new Map([
                [RelativePath.make("added.txt"), current],
                [RelativePath.make("tracked.txt"), old],
              ])
              expect((yield* snapshots.preview({ files: selected })).some((item) => item.path === "tracked.txt")).toBe(
                true,
              )
              yield* snapshots.restore({ files: selected })
              expect(yield* read(path.join(project, "tracked.txt"))).toBe("old snapshot\n")
              expect(yield* read(path.join(project, "added.txt"))).toBe("added\n")
              yield* snapshots.checkout(current)
              expect(yield* read(path.join(project, "tracked.txt"))).toBe("new snapshot\n")
              yield* snapshots.checkout(old)
              expect(yield* read(path.join(project, "tracked.txt"))).toBe("old snapshot\n")
            }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  testEffect(Layer.empty).live("publishes snapshot storage only after the seed objects are retained", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await Bun.write(path.join(project, "tracked.txt"), "seed bytes\n")
            await $`git init`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git -c user.name=Test -c user.email=test@opencode.test -c commit.gpgsign=false commit -m seed`
              .cwd(project)
              .quiet()
          })
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const original = yield* Effect.promise(() => fs.readFile(path.join(project, ".git", "index")))
            yield* Effect.promise(() => Bun.write(path.join(project, ".git", "index"), "invalid seed index"))
            expect(yield* snapshot.capture()).toBeUndefined()
            const root = (yield* Effect.promise(() => $`git rev-list --max-parents=0 HEAD`.cwd(project).quiet())).stdout
              .toString()
              .trim()
            expect(yield* Effect.promise(() => fs.readdir(path.join(tmp.path, "snapshot", root)))).toEqual([])
            yield* Effect.promise(() => Bun.write(path.join(project, ".git", "index"), original))
            const captured = yield* snapshot.capture()
            expect(captured).toBeDefined()
            if (!captured) return
            const directory = AbsolutePath.make(path.join(tmp.path, "export"))
            yield* snapshot.materialize({ snapshot: captured, directory })
            expect(yield* read(path.join(directory, "tracked.txt"))).toBe("seed bytes\n")
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("does not reuse a previous snapshot when refreshing the index fails", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await Bun.write(path.join(project, "tracked.txt"), "before\n")
            await $`git init`.cwd(project).quiet()
            await $`git -c user.name=Test -c user.email=test@opencode.test add .`.cwd(project).quiet()
            await $`git -c user.name=Test -c user.email=test@opencode.test -c commit.gpgsign=false commit -m seed`
              .cwd(project)
              .quiet()
          })
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const captured = yield* snapshot.capture()
            expect(captured).toBeDefined()
            const original = (yield* Effect.promise(() =>
              $`git rev-list --max-parents=0 HEAD`.cwd(project).quiet(),
            )).stdout
              .toString()
              .trim()
            const lock = path.join(tmp.path, "snapshot", original, `${Hash.fast(project)}.owned`, "index.lock")
            yield* Effect.promise(async () => {
              await Bun.write(path.join(project, "tracked.txt"), "after\n")
              await Bun.write(lock, "owned failure injection")
            })
            expect(yield* snapshot.capture()).toBeUndefined()
            yield* Effect.promise(() => fs.rm(lock))
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            expect(after).not.toBe(captured)
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("owns captured objects after the source Git repository is removed", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await Bun.write(path.join(project, "tracked.txt"), "frozen seed bytes\n")
            await $`git init`.cwd(project).quiet()
            await $`git -c user.name=Test -c user.email=test@opencode.test add .`.cwd(project).quiet()
            await $`git -c user.name=Test -c user.email=test@opencode.test -c commit.gpgsign=false commit -m seed`
              .cwd(project)
              .quiet()
          })
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const captured = yield* snapshot.capture()
            expect(captured).toBeDefined()
            if (!captured) return
            yield* Effect.promise(async () => {
              await fs.rm(path.join(project, ".git"), { recursive: true })
              await Bun.write(path.join(project, "tracked.txt"), "live replacement\n")
            })
            const directory = AbsolutePath.make(path.join(tmp.path, "export"))
            const next = yield* snapshot.capture()
            expect(next).toBeDefined()
            expect(next).not.toBe(captured)
            yield* snapshot.materialize({ snapshot: captured, directory })
            expect(yield* read(path.join(directory, "tracked.txt"))).toBe("frozen seed bytes\n")
            expect(yield* read(path.join(project, "tracked.txt"))).toBe("live replacement\n")
            if (!next) return
            const updated = AbsolutePath.make(path.join(tmp.path, "updated"))
            yield* snapshot.materialize({ snapshot: next, directory: updated })
            expect(yield* read(path.join(updated, "tracked.txt"))).toBe("live replacement\n")
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("captures and restores Location-scoped changes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const location = path.join(project, "scope")
          yield* Effect.promise(async () => {
            await fs.mkdir(location, { recursive: true })
            await fs.writeFile(path.join(location, "tracked.txt"), "one\n")
            await fs.writeFile(path.join(project, "outside.txt"), "outside\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })

          const layer = snapshotLayer(tmp.path, location)
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return

            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(location, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(location, "added.txt"), "added\n")
              await fs.writeFile(path.join(project, "outside.txt"), "changed outside\n")
            })
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            if (!after) return

            const materialized = path.join(tmp.path, "materialized")
            yield* snapshot.materialize({ snapshot: after, directory: AbsolutePath.make(materialized) })
            expect(yield* read(path.join(materialized, "scope", "tracked.txt"))).toBe("two\n")
            expect(yield* read(path.join(materialized, "scope", "added.txt"))).toBe("added\n")
            expect(yield* read(path.join(materialized, "outside.txt"))).toBe("outside\n")
            expect(
              (yield* Effect.promise(() => $`git rev-parse --is-inside-work-tree`.cwd(materialized).quiet())).stdout
                .toString()
                .trim(),
            ).toBe("true")
            expect(
              (yield* Effect.promise(() => $`git status --short`.cwd(materialized).quiet())).stdout.toString(),
            ).toBe("")

            expect(yield* snapshot.files({ from: before, to: after })).toEqual([
              RelativePath.make("scope/added.txt"),
              RelativePath.make("scope/tracked.txt"),
            ])
            const plan = new Map([[RelativePath.make("scope/tracked.txt"), before]])
            const preview = yield* snapshot.preview({ files: plan, context: 1 })
            expect(preview).toHaveLength(1)
            expect(preview[0]?.path).toBe(RelativePath.make("scope/tracked.txt"))
            yield* snapshot.restore({ files: plan })
            expect(yield* read(path.join(location, "tracked.txt"))).toBe("one\n")
            expect(yield* read(path.join(location, "added.txt"))).toBe("added\n")
            expect(yield* read(path.join(project, "outside.txt"))).toBe("changed outside\n")
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("force includes ignored delivery artifacts", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const location = path.join(project, "scope")
          const artifact = Buffer.alloc(2 * 1024 * 1024 + 1, 7)
          yield* Effect.promise(async () => {
            await fs.mkdir(location, { recursive: true })
            await fs.writeFile(path.join(location, ".gitignore"), "executable\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
            await fs.writeFile(path.join(location, "executable"), artifact)
          })

          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const normal = yield* snapshot.capture()
            expect(normal).toBeDefined()
            if (!normal) return
            const normalDirectory = AbsolutePath.make(path.join(tmp.path, "normal"))
            yield* snapshot.materialize({ snapshot: normal, directory: normalDirectory })
            expect(
              yield* Effect.promise(() => Bun.file(path.join(normalDirectory, "scope", "executable")).exists()),
            ).toBe(false)

            const included = yield* snapshot.capture({ include: [RelativePath.make("executable")] })
            expect(included).toBeDefined()
            if (!included) return
            const includedDirectory = AbsolutePath.make(path.join(tmp.path, "included"))
            yield* snapshot.materialize({ snapshot: included, directory: includedDirectory })
            expect(
              yield* Effect.promise(() => fs.readFile(path.join(includedDirectory, "scope", "executable"))),
            ).toEqual(artifact)
          }).pipe(Effect.provide(snapshotLayer(tmp.path, location)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("treats capture outside Git as unavailable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          expect(
            yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, tmp.path))),
          ).toBeUndefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("isolates snapshot indexes by canonical Git worktree", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const linked = path.join(tmp.path, "linked")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "main\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
            await $`git worktree add --detach ${linked} HEAD`.cwd(project).quiet()
          })

          const capture = (directory: string) =>
            Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, directory)))
          expect(yield* capture(project)).toBeDefined()
          expect(yield* capture(linked)).toBeDefined()

          const projectID = yield* Effect.gen(function* () {
            return (yield* Location.Service).project.id
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))),
            ),
          )
          expect(
            yield* Effect.promise(() =>
              fs.stat(path.join(tmp.path, "snapshot", projectID, `${Hash.fast(project)}.owned`)),
            ),
          ).toBeDefined()
          expect(
            yield* Effect.promise(() =>
              fs.stat(path.join(tmp.path, "snapshot", projectID, `${Hash.fast(linked)}.owned`)),
            ),
          ).toBeDefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("checks out a legacy revert snapshot without removing unrelated files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })

          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return
            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(project, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(project, "unrelated.txt"), "keep\n")
            })
            yield* snapshot.checkout(before)
            expect(yield* read(path.join(project, "tracked.txt"))).toBe("one\n")
            expect(yield* read(path.join(project, "unrelated.txt"))).toBe("keep\n")
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

function snapshotLayer(data: string, directory: string) {
  return AppNodeBuilder.build(Snapshot.node, [
    [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))],
    [Global.node, Global.layerWith({ data, config: path.join(data, "config") })],
  ])
}

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replaceAll("\r\n", "\n")))
}
