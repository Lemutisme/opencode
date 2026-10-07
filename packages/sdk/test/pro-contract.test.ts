import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { ContractNative } from "../src/pro-contract/native"

test("checkpoints preserve executable files, empty directories and exact bytes across fresh workspaces", async () => {
  await using dir = await tmpdir("contract-checkpoint-")
  const source = path.join(dir.path, "source")
  const objects = path.join(dir.path, "objects")
  await fs.mkdir(path.join(source, "empty"), { recursive: true })
  await Bun.write(path.join(source, "run.sh"), "#!/bin/sh\nprintf retained\n")
  await fs.chmod(path.join(source, "run.sh"), 0o700)
  const [first, second] = await Promise.all([
    ContractNative.snapshot(source, objects),
    ContractNative.snapshot(source, objects),
  ])
  expect(first.hash).toBe(second.hash)
  await ContractNative.restore(objects, first.hash, path.join(dir.path, "restored"))
  expect((await fs.stat(path.join(dir.path, "restored/empty"))).isDirectory()).toBe(true)
  expect((await fs.stat(path.join(dir.path, "restored/run.sh"))).mode & 0o100).toBe(0o100)
  expect(await Bun.file(path.join(dir.path, "restored/run.sh")).text()).toBe("#!/bin/sh\nprintf retained\n")
  await Bun.write(path.join(source, "run.sh"), "Changed live workspace")
  expect(await Bun.file(path.join(first.directory, "run.sh")).text()).toContain("retained")
  await Bun.write(path.join(first.directory, "run.sh"), "Corrupted retained bytes")
  await expect(ContractNative.restore(objects, first.hash, path.join(dir.path, "corrupt"))).rejects.toThrow("changed")
})

test("candidate symlinks cannot turn a snapshot into a host file read", async () => {
  await using dir = await tmpdir("contract-links-")
  const source = path.join(dir.path, "source")
  await fs.mkdir(source)
  await fs.symlink("/etc/passwd", path.join(source, "leak"))
  await expect(ContractNative.snapshot(source, path.join(dir.path, "objects"))).rejects.toThrow("regular files")
})
