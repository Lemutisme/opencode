import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ContractDelivery } from "./contract-delivery"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-test-"))
  directories.push(root)
  const directory = path.join(root, "candidate")
  await fs.mkdir(directory)
  await Bun.write(path.join(root, "reference"), '#!/bin/sh\nprintf "reference:%s\\n" "$1"\n')
  await fs.chmod(path.join(root, "reference"), 0o755)
  await Bun.write(path.join(directory, "source"), '#!/bin/sh\nprintf "candidate:%s\\n" "$1"\n')
  await Bun.write(path.join(directory, "compile.sh"), "cp source executable\nchmod +x executable\n")
  await Bun.write(path.join(directory, "validate.sh"), "exit 0\n")
  const controller = new AbortController()
  const options = {
    directory,
    state: path.join(root, "state"),
    reference: path.join(root, "reference"),
    deadline: Date.now() + 60_000,
    signal: controller.signal,
    assertStanding: async () => undefined,
  }
  return { root, directory, options, delivery: await ContractDelivery.create(options), controller }
}
const probe = { title: "documented argument", args: ["value"] }

test("a successor inherits unresolved public obligations, not predecessor readiness", async () => {
  const f = await fixture()
  await f.delivery.act({ action: "probe", probe })
  const obligations = f.delivery.obligations()
  const successor = await ContractDelivery.create({ ...f.options, state: path.join(f.root, "successor"), obligations })
  expect(successor.obligations()).toEqual(obligations)
  expect(await successor.act({ action: "handoff", summary: "same self-validator, new agent" })).toMatchObject({
    state: "open",
    reason: "Retained public counterexamples remain",
  })
  await fs.copyFile(f.options.reference, path.join(f.directory, "source"))
  expect(await successor.act({ action: "handoff", summary: "repaired by successor" })).toMatchObject({
    state: "ready",
    probes: 1,
  })
})

test("stop and a passing self-validator cannot close a retained counterexample", async () => {
  const f = await fixture()
  expect((await f.delivery.status()).state).toBe("open")
  expect(await f.delivery.act({ action: "handoff", summary: "done" })).toMatchObject({ state: "open" })
  expect(await f.delivery.act({ action: "probe", probe })).toMatchObject({ matches: false, actual: null })
  expect(await f.delivery.act({ action: "handoff", summary: "self test passes" })).toMatchObject({
    state: "open",
    reason: "Retained public counterexamples remain",
  })
  await fs.copyFile(f.options.reference, path.join(f.directory, "source"))
  expect(await f.delivery.act({ action: "handoff", summary: "fixed; only this public case is covered" })).toMatchObject(
    { state: "ready", authoritativeCompletion: false, probes: 1 },
  )
  const events = (await Bun.file(path.join(f.options.state, "delivery.jsonl")).text())
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s))
  expect(events.filter((event) => event.type === "probe")).toHaveLength(1)
  expect(events.some((event) => event.type === "check" && !event.matches)).toBe(true)
  expect(events.at(-1).type).toBe("handoff")
})

test("all cases replay, IDs deduplicate, and mutation invalidates handoff", async () => {
  const f = await fixture()
  await fs.copyFile(f.options.reference, path.join(f.directory, "source"))
  await f.delivery.act({ action: "probe", probe })
  await f.delivery.act({ action: "probe", probe: { ...probe, args: ["second"] } })
  await f.delivery.act({ action: "probe", probe })
  expect(await f.delivery.act({ action: "handoff", summary: "two cases" })).toMatchObject({ state: "ready", probes: 2 })
  await Bun.write(path.join(f.directory, "source"), "changed")
  expect((await f.delivery.status()).state).toBe("open")
})

test("fixtures, environment, stdin, nonzero exits and output files compare byte-for-byte", async () => {
  const f = await fixture()
  const script = '#!/bin/sh\ncat input.txt\ncat\necho "$FIXTURE" >&2\nprintf "bytes" > out.bin\nexit 7\n'
  await Bun.write(f.options.reference, script)
  await Bun.write(path.join(f.directory, "source"), script)
  const input = {
    title: "observable failure behavior",
    args: [],
    stdin: "stdin\n",
    files: { "input.txt": "fixture\n" },
    env: { FIXTURE: "{{case}}/input.txt" },
    outputs: ["out.bin", "absent"],
  }
  await f.delivery.act({ action: "probe", probe: input })
  expect(await f.delivery.act({ action: "handoff", summary: "nonzero exit is expected" })).toMatchObject({
    state: "ready",
  })
  expect(await f.delivery.act({ action: "probe", probe: input })).toMatchObject({ matches: true })
})

