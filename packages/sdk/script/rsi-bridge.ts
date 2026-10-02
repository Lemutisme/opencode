// Host-owned environment leases. Neither the environment nor its grader is H.
import { Schema } from "effect"
import type { RSIRuntime } from "./rsi-runtime"

export type NativeBridge = {
  prepare(input: { run: string; deadline: number; signal: AbortSignal }): Promise<{
    directory: string
    tools: RSIRuntime.File
    goal?: string
  }>
  // Deny new actions and acknowledge completion/cancellation of in-flight work.
  // Revocation fences a generation; only finish may destroy its environment.
  revoke(input: { run: string }): Promise<void>
  finish(): Promise<void>
}

export const BridgeTools = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.String, inputSchema: Schema.Unknown }),
  ),
})

export function bridgeTools(value: unknown, mode: "bridge" | "tau") {
  const input = Schema.decodeUnknownSync(BridgeTools)(value, { onExcessProperty: "error" })
  const names = input.tools.map((tool) => tool.name)
  if (
    !names.length ||
    new Set(names).size !== names.length ||
    names.some((name) => !/^[a-z][a-z0-9_]{0,63}$/.test(name)) ||
    names.some((name) => ["task_handoff", "task_blocked", "rsi_revise"].includes(name)) ||
    (mode === "tau" && (names.length !== 1 || names[0] !== "tau_turn"))
  )
    throw new Error("invalid host benchmark tool allowlist")
  return input
}
