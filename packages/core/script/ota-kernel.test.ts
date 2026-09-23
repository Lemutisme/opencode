import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.each(["same", "changed", "missing", "symlink", "duplicate", "mode"])(
  "fixed kernel archive boundary: %s",
  async (variant) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ota-kernel-"))
    try {
      await Bun.write(
        path.join(root, "manifest.json"),
        JSON.stringify({
          kind: "ota-fixed-kernel-v1",
          files: {
            "kernel.ts": { mode: 0o644, sha256: new Bun.CryptoHasher("sha256").update("fixed\n").digest("hex") },
          },
        }),
      )
      const create = Bun.spawn(
        [
          "python3",
          "-I",
          "-c",
          String.raw`
import io,sys,tarfile
variant=sys.argv[2]
with tarfile.open(sys.argv[1], 'w') as stream:
 for index in range(2 if variant=='duplicate' else 1):
  item=tarfile.TarInfo('other.ts' if variant=='missing' else 'kernel.ts')
  item.mode=0o755 if variant=='mode' else 0o644
  if variant=='symlink':
   item.type=tarfile.SYMTYPE;item.linkname='other.ts';stream.addfile(item);continue
  data=b'changed\n' if variant=='changed' else b'fixed\n'
  item.size=len(data);stream.addfile(item,io.BytesIO(data))
`,
          path.join(root, "source.tar"),
          variant,
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      expect(await create.exited).toBe(0)
      const check = Bun.spawn(
        [
          "python3",
          "-I",
          path.join(import.meta.dir, "ota-kernel.py"),
          path.join(root, "manifest.json"),
          path.join(root, "source.tar"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const output = await new Response(check.stdout).json()
      expect(await check.exited).toBe(variant === "same" ? 0 : 65)
      expect(output).toMatchObject({ passed: variant === "same" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
