import { expect, test } from "bun:test"
import { bridgeTools } from "./rsi-bridge"

const tool = (name: string) => ({ name, description: "public environment action", inputSchema: { type: "object" } })

test("external tool allowlists bind the public host manifest, not local shell authority", () => {
  expect(bridgeTools({ tools: [tool("terminal")] }, "bridge").tools.map((item) => item.name)).toEqual(["terminal"])
  expect(bridgeTools({ tools: [tool("tau_turn")] }, "tau").tools.map((item) => item.name)).toEqual(["tau_turn"])
  for (const names of [[], ["terminal", "terminal"], ["task_handoff"], ["task_blocked"], ["rsi_revise"], ["a/b"]])
    expect(() => bridgeTools({ tools: names.map(tool) }, "bridge")).toThrow("allowlist")
  expect(() => bridgeTools({ tools: [tool("shell")] }, "tau")).toThrow("allowlist")
  expect(() => bridgeTools({ tools: [tool("tau_turn"), tool("terminal")] }, "tau")).toThrow("allowlist")
})
