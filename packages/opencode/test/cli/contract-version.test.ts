import { describe, expect } from "bun:test"
import { ProContractVersion } from "@opencode-ai/core/pro-contract/version"
import { ProContract } from "@opencode-ai/schema/pro-contract"
import { Effect, Schema } from "effect"
import { mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

const Frozen = Schema.Struct({ versionHash: Schema.String, manifest: ProContractVersion.Manifest })
const Qualified = Schema.Struct({
  run: ProContractVersion.Record,
  qualification: Schema.Struct({ runID: Schema.String, evidenceHash: Schema.String }),
})
const Executed = Schema.Struct({ contract: ProContract.Info, run: ProContractVersion.Record })

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
    "runs ordinary work without a research policy and authorizes its produced method without accepting the work",
    ({ home, opencode, llm }) =>
      Effect.gen(function* () {
        const command = (args: string[]) =>
          opencode.spawn(args, { env: { OPENCODE_DB: path.join(home, "contracts.sqlite") } })
        const run = (args: string[]) => command(["contract", "version", ...args])
        const successor = `
const input = await Bun.stdin.json()
console.log(JSON.stringify({ version: 1, observations: [{ successor: input.task.input }], requests: [], artifacts: [] }))
`
        yield* Effect.promise(() => mkdir(path.join(home, "source")))
        yield* Effect.promise(() => mkdir(path.join(home, "workspace")))
        yield* Effect.promise(() => Bun.write(path.join(home, "workspace", "notes.txt"), "An ordinary writing task."))
        yield* Effect.promise(() => Bun.write(path.join(home, "task.json"), '{"kind":"write-report"}'))
        yield* Effect.promise(() =>
          Bun.write(path.join(home, "policy.txt"), "Read the supplied notes and prepare a report."),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, "source", "workflow.ts"),
            `
const input = await Bun.stdin.json()
await Bun.write("report.txt", await Bun.file("notes.txt").text())
await Bun.write("candidate/workflow.ts", ${JSON.stringify(successor)})
console.log(JSON.stringify({
  version: 1,
  observations: [input.task.input],
  requests: [{ type: "accept", contractID: input.task.contractID }],
  artifacts: ["report.txt", "candidate/workflow.ts"],
}))
`,
          ),
        )
        const missing = yield* command(["contract", "strategy", "show", "ordinary"])
        expect(missing.exitCode).not.toBe(0)
        expect(missing.stderr).toContain("Strategy scope not found: ordinary")
        const frozen = yield* run(["freeze", "--directory", "source", "--entrypoint", "workflow.ts"])
        opencode.expectExit(frozen, 0, "freeze ordinary method")
        const version = Schema.decodeUnknownSync(Schema.fromJsonString(Frozen))(frozen.stdout)
        const authorize = [
          "authorize",
          version.versionHash,
          "--id",
          "pct_cli_ordinary_method",
          "--scope",
          "ordinary",
          "--policy",
          "policy.txt",
          "--evidence-hash",
          "a".repeat(64),
        ]
        const authorized = yield* run(authorize)
        opencode.expectExit(authorized, 0, "explicit method authorization without a policy")
        const method = Schema.decodeUnknownSync(Schema.fromJsonString(ProContract.ExecutionAuthorization))(
          authorized.stdout,
        )
        const retry = yield* run(authorize)
        opencode.expectExit(retry, 0, "exact method authorization retry")
        expect(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(retry.stdout)).toEqual(method)
        yield* Effect.promise(() => Bun.write(path.join(home, "method.json"), authorized.stdout))

        const executed = yield* run([
          "run",
          "--id",
          "pct_cli_ordinary_task",
          "--scope",
          "ordinary",
          "--method",
          "method.json",
          "--task",
          "task.json",
          "--workspace",
          "workspace",
          "--target-executable",
          version.versionHash,
          "--deadline",
          new Date(Date.now() + 60_000).toISOString(),
        ])
        opencode.expectExit(executed, 0, "ordinary work uses its directly authorized frozen method")
        const result = Schema.decodeUnknownSync(Schema.fromJsonString(Executed))(executed.stdout)
        expect(result.run.status).toBe("completed")
        expect(result.run.versionHash).toBe(version.versionHash)
        expect(result.run.targetVersion).toBe(version.versionHash)
        expect(result.contract.status).toBe("verification")
        expect(result.contract.spec.requires).toEqual([])
        expect(result.run.result).toMatchObject({
          observations: [{ kind: "write-report" }],
          requests: [{ type: "accept", contractID: result.contract.id }],
        })

        const exported = yield* run(["export", result.run.id, "--directory", "exported"])
        opencode.expectExit(exported, 0, "inspect ordinary task artifacts independently")
        const report = yield* Effect.promise(() => Bun.file(path.join(home, "exported", "report.txt")).text())
        expect(report).toBe("An ordinary writing task.")
        expect(
          yield* Effect.promise(() => Bun.file(path.join(home, "exported", "candidate", "workflow.ts")).text()),
        ).toBe(successor)
        const next = yield* run(["freeze", "--directory", "exported/candidate", "--entrypoint", "workflow.ts"])
        opencode.expectExit(next, 0, "freeze ordinary artifact as successor method")
        const candidate = Schema.decodeUnknownSync(Schema.fromJsonString(Frozen))(next.stdout)
        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, "source.json"),
            JSON.stringify({
              contractID: result.contract.id,
              revision: result.contract.revision,
              specHash: result.contract.specHash,
              subjectHash: result.contract.handoff!.subjectHash,
              runID: result.run.id,
            }),
          ),
        )
        const adopted = yield* run([
          "authorize",
          candidate.versionHash,
          "--scope",
          "ordinary",
          "--source",
          "source.json",
          "--evidence-hash",
          new Bun.CryptoHasher("sha256").update(successor).digest("hex"),
        ])
        opencode.expectExit(adopted, 0, "ordinary output can become a method with explicit source and authorization")
        yield* Effect.promise(() => Bun.write(path.join(home, "successor.json"), adopted.stdout))
        const stillPending = yield* command(["contract", "show", result.contract.id])
        opencode.expectExit(stillPending, 0, "successor authorization does not accept the generating task")
        expect(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(stillPending.stdout)).toMatchObject({
          status: "verification",
        })
        const continued = yield* run([
          "run",
          "--scope",
          "ordinary",
          "--method",
          "successor.json",
          "--task",
          "task.json",
          "--workspace",
          "workspace",
          "--deadline",
          new Date(Date.now() + 60_000).toISOString(),
        ])
        opencode.expectExit(continued, 0, "actual ordinary successor runs the next task")
        expect(Schema.decodeUnknownSync(Schema.fromJsonString(Executed))(continued.stdout)).toMatchObject({
          contract: { status: "verification", spec: { requires: [] } },
          run: {
            versionHash: candidate.versionHash,
            result: { observations: [{ successor: { kind: "write-report" } }] },
          },
        })

        const attested = yield* command([
          "contract",
          "attest",
          result.contract.id,
          "--revision",
          String(result.contract.revision),
          "--spec-hash",
          result.contract.specHash,
          "--subject-hash",
          result.contract.handoff!.subjectHash,
          "--evidence-hash",
          new Bun.CryptoHasher("sha256").update(report).digest("hex"),
        ])
        opencode.expectExit(attested, 0, "explicit principal accepts the inspected report")
        const accepted = yield* command(["contract", "show", result.contract.id])
        opencode.expectExit(accepted, 0, "show independently accepted ordinary task")
        expect(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(accepted.stdout)).toMatchObject({
          status: "discharged",
        })
        const noPolicy = yield* command(["contract", "strategy", "show", "ordinary"])
        expect(noPolicy.exitCode).not.toBe(0)
        expect(noPolicy.stderr).toContain("Strategy scope not found: ordinary")
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
        const direct = [
          "run",
          "--scope",
          "missing",
          "--workspace",
          "source",
          "--task",
          "task.json",
          "--deadline",
          "2100-01-01T00:00:00Z",
        ]
        yield* Effect.forEach([[], ["--role", "incumbent", "--method", "missing.json"]], (selection) =>
          Effect.gen(function* () {
            const ambiguous = yield* run([...direct, ...selection])
            expect(ambiguous.exitCode).not.toBe(0)
            expect(ambiguous.stderr).toContain("Use exactly one of --role or --method")
          }),
        )
        const wrongArchive = yield* run([...direct, "--method", "missing.json", "--target-version", "a".repeat(64)])
        expect(wrongArchive.exitCode).not.toBe(0)
        expect(wrongArchive.stderr).toContain("--target-version requires --role")
        const wrongExecutable = yield* run([...direct, "--role", "incumbent", "--target-executable", "a".repeat(64)])
        expect(wrongExecutable.exitCode).not.toBe(0)
        expect(wrongExecutable.stderr).toContain("--target-executable requires --method")

        yield* Effect.promise(() => Bun.write(path.join(home, "task.json"), "{}"))
        yield* Effect.promise(() => Bun.write(path.join(home, "method.json"), '{"contractID":"pct_incomplete"}'))
        const malformedMethod = yield* run([...direct, "--method", "method.json"])
        expect(malformedMethod.exitCode).not.toBe(0)
        expect(malformedMethod.stderr).toContain("Invalid JSON file method.json")
        yield* Effect.promise(() => Bun.write(path.join(home, "source.json"), '{"runID":"incomplete"}'))
        const malformedSource = yield* run([
          "authorize",
          "a".repeat(64),
          "--scope",
          "missing",
          "--evidence-hash",
          "b".repeat(64),
          "--source",
          "source.json",
        ])
        expect(malformedSource.exitCode).not.toBe(0)
        expect(malformedSource.stderr).toContain("Invalid JSON file source.json")
        expect(yield* llm.calls).toBe(0)
      }),
    120_000,
  )
})
