import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readTextSnapshot } from "./advisory-archive"

test("text scoring retains empty files and rejects symlink, directory, duplicate and binary entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "advisory-archive-"))
  try {
    await Bun.write(path.join(directory, "answer.txt"), "42")
    await Bun.write(path.join(directory, "empty.txt"), "")
    await Bun.write(path.join(directory, "binary"), new Uint8Array([255, 254]))
    await symlink("answer.txt", path.join(directory, "link"))
    await mkdir(path.join(directory, "dir"))
    const archive = async (files: string[]) => {
      const child = Bun.spawn(["tar", "-cf", "-", "--", ...files], { cwd: directory, stdout: "pipe", stderr: "ignore" })
      const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer())
      expect(await child.exited).toBe(0)
      return bytes
    }
    expect(
      await readTextSnapshot(
        await archive(["answer.txt", "empty.txt"]),
        ["answer.txt", "empty.txt", "missing.txt"],
        1000,
      ),
    ).toEqual({ "answer.txt": "42", "empty.txt": "" })
    for (const files of [["link"], ["dir"], ["answer.txt", "answer.txt"]])
      await expect(readTextSnapshot(await archive(files), [files[0]], 1000)).rejects.toThrow("exactly one regular file")
    await expect(readTextSnapshot(await archive(["binary"]), ["binary"], 1000)).rejects.toThrow("binary candidate")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
