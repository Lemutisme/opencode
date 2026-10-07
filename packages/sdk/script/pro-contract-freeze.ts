#!/usr/bin/env bun
// Operator-owned release packaging. No candidate code executes during freezing.
import fs from "node:fs/promises"
import path from "node:path"

const source = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "../../.."))
const target = process.argv[3]
if (!target || !path.isAbsolute(target) || target === source || target.startsWith(source + path.sep))
  throw new Error("Usage: bun script/pro-contract-freeze.ts SOURCE ABSOLUTE_NEW_RELEASE")
await fs.mkdir(target, { mode: 0o700 })
const list = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: source,
  stdout: "pipe",
})
const names = (await new Response(list.stdout).text()).split("\0").filter(Boolean)
if ((await list.exited) !== 0) throw new Error("Cannot enumerate runtime source")
const files = await Promise.all(
  names.map(async (name) => {
    const stat = await fs.lstat(path.join(source, name))
    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(path.join(source, name))
      if (path.isAbsolute(link) || !path.resolve(source, path.dirname(name), link).startsWith(source + path.sep))
        throw new Error(`Source symlink leaves the release: ${name}`)
      await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true })
      await fs.symlink(link, path.join(target, name))
      return { path: name, hash: Bun.SHA256.hash("symlink:" + link, "hex"), link: true }
    }
    if (!stat.isFile()) throw new Error(`Source manifest requires a regular file: ${name}`)
    const bytes = await Bun.file(path.join(source, name)).bytes()
    await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true })
    await Bun.write(path.join(target, name), bytes)
    await fs.chmod(path.join(target, name), stat.mode & 0o777)
    return { path: name, hash: Bun.SHA256.hash(bytes, "hex") }
  }),
)
const dependencies = [
  "node_modules",
  ...(await fs.readdir(path.join(source, "packages"))).map((name) => `packages/${name}/node_modules`),
]
for (const directory of dependencies) {
  if (!(await fs.stat(path.join(source, directory)).catch(() => undefined))) continue
  const process = Bun.spawn(
    ["cp", "-a", "--reflink=auto", path.join(source, directory), path.join(target, directory)],
    { stdout: "inherit", stderr: "inherit" },
  )
  if ((await process.exited) !== 0) throw new Error("Dependency supply copy failed")
}
const revision = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: source, stdout: "pipe" })
const sourceCommit = (await new Response(revision.stdout).text()).trim()
if ((await revision.exited) !== 0) throw new Error("Cannot resolve source revision")
const base = Bun.spawn(["git", "merge-base", "HEAD", "origin/v2"], { cwd: source, stdout: "pipe" })
const upstream = (await new Response(base.stdout).text()).trim()
if ((await base.exited) !== 0) throw new Error("Cannot resolve upstream base")
await Bun.write(
  path.join(target, "RELEASE.json"),
  JSON.stringify({ upstream, sourceCommit, files: files.sort((a, b) => a.path.localeCompare(b.path)) }),
)
console.log(JSON.stringify({ directory: target, upstream, sourceCommit, files: files.length }))
