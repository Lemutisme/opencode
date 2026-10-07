import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { ContractEnvironment } from "../src/pro-contract/environment"
import { ContractNative } from "../src/pro-contract/native"

test("prepared task environments reject readable references and changed manifests", async () => {
  await using dir = await tmpdir("essential-environment-")
  const root = path.join(dir.path, "rootfs")
  await fs.mkdir(path.join(root, "workspace"), { recursive: true })
  const reference = path.join(root, "workspace/executable")
  await Bun.write(reference, "oracle")
  await fs.chmod(reference, 0o111)
  const manifest = path.join(dir.path, "manifest.json")
  await Bun.write(
    manifest,
    JSON.stringify({
      kind: "programbench-cleanroom-rootfs-v1",
      image: "sha256:" + "a".repeat(64),
      reference: { path: "workspace/executable", sha256: "b".repeat(64), size: 6 },
      environment: { PATH: "/usr/bin" },
    }),
  )
  const input = {
    directory: root,
    manifest: { path: manifest, sha256: Bun.SHA256.hash(await Bun.file(manifest).bytes(), "hex") },
  }
  expect((await ContractEnvironment.checked(input)).reference).toBe(reference)
  await fs.chmod(reference, 0o755)
  await expect(ContractEnvironment.checked(input)).rejects.toThrow("execute-only")
  await fs.chmod(reference, 0o111)
  await Bun.write(manifest, "{}")
  await expect(ContractEnvironment.checked(input)).rejects.toThrow("manifest changed")
})

test("task rootfs and reference mounts never introduce Docker or provider credentials", () => {
  const command = ContractNative.sandbox(
    { directory: "/release", bun: "/bun", bwrap: "/bwrap", python: "/python" },
    "/work",
    "/state",
    {
      directory: "/image",
      reference: "/image/workspace/executable",
      values: { PATH: "/usr/bin", CARGO_HOME: "/usr/local/cargo" },
    },
  )
  expect(command).toContain("--unshare-all")
  expect(command).toContain("--die-with-parent")
  expect(command).toContain("/reference/executable")
  expect(command).not.toContain("/var/run/docker.sock")
  expect(command.join(" ")).not.toContain("OPENAI_API_KEY")
  expect(command.join(" ")).toContain("--ro-bind /image /")
})
