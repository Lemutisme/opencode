// A trusted application profile supplies isolated workers and an external grader.
// Candidate artifacts are NEVER imported as host modules.
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { OTA } from "./ota-rsi.js"
import type { Protocol } from "./ota-rsi.js"
import { Artifacts, supervise } from "./ota-supervisor.js"
import type { Driver, Readmission } from "./ota-supervisor.js"

const [rootArg, profileArg, locked] = process.argv.slice(2)
if (!rootArg || !profileArg) throw new Error("usage: bun script/ota-run.ts ROOT TRUSTED_PROFILE")
const root = path.resolve(rootArg)
const profile = path.resolve(profileArg)
await mkdir(root, { recursive: true, mode: 0o700 })
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    void Bun.write(path.join(root, "CANCEL"), signal)
  })
}
if (locked !== "--locked") {
  const child = Bun.spawn(
    ["flock", "-n", path.join(root, "supervisor.lock"), process.execPath, import.meta.path, root, profile, "--locked"],
    {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  process.exit(await child.exited)
}
const { configure } = (await import(pathToFileURL(profile).href)) as {
  configure(
    root: string,
  ): Promise<{
    protocol: Protocol
    seed: { s: Uint8Array; h: Uint8Array }
    driver: Driver
    readmission?: Readmission
    dispose?(): Promise<void>
  }>
}
const config = await configure(root)
const artifacts = new Artifacts(path.join(root, "objects"))
const ota = new OTA(path.join(root, "ota.sqlite"), config.protocol, {
  s: await artifacts.put(config.seed.s),
  h: await artifacts.put(config.seed.h),
})
try {
  const state = await supervise(root, ota, artifacts, config.driver, config.readmission)
  await Bun.write(path.join(root, "STATUS.json"), JSON.stringify(state, null, 2))
  process.exitCode =
    state.stopped?.startsWith("cancelled") ||
    state.stopped === "full-pass improvement confirmed" ||
    state.stopped === "recursive closure completed" ||
    state.stopped === "task delivered"
      ? 0
      : 1
} finally {
  ota.db.close()
  await config.dispose?.()
}
