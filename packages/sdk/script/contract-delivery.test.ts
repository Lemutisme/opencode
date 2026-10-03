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

test("handoff removes a stale executable before compiling and retains the failure", async () => {
  const f = await fixture()
  await fs.copyFile(f.options.reference, path.join(f.directory, "source"))
  await f.delivery.act({ action: "probe", probe })
  expect(await f.delivery.act({ action: "handoff", summary: "first build" })).toMatchObject({ state: "ready" })
  await Bun.write(path.join(f.directory, "compile.sh"), "chmod +x executable\n")
  await Bun.write(path.join(f.directory, "validate.sh"), "touch validator-ran\n")
  expect(await f.delivery.act({ action: "handoff", summary: "old entrypoint still runs" })).toMatchObject({
    state: "open",
    reason: "compile.sh failed",
    result: { exit: 1 },
  })
  expect(await Bun.file(path.join(f.directory, "executable")).exists()).toBe(false)
  expect(await Bun.file(path.join(f.directory, "validator-ran")).exists()).toBe(false)
  expect(await f.delivery.status()).toMatchObject({ state: "open", probes: 1 })
  const events = (await Bun.file(path.join(f.options.state, "delivery.jsonl")).text()).trim().split("\n")
  expect(JSON.parse(events.at(-1)!).type).toBe("reopened")
})

test.each(["absent", "nonexecutable", "symlink", "directory"] as const)(
  "compile exit zero with a %s entrypoint cannot be repaired by validator side effects",
  async (kind) => {
    const f = await fixture()
    await fs.copyFile(f.options.reference, path.join(f.directory, "source"))
    await f.delivery.act({ action: "probe", probe })
    await fs.copyFile(f.options.reference, path.join(f.directory, "executable"))
    await Bun.write(
      path.join(f.directory, "compile.sh"),
      {
        absent: "exit 0\n",
        nonexecutable: "cp source executable\nchmod 0644 executable\n",
        symlink: `ln -s ${JSON.stringify(f.options.reference)} executable\n`,
        directory: "mkdir executable\n",
      }[kind],
    )
    await Bun.write(
      path.join(f.directory, "validate.sh"),
      "touch validator-ran\ncp source executable\nchmod +x executable\n",
    )
    expect(await f.delivery.act({ action: "handoff", summary: "compiler returned zero" })).toMatchObject({
      state: "open",
      reason: "compile.sh did not produce a regular executable",
    })
    expect(await Bun.file(path.join(f.directory, "validator-ran")).exists()).toBe(false)
    expect(await f.delivery.status()).toMatchObject({ state: "open", probes: 1 })
  },
)

test("source rebuild replaces an old reference symlink without reading or changing execute-only gold", async () => {
  const f = await fixture()
  // An execute-only script still needs interpreter read access; use a real ELF
  // fixture, as the cleanroom does. Never read this reference after chmod 0111.
  await fs.copyFile("/bin/echo", f.options.reference)
  await Bun.write(path.join(f.directory, "source"), '#!/bin/sh\nprintf "%s\\n" "$*"\n')
  await fs.chmod(f.options.reference, 0o111)
  await f.delivery.act({ action: "probe", probe })
  const reference = await fs.lstat(f.options.reference)
  await fs.symlink(f.options.reference, path.join(f.directory, "executable"))
  expect(
    await f.delivery.act({ action: "handoff", summary: "rebuilt source, independent host verification pending" }),
  ).toMatchObject({
    state: "ready",
    probes: 1,
    authoritativeCompletion: false,
  })
  expect((await fs.lstat(path.join(f.directory, "executable"))).isSymbolicLink()).toBe(false)
  const after = await fs.lstat(f.options.reference)
  expect({ mode: after.mode, mtime: after.mtimeMs, size: after.size, inode: after.ino }).toEqual({
    mode: reference.mode,
    mtime: reference.mtimeMs,
    size: reference.size,
    inode: reference.ino,
  })
  expect(after.mode & 0o777).toBe(0o111)
})

test("a freshly rebuilt executable still cannot discharge a failed retained probe", async () => {
  const f = await fixture()
  await f.delivery.act({ action: "probe", probe })
  expect(await f.delivery.act({ action: "handoff", summary: "build and validator pass" })).toMatchObject({
    state: "open",
    reason: "Retained public counterexamples remain",
    failures: [{ title: probe.title, matches: false }],
  })
  expect(await Bun.file(path.join(f.directory, "executable")).exists()).toBe(true)
  expect(await f.delivery.status()).toMatchObject({ state: "open", probes: 1 })
})

test.each(["call cancellation", "original deadline"] as const)(
  "%s fences a rebuild's child processes without admitting stale readiness",
  async (kind) => {
    const f = await fixture()
    await fs.copyFile(f.options.reference, path.join(f.directory, "source"))
    await f.delivery.act({ action: "probe", probe })
    await fs.copyFile(f.options.reference, path.join(f.directory, "executable"))
    await Bun.write(
      path.join(f.directory, "compile.sh"),
      "echo $$ > compiler.pid\nsleep 60 &\necho $! > child.pid\nwait\ncp source executable\nchmod +x executable\n",
    )
    const call = new AbortController()
    if (kind === "original deadline") f.options.deadline = Date.now() + 500
    const deadline = f.options.deadline
    const active = f.delivery.act({ action: "handoff", summary: "compile in progress" }, call.signal)
    const timer = kind === "call cancellation" ? setTimeout(() => call.abort(), 250) : undefined
    await expect(active).rejects.toThrow("cancelled or original deadline")
    clearTimeout(timer)
    expect(await Bun.file(path.join(f.directory, "child.pid")).exists()).toBe(true)
    const pids = await Promise.all(
      ["compiler.pid", "child.pid"].map((name) => Bun.file(path.join(f.directory, name)).text()),
    )
    expect(f.options.deadline).toBe(deadline)
    expect(f.controller.signal.aborted).toBe(false)
    expect(await Bun.file(path.join(f.directory, "executable")).exists()).toBe(false)
    for (const pid of pids) {
      const state = await Bun.file(`/proc/${Number(pid)}/stat`)
        .text()
        .then(
          (text) => text.slice(text.lastIndexOf(")") + 2).split(" ")[0],
          () => "gone",
        )
      expect(["gone", "Z"]).toContain(state)
    }
    expect((await Bun.file(path.join(f.options.state, "delivery.jsonl")).text()).includes('"type":"handoff"')).toBe(
      false,
    )
    if (kind === "original deadline") {
      await expect(f.delivery.act({ action: "status" })).rejects.toThrow("deadline")
      return
    }
    expect(await f.delivery.status()).toMatchObject({ state: "open", probes: 1 })
    await Bun.write(path.join(f.directory, "compile.sh"), "cp source executable\nchmod +x executable\n")
    expect(await f.delivery.act({ action: "handoff", summary: "repaired within the same deadline" })).toMatchObject({
      state: "ready",
    })
    expect(f.options.deadline).toBe(deadline)
  },
)

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
