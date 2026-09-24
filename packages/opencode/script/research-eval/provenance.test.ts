import { expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp } from "node:fs/promises"
import { codeIdentity } from "./provenance"
import { source } from "./freeze"
import { identities } from "./launch"
import { digest } from "./ledger"

test("runtime identity binds production schema, prompts, lockfile and loading configuration across freeze and scoring", async () => {
  const root = await mkdtemp("/tmp/opencode-s6c-provenance-")
  const repository = path.join(root, "repository")
  const git = Bun.spawn(["git", "init", repository], { stdout: "ignore", stderr: "pipe" })
  expect(await git.exited).toBe(0)
  const runtime = [
    "packages/opencode/script/research-eval/score.ts",
    "packages/opencode/script/research-eval/isolate.c",
    "packages/sdk-next/src/research/isolate.c",
    "packages/sdk-next/src/research/python.ts",
    "packages/schema/src/pro-contract.ts",
    "packages/core/src/pro-contract.ts",
    "packages/sdk-next/src/research/schema.ts",
    "packages/core/src/system-context/prompt.md",
    "bun.lock",
    "package.json",
    "packages/schema/package.json",
    "tsconfig.json",
    "packages/core/tsconfig.build.json",
    "bunfig.toml",
    "packages/opencode/bunfig.toml",
    "patches/dependency.patch",
  ]
  await Promise.all(runtime.map((file) => Bun.write(path.join(repository, file), "original\n")))
  const hash = await codeIdentity(repository)
  await Promise.all(
    [
      "specs/review.md",
      "packages/opencode/script/research-eval/score.test.ts",
      "packages/core/src/pro-contract.test.ts",
      "packages/schema/test/budget.test.ts",
    ].map((file) => Bun.write(path.join(repository, file), "review and test changes\n")),
  )
  expect(await codeIdentity(repository)).toBe(hash)
  for (const file of runtime) {
    await Bun.write(path.join(repository, file), "changed\n")
    expect(await codeIdentity(repository)).not.toBe(hash)
    await Bun.write(path.join(repository, file), "original\n")
  }
  await source(repository, path.join(root, "snapshot"))
  const manifest = await Bun.file(path.join(root, "snapshot/manifest.json")).json()
  expect(digest(JSON.stringify(identities(manifest, [], {}, {}).runner))).toBe(hash)
})
