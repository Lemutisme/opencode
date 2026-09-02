import { Database } from "bun:sqlite"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../../lib/cli-process"

const password = "contract-fault-secret"
const authorization = `Basic ${btoa(`opencode:${password}`)}`

describe("ProContract issue process recovery", () => {
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

        const afterBefore = yield* opencode.serve({ env: stableEnvironment(home) })
        expect((yield* Effect.promise(() => get(afterBefore.url, `/api/contract/${before.id}`))).status).toBe(404)
        expect((yield* Effect.promise(() => get(afterBefore.url, `/api/contract/${before.id}/execution`))).status).toBe(
          404,
        )
        expect((yield* Effect.promise(() => issue(afterBefore.url, before))).status).toBe(200)
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

        const recovered = yield* opencode.serve({ env: stableEnvironment(home) })
        expect((yield* Effect.promise(() => get(recovered.url, `/api/contract/${after.id}`))).status).toBe(200)
        expect((yield* Effect.promise(() => get(recovered.url, `/api/contract/${after.id}/execution`))).status).toBe(
          404,
        )
        expect((yield* Effect.promise(() => issue(recovered.url, after))).status).toBe(200)
        expect((yield* Effect.promise(() => get(recovered.url, `/api/contract/${after.id}/execution`))).status).toBe(
          200,
        )
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
    OPENCODE_DB: path.join(home, "contract.db"),
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
    goal: "Deliver one exact artifact",
    executionPolicy: "Preserve the exact recovery policy.",
    location: { directory: home },
    model: { providerID: "openai", id: "gpt-5.4" },
    trigger: { type: "time", at: Date.now() + 24 * 60 * 60 * 1_000 },
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

async function waitFor(file: string) {
  const deadline = Date.now() + 20_000
  while (!(await Bun.file(file).exists())) {
    if (Date.now() >= deadline) throw new Error(`Formation barrier did not open: ${file}`)
    await Bun.sleep(10)
  }
}

async function verifyDatabase(home: string, ids: string[]) {
  const database = new Database(path.join(home, "contract.db"), { readonly: true })
  try {
    expect(database.query("SELECT id FROM pro_contract ORDER BY id").all() as Array<{ id: string }>).toEqual(
      ids.sort().map((id) => ({ id })),
    )
    expect(
      database.query("SELECT contract_id FROM pro_contract_opencode ORDER BY contract_id").all() as Array<{
        contract_id: string
      }>,
    ).toEqual(ids.sort().map((contract_id) => ({ contract_id })))
  } finally {
    database.close()
  }
}
