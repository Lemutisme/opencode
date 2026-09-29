// Executable qualification profile, NOT a model experiment or an RSI quality claim.
// The deterministic proposer changes real artifacts; every execution is sandboxed.
import path from "node:path"
import { hash } from "./ota-rsi.js"
import type { Protocol } from "./ota-rsi.js"
import { Sandbox } from "./ota-sandbox.js"
import type { Driver } from "./ota-supervisor.js"

export async function configure(root: string, mode = process.env.OTA_FIXTURE_MODE ?? "healthy") {
  const image = process.env.OPENCODE_OTA_IMAGE
  if (!image) throw new Error("OPENCODE_OTA_IMAGE must name a preinstalled pinned Python image")
  const sandbox = new Sandbox(root, image)
  const accounting = { source: "offline-fixture-no-provider", knownCost: "0", incomplete: false }
  const files = [
    import.meta.path,
    ...["ota-rsi.ts", "ota-supervisor.ts", "ota-sandbox.ts", "ota-run.ts"].map((name) =>
      path.join(import.meta.dir, name),
    ),
    path.join(import.meta.dir, "../src/pro-contract/kernel.ts"),
    Bun.resolveSync("@opencode/util/hash", import.meta.dir),
    path.join(import.meta.dir, "../../schema/src/pro-contract.ts"),
  ]
  const fingerprint = async () =>
    hash(
      JSON.stringify([
        image,
        mode,
        ...(await Promise.all(files.map(async (file) => hash(await Bun.file(file).bytes())))),
      ]),
    )
  const harness = `import json, os, sys, time
VERSION = 0
MODE = ${JSON.stringify(mode)}
if sys.argv[1] == "solve":
    print(int(sys.argv[2]) + json.load(open('/release/s'))['delta'])
    sys.exit(0)
if MODE == 'hang' and VERSION > 0:
    while True:
        print('heartbeat: all good', flush=True) # Deliberately untrusted: ignored.
        time.sleep(0.1)
slot = sys.argv[2]
if slot == 's':
    source = open('/release/h').read().replace('VERSION = ' + str(VERSION), 'VERSION = ' + str(VERSION + 1))
    open('/candidate/h', 'w').write(source)
else:
    strategy = json.load(open('/release/s'))
    strategy['generation'] += 1
    open('/candidate/s', 'w').write(json.dumps(strategy))
`
  const protocol: Protocol = {
    trusted: await fingerprint(),
    scope: "mechanics",
    minimumMeanGainBps: 200,
    tests: [-5, 0, 7].map((value) => ({ id: `arithmetic:${value}`, total: 1 })),
    startupMs: 8_000,
    heartbeatMs: 8_000,
    probationMs: 2_000,
  }
  const driver: Driver = {
    fingerprint,
    fence: () => sandbox.fence(),
    start: async (job) => {
      const worker = await sandbox.start({
        files: job.pair,
        output: job.output,
        argv: ["/usr/bin/python3", "/release/h", "mutate", job.slot],
      })
      return {
        result: worker.result,
        // This offline proposer makes no provider/tool progress before its useful
        // final artifact. Merely printing "heartbeat" must not refresh the lease.
        progress: async () => -1,
        stop: async () => {
          await worker.stop()
          return accounting
        },
      }
    },
    evaluate: async (input) => {
      const value = Number(input.test.id.split(":")[1])
      const worker = await sandbox.start({
        files: input.pair,
        argv: ["/usr/bin/python3", "/release/h", "solve", String(value)],
      })
      const stop = () => {
        void sandbox.fence()
      }
      input.signal.addEventListener("abort", stop, { once: true })
      try {
        await worker.result
        const output = await Bun.file(worker.logfile).text()
        return { passed: output.trim() === String(value + 1) ? 1 : 0, total: 1, valid: true, accounting }
      } finally {
        input.signal.removeEventListener("abort", stop)
        await worker.stop()
      }
    },
  }
  return {
    protocol,
    driver,
    seed: {
      s: new TextEncoder().encode(JSON.stringify({ delta: 1, generation: 0 })),
      h: new TextEncoder().encode(harness),
    },
  }
}