test("validator failure or mutation cannot admit handoff", async () => {
  const f = await fixture()
  await fs.copyFile(f.options.reference, path.join(f.directory, "source"))
  await f.delivery.act({ action: "probe", probe })
  await Bun.write(path.join(f.directory, "validate.sh"), "exit 9\n")
  expect(await f.delivery.act({ action: "handoff", summary: "done" })).toMatchObject({
    state: "open",
    reason: "validate.sh failed",
  })
  await Bun.write(path.join(f.directory, "validate.sh"), "echo mutation >> source\n")
  expect(await f.delivery.act({ action: "handoff", summary: "done" })).toMatchObject({
    state: "open",
    reason: "Candidate changed during replay; evidence is stale",
  })
})

test("blocked disposition cannot become readiness", async () => {
  const f = await fixture()
  expect(await f.delivery.act({ action: "blocked", reason: "reference is nondeterministic" })).toMatchObject({
    state: "blocked",
    reason: "reference is nondeterministic",
  })
  await expect(f.delivery.act({ action: "handoff", summary: "done" })).rejects.toThrow("explicitly blocked")
})

test("standing, cancellation, deadline and evidence recovery fail closed", async () => {
  const f = await fixture()
  await f.delivery.act({ action: "probe", probe })
  await expect(ContractDelivery.create(f.options)).rejects.toThrow("explicit recovery")
  f.controller.abort()
  await expect(f.delivery.act({ action: "status" })).rejects.toThrow()
  const expired = await fixture()
  expired.options.deadline = Date.now() - 1
  await expect(expired.delivery.act({ action: "probe", probe })).rejects.toThrow("deadline")
  const revoked = await fixture()
  revoked.options.assertStanding = async () => {
    throw new Error("revoked")
  }
  await expect(revoked.delivery.act({ action: "probe", probe })).rejects.toThrow("revoked")
})

test("fixture traversal is refused before reference execution", async () => {
  const f = await fixture()
  await expect(f.delivery.act({ action: "probe", probe: { ...probe, files: { "../escape": "bad" } } })).rejects.toThrow(
    "Fixture paths",
  )
})

test("aborting an active operation records no fabricated evidence", async () => {
  const f = await fixture()
  await Bun.write(f.options.reference, "#!/bin/sh\nsleep 60\n")
  const active = f.delivery.act({ action: "probe", probe })
  const timer = setTimeout(() => f.controller.abort(), 100)
  await expect(active).rejects.toThrow("cancelled")
  clearTimeout(timer)
  expect((await Bun.file(path.join(f.options.state, "delivery.jsonl")).text()).includes('"type":"probe"')).toBe(false)
})

test("serialization preserves effect ordering after a failed operation", async () => {
  const f = await fixture()
  const order: number[] = []
  const first = f.delivery.exclusive(async () => {
    await Bun.sleep(20)
    order.push(1)
    throw new Error("failed tool")
  })
  const second = f.delivery.exclusive(async () => {
    order.push(2)
  })
  await expect(first).rejects.toThrow("failed tool")
  await second
  expect(order).toEqual([1, 2])
})

test("binary probes retain bytes rather than lossy UTF-8 output", async () => {
  const f = await fixture()
  const script = "#!/bin/sh\ncat binary.dat\ncat\n"
  await Bun.write(f.options.reference, script)
  await Bun.write(path.join(f.directory, "source"), script)
  const value = {
    title: "arbitrary bytes",
    args: [],
    stdin: { base64: "AP8B" },
    files: { "binary.dat": { base64: "gIA=" } },
  }
  await f.delivery.act({ action: "probe", probe: value })
  expect(await f.delivery.act({ action: "handoff", summary: "binary roundtrip" })).toMatchObject({ state: "ready" })
  await expect(
    f.delivery.act({ action: "probe", probe: { ...value, stdin: { base64: "not base64" } } }),
  ).rejects.toThrow("canonical base64")
})

test("a tool-context cancellation interrupts a probe without cancelling the allocation", async () => {
  const f = await fixture()
  await Bun.write(f.options.reference, "#!/bin/sh\nsleep 60\n")
  const call = new AbortController()
  const active = f.delivery.act({ action: "probe", probe }, call.signal)
  const timer = setTimeout(() => call.abort(), 100)
  await expect(active).rejects.toThrow("cancelled")
  clearTimeout(timer)
  expect(f.controller.signal.aborted).toBe(false)
  expect(await f.delivery.act({ action: "status" })).toMatchObject({ state: "open" })
})

test("source symlinks cannot escape the snapshot binding", async () => {
  const f = await fixture()
  await f.delivery.act({ action: "probe", probe })
  await fs.symlink(f.options.reference, path.join(f.directory, "external-source"))
  await expect(f.delivery.act({ action: "handoff", summary: "done" })).rejects.toThrow("escapes snapshot scope")
})

test("an active operation expires at the original deadline", async () => {
  const f = await fixture()
  await Bun.write(f.options.reference, "#!/bin/sh\nsleep 60\n")
  f.options.deadline = Date.now() + 100
  await expect(f.delivery.act({ action: "probe", probe })).rejects.toThrow("deadline")
  await expect(f.delivery.act({ action: "status" })).rejects.toThrow("deadline")
})
