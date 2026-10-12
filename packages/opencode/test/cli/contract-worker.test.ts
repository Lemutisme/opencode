import { expect, test } from "bun:test"
import { ServerAuth } from "../../src/server/auth"
import { Rpc } from "../../src/util/rpc"
import { withTimeout } from "../../src/util/timeout"
import type { rpc } from "../../src/cli/tui/worker"
import { tmpdir } from "../fixture/fixture"

test("private TUI RPC can issue, inspect, and release without user-configured credentials", async () => {
  await using dir = await tmpdir()
  const worker = new Worker(new URL("../../src/cli/tui/worker.ts", import.meta.url), {
    env: ServerAuth.workerEnv(
      {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: undefined,
        OPENCODE_TEST_HOME: dir.path,
        XDG_CONFIG_HOME: `${dir.path}/config`,
        XDG_DATA_HOME: `${dir.path}/data`,
        XDG_CACHE_HOME: `${dir.path}/cache`,
        XDG_STATE_HOME: `${dir.path}/state`,
        OPENCODE_PURE: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_AUTH_CONTENT: "{}",
      },
      false,
    ),
  })
  const client = Rpc.client<typeof rpc>(worker)
  try {
    const issued = await client.call("fetch", {
      url: "http://opencode.internal/api/contract",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "pct_private_worker",
        scope: "private-worker",
        goal: "Run only after the user-approved future trigger",
        location: { directory: dir.path },
        model: { providerID: "openai", id: "gpt-5.4" },
        trigger: { type: "time", at: Date.now() + 60_000 },
      }),
    })
    expect(issued.status).toBe(200)
    expect(JSON.parse(issued.body).data.status).toBe("dormant")
    const list = await client.call("fetch", {
      url: "http://opencode.internal/api/contract?scope=private-worker",
      method: "GET",
      headers: {},
    })
    expect(JSON.parse(list.body).data.map((item: { id: string }) => item.id)).toEqual(["pct_private_worker"])
    const released = await client.call("fetch", {
      url: "http://opencode.internal/api/contract/pct_private_worker/release",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "User cancelled before execution" }),
    })
    expect(released.status).toBe(200)
  } finally {
    await withTimeout(client.call("shutdown", undefined), 5000)
      .catch(() => {})
      .finally(() => worker.terminate())
  }
}, 30_000)
