import { expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { evaluationReady } from "./ota-profile"
import { reference } from "./ota-native"

test.each(["pass", "negative", "foreign", "cancel", "link"])("external grader readiness: %s", async (kind) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ota-ready-"))
  try {
    await Bun.write(path.join(root, "plan"), "fixed plan")
    const plan = await reference(path.join(root, "plan"))
    const receipt = path.join(root, "receipt.json")
    const abort = new AbortController()
    if (kind === "cancel") abort.abort()
    if (kind !== "cancel") {
      await Bun.write(
        kind === "link" ? path.join(root, "target.json") : receipt,
        JSON.stringify({
          passed: kind !== "negative",
          plan_sha256: kind === "foreign" ? "0".repeat(64) : plan.sha256,
        }),
      )
    }
    if (kind === "link") await symlink(path.join(root, "target.json"), receipt)
    const result = evaluationReady({ plan, receipt }, abort.signal)
    if (kind === "pass") return await expect(result).resolves.toBeUndefined()
    await expect(result).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
