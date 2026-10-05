import { expect, test } from "bun:test"
import { ProContract } from "@opencode-ai/schema/pro-contract"
import { Schema } from "effect"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"

const Result = Schema.Struct({
  contract: ProContract.Info,
  history: Schema.optional(Schema.Array(Schema.Unknown)),
  exact_retry: Schema.optional(Schema.Boolean),
})

test("strategy settlement binds independent evidence to exact evaluated coordinates across process restarts", async () => {
  await using directory = await tmpdir()
  const artifact = async (name: string, content: string) => {
    const filename = path.join(directory.path, name)
    await Bun.write(filename, content)
    return { path: filename, sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex") }
  }
  const invoke = async (input: Record<string, unknown>) => {
    const request = path.join(directory.path, crypto.randomUUID() + ".json")
    const output = request + ".result.json"
    await Bun.write(request, JSON.stringify(input))
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "../script/strategy-kernel.ts"), request, output],
      {
        cwd: directory.path,
        env: {
          HOME: directory.path,
          TMPDIR: directory.path,
          XDG_DATA_HOME: path.join(directory.path, "data"),
          XDG_CONFIG_HOME: path.join(directory.path, "config"),
          XDG_CACHE_HOME: path.join(directory.path, "cache"),
          XDG_STATE_HOME: path.join(directory.path, "state"),
          OPENCODE_TEST_HOME: directory.path,
          OPENCODE_DB: path.join(directory.path, "contracts.db"),
          OPENCODE_DISABLE_MODELS_FETCH: "true",
          OPENCODE_DISABLE_AUTOUPDATE: "true",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout, stderr, output }
  }
  const accepted = async (input: Record<string, unknown>) => {
    const result = await invoke(input)
    expect(result.code, result.stderr || result.stdout).toBe(0)
    return Schema.decodeUnknownSync(Schema.fromJsonString(Result))(await Bun.file(result.output).text())
  }
  const protocol = await artifact(
    "protocol.json",
    JSON.stringify({ kind: "synthetic-strategy-test-v1", purpose: "delivery" }),
  )
  const strategy = await artifact(
    "strategy.json",
    JSON.stringify({
      kind: "strategy-bundle-v1",
      generation: 0,
      runtime_sha256: "0".repeat(64),
      solver_policy: await artifact("solver.txt", "Solve only the frozen synthetic task.\n"),
      generator_policy: await artifact("generator.txt", "Preserve the frozen synthetic acceptance terms.\n"),
    }),
  )
  const request = { id: ProContract.ID.create(), strategy, protocol_sha256: protocol.sha256 }
  const now = Date.now()
  const issued = await accepted({
    ...request,
    action: "issue",
    claim: "The strategy satisfies the frozen synthetic protocol",
    scope: "synthetic-strategy-test",
    purpose: "delivery",
    created_at: now,
    deadline: now + 60_000,
  })
  expect(issued.contract.status).toBe("dormant")
  expect(issued.contract.spec.budget).toEqual({ deadline: now + 60_000 })
  const evidence = await artifact(
    "evidence.json",
    JSON.stringify({
      strategy_sha256: strategy.sha256,
      protocol_sha256: protocol.sha256,
      purpose: "delivery",
      passed: true,
    }),
  )
  const settlement = { ...request, action: "settle", evidence }
  const attestation = {
    revision: issued.contract.revision,
    specHash: issued.contract.specHash,
    subjectHash: strategy.sha256,
    evidenceHash: evidence.sha256,
  }
  const missing = await invoke(settlement)
  expect(missing.code).not.toBe(0)
  expect(missing.stderr).toContain("settlement requires the exact evaluated Contract coordinates")
  expect((await invoke({ ...settlement, attestation: { evidenceHash: evidence.sha256 } })).code).not.toBe(0)
  for (const stale of [
    { revision: attestation.revision + 1 },
    { specHash: "1".repeat(64) },
    { subjectHash: "2".repeat(64) },
    { evidenceHash: "3".repeat(64) },
  ]) {
    const rejected = await invoke({ ...settlement, attestation: { ...attestation, ...stale } })
    expect(rejected.code).not.toBe(0)
    expect(rejected.stderr).toContain("settlement requires the exact evaluated Contract coordinates")
  }
  const unchanged = await accepted({ ...request, action: "read" })
  expect(unchanged.contract).toEqual(issued.contract)
  expect(unchanged.history).toHaveLength(1)

  const settled = await accepted({ ...settlement, attestation })
  expect(settled.contract.status).toBe("discharged")
  expect(settled.contract.handoff?.subjectHash).toBe(strategy.sha256)
  expect(settled.contract.attestationID).toBeDefined()
  expect(settled.history).toHaveLength(4)

  const retry = await accepted({ ...settlement, attestation })
  expect(retry.exact_retry).toBe(true)
  expect(retry.contract).toEqual(settled.contract)
  expect((await accepted({ ...request, action: "read" })).history).toEqual(settled.history)
}, 60_000)
