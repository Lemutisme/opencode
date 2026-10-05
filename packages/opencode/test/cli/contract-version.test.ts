import { describe, expect } from "bun:test"
import { ProContractVersion } from "@opencode-ai/core/pro-contract/version"
import { Effect, Schema } from "effect"
import { mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

const Frozen = Schema.Struct({ versionHash: Schema.String, manifest: ProContractVersion.Manifest })
const Qualified = Schema.Struct({
  run: ProContractVersion.Record,
  qualification: Schema.Struct({ runID: Schema.String, evidenceHash: Schema.String }),
})

describe("contract executable version CLI", () => {
  cliIt.live(
    "freezes exact source and configuration and inspects the retained version without a model call",
    ({ home, opencode, llm }) =>
      Effect.gen(function* () {
        const run = (args: string[]) => opencode.spawn(["contract", "version", ...args])
        yield* Effect.promise(() => mkdir(path.join(home, "source")))
        yield* Effect.promise(() => Bun.write(path.join(home, "source", "workflow.ts"), "console.log('workflow-v0')\n"))
        yield* Effect.promise(() => Bun.write(path.join(home, "config.json"), '{"diagnosis":"feedback-stagnation"}'))
        const freeze = ["freeze", "--directory", "source", "--entrypoint", "workflow.ts", "--config", "config.json"]
        const initial = yield* run(freeze)
        opencode.expectExit(initial, 0, "freeze workflow")
        const version = Schema.decodeUnknownSync(Schema.fromJsonString(Frozen))(initial.stdout)
        expect(version.versionHash).toMatch(/^[a-f0-9]{64}$/)
        expect(version.manifest.config).toEqual({ diagnosis: "feedback-stagnation" })
        expect(version.manifest.entrypoint).toBe("workflow.ts")
        expect(version.manifest.files).toHaveLength(1)

        const retry = yield* run(freeze)
        opencode.expectExit(retry, 0, "exact freeze retry")
        expect(Schema.decodeUnknownSync(Schema.fromJsonString(Frozen))(retry.stdout)).toEqual(version)

        yield* Effect.promise(() => Bun.write(path.join(home, "source", "workflow.ts"), "console.log('workflow-v1')\n"))
        const inspected = yield* run(["inspect", version.versionHash])
        opencode.expectExit(inspected, 0, "inspect frozen copy after source change")
        expect(Schema.decodeUnknownSync(Schema.fromJsonString(Frozen))(inspected.stdout)).toEqual(version)
        const successor = yield* run(freeze)
        opencode.expectExit(successor, 0, "freeze changed source")
        expect(Schema.decodeUnknownSync(Schema.fromJsonString(Frozen))(successor.stdout).versionHash).not.toBe(
          version.versionHash,
        )
        expect(yield* llm.calls).toBe(0)
      }),
    120_000,
  )

  cliIt.live(
    "qualifies offline, retains untrusted requests, and exports only to a fresh non-host directory",
    ({ home, opencode, llm }) =>
      Effect.gen(function* () {
        const run = (args: string[]) => opencode.spawn(["contract", "version", ...args])
        yield* Effect.promise(() => mkdir(path.join(home, "source")))
        yield* Effect.promise(() => mkdir(path.join(home, "workspace")))
        yield* Effect.promise(() => Bun.write(path.join(home, "task.json"), '{"probe":"startup"}'))
        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, "source", "workflow.ts"),
            `
const input = await Bun.stdin.json()
await Bun.write("diagnostic.txt", "startup completed")
console.log(JSON.stringify({
  version: 1,
  observations: [input.task],
  requests: [{ type: "accept", arbitrary: true }],
  artifacts: ["diagnostic.txt"],
}))
`,
          ),
        )
        const frozen = yield* run(["freeze", "--directory", "source", "--entrypoint", "workflow.ts"])
        opencode.expectExit(frozen, 0, "freeze qualification workflow")
        const version = Schema.decodeUnknownSync(Schema.fromJsonString(Frozen))(frozen.stdout)
        const qualified = yield* run([
          "qualify",
          version.versionHash,
          "--task",
          "task.json",
          "--workspace",
          "workspace",
          "--deadline",
          new Date(Date.now() + 60_000).toISOString(),
        ])
        opencode.expectExit(qualified, 0, "offline startup qualification")
        const result = Schema.decodeUnknownSync(Schema.fromJsonString(Qualified))(qualified.stdout)
        expect(result.run.status).toBe("completed")
        expect(result.qualification).toEqual({
          runID: result.run.id,
          evidenceHash: ProContractVersion.subjectHash(result.run),
        })
        expect(result.run.result).toMatchObject({
          observations: [{ purpose: "qualification", input: { probe: "startup" } }],
          requests: [{ type: "accept", arbitrary: true }],
        })
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "workspace", "diagnostic.txt")).exists())).toBe(
          false,
        )

        const protectedPath = path.join(home, ".local", "share", "opencode", "pro-contract", "versions", "exported")
        const protectedExport = yield* run(["export", result.run.id, "--directory", protectedPath])
        expect(protectedExport.exitCode).not.toBe(0)
        expect(protectedExport.stderr).toContain("Artifact exports must remain outside host data storage")

        const exported = yield* run(["export", result.run.id, "--directory", "exported"])
        opencode.expectExit(exported, 0, "export qualification artifacts")
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "exported", "diagnostic.txt")).text())).toBe(
          "startup completed",
        )
        const overwrite = yield* run(["export", result.run.id, "--directory", "exported"])
        expect(overwrite.exitCode).not.toBe(0)
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "exported", "diagnostic.txt")).text())).toBe(
          "startup completed",
        )
        expect(yield* llm.calls).toBe(0)
      }),
    120_000,
  )

  cliIt.live(
    "rejects malformed configuration, unsafe source, invalid deadlines and unbound model variants",
    ({ home, opencode, llm }) =>
      Effect.gen(function* () {
        const run = (args: string[]) => opencode.spawn(["contract", "version", ...args])
        yield* Effect.promise(() => mkdir(path.join(home, "source")))
        yield* Effect.promise(() => Bun.write(path.join(home, "source", "workflow.ts"), "console.log('workflow')\n"))
        yield* Effect.promise(() => Bun.write(path.join(home, "config.json"), "{malformed"))
        const malformed = yield* run([
          "freeze",
          "--directory",
          "source",
          "--entrypoint",
          "workflow.ts",
          "--config",
          "config.json",
        ])
        expect(malformed.exitCode).not.toBe(0)
        expect(malformed.stderr).toContain("Invalid JSON file config.json")

        const traversal = yield* run(["freeze", "--directory", "source", "--entrypoint", "../workflow.ts"])
        expect(traversal.exitCode).not.toBe(0)
        expect(traversal.stderr).toContain("Expected a normalized package-relative path")

        yield* Effect.promise(() => symlink(path.join(home, "config.json"), path.join(home, "source", "secret.json")))
        const unsafe = yield* run(["freeze", "--directory", "source", "--entrypoint", "workflow.ts"])
        expect(unsafe.exitCode).not.toBe(0)

        const task = [
          "run",
          "--scope",
          "missing",
          "--role",
          "incumbent",
          "--workspace",
          "source",
          "--task",
          "missing.json",
        ]
        const deadline = yield* run([...task, "--deadline", "not-a-time"])
        expect(deadline.exitCode).not.toBe(0)
        expect(deadline.stderr).toContain("Invalid deadline: not-a-time")
        const variant = yield* run([...task, "--deadline", "2100-01-01T00:00:00Z", "--variant", "high"])
        expect(variant.exitCode).not.toBe(0)
        expect(variant.stderr).toContain("--variant requires --model")
        yield* Effect.forEach(["pct_missing-revision", "pct_dependency@9007199254740993"], (requirement) =>
          Effect.gen(function* () {
            const invalid = yield* run([...task, "--deadline", "2100-01-01T00:00:00Z", "--require", requirement])
            expect(invalid.exitCode).not.toBe(0)
            expect(invalid.stderr).toContain(`Invalid required Contract: ${requirement}`)
          }),
        )
        expect(yield* llm.calls).toBe(0)
      }),
    120_000,
  )
})
