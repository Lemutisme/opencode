import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { ContractFence } from "../src/pro-contract/fence"
import { tmpdir } from "../../core/test/fixture/tmpdir"

const wrapper = [
  "import json, signal, subprocess, sys",
  "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
  "child = subprocess.Popen([sys.executable, '-u', '-c', 'import os, signal; signal.signal(signal.SIGTERM, signal.SIG_IGN); print(os.getpid(), flush=True); signal.pause()'], stdout=subprocess.PIPE, start_new_session=True)",
  "print(json.dumps({'pid': int(child.stdout.readline())}), flush=True)",
  "signal.pause()",
].join("\n")

async function ready(code: string) {
  const child = Bun.spawn(["/usr/bin/python3", "-u", "-c", code], { stdout: "pipe", stderr: "inherit" })
  const reader = child.stdout.getReader()
  const first = await reader.read()
  reader.releaseLock()
  if (first.done) throw new Error("Process fixture exited before readiness")
  return { child, value: JSON.parse(new TextDecoder().decode(first.value)) as { pid: number } }
}

function live(identity: ContractFence.Identity) {
  try {
    const fields = readFileSync(`/proc/${identity.pid}/stat`, "utf8").split(")").at(-1)!.trim().split(/\s+/)
    return fields[19] === identity.birth && fields[0] !== "Z" && fields[0] !== "X"
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

test("cancellation fences the separate native process and escalates a TERM-ignoring gateway", async () => {
  await using directory = await tmpdir("contract-fence-cancel-")
  const worker = await ready(wrapper)
  const gateway = await ready(
    "import os, signal; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('{\"pid\":%s}' % os.getpid(), flush=True); signal.pause()",
  )
  const runtime = ContractFence.identity(worker.value.pid)
  const gatewayIdentity = ContractFence.identity(gateway.value.pid)
  const abort = new AbortController()
  const deadline = Date.now() + 60000
  const fence = ContractFence.own({ worker: worker.child, signal: abort.signal, deadline })
  fence.runtime(runtime)
  fence.gateway(gateway.child)
  fence.ready()
  try {
    abort.abort()
    // Repeat cancellation must not renew the grace or skip the other targets.
    fence.stop("repeat cancellation")
    await expect(fence.wait(Promise.resolve("already completed"))).rejects.toThrow("cancelled")
    await expect(fence.wait(Promise.reject(new Error("abandoned operation")))).rejects.toThrow("cancelled")
    await expect(fence.wait(worker.child.exited)).rejects.toThrow("cancelled")
    const receipt = await fence.finish(path.join(directory.path, "FENCED.json"))
    expect(receipt.acknowledged).toBe(true)
    expect(receipt.wrapperExited && receipt.runtimeExited && receipt.gatewayExited).toBe(true)
    expect(receipt.deadline).toBe(deadline)
    expect(receipt.time).toBeLessThanOrEqual(receipt.cleanupDeadline + 200)
    expect(receipt.cleanupDeadline - receipt.cleanupStarted).toBe(5000)
    expect(receipt.cleanupElapsed).toBeLessThan(5200)
    expect(receipt.wrapper?.pid).toBe(worker.child.pid)
    expect(live(runtime)).toBe(false)
    expect(live(gatewayIdentity)).toBe(false)
    await Promise.all([worker.child.exited, gateway.child.exited])
    expect(gateway.child.signalCode).toBe("SIGKILL")
    expect(await Bun.file(path.join(directory.path, "FENCED.json")).json()).toEqual(receipt)
  } finally {
    worker.child.kill("SIGKILL")
    gateway.child.kill("SIGKILL")
    if (live(runtime)) process.kill(runtime.pid, "SIGKILL")
  }
}, 10000)

test("a passed original deadline rejects already settled work even before its timer callback", async () => {
  await using directory = await tmpdir("contract-fence-settled-")
  const worker = await ready("import os, signal; print('{\"pid\":%s}' % os.getpid(), flush=True); signal.pause()")
  const fence = ContractFence.own({
    worker: worker.child,
    deadline: Date.now() - 1,
    signal: new AbortController().signal,
  })
  fence.runtime(ContractFence.identity(worker.value.pid))
  try {
    await expect(fence.wait(Promise.resolve("already completed"))).rejects.toThrow("deadline expired")
    const receipt = await fence.finish(path.join(directory.path, "FENCED.json"))
    expect(receipt.acknowledged).toBe(true)
    expect(receipt.reason).toBe("Native execution deadline expired")
  } finally {
    worker.child.kill("SIGKILL")
  }
}, 10000)

test("the original deadline bounds a stuck identity read without falsely acknowledging an unknown runtime", async () => {
  await using directory = await tmpdir("contract-fence-deadline-")
  const worker = await ready(
    "import os, signal; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('{\"pid\":%s}' % os.getpid(), flush=True); signal.pause()",
  )
  const deadline = Date.now() + 50
  const fence = ContractFence.own({ worker: worker.child, signal: new AbortController().signal, deadline })
  try {
    await expect(fence.wait(worker.child.stdout.getReader().read())).rejects.toThrow("deadline expired")
    const receipt = await fence.finish(path.join(directory.path, "FENCED.json"))
    expect(receipt.acknowledged).toBe(false)
    expect(receipt.wrapperExited).toBe(true)
    expect(receipt.runtimeExited).toBe(false)
    expect(receipt.deadline).toBe(deadline)
    expect(receipt.cleanupStarted).toBeGreaterThanOrEqual(deadline)
    expect(receipt.time).toBeLessThanOrEqual(deadline + 5400)
    expect(receipt.cleanupElapsed).toBeLessThan(5200)
    expect(await worker.child.exited).not.toBe(0)
    expect((await Bun.file(path.join(directory.path, "FENCED.json")).json()).acknowledged).toBe(false)
  } finally {
    worker.child.kill("SIGKILL")
  }
}, 10000)

test("a wrapper that exited before identity acquisition cannot acknowledge an unknown native process", async () => {
  await using directory = await tmpdir("contract-fence-fast-wrapper-")
  const worker = Bun.spawn(["/usr/bin/true"], { stdout: "ignore", stderr: "ignore" })
  expect(await worker.exited).toBe(0)
  const fence = ContractFence.own({ worker, deadline: Date.now() + 60000, signal: new AbortController().signal })
  const receipt = await fence.finish(path.join(directory.path, "FENCED.json"))
  expect(receipt.wrapperExited).toBe(true)
  expect(receipt.runtimeExited).toBe(false)
  expect(receipt.acknowledged).toBe(false)
  expect(receipt.cleanupElapsed).toBeLessThan(5200)
}, 10000)

test("a gateway acquired during cancellation is still owned and killed", async () => {
  await using directory = await tmpdir("contract-fence-race-")
  const worker = await ready(wrapper)
  const runtime = ContractFence.identity(worker.value.pid)
  const fence = ContractFence.own({
    worker: worker.child,
    signal: new AbortController().signal,
    deadline: Date.now() + 60000,
  })
  fence.runtime(runtime)
  fence.stop("cancel during setup")
  const gateway = await ready(
    "import os, signal; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('{\"pid\":%s}' % os.getpid(), flush=True); signal.pause()",
  )
  fence.gateway(gateway.child)
  try {
    const receipt = await fence.finish(path.join(directory.path, "FENCED.json"))
    expect(receipt.acknowledged).toBe(true)
    expect(receipt.reason).toBe("cancel during setup")
    expect(receipt.time).toBeLessThanOrEqual(receipt.cleanupDeadline + 200)
    await gateway.child.exited
    expect(gateway.child.signalCode).toBe("SIGKILL")
    expect(live(runtime)).toBe(false)
  } finally {
    worker.child.kill("SIGKILL")
    gateway.child.kill("SIGKILL")
    if (live(runtime)) process.kill(runtime.pid, "SIGKILL")
  }
}, 10000)
