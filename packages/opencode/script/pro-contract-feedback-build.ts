import { readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const [overlayPath, catalogPath, outputPath, buildVersion] = process.argv.slice(2)
if (!overlayPath || !catalogPath || !outputPath)
  throw new Error("Usage: pro-contract-feedback-build.ts OVERLAY MODELS_JSON OUTPUT_BINARY [VERSION]")
const overlay = path.resolve(overlayPath)
const output = path.resolve(outputPath)
const catalog = await Bun.file(path.resolve(catalogPath)).text()
const manifest: { repository: string; files: Array<{ path: string; sha256: string }> } = await Bun.file(
  path.join(overlay, "manifest.json"),
).json()
const files = new Map(manifest.files.map((file) => [path.join(manifest.repository, file.path), file]))
const filter = new RegExp(
  `^(?:${[...files.keys()].map((file) => file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
)
const loaded = new Set<string>()
const version = buildVersion ?? "0.0.0-procontract-feedback-20260905"
const worker = "./src/cli/tui/worker.ts"
const parser = "opentui-tree-sitter-worker.js"
process.chdir(path.resolve(import.meta.dir, ".."))
await mkdir(path.dirname(output), { recursive: true })
const result = await Bun.build({
  conditions: ["bun", "node"],
  tsconfig: "./tsconfig.json",
  plugins: [
    createSolidTransformPlugin(),
    {
      name: "frozen-procontract-feedback-build",
      setup(builder) {
        builder.onLoad({ filter }, (args) => {
          const file = files.get(args.path)
          if (!file) throw new Error(`Unexpected module: ${args.path}`)
          const contents = readFileSync(path.join(overlay, file.path), "utf8")
          if (new Bun.CryptoHasher("sha256").update(contents).digest("hex") !== file.sha256)
            throw new Error(`Frozen module changed: ${file.path}`)
          loaded.add(file.path)
          return { contents, loader: "ts" }
        })
      },
    },
  ],
  external: ["node-gyp"],
  format: "esm",
  minify: true,
  sourcemap: "none",
  splitting: true,
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    target: "bun-linux-x64",
    outfile: output,
    execArgv: [`--user-agent=opencode/${version}`, "--use-system-ca", "--"],
  },
  files: { [parser]: await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text() },
  entrypoints: ["./src/index.ts", worker, parser],
  define: {
    FFF_LIBC: JSON.stringify("gnu"),
    OPENCODE_VERSION: JSON.stringify(version),
    OPENCODE_MODELS_DEV: catalog,
    OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(`/$bunfs/root/${parser}`),
    OPENCODE_WORKER_PATH: JSON.stringify(worker),
    OPENCODE_CHANNEL: JSON.stringify("contract-policy-split"),
    OPENCODE_LIBC: JSON.stringify("glibc"),
    "process.env.OPENTUI_LIBC": JSON.stringify("glibc"),
  },
})
if (!result.success || loaded.size !== files.size)
  throw new Error(`Build failed or missed frozen modules: ${JSON.stringify(result.logs)}`)
const smoke = Bun.spawn([output, "--version"], { stdout: "pipe", stderr: "pipe" })
const observed = await new Response(smoke.stdout).text()
if ((await smoke.exited) !== 0 || observed.trim() !== version) throw new Error("Binary version probe failed")
await Bun.write(
  `${output}.build.json`,
  JSON.stringify(
    {
      version,
      binary: output,
      binarySha256: new Bun.CryptoHasher("sha256").update(await Bun.file(output).arrayBuffer()).digest("hex"),
      catalogSha256: new Bun.CryptoHasher("sha256").update(catalog).digest("hex"),
      modules: manifest.files,
      loaded: [...loaded].sort(),
      builderSha256: new Bun.CryptoHasher("sha256")
        .update(await Bun.file(import.meta.path).arrayBuffer())
        .digest("hex"),
    },
    null,
    2,
  ) + "\n",
)
console.log(JSON.stringify({ binary: output, version, loaded: loaded.size }))
