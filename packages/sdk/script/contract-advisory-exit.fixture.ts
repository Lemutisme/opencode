// Run only in a disposable subprocess: these fixtures intentionally leave SDK work unsettled.
import fs from "node:fs"
import path from "node:path"
import { TestLLM } from "@opencode/ai/testing"
import { config, fixture, script } from "./contract-advisory.fixture"

const mode = process.argv[2]
const root = process.argv[3]
const f = await fixture({
  root,
  git: mode === "snapshot",
  config: { ...config, reviewMs: mode === "signal" ? 10_000 : 300 },
  timing: { marginMs: 0, minimumMs: 1, settlementMs: 200 },
  reviewer: () => {
    if (mode === "snapshot") {
      fs.writeFileSync(path.join(root, "stall"), "end-of-step snapshot\n")
      return TestLLM.text("Completed provider output; snapshot settlement is next.", "advice")
    }
    if (mode === "signal") process.stdout.write("READY\n")
    return TestLLM.hangAfter()
  },
  researcher:
    mode === "snapshot"
      ? () => TestLLM.text("Warm up the shared Git snapshot repository.", "warmup")
      : script(TestLLM.tool("blocked", "contract_delivery", { action: "blocked", reason: "unresolved" })),
  adapt:
    mode === "signal" || mode === "snapshot"
      ? undefined
      : (host) => ({
          ...host,
          sessions: {
            ...host.sessions,
            prompt: async (value, options) => {
              if (options !== undefined) throw new Error("Reviewer prompt must have no request options")
              const result = await host.sessions.prompt(value)
              const journal = path.join(root, "state/advisory.jsonl")
              if (mode === "evidence-hang" || mode === "evidence-fail") {
                fs.renameSync(journal, path.join(root, "state/advisory-start.jsonl"))
                if (mode === "evidence-fail") fs.mkdirSync(journal)
                if (mode === "evidence-hang") {
                  const fifo = Bun.spawnSync(["mkfifo", journal])
                  if (fifo.exitCode) throw new Error(fifo.stderr.toString())
                }
              }
              fs.writeFileSync(path.join(root, "admitted"), JSON.stringify({ at: Date.now(), result }))
              return await new Promise<never>(() => {})
            },
          },
        }),
})
process.on("SIGTERM", () => f.controller.abort())
try {
  if (mode === "signal") {
    await f.prompt()
    await f.drain().then(
      () => {
        throw new Error("Stopped worker must fail")
      },
      () => undefined,
    )
  } else {
    if (mode === "snapshot") {
      await f.prompt()
      await f.wait()
    }
    const result = await f.advisory!.review({ node: "idle", statement: "fixture progress" })
    throw new Error("Unsettled reviewer unexpectedly returned: " + JSON.stringify(result))
  }
} finally {
  await f.advisory!.settle()
  fs.writeFileSync(path.join(root, "closing"), "host.close reached\n")
  await f.host.close()
}
process.exit(0)
