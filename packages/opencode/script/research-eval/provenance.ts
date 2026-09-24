import { lstat, readlink } from "node:fs/promises"
import path from "node:path"
import { digest } from "./ledger"

/** Include production dependencies and prompt assets; review documents and tests are not runtime inputs. */
export function runtimeFiles(files: string[]) {
  return [...new Set(files)]
    .filter((file) => {
      if (/(^|\/)(?:tests?|__tests__|docs|specs)\//.test(file) || /\.(?:test|spec)\.[^/]+$/.test(file)) return false
      return (
        file === "bun.lock" ||
        file.startsWith("patches/") ||
        file.startsWith("packages/opencode/script/research-eval/") ||
        /^packages\/(?:[^/]+\/)*src\//.test(file) ||
        /^(?:packages\/(?:[^/]+\/)+)?(?:package\.json|bunfig\.toml|tsconfig[^/]*\.json)$/.test(file)
      )
    })
    .sort()
}

/** Same ordered inventory used by freeze.runner and every post-run scoring/recognition entrypoint. */
export async function codeIdentity(root = path.resolve(import.meta.dir, "../../../..")) {
  const inventory = Bun.spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const files = (await new Response(inventory.stdout).text()).split("\0").filter(Boolean)
  if (await inventory.exited) throw new Error("Cannot identify runtime source inventory")
  const entries = await Promise.all(
    runtimeFiles(files).map(async (file) => {
      const absolute = path.join(root, file)
      const stat = await lstat(absolute)
      if (!stat.isFile() && !stat.isSymbolicLink()) return undefined
      const link = stat.isSymbolicLink() ? await readlink(absolute) : undefined
      return [
        file,
        {
          hash: digest(link ?? new Uint8Array(await Bun.file(absolute).arrayBuffer())),
          mode: stat.mode,
          ...(link === undefined ? {} : { link }),
        },
      ] as const
    }),
  )
  return digest(JSON.stringify(Object.fromEntries(entries.filter((entry) => entry !== undefined))))
}
