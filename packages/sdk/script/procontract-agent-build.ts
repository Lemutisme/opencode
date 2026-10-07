#!/usr/bin/env bun

import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { BunPlugin } from "bun"

const root = path.resolve(import.meta.dirname, "../../..")
const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(`--${name}=`.length)
const entry = path.resolve(option("entry") ?? path.join(import.meta.dirname, "procontract-agent.ts"))
const outdir = path.resolve(option("outdir") ?? path.join(import.meta.dirname, "../dist/procontract-agent"))
const version = option("version") ?? (await Bun.file(path.join(import.meta.dirname, "../package.json")).json()).version
const targets = { x86_64: "bun-linux-x64-baseline", aarch64: "bun-linux-arm64" } as const
const requested = option("target")
const selected = requested ? [requested] : Object.keys(targets)
const known = selected.filter((name): name is keyof typeof targets => name in targets)
if (known.length !== selected.length) throw new Error(`Unknown target ${requested}; expected x86_64 or aarch64`)
// Cross-compilation embeds the runtime of the building Bun, so releases must use the repository's pinned Bun.
const pinned = (await Bun.file(path.join(root, "package.json")).json()).packageManager.replace("bun@", "")
if (Bun.version !== pinned) throw new Error(`Build with Bun ${pinned}, not ${Bun.version}`)

// The agent runs with fs.filewatcher and fs.fff off and never opens a terminal. Resolve those native
// bindings to Core's inert workerd variants instead of embedding per-target shared libraries.
const inert: Record<string, string> = {
  "#fff": "filesystem/fff.workerd.ts",
  "#pty": "pty/pty.workerd.ts",
  "#persistent-pty-binary": "persistent-pty/binary.workerd.ts",
}
const inertNative: BunPlugin = {
  name: "procontract-agent-inert-native",
  setup(build) {
    build.onResolve({ filter: /^#(fff|pty|persistent-pty-binary)$/ }, (args) => ({
      path: path.join(root, "packages/core/src", inert[args.path]),
    }))
    build.onLoad({ filter: /filesystem[/\\]watcher-binding\.ts$/ }, () => ({
      loader: "js",
      contents: `export default () => { throw new Error("procontract-agent does not watch files") }`,
    }))
  },
}

await mkdir(outdir, { recursive: true })
for (const name of known) {
  const outfile = path.join(outdir, `procontract-agent-linux-${name}`)
  console.error(`building ${outfile}`)
  const result = await Bun.build({
    entrypoints: [entry],
    plugins: [inertNative],
    format: "esm",
    minify: true,
    bytecode: true,
    compile: {
      target: targets[name],
      outfile,
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
      execArgv: [`--user-agent=procontract-agent/${version}`, "--use-system-ca", "--no-warnings", "--"],
    },
    define: { PROCONTRACT_AGENT_VERSION: JSON.stringify(version) },
  })
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${outfile}`)
}

const sums = await Promise.all(
  known.map(async (name) => {
    const file = `procontract-agent-linux-${name}`
    const bytes = await Bun.file(path.join(outdir, file)).arrayBuffer()
    return `${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}  ${file}\n`
  }),
)
await Bun.write(path.join(outdir, "SHA256SUMS"), sums.join(""))
