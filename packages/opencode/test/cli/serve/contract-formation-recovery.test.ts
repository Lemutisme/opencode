import { Database } from "bun:sqlite"
import { describe, expect } from "bun:test"
import { Hash } from "@opencode-ai/core/util/hash"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../../lib/cli-process"

const password = "contract-fault-secret"
const authorization = `Basic ${btoa(`opencode:${password}`)}`

describe("ProContract formation process recovery", () => {
  cliIt.live(
    "survives SIGKILL before commit and after commit before binding",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const before = issueBody(home, "pct_fault_before", "scope-before")
        const beforeBarrier = path.join(home, "barrier-before")
        yield* Effect.promise(() => Bun.write(path.join(beforeBarrier, ".keep"), ""))
        const beforeServer = yield* opencode.serve({
          env: faultEnvironment(home, beforeBarrier, "before_commit"),
        })
        const beforeRequest = issue(beforeServer.url, before).catch(() => undefined)
        yield* Effect.promise(() => waitFor(path.join(beforeBarrier, "before_commit.ready")))
        beforeServer.kill("SIGKILL")
        yield* Effect.promise(() => beforeServer.exited)
        yield* Effect.promise(() => beforeRequest)
        expect(yield* Effect.promise(() => formationRoots(home))).not.toContain(before.id)

        const afterBefore = yield* opencode.serve({ env: stableEnvironment(home) })
        expect((yield* Effect.promise(() => get(afterBefore.url, `/api/contract/${before.id}`))).status).toBe(404)
        expect((yield* Effect.promise(() => get(afterBefore.url, `/api/contract/${before.id}/execution`))).status).toBe(
          404,
        )
        const admittedBefore = yield* Effect.promise(() => issue(afterBefore.url, before))
        expect(admittedBefore.status).toBe(200)
        afterBefore.kill()
        yield* Effect.promise(() => afterBefore.exited)

        const after = issueBody(home, "pct_fault_after", "scope-after")
        const afterBarrier = path.join(home, "barrier-after")
        yield* Effect.promise(() => Bun.write(path.join(afterBarrier, ".keep"), ""))
        const afterServer = yield* opencode.serve({
          env: faultEnvironment(home, afterBarrier, "after_commit_before_binding"),
        })
        const afterRequest = issue(afterServer.url, after).catch(() => undefined)
        yield* Effect.promise(() => waitFor(path.join(afterBarrier, "after_commit_before_binding.ready")))
        afterServer.kill("SIGKILL")
        yield* Effect.promise(() => afterServer.exited)
        yield* Effect.promise(() => afterRequest)
        expect(yield* Effect.promise(() => formationRoots(home))).toContain(after.id)

        const recovered = yield* opencode.serve({ env: stableEnvironment(home) })
        expect((yield* Effect.promise(() => get(recovered.url, `/api/contract/${after.id}`))).status).toBe(200)
        expect((yield* Effect.promise(() => get(recovered.url, `/api/contract/${after.id}/execution`))).status).toBe(
          404,
        )
        expect(
          yield* Effect.promise(async () =>
            awaitJson(await get(recovered.url, `/api/contract/quiet?scope=${after.scope}`)),
          ),
        ).toMatchObject({ quiet: false })

        expect((yield* Effect.promise(() => issue(recovered.url, { ...after, evaluation: undefined }))).status).toBe(409)
        expect(
          (
            yield* Effect.promise(() =>
              issue(recovered.url, {
                ...after,
                evaluation: { ...after.evaluation, deadline: after.evaluation.deadline + 1 },
              }),
            )
          ).status,
        ).toBe(409)

        const exact = yield* Effect.promise(() => Promise.all(Array.from({ length: 4 }, () => issue(recovered.url, after))))
        expect(exact.every((response) => response.status === 200)).toBe(true)
        const receipts = yield* Effect.promise(() => Promise.all(exact.map((response) => response.json())))
        expect(new Set(receipts.map((receipt) => JSON.stringify(receipt))).size).toBe(1)
        expect((yield* Effect.promise(() => get(recovered.url, `/api/contract/${after.id}/execution`))).status).toBe(
          200,
        )
        expect(
          yield* Effect.promise(async () =>
            awaitJson(await get(recovered.url, `/api/contract/quiet?scope=${after.scope}`)),
          ),
        ).toMatchObject({ quiet: false })
        recovered.kill()
        yield* Effect.promise(() => recovered.exited)

        yield* Effect.promise(() => verifyDatabase(home, [before.id, after.id]))
      }),
    120_000,
  )
})

