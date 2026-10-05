import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import path from "path"
import { ProContractPolicy } from "@opencode-ai/core/pro-contract/policy"
import { ProContractPromotion } from "@opencode-ai/core/pro-contract/promotion"
import { cliIt } from "../lib/cli-process"

const bundle = {
  version: 1,
  solver: "Verify the exact public requirements before handing off the deliverable.",
  generator: "Write an improved solver/generator bundle to strategy.json without changing evaluation terms.",
} satisfies ProContractPolicy.Bundle

const protocol = {
  version: 1,
  performanceRule: "task-pareto",
  evaluatorHash: "a".repeat(64),
  tests: [
    { id: "safety", total: 1 },
    ...(["development", "confirmation"] as const).flatMap((panel) =>
      ["1", "2"].map((replicate) => ({
        id: `${panel}-${replicate}`,
        total: 10,
        performance: { panel, task: "task", replicate },
      })),
    ),
  ],
} satisfies ProContractPromotion.Protocol

const Selection = Schema.Struct({
  revision: Schema.Number,
  selected: Schema.Number,
  history: Schema.Array(
    Schema.Struct({ contractID: Schema.String, revision: Schema.Number, bundleHash: Schema.String }),
  ),
})

describe("contract strategy CLI", () => {
  cliIt.live(
    "persists local seed authority, resolves both roles, and fails closed after revocation",
    ({ home, opencode, llm }) =>
      Effect.gen(function* () {
        const run = (args: string[]) =>
          opencode.spawn(["contract", "strategy", ...args], {
            env: { OPENCODE_DB: path.join(home, "contracts.sqlite") },
          })
        yield* Effect.promise(() => Bun.write(path.join(home, "protocol.json"), JSON.stringify(protocol)))
        yield* Effect.promise(() => Bun.write(path.join(home, "strategy.json"), JSON.stringify(bundle)))
        const authorize = ["authorize", "--scope", "test", "--protocol", "protocol.json", "--bundle", "strategy.json"]
        const initial = yield* run(authorize)
        opencode.expectExit(initial, 0, "authorize seed")
        const state = Schema.decodeUnknownSync(Schema.fromJsonString(Selection))(initial.stdout)
        expect(state.revision).toBe(1)
        expect(state.selected).toBe(0)
        expect(state.history).toHaveLength(1)
        expect(state.history[0].bundleHash).toBe(ProContractPolicy.hashBundle(bundle))

        const shown = yield* run(["show", "test"])
        opencode.expectExit(shown, 0, "show persisted seed")
        expect(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(shown.stdout)).toMatchObject({
          revision: 1,
          protocol,
          protocolHash: ProContractPromotion.hashProtocol(protocol),
          history: [{ bundle }],
        })

        yield* Effect.forEach(["solver", "generator"] as const, (role) =>
          Effect.gen(function* () {
            const bound = yield* run(["bind", "test", "--role", role])
            opencode.expectExit(bound, 0, `bind ${role}`)
            expect(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(bound.stdout)).toEqual({
              executionPolicy: bundle[role],
              requirement: { contractID: state.history[0].contractID, revision: state.history[0].revision },
              identity: { scope: "test", revision: 1, bundleHash: ProContractPolicy.hashBundle(bundle), role },
            })
          }),
        )

        const retry = yield* run(authorize)
        opencode.expectExit(retry, 0, "exact authorization retry")
        expect(Schema.decodeUnknownSync(Schema.fromJsonString(Selection))(retry.stdout)).toEqual(state)

        yield* Effect.promise(() =>
          Bun.write(path.join(home, "changed.json"), JSON.stringify({ ...bundle, solver: "Different solver" })),
        )
        const changed = yield* run([...authorize.slice(0, -1), "changed.json"])
        expect(changed.exitCode).not.toBe(0)
        expect(changed.stderr).toContain("Frozen policy scope or authorized seed changed")

        const stale = yield* run(["revoke", "test", "--expected-revision", "2", "--evidence-hash", "b".repeat(64)])
        expect(stale.exitCode).not.toBe(0)
        expect(stale.stderr).toContain("Stale policy selection revision")
        const stillBound = yield* run(["bind", "test", "--role", "solver"])
        opencode.expectExit(stillBound, 0, "stale revoke preserves standing")

        const noPredecessor = yield* run(["rollback", "test", "--expected-revision", "1"])
        expect(noPredecessor.exitCode).not.toBe(0)
        expect(noPredecessor.stderr).toContain("No previously authorized policy retains standing")

        const revoked = yield* run(["revoke", "test", "--expected-revision", "1", "--evidence-hash", "b".repeat(64)])
        opencode.expectExit(revoked, 0, "revoke seed")
        const blocked = yield* run(["bind", "test", "--role", "generator"])
        expect(blocked.exitCode).not.toBe(0)
        expect(blocked.stderr).toContain("Selected policy support was withdrawn")

        const support = yield* opencode.spawn(["contract", "show", state.history[0].contractID], {
          env: { OPENCODE_DB: path.join(home, "contracts.sqlite") },
        })
        opencode.expectExit(support, 0, "show ordinary challenged Contract")
        expect(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(support.stdout)).toMatchObject({
          id: state.history[0].contractID,
          challenge: { evidenceHash: "b".repeat(64) },
        })
        expect(yield* llm.calls).toBe(0)
      }),
    120_000,
  )

  cliIt.live(
    "rejects malformed input and missing or invalid selection coordinates without creating a scope",
    ({ home, opencode, llm }) =>
      Effect.gen(function* () {
        const run = (args: string[]) =>
          opencode.spawn(["contract", "strategy", ...args], {
            env: { OPENCODE_DB: path.join(home, "contracts.sqlite") },
          })
        yield* Effect.promise(() => Bun.write(path.join(home, "protocol.json"), JSON.stringify(protocol)))
        yield* Effect.promise(() => Bun.write(path.join(home, "strategy.json"), "{broken"))
        const authorize = ["authorize", "--scope", "test", "--protocol", "protocol.json", "--bundle", "strategy.json"]
        const malformed = yield* run(authorize)
        expect(malformed.exitCode).not.toBe(0)
        expect(malformed.stderr).toContain("Invalid JSON file strategy.json")

        yield* Effect.promise(() =>
          Bun.write(path.join(home, "strategy.json"), JSON.stringify({ ...bundle, hidden: true })),
        )
        const excess = yield* run(authorize)
        expect(excess.exitCode).not.toBe(0)
        expect(excess.stderr).toContain("Invalid JSON file strategy.json")

        const missingFile = yield* run([...authorize.slice(0, -1), "missing.json"])
        expect(missingFile.exitCode).not.toBe(0)
        expect(missingFile.stderr).toContain("Cannot read JSON file missing.json")

        yield* Effect.forEach([[], ["--expected-revision", "0"], ["--expected-revision", "1.5"]], (revision) =>
          Effect.gen(function* () {
            const result = yield* run(["rollback", "test", ...revision])
            expect(result.exitCode).not.toBe(0)
          }),
        )
        const missingScope = yield* run(["show", "test"])
        expect(missingScope.exitCode).not.toBe(0)
        expect(missingScope.stderr).toContain("Strategy scope not found: test")
        expect(yield* llm.calls).toBe(0)
      }),
    120_000,
  )
})
