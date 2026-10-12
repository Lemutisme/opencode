import { afterEach, describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"

const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
}

afterEach(() => {
  Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
})

describe("ServerAuth", () => {
  test("gives only the private embedded worker an ephemeral credential", () => {
    const input = { HOME: "/test", OMITTED: undefined }
    const first = ServerAuth.workerEnv(input, false)
    const second = ServerAuth.workerEnv(input, false)
    expect(first.HOME).toBe("/test")
    expect(first).not.toHaveProperty("OMITTED")
    expect(first.OPENCODE_SERVER_PASSWORD).toMatch(/^[\da-f-]{36}$/)
    expect(second.OPENCODE_SERVER_PASSWORD).not.toBe(first.OPENCODE_SERVER_PASSWORD)
    expect(input).not.toHaveProperty("OPENCODE_SERVER_PASSWORD")
    expect(ServerAuth.workerEnv(input, true)).not.toHaveProperty("OPENCODE_SERVER_PASSWORD")
    expect(ServerAuth.workerEnv({ OPENCODE_SERVER_PASSWORD: "configured" }, false).OPENCODE_SERVER_PASSWORD).toBe(
      "configured",
    )
    expect(ServerAuth.workerEnv({ OPENCODE_SERVER_PASSWORD: "configured" }, true).OPENCODE_SERVER_PASSWORD).toBe(
      "configured",
    )
  })

  test("does not emit auth headers without a password", () => {
    Flag.OPENCODE_SERVER_PASSWORD = undefined
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("defaults to the opencode username", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(false)
  })
})
