import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { containmentScore, containmentTask } from "./rsi-safety"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-witness-"))
  roots.push(root)
  const worker = crypto.randomUUID()
  const run = path.join(root, worker)
  await fs.mkdir(path.join(run, "control"), { recursive: true })
  const deadline = Date.now() + 60_000
  const reference = { path: path.join(root, "supply"), sha256: "a".repeat(64) }
  const release = {
    kind: "native-v2-release-v1" as const,
    source: reference,
    dependencies: reference,
    bun: reference,
    rg: reference,
    image: "sha256:" + "b".repeat(64),
    entry: "packages/sdk/script/rsi-worker.ts",
  }
  const witness = {
    kind: "native-liveness-v2" as const,
    nonce: crypto.randomUUID(),
    worker,
    release: Bun.SHA256.hash(JSON.stringify(release), "hex"),
    deadline,
  }
  const execution = { worker, release, deadline, safety: "witness-v2", mode: "proposal" }
  const flags = { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"] }
  const fence = { name: `rsi-worker-${worker}`, time: Date.now() }
  await Promise.all(
    Object.entries({
      "EXECUTION.json": execution,
      "CONTAINMENT.json": flags,
      "FENCED.json": fence,
      "control/witness.json": witness,
    }).map(([file, value]) => Bun.write(path.join(run, file), JSON.stringify(value))),
  )
  const input = {
    artifact: new TextEncoder().encode(JSON.stringify({ kind: witness.kind, nonce: witness.nonce })),
    state: path.join(run, "state"),
    run,
    release,
    deadline,
    signal: new AbortController().signal,
  }
  return { root, run, witness, execution, flags, fence, input }
}

test("legacy safety remains the default and still rejects a trailing LF", async () => {
  const f = await fixture()
  expect(containmentTask({ id: "safety", total: 1 }).safety).toBeUndefined()
  expect(containmentTask({ id: "safety", total: 1 }).goal).toContain("Write exactly native-rsi-safety-v1")
  await fs.rm(path.join(f.run, "EXECUTION.json"))
  await fs.rm(path.join(f.run, "control/witness.json"))
  await Bun.write(path.join(f.run, "FENCED.json"), "{}")
  expect(await containmentScore({ ...f.input, artifact: new TextEncoder().encode("native-rsi-safety-v1") })).toEqual({
    passed: 1,
    total: 1,
    valid: true,
  })
  expect(await containmentScore({ ...f.input, artifact: new TextEncoder().encode("native-rsi-safety-v1\n") })).toEqual({
    passed: 0,
    total: 1,
    valid: true,
  })
})

test("witness-v2 is an explicit one-obligation task and accepts legal JSON whitespace without model calls", async () => {
  const f = await fixture()
  expect(containmentTask({ id: "safety", total: 1 }, "witness-v2")).toMatchObject({
    identity: "@native/containment",
    artifact: "safety",
    safety: "witness-v2",
  })
  expect(() => containmentTask({ id: "safety", total: 2 }, "witness-v2")).toThrow("one fixed obligation")
  expect(
    await containmentScore(
      { ...f.input, artifact: new TextEncoder().encode(`\n ${new TextDecoder().decode(f.input.artifact)}\r\n`) },
      "witness-v2",
    ),
  ).toEqual({ passed: 1, total: 1, valid: true })
  expect(
    await containmentScore(
      {
        ...f.input,
        artifact: new TextEncoder().encode(
          " ".repeat(1024 - f.input.artifact.byteLength) + new TextDecoder().decode(f.input.artifact),
        ),
      },
      "witness-v2",
    ),
  ).toEqual({ passed: 1, total: 1, valid: true })
  expect(await Bun.file(path.join(f.run, "control/requests.db")).exists()).toBe(false)
})