function stableEnvironment(home: string) {
  return {
    NODE_ENV: "test",
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DB: path.join(home, "formation.db"),
  }
}

function faultEnvironment(home: string, directory: string, point: "before_commit" | "after_commit_before_binding") {
  return {
    ...stableEnvironment(home),
    OPENCODE_TEST_CONTRACT_FORMATION_BARRIER: directory,
    OPENCODE_TEST_CONTRACT_FORMATION_BARRIER_POINT: point,
  }
}

function issueBody(home: string, id: string, scope: string) {
  return {
    id,
    scope,
    goal: "Deliver one exact artifact and reserve independent evaluation",
    location: { directory: home },
    model: { providerID: "openai", id: "gpt-5.4" },
    trigger: { type: "time", at: Date.now() + 24 * 60 * 60 * 1_000 },
    evaluation: { evaluatorHash: "fault-evaluator-v1", deadline: Date.now() + 48 * 60 * 60 * 1_000 },
  } as const
}

function issue(url: string, body: object) {
  return fetch(new URL("/api/contract", url), {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function get(url: string, pathname: string) {
  return fetch(new URL(pathname, url), { headers: { authorization } })
}

async function awaitJson(response: Response) {
  return response.json()
}

async function waitFor(file: string) {
  const deadline = Date.now() + 20_000
  while (!(await Bun.file(file).exists())) {
    if (Date.now() >= deadline) throw new Error(`Formation barrier did not open: ${file}`)
    await Bun.sleep(10)
  }
}

async function verifyDatabase(home: string, roots: string[]) {
  const database = new Database(await databasePath(home), { readonly: true })
  try {
    const formations = database.query("SELECT data FROM pro_contract_formation ORDER BY root_contract_id").all() as Array<{
      data: string
    }>
    expect(formations).toHaveLength(2)
    const formationData = formations.map(
      (row) => JSON.parse(row.data) as { rootContractID: string; components: Array<{ contractID: string }> },
    )
    expect(formationData.map((formation) => formation.rootContractID).sort()).toEqual([...roots].sort())
    expect(formationData.every((formation) => formation.components.length === 2)).toBe(true)
    const contracts = database.query("SELECT id FROM pro_contract ORDER BY id").all() as Array<{ id: string }>
    expect(contracts).toHaveLength(4)
    expect(
      formationData.every((formation) =>
        formation.components.every((component) => contracts.some((contract) => contract.id === component.contractID)),
      ),
    ).toBe(true)
    expect(
      database.query("SELECT contract_id FROM pro_contract_opencode ORDER BY contract_id").all() as Array<{
        contract_id: string
      }>,
    ).toEqual(roots.sort().map((contract_id) => ({ contract_id })))

    const events = database
      .query("SELECT seq, command, decision, previous_hash, hash FROM pro_contract_event ORDER BY seq")
      .all() as Array<{ seq: number; command: string; decision: string; previous_hash: string; hash: string }>
    expect(events.length).toBeGreaterThanOrEqual(4)
    let previous = "0".repeat(64)
    for (const event of events) {
      expect(event.previous_hash).toBe(previous)
      expect(event.hash).toBe(
        Hash.sha256(JSON.stringify([previous, event.seq, JSON.parse(event.command), JSON.parse(event.decision)])),
      )
      previous = event.hash
    }
    expect(database.query("SELECT head_seq, head_hash FROM pro_contract_ledger WHERE id = 1").get()).toEqual({
      head_seq: events.at(-1)?.seq,
      head_hash: previous,
    })
  } finally {
    database.close()
  }
}

async function formationRoots(home: string) {
  const database = new Database(await databasePath(home), { readonly: true })
  try {
    return (
      database.query("SELECT root_contract_id FROM pro_contract_formation ORDER BY root_contract_id").all() as Array<{
        root_contract_id: string
      }>
    ).map((row) => row.root_contract_id)
  } finally {
    database.close()
  }
}

async function databasePath(home: string) {
  return path.join(home, "formation.db")
}
