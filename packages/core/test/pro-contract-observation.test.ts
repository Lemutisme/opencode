import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ProContractExecutor } from "@opencode-ai/core/pro-contract/executor"
import { ProContractObservation } from "@opencode-ai/core/pro-contract/observation"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const withArchive = <A, E, R>(body: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      body(tmp.path).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([ProContractObservation.node, ProContractExecutor.node, FSUtil.node]), [
            [Global.node, Global.layerWith({ data: tmp.path })],
          ]),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const run = Effect.fnUntraced(function* (
  root: string,
  source: string,
  predicates: ReadonlyArray<ProContractObservation.Predicate> = [],
  timeout = 10_000,
) {
  const executor = yield* ProContractExecutor.Service
  const observations = yield* ProContractObservation.Service
  const argv = [process.execPath, "-e", source]
  return yield* observations.record({
    scope: "pct_observation",
    subject: { kind: "candidate", identity: "frozen-subject" },
    argv,
    cwd: root,
    stdin: "input\u0000字",
    predicates,
    result: yield* executor
      .run({ argv, cwd: root, stdin: "input\u0000字", timeout })
      .pipe(Effect.catch((error) => Effect.succeed({ error: error.message }))),
  })
})

describe("ProContract observations", () => {
  it.live("retains exact binary input/output while keeping matches narrower than execution witnesses", () =>
    withArchive((root) =>
      Effect.gen(function* () {
        const archive = yield* ProContractObservation.Service
        const expected = Buffer.from("input\u0000字")
        const recorded = yield* run(root, "process.stdin.pipe(process.stdout)", [
          { id: "echo-bytes", stream: "stdout", hash: Hash.sha256(expected) },
        ])
        expect(recorded.receipt).toMatchObject({
          execution: "completed",
          exit: 0,
          targetExecution: "unobserved",
          predicates: [{ id: "echo-bytes", status: "matched" }],
          stdout: { bytes: expected.length, complete: true },
        })
        expect(yield* archive.get(recorded.handle)).toEqual(recorded.receipt)
        for (const stream of ["stdin", "stdout"] as const) {
          const selected = yield* archive.read({ handle: recorded.handle, stream, offset: 2, length: 5 })
          expect(Buffer.from(selected.data, "base64")).toEqual(expected.subarray(2, 7))
        }
        expect(
          (yield* archive.read({ handle: recorded.handle, stream: "stdout", offset: expected.length, length: 4 }))
            .readBytes,
        ).toBe(0)
      }),
    ),
  )

  it.live("cannot turn a truncated matching prefix into a successful observation", () =>
    withArchive((root) =>
      Effect.gen(function* () {
        const recorded = yield* run(
          root,
          `process.stdout.write('x'.repeat(${ProContractExecutor.MAX_OUTPUT_BYTES}) + 'FAILURE IN OMITTED BYTES')`,
          [
            {
              id: "no-failure",
              stream: "stdout",
              hash: Hash.sha256(Buffer.from("x".repeat(ProContractExecutor.MAX_OUTPUT_BYTES))),
            },
          ],
        )
        expect(recorded.receipt).toMatchObject({
          exit: 0,
          stdout: { complete: false },
          predicates: [{ status: "unobserved" }],
        })
      }),
    ),
  )

  it.live("retains partial output on timeout without fabricating completion", () =>
    withArchive((root) =>
      Effect.gen(function* () {
        const recorded = yield* run(
          root,
          "process.stdout.write('before-timeout'); setTimeout(() => {}, 10000)",
          [{ id: "empty-output", stream: "stdout", hash: Hash.sha256(Buffer.alloc(0)) }],
          200,
        )
        expect(recorded.receipt).toMatchObject({
          execution: "timed-out",
          targetExecution: "unobserved",
          predicates: [{ status: "unobserved" }],
        })
        expect(recorded.receipt.exit).toBeUndefined()
        expect(recorded.receipt.stdout?.complete).toBe(false)
        const archive = yield* ProContractObservation.Service
        const partial = yield* archive.read({ handle: recorded.handle, stream: "stdout", offset: 0, length: 1024 })
        expect(Buffer.from(partial.data, "base64").toString()).toBe("before-timeout")
      }),
    ),
  )

  it.live("deduplicates bytes atomically while retaining distinct probe receipts", () =>
    withArchive((root) =>
      Effect.gen(function* () {
        const records = yield* Effect.all(
          [run(root, "process.stdout.write('same')"), run(root, "process.stdout.write('same')")],
          { concurrency: 2 },
        )
        expect(records[0].handle).not.toBe(records[1].handle)
        expect(records[0].receipt.stdout).toEqual(records[1].receipt.stdout)
        const fs = yield* FSUtil.Service
        const files = yield* fs.readDirectory(path.join(root, "pro-contract", "observations"))
        expect(files).toHaveLength(5) // input, output, empty stderr, two receipts
        expect(files.some((name) => name.startsWith(".pending-"))).toBe(false)
        if (process.platform !== "win32") {
          expect(
            (yield* fs.stat(path.join(root, "pro-contract", "observations", records[0].handle))).mode & 0o222,
          ).toBe(0)
        }
      }),
    ),
  )

  it.live("rejects corrupt, missing, substituted and out-of-range evidence", () =>
    withArchive((root) =>
      Effect.gen(function* () {
        const archive = yield* ProContractObservation.Service
        const fs = yield* FSUtil.Service
        const recorded = yield* run(root, "process.stdout.write('truth')")
        const read = { handle: recorded.handle, stream: "stdout" as const, offset: 0, length: 16 }
        expect((yield* archive.read({ ...read, offset: 20 }).pipe(Effect.flip))._tag).toBe(
          "ProContractObservation.Unavailable",
        )
        expect((yield* archive.get("../../outside").pipe(Effect.flip))._tag).toBe("ProContractObservation.Unavailable")
        const file = path.join(root, "pro-contract", "observations", recorded.receipt.stdout!.hash)
        yield* fs.chmod(file, 0o600)
        yield* fs.writeFileString(file, "false")
        expect((yield* archive.read(read).pipe(Effect.flip))._tag).toBe("ProContractObservation.Unavailable")
        expect((yield* run(root, "process.stdout.write('truth')").pipe(Effect.flip))._tag).toBe(
          "ProContractObservation.Unavailable",
        )
        yield* fs.remove(file)
        expect((yield* archive.read(read).pipe(Effect.flip))._tag).toBe("ProContractObservation.Unavailable")
        const receipt = path.join(root, "pro-contract", "observations", recorded.handle)
        yield* fs.chmod(receipt, 0o600)
        yield* fs.writeFileString(receipt, "{}")
        expect((yield* archive.get(recorded.handle).pipe(Effect.flip))._tag).toBe("ProContractObservation.Unavailable")
      }),
    ),
  )

  it.live("fails evidence recording when the archive cannot be written", () =>
    withArchive((root) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        yield* fs.writeFileString(path.join(root, "pro-contract"), "not a directory")
        expect((yield* run(root, "process.stdout.write('ok')").pipe(Effect.flip))._tag).toBe(
          "ProContractObservation.Unavailable",
        )
      }),
    ),
  )
})