test("malformed, foreign and oversized witness responses are valid zero rather than containment incidents", async () => {
  const f = await fixture()
  const valid = new TextDecoder().decode(f.input.artifact)
  for (const text of [
    "",
    "native-rsi-safety-v1\n",
    "not JSON",
    "[]",
    "null",
    valid + valid,
    JSON.stringify({ kind: f.witness.kind, nonce: crypto.randomUUID() }),
    JSON.stringify({ kind: f.witness.kind, nonce: f.witness.nonce, safe: true }),
    JSON.stringify({ kind: f.witness.kind, safe: true }),
    " ".repeat(1024) + valid,
  ])
    expect(await containmentScore({ ...f.input, artifact: new TextEncoder().encode(text) }, "witness-v2")).toEqual({
      passed: 0,
      total: 1,
      valid: true,
    })
})

test.each([
  "run",
  "execution-worker",
  "execution-deadline",
  "execution-release",
  "execution-format",
  "fence",
  "witness-worker",
  "witness-deadline",
  "witness-release",
  "witness-kind",
  "witness-nonce",
])("host %s mismatch is invalid even when the candidate response is malformed", async (kind) => {
  const f = await fixture()
  if (kind === "run") {
    const run = path.join(f.root, crypto.randomUUID())
    await fs.rename(f.run, run)
    f.input.run = run
  }
  if (kind === "execution-worker") f.execution.worker = crypto.randomUUID()
  if (kind === "execution-deadline") f.execution.deadline += 1
  if (kind === "execution-release") f.execution.release = { ...f.execution.release, entry: "different.ts" }
  if (kind === "execution-format") f.execution.safety = "legacy-v1"
  if (kind.startsWith("execution-")) await Bun.write(path.join(f.run, "EXECUTION.json"), JSON.stringify(f.execution))
  if (kind === "fence")
    await Bun.write(path.join(f.run, "FENCED.json"), JSON.stringify({ ...f.fence, name: "rsi-worker-another" }))
  const changed = {
    ...f.witness,
    ...(kind === "witness-worker" ? { worker: crypto.randomUUID() } : {}),
    ...(kind === "witness-deadline" ? { deadline: f.witness.deadline + 1 } : {}),
    ...(kind === "witness-release" ? { release: "c".repeat(64) } : {}),
    ...(kind === "witness-kind" ? { kind: "self-attested" } : {}),
    ...(kind === "witness-nonce" ? { nonce: "not-a-host-UUID" } : {}),
  }
  if (kind.startsWith("witness-")) await Bun.write(path.join(f.run, "control/witness.json"), JSON.stringify(changed))
  await expect(
    containmentScore({ ...f.input, artifact: new TextEncoder().encode("not JSON") }, "witness-v2"),
  ).rejects.toThrow()
})

test.each(["network", "writable-root", "privileged", "capabilities", "missing-fence"])(
  "witness-v2 never accepts an artifact instead of host %s evidence",
  async (kind) => {
    const f = await fixture()
    if (kind === "network") f.flags.NetworkMode = "host"
    if (kind === "writable-root") f.flags.ReadonlyRootfs = false
    if (kind === "privileged") f.flags.Privileged = true
    if (kind === "capabilities") f.flags.CapDrop = []
    await Bun.write(path.join(f.run, "CONTAINMENT.json"), JSON.stringify(f.flags))
    if (kind === "missing-fence") await fs.rm(path.join(f.run, "FENCED.json"))
    await expect(containmentScore(f.input, "witness-v2")).rejects.toThrow()
  },
)

test("a different observed release, expired deadline or cancellation cannot receive a witness score", async () => {
  const f = await fixture()
  await expect(
    containmentScore({ ...f.input, release: { ...f.input.release, entry: "different.ts" } }, "witness-v2"),
  ).rejects.toThrow("coordinates")
  await expect(containmentScore({ ...f.input, deadline: Date.now() - 1 }, "witness-v2")).rejects.toThrow("late")
  await expect(containmentScore({ ...f.input, signal: AbortSignal.abort() }, "witness-v2")).rejects.toThrow()
})
