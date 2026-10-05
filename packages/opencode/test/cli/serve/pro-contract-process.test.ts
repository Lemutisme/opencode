import { describe, expect } from "bun:test"
import { $ } from "bun"
import { ProContract } from "@opencode-ai/schema/pro-contract"
import { OpenCodeExecution } from "@opencode-ai/protocol/groups/pro-contract"
import { Effect, Schema } from "effect"
import path from "node:path"
import { cliIt, type OpencodeCli } from "../../lib/cli-process"
import { awaitWithTimeout, pollWithTimeout } from "../../lib/effect"
import { testProviderConfig } from "../../lib/test-provider"

const password = "contract-process-test"
const contractResponse = Schema.Struct({ data: ProContract.Info })
const activeResponse = Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })
const policyState = Schema.Struct({
  revision: Schema.Number,
  selected: Schema.Number,
  protocolHash: Schema.String,
  history: Schema.Array(Schema.Struct({ contractID: Schema.String, bundleHash: Schema.String })),
})

describe("ProContract release lifecycle (subprocess)", () => {
  cliIt.live(
    "replays a frozen handoff, survives restart, and rejects evidence for the replaced subject",
    ({ opencode, llm, home }) =>
      Effect.gen(function* () {
        const env = yield* environment(home, llm.url)
        const directory = yield* candidate(home)
        const checker =
          "if (!/^ready-[AB]\\n$/.test(require('fs').readFileSync('lifecycle.txt', 'utf8'))) process.exit(1)\n"
        yield* Effect.promise(() => Bun.write(path.join(directory, "verify.cjs"), checker))
        yield* llm.tool("contract_report_ready", { summary: "The frozen candidate passes replay.", uncertainties: [] })
        const server = yield* opencode.serve({ env })
        const payload = {
          id: "pct_process_lifecycle",
          scope: "process-lifecycle",
          goal: "Verify the exact lifecycle.txt candidate.",
          location: { directory },
          model: { providerID: "test", id: "test-model" },
          budget: { deadline: Date.now() + 120_000 },
          authority: ["filesystem.read"],
          evidence: {
            type: "principal",
            replay: {
              checks: [{ argv: [process.execPath, "verify.cjs"], timeout: 5_000, exit: 0 }],
              protected: [{ path: "verify.cjs", hash: hash(checker) }],
              artifacts: ["lifecycle.txt"],
            },
          },
        }
        expect((yield* request(server.url, "/api/contract", payload)).status).toBe(200)
        const firstExecution = yield* execution(server.url, payload.id)
        expect((yield* request(server.url, "/api/contract", payload)).status).toBe(200)
        expect((yield* execution(server.url, payload.id)).sessionID).toBe(firstExecution.sessionID)
        const first = yield* atStatus(server.url, payload.id, "verification")
        expect(first.handoff?.replay).toMatchObject({ passed: true, subjectHash: first.handoff?.subjectHash })
        expect((yield* execution(server.url, payload.id)).turnsUsed).toBe(1)
        expect((yield* execution(server.url, payload.id)).actionsUsed).toBe(1)

        // Export must use the frozen Snapshot, never the subsequently changed workspace.
        yield* Effect.promise(() => Bun.write(path.join(directory, "lifecycle.txt"), "ready-B\n"))
        const exported = yield* opencode.spawn(["contract", "export", payload.id, path.join(home, "exported")], { env })
        opencode.expectExit(exported, 0, "frozen handoff export")
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "exported/lifecycle.txt")).text())).toBe(
          "ready-A\n",
        )

        const beforeRestart = yield* request(server.url, "/api/contract/quiet?scope=process-lifecycle")
        server.kill()
        yield* awaitWithTimeout(
          Effect.promise(() => server.exited),
          "first server did not stop",
          "10 seconds",
        )
        const restarted = yield* opencode.serve({ env })
        expect(yield* contract(restarted.url, payload.id)).toEqual(first)
        expect(yield* request(restarted.url, "/api/contract/quiet?scope=process-lifecycle")).toEqual(beforeRestart)

        yield* llm.tool("contract_report_ready", {
          summary: "The replacement candidate passes replay.",
          uncertainties: [],
        })
        expect(
          (yield* request(restarted.url, `/api/contract/${payload.id}/challenge`, {
            revision: first.revision,
            subjectHash: first.handoff!.subjectHash,
            evidenceHash: hash("independent counterexample for A"),
            disclosure: "executor",
            summary: "Recheck the replacement candidate.",
          })).status,
        ).toBe(200)
        const second = yield* atStatus(restarted.url, payload.id, "verification")
        expect(second.handoff!.subjectHash).not.toBe(first.handoff!.subjectHash)
        expect((yield* execution(restarted.url, payload.id)).sessionID).not.toBe(firstExecution.sessionID)
        expect(second.handoff?.replay?.passed).toBe(true)
        const beforeStale = yield* request(restarted.url, "/api/contract/quiet?scope=process-lifecycle")
        const stale = yield* request(restarted.url, `/api/contract/${payload.id}/attestation`, {
          revision: first.revision,
          specHash: first.specHash,
          subjectHash: first.handoff!.subjectHash,
          evidenceHash: hash("independent report for A"),
        })
        expect(stale.status).toBe(409)
        expect(yield* contract(restarted.url, payload.id)).toEqual(second)
        const afterStale = yield* request(restarted.url, "/api/contract/quiet?scope=process-lifecycle")
        expect(afterStale.body).toMatchObject({ quiet: false, outstanding: [payload.id] })
        expect(afterStale.body).not.toEqual(beforeStale.body)
        expect(
          (yield* request(restarted.url, `/api/contract/${payload.id}/attestation`, {
            revision: second.revision,
            specHash: second.specHash,
            subjectHash: second.handoff!.subjectHash,
            evidenceHash: second.handoff!.replay!.evidenceHash,
          })).status,
        ).toBe(409)
        expect(yield* contract(restarted.url, payload.id)).toEqual(second)

        const verifiedExport = yield* opencode.spawn(["contract", "export", payload.id, path.join(home, "verified")], {
          env,
        })
        opencode.expectExit(verifiedExport, 0, "independent verifier export")
        const observation = Bun.spawnSync(
          [
            process.execPath,
            "-e",
            "process.stdout.write(require('fs').readFileSync(process.argv[1]))",
            path.join(home, "verified/lifecycle.txt"),
          ],
          { env: {}, timeout: 5_000 },
        )
        expect(observation.exitCode).toBe(0)
        expect(observation.stdout.toString()).toBe("ready-B\n")
        const evidence = {
          contractID: second.id,
          revision: second.revision,
          specHash: second.specHash,
          subjectHash: second.handoff!.subjectHash,
          observedHash: hash(observation.stdout.toString()),
          passed: true,
        }
        yield* Effect.promise(() => Bun.write(path.join(home, "principal-evidence.json"), JSON.stringify(evidence)))
        const attested = yield* request(restarted.url, `/api/contract/${payload.id}/attestation`, {
          revision: evidence.revision,
          specHash: evidence.specHash,
          subjectHash: evidence.subjectHash,
          evidenceHash: hash(JSON.stringify(evidence)),
        })
        expect(attested.status).toBe(200)
        expect((yield* contract(restarted.url, payload.id)).status).toBe("discharged")
        expect((yield* request(restarted.url, "/api/contract/quiet?scope=process-lifecycle")).body).toMatchObject({
          quiet: true,
          outstanding: [],
        })
        expect(yield* llm.pending).toBe(0)
      }),
    90_000,
  )

  cliIt.live(
    "generates and promotes a strategy, consumes its successor over the provider wire, and rolls back",
    ({ opencode, llm, home }) =>
      Effect.gen(function* () {
        const env = yield* environment(home, llm.url)
        const directory = yield* candidate(home)
        const seed = { version: 1, solver: "SEED_SOLVER_POLICY", generator: "SEED_GENERATOR_POLICY" }
        const successor = { version: 1, solver: "SUCCESSOR_SOLVER_POLICY", generator: "SUCCESSOR_GENERATOR_POLICY" }
        const protocol = {
          version: 1,
          performanceRule: "task-pareto",
          evaluatorHash: hash("deterministic mechanism fixture, not capability evidence"),
          tests: [
            { id: "safety", total: 1 },
            ...["development", "confirmation"].flatMap((panel) =>
              ["0", "1"].map((replicate) => ({
                id: `${panel}-${replicate}`,
                total: 10,
                performance: { panel, task: `${panel}-task`, replicate },
              })),
            ),
          ],
        }
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(path.join(home, "seed.json"), JSON.stringify(seed)),
            Bun.write(path.join(home, "protocol.json"), JSON.stringify(protocol)),
            Bun.write(path.join(home, "successor.json"), JSON.stringify(successor)),
          ]),
        )
        const cli = (args: string[], cwd?: string) => command(opencode, env, args, cwd)
        const authorized = Schema.decodeUnknownSync(policyState)(
          yield* cli([
            "contract",
            "strategy",
            "authorize",
            "--scope",
            "process-rsi",
            "--protocol",
            path.join(home, "protocol.json"),
            "--bundle",
            path.join(home, "seed.json"),
          ]),
        )
        const server = yield* opencode.serve({ env })
        yield* llm.tool("write", { path: "strategy.json", content: JSON.stringify(successor) })
        yield* llm.tool("contract_report_ready", { summary: "Generated an exact successor bundle.", uncertainties: [] })
        const issue = (id: string, role: "solver" | "generator") =>
          cli(
            [
              "contract",
              "issue",
              "--id",
              id,
              "--scope",
              "process-rsi-work",
              "--goal",
              `Execute ${id}`,
              "--model",
              "test/test-model",
              "--strategy",
              "process-rsi",
              "--strategy-role",
              role,
              "--write",
              "--deadline",
              new Date(Date.now() + 120_000).toISOString(),
            ],
            directory,
          )
        yield* issue("pct_process_generation", "generator")
        const generation = yield* atStatus(server.url, "pct_process_generation", "verification")
        expect((yield* execution(server.url, generation.id)).turnsUsed).toBe(2)
        const generatedRequests = yield* llm.inputs
        expect(JSON.stringify(generatedRequests[0]?.messages)).toContain(seed.generator)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "strategy.json")).json())).toEqual(successor)
        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, "generation.json"),
            JSON.stringify({
              contractID: generation.id,
              revision: generation.revision,
              subjectHash: generation.handoff!.subjectHash,
            }),
          ),
        )
        const proposal = Schema.decodeUnknownSync(ProContract.Info)(
          yield* cli([
            "contract",
            "strategy",
            "propose",
            "--scope",
            "process-rsi",
            "--expected-revision",
            "1",
            "--bundle",
            path.join(home, "successor.json"),
            "--generation",
            path.join(home, "generation.json"),
          ]),
        )
        const coordinates = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ candidateHash: Schema.String })),
        )(proposal.spec.brief)
        const evidence = {
          protocolHash: authorized.protocolHash,
          baselineHash: authorized.history[0].bundleHash,
          candidateHash: coordinates.candidateHash,
          receiptHash: hash("complete deterministic development and confirmation fixture"),
          baseline: protocol.tests.map((test) => ({ id: test.id, total: test.total, valid: true, passed: 1 })),
          rows: protocol.tests.map((test) => ({
            id: test.id,
            total: test.total,
            valid: true,
            passed: test.total === 1 ? 1 : 2,
          })),
        }
        yield* Effect.promise(() => Bun.write(path.join(home, "evidence.json"), JSON.stringify(evidence)))
        const settlement = yield* cli([
          "contract",
          "strategy",
          "settle",
          proposal.id,
          "--evidence",
          path.join(home, "evidence.json"),
        ])
        expect(settlement).toMatchObject({ state: { revision: 2, selected: 2 }, decision: { eligible: true } })
        expect((yield* contract(server.url, proposal.id)).status).toBe("discharged")
        expect(
          yield* cli(["contract", "strategy", "settle", proposal.id, "--evidence", path.join(home, "evidence.json")]),
        ).toEqual(settlement)

        // Adoption changes service only; continuing research is a separate, explicit authorization.
        yield* cli([
          "contract",
          "strategy",
          "select-research",
          "--scope",
          "process-rsi",
          "--expected-revision",
          "2",
          "--bundle-hash",
          coordinates.candidateHash,
        ])

        yield* llm.reset
        const next = { ...successor, generator: "NEXT_GENERATOR_POLICY" }
        yield* llm.tool("write", { path: "strategy.json", content: JSON.stringify(next) })
        yield* llm.tool("contract_report_ready", {
          summary: "Used the selected successor to generate again.",
          uncertainties: [],
        })
        yield* issue("pct_process_successor", "generator")
        yield* atStatus(server.url, "pct_process_successor", "verification")
        const successorRequests = yield* llm.inputs
        expect(JSON.stringify(successorRequests[0]?.messages)).toContain(successor.generator)
        expect(JSON.stringify(successorRequests[0]?.messages)).not.toContain(seed.generator)
        expect((yield* execution(server.url, "pct_process_successor")).executionPolicy).toBe(successor.generator)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "strategy.json")).json())).toEqual(next)

        expect(
          yield* cli(["contract", "strategy", "rollback", "process-rsi", "--expected-revision", "3"]),
        ).toMatchObject({ revision: 4, selected: 0 })
        yield* llm.reset
        yield* llm.tool("contract_report_ready", { summary: "Consumed the restored seed solver.", uncertainties: [] })
        yield* issue("pct_process_rollback", "solver")
        yield* atStatus(server.url, "pct_process_rollback", "verification")
        const restoredRequests = yield* llm.inputs
        expect(JSON.stringify(restoredRequests[0]?.messages)).toContain(seed.solver)
        expect(JSON.stringify(restoredRequests[0]?.messages)).not.toContain(successor.solver)
        expect((yield* execution(server.url, "pct_process_rollback")).executionPolicy).toBe(seed.solver)
      }),
    120_000,
  )

  cliIt.live(
    "terminates a stalled provider at the original deadline without discharging the duty",
    ({ opencode, llm, home }) =>
      Effect.gen(function* () {
        const directory = yield* candidate(home)
        const server = yield* opencode.serve({ env: yield* environment(home, llm.url) })
        yield* llm.hang
        const deadline = Date.now() + 5_000
        expect(
          (yield* request(server.url, "/api/contract", {
            id: "pct_process_deadline",
            scope: "process-deadline",
            goal: "Exercise bounded stalled execution.",
            location: { directory },
            model: { providerID: "test", id: "test-model" },
            budget: { deadline },
          })).status,
        ).toBe(200)
        const binding = yield* execution(server.url, "pct_process_deadline")
        yield* awaitWithTimeout(llm.wait(1), "provider was never called", "10 seconds")
        yield* running(server.url, binding.sessionID, true)
        const expired = yield* atStatus(server.url, binding.contractID, "escalated")
        expect(Date.now()).toBeGreaterThanOrEqual(deadline)
        expect(expired.spec.budget).toEqual({ deadline })
        expect(expired.escalation?.reason).toContain("deadline")
        yield* running(server.url, binding.sessionID, false)
        expect((yield* execution(server.url, binding.contractID)).turnsUsed).toBe(1)
        expect((yield* request(server.url, "/api/contract/quiet?scope=process-deadline")).body).toMatchObject({
          quiet: false,
          outstanding: [binding.contractID],
        })
      }),
    60_000,
  )

  cliIt.live(
    "releases a Contract by interrupting its active provider instead of waiting for its deadline",
    ({ opencode, llm, home }) =>
      Effect.gen(function* () {
        const directory = yield* candidate(home)
        const server = yield* opencode.serve({ env: yield* environment(home, llm.url) })
        yield* llm.hang
        expect(
          (yield* request(server.url, "/api/contract", {
            id: "pct_process_cancel",
            scope: "process-cancel",
            goal: "Exercise explicit cancellation.",
            location: { directory },
            model: { providerID: "test", id: "test-model" },
            budget: { deadline: Date.now() + 120_000 },
          })).status,
        ).toBe(200)
        const binding = yield* execution(server.url, "pct_process_cancel")
        yield* awaitWithTimeout(llm.wait(1), "provider was never called", "10 seconds")
        yield* running(server.url, binding.sessionID, true)
        expect(
          (yield* request(server.url, `/api/contract/${binding.contractID}/release`, {
            reason: "Explicit cancellation",
          })).status,
        ).toBe(200)
        yield* running(server.url, binding.sessionID, false)
        expect((yield* contract(server.url, binding.contractID)).status).toBe("released")
        expect((yield* execution(server.url, binding.contractID)).turnsUsed).toBe(1)
        expect((yield* request(server.url, "/api/contract/quiet?scope=process-cancel")).body).toMatchObject({
          quiet: true,
          outstanding: [],
        })
      }),
    60_000,
  )
})

