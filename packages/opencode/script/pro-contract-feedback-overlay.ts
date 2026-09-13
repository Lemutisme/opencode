import { appendFileSync, readFileSync } from "node:fs"
import path from "node:path"

const directory = process.env.PROCONTRACT_SCREEN_OVERLAY
if (!directory) throw new Error("Frozen runtime overlay is required")
const manifest: { repository: string; files: Array<{ path: string; sha256: string }> } = JSON.parse(
  readFileSync(path.join(directory, "manifest.json"), "utf8"),
)
const files = new Map(manifest.files.map((file) => [path.join(manifest.repository, file.path), file]))
const filter = new RegExp(
  `^(?:${[...files.keys()].map((file) => file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
)

Bun.plugin({
  name: "frozen-procontract-screen",
  setup(builder) {
    builder.onLoad({ filter }, (args) => {
      const file = files.get(args.path)
      if (!file) throw new Error(`Unexpected frozen module: ${args.path}`)
      const contents = readFileSync(path.join(directory, file.path), "utf8")
      if (new Bun.CryptoHasher("sha256").update(contents).digest("hex") !== file.sha256)
        throw new Error(`Frozen source changed: ${file.path}`)
      if (process.env.PROCONTRACT_SCREEN_LOAD_LOG)
        appendFileSync(
          process.env.PROCONTRACT_SCREEN_LOAD_LOG,
          JSON.stringify({ pid: process.pid, path: file.path, sha256: file.sha256 }) + "\n",
        )
      return { contents, loader: "ts" }
    })
  },
})
