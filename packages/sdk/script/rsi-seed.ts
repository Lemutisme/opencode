// Operator-only packaging. Never point this at candidate source; proposals use the sandbox builder.
import fs from "node:fs/promises"
import path from "node:path"
import { RSIRuntime } from "./rsi-runtime"

export async function seedRelease(input: {
  source: string
  destination: string
  bun: string
  rg: string
  image: string
  entry?: string
}) {
  await fs.mkdir(input.destination, { recursive: true, mode: 0o700 })
  const source = path.join(input.destination, "source.tar")
  const dependencies = path.join(input.destination, "dependencies.tar")
  if ((await Bun.file(source).exists()) || (await Bun.file(dependencies).exists()))
    throw new Error("refusing to replace a sealed seed")
  await RSIRuntime.run(["python3", "-I", path.join(import.meta.dir, "rsi-files.py"), "source", input.source, source], {
    timeout: 120_000,
  })
  const paths = await RSIRuntime.run(["find", input.source, "-name", "node_modules", "-type", "d", "-prune", "-print0"])
  const names = paths
    .split("\0")
    .filter(Boolean)
    .map((file) => path.relative(input.source, file) + "\0")
    .join("")
  await RSIRuntime.run(["tar", "-C", input.source, "--null", "-T", "-", "-cf", dependencies], {
    input: names,
    timeout: 300_000,
  })
  const release: RSIRuntime.Release = {
    kind: "native-v2-release-v1",
    source: await RSIRuntime.ref(source),
    dependencies: await RSIRuntime.ref(dependencies),
    bun: await RSIRuntime.ref(input.bun),
    rg: await RSIRuntime.ref(input.rg),
    image: input.image,
    entry: input.entry ?? "packages/sdk/script/rsi-worker.ts",
  }
  await Bun.write(path.join(input.destination, "release.json"), JSON.stringify(release, null, 2))
  return release
}
if (import.meta.main) {
  const [source, destination, bun, rg, image] = process.argv.slice(2)
  if (!source || !destination || !bun || !rg || !image)
    throw new Error("usage: bun rsi-seed.ts SOURCE NEW_DEST BUN RG IMAGE")
  console.log(
    JSON.stringify(
      await seedRelease({
        source: path.resolve(source),
        destination: path.resolve(destination),
        bun: path.resolve(bun),
        rg: path.resolve(rg),
        image,
      }),
      null,
      2,
    ),
  )
}