function environment(home: string, url: string) {
  return Effect.promise(async () => {
    const config = testProviderConfig(url)
    const env = {
      OPENCODE_DB: path.join(home, "contracts.sqlite"),
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_TEST_PROVIDER_KEY: "non-secret-loopback-placeholder",
      OPENCODE_STRATEGY_PORTFOLIO: "0",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...config,
        enabled_providers: ["test"],
        provider: { test: { ...config.provider.test, env: ["OPENCODE_TEST_PROVIDER_KEY"] } },
      }),
    }
    // Core V2 loads config documents, not the legacy inline-config environment override.
    await Bun.write(path.join(home, ".config/opencode/opencode.json"), env.OPENCODE_CONFIG_CONTENT)
    return env
  })
}

function candidate(home: string) {
  return Effect.promise(async () => {
    const directory = path.join(home, "candidate")
    await Bun.write(path.join(directory, "lifecycle.txt"), "ready-A\n")
    await $`git init`.cwd(directory).quiet()
    await $`git -c user.name=Test -c user.email=test@opencode.test -c commit.gpgsign=false commit --allow-empty -m root`
      .cwd(directory)
      .quiet()
    return directory
  })
}

function request(url: string, endpoint: string, payload?: unknown) {
  return Effect.promise(async () => {
    const response = await fetch(new URL(endpoint, url), {
      method: payload === undefined ? "GET" : "POST",
      headers: { authorization: `Basic ${btoa(`opencode:${password}`)}`, "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    })
    const body: unknown = await response.json()
    return { status: response.status, body }
  })
}

function contract(url: string, id: string) {
  return request(url, `/api/contract/${id}`).pipe(
    Effect.map((response) => {
      expect(response.status).toBe(200)
      return Schema.decodeUnknownSync(contractResponse)(response.body).data
    }),
  )
}

function execution(url: string, id: string) {
  return request(url, `/api/contract/${id}/execution`).pipe(
    Effect.map((response) => {
      expect(response.status).toBe(200)
      return Schema.decodeUnknownSync(OpenCodeExecution)(response.body)
    }),
  )
}

function atStatus(url: string, id: string, status: ProContract.Status) {
  return pollWithTimeout(
    contract(url, id).pipe(Effect.map((current) => (current.status === status ? current : undefined))),
    `Contract ${id} never reached ${status}`,
    "20 seconds",
  ).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const binding = yield* execution(url, id)
        return yield* Effect.fail(
          new Error(
            `${error.message}\n${JSON.stringify({
              contract: yield* contract(url, id),
              binding,
              history: yield* request(url, `/api/session/${binding.sessionID}/history`),
            })}`,
          ),
        )
      }),
    ),
  )
}

function running(url: string, id: string, expected: boolean) {
  return pollWithTimeout(
    request(url, "/api/session/active").pipe(
      Effect.map((response) => {
        expect(response.status).toBe(200)
        return id in Schema.decodeUnknownSync(activeResponse)(response.body).data === expected ? true : undefined
      }),
    ),
    `Session ${id} did not become ${expected ? "active" : "inactive"}`,
    "10 seconds",
  )
}

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function command(opencode: OpencodeCli, env: Record<string, string>, args: string[], cwd?: string) {
  return opencode.spawn(args, { env, cwd }).pipe(
    Effect.map((result) => {
      opencode.expectExit(result, 0, args.join(" "))
      const body: unknown = JSON.parse(result.stdout)
      return body
    }),
  )
}
