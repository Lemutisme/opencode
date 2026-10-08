import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ContractNative } from "../src/pro-contract/native"
import { tmpdir } from "../../core/test/fixture/tmpdir"

test.skipIf(process.platform !== "linux" || !Bun.which("bwrap"))(
  "a real local safety grade preserves exact verifier provenance and observed wrapper exit",
  async () => {
    await using directory = await tmpdir("contract-local-verification-")
    const source = path.join(directory.path, "source")
    const root = path.join(directory.path, "campaign")
    const runtime = path.join(directory.path, "runtime")
    const verifier = {
      directory: path.join(directory.path, "verifier"),
      command: ["/usr/bin/python3", "/verifier/judge.py"],
    }
    await Promise.all([source, runtime, verifier.directory].map((item) => fs.mkdir(item)))
    await Bun.write(path.join(source, "answer.txt"), "safe")
    await Bun.write(
      path.join(verifier.directory, "judge.py"),
      "import json,pathlib\nassert pathlib.Path('/workspace/answer.txt').read_text() == 'safe'\nassert not pathlib.Path('/workspace/VERIFICATION.json').exists()\nassert not pathlib.Path('/VERIFICATION.json').exists()\nprint(json.dumps(dict(passed=1,total=1,valid=True)))\n",
    )
    const checkpoint = await ContractNative.snapshot(source, path.join(root, "checkpoints"))
    const deadline = Date.now() + 10000
    const result = await ContractNative.grade({
      root,
      runtime: { directory: runtime, bun: process.execPath, python: "/usr/bin/python3", bwrap: Bun.which("bwrap")! },
      verifier,
      checkpoint: checkpoint.hash,
      deadline,
      signal: new AbortController().signal,
    })
    expect(result.result).toEqual({ passed: 1, total: 1, valid: true })
    const link = await Bun.file(path.join(result.root, "VERIFICATION.json")).json()
    expect(link).toMatchObject({
      version: 1,
      kind: "local",
      verifier,
      checkpoint: checkpoint.hash,
      deadline,
      terminal: null,
    })
    const fence = await Bun.file(path.join(result.root, "FENCED.json")).json()
    expect(fence).toMatchObject({ acknowledged: true, wrapperExited: true, exitCode: 0, deadline })
    expect(fence.wrapper.pid).toBeInteger()
    expect(fence.wrapper.birth).toMatch(/^\d+$/)
    expect(fence.time).toBeGreaterThanOrEqual(link.started)
    expect(fence.time).toBeLessThan(deadline)
    const current = await Bun.file(`/proc/${fence.wrapper.pid}/stat`)
      .text()
      .catch(() => undefined)
    expect(current?.split(")").at(-1)?.trim().split(/\s+/)[19]).not.toBe(fence.wrapper.birth)
  },
  15000,
)
