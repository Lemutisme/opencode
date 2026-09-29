import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { ProContract } from "@opencode/core/pro-contract"

const temporary: string[] = []
afterEach(() => Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

describe("V2 strategy settlement CLI", () => {
  test("persists qualification across processes and reconciles exact settlement retries", async () => {
    const fixture = await setup()
    const issued = await fixture.run({ action: "issue" })
    expect(issued.code).toBe(0)
    expect(issued.value?.contract.status).toBe("dormant")
    expect(issued.value?.contract.spec.budget).toEqual({ deadline: fixture.request.deadline })

    const evidence = await fixture.evidence(true)
    const settled = await fixture.run({ action: "settle", evidence })
    expect(settled.code).toBe(0)
    expect(settled.value?.contract.status).toBe("discharged")
    expect(settled.value?.contract.handoff?.subjectHash).toBe(fixture.request.strategy.sha256)
    expect(settled.value?.contract.attestationID).toBeDefined()

    const retried = await fixture.run({ action: "settle", evidence })
    expect(retried.code).toBe(0)
    expect(retried.value?.exact_retry).toBe(true)
    expect(retried.value?.contract).toEqual(settled.value?.contract)
    expect((await fixture.run({ action: "read" })).value?.contract).toEqual(settled.value?.contract)
  })

  test("negative performance evidence cannot discharge the strategy", async () => {
    const fixture = await setup()
    await fixture.run({ action: "issue" })
    const result = await fixture.run({ action: "settle", evidence: await fixture.evidence(false) })
    expect(result.code).toBe(0)
    expect(result.value?.contract.status).toBe("escalated")
    expect(result.value?.contract.attestationID).toBeUndefined()
  })

  test.each(["protocol_sha256", "strategy_sha256", "purpose"])("rejects evidence for a different %s", async (field) => {
    const fixture = await setup()
    const issued = await fixture.run({ action: "issue" })
    const result = await fixture.run({
      action: "settle",
      evidence: await fixture.evidence(true, { [field]: "f".repeat(64) }),
    })
    expect(result.code).not.toBe(0)
    expect((await fixture.run({ action: "read" })).value?.contract).toEqual(issued.value?.contract)
  })

  test("a different positive report is not an exact settlement retry", async () => {
    const fixture = await setup()
    await fixture.run({ action: "issue" })
    const settled = await fixture.run({ action: "settle", evidence: await fixture.evidence(true) })
    const conflict = await fixture.run({ action: "settle", evidence: await fixture.evidence(true, { observation: 2 }) })
    expect(conflict.code).not.toBe(0)
    expect(conflict.error).toContain("conflicting settlement retry")
    expect((await fixture.run({ action: "read" })).value?.contract).toEqual(settled.value?.contract)
  })

  test("selection requires live performance support; a challenge revokes dependent standing", async () => {
    const fixture = await setup()
    await fixture.run({ action: "issue" })
    const selection = { id: "pct_selection", requires: [{ contractID: fixture.request.id, revision: 1 }] }
    expect((await fixture.run({ action: "issue", ...selection })).code).toBe(0)
    const evidence = await fixture.evidence(true)
    expect((await fixture.run({ action: "settle", ...selection, evidence })).code).not.toBe(0)
    expect((await fixture.run({ action: "settle", evidence })).value?.contract.status).toBe("discharged")
    expect((await fixture.run({ action: "settle", ...selection, evidence })).value?.contract.status).toBe("discharged")

    const challenged = await fixture.run({ action: "challenge", evidence: await fixture.evidence(false) })
    expect(challenged.code).toBe(0)
    expect(challenged.value?.contract.status).toBe("escalated")
    const dependent = await fixture.run({ action: "read", id: selection.id })
    expect(dependent.value?.contract.status).toBe("escalated")
    expect(dependent.value?.contract.attestationID).toBeUndefined()
  })

  test("materializes exact policy bytes and refuses a changed artifact", async () => {
    const fixture = await setup()
    await Bun.write(fixture.policy, "different strategy")
    const result = await fixture.run({ action: "issue" })
    expect(result.code).not.toBe(0)
    expect(result.error).toContain("artifact identity mismatch")
    expect(await Bun.file(fixture.database).exists()).toBe(false)
  })

  test("requires an explicit persistent database rather than V2's in-memory default", async () => {
    const fixture = await setup()
    const result = await fixture.run({ action: "issue" }, ":memory:")
    expect(result.code).not.toBe(0)
    expect(result.error).toContain("isolated database required")
  })
})

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "procontract-v2-strategy-"))
  temporary.push(root)
  const artifact = async (name: string, text: string) => {
    const file = path.join(root, name)
    await Bun.write(file, text)
    return { path: file, sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") }
  }
  const policy = await artifact("solver.txt", "Solve the task and report evidence.")
  const generator = await artifact("generator.txt", "Propose a falsifiable successor strategy.")
  const strategy = await artifact(
    "strategy.json",
    JSON.stringify({
      kind: "strategy-bundle-v1",
      generation: 0,
      runtime_sha256: "a".repeat(64),
      solver_policy: policy,
      generator_policy: generator,
    }),
  )
  const request = {
    id: "pct_strategy",
    strategy,
    protocol_sha256: "b".repeat(64),
    purpose: "performance",
    claim: "The candidate satisfies this frozen comparison protocol.",
    scope: "migration-test",
    created_at: Date.now(),
    deadline: Date.now() + 6 * 60 * 60 * 1_000,
  }
  const database = path.join(root, "issuer.sqlite")
  const result = Schema.fromJsonString(
    Schema.Struct({
      contract: ProContract.Info,
      exact_retry: Schema.optional(Schema.Boolean),
    }),
  )
  return {
    request,
    database,
    policy: policy.path,
    evidence: (passed: boolean, fields: Record<string, unknown> = {}) =>
      artifact(
        `evidence-${crypto.randomUUID()}.json`,
        JSON.stringify({
          strategy_sha256: strategy.sha256,
          protocol_sha256: request.protocol_sha256,
          purpose: request.purpose,
          passed,
          ...fields,
        }),
      ),
    run: async (fields: Record<string, unknown>, db = database) => {
      const input = await artifact(`request-${crypto.randomUUID()}.json`, JSON.stringify({ ...request, ...fields }))
      const output = path.join(root, `result-${crypto.randomUUID()}.json`)
      const child = Bun.spawn(
        [process.execPath, path.join(import.meta.dir, "strategy-kernel.ts"), input.path, output],
        {
          env: {
            ...process.env,
            OPENCODE_DB: db,
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_CONFIG_HOME: path.join(root, "config"),
          },
          stdout: "ignore",
          stderr: "pipe",
          timeout: 10_000,
        },
      )
      const error = await new Response(child.stderr).text()
      const code = await child.exited
      return {
        code,
        error,
        value: code === 0 ? Schema.decodeUnknownSync(result)(await Bun.file(output).text()) : undefined,
      }
    },
  }
}
