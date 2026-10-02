import { afterEach, describe, expect, test } from "bun:test"
import { link, mkdtemp, mkdir, rm, symlink, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Artifacts, evaluationWorkers, supervise } from "./ota-supervisor.js"
import { configure } from "./ota-fixture.js"
import { hash, OTA, subject } from "./ota-rsi.js"
import { Sandbox } from "./ota-sandbox.js"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function directory() {
  const result = await mkdtemp(path.join(os.tmpdir(), "ota-supervisor-"))
  temporary.push(result)
  return result
}

describe("OTA artifact boundary", () => {
  test("paired evaluation workers enforce concurrency and drain before returning", async () => {
    const observed = { running: 0, peak: 0, finished: 0 }
    await evaluationWorkers([0, 1, 2, 3, 4, 5], 3, async () => {
      observed.running += 1
      observed.peak = Math.max(observed.peak, observed.running)
      const child = Bun.spawn(["python3", "-I", "-c", "import time;time.sleep(.1)"], {
        stdout: "ignore",
        stderr: "ignore",
      })
      expect(await child.exited).toBe(0)
      observed.running -= 1
      observed.finished += 1
    })
    expect(observed).toEqual({ running: 0, peak: 3, finished: 6 })
  })

  test("a failed evaluation aborts peers, drains them and admits no later work", async () => {
    const seen: number[] = []
    const completed: number[] = []
    await expect(
      evaluationWorkers([0, 1, 2, 3, 4], 2, async (value, signal) => {
        seen.push(value)
        if (value === 0) {
          await Bun.sleep(20)
          throw new Error("missing evidence")
        }
        while (!signal.aborted) await Bun.sleep(5)
        completed.push(value)
      }),
    ).rejects.toThrow("missing evidence")
    expect(seen).toEqual([0, 1])
    expect(completed).toEqual([1])
  })

  test("a later worker's original fault survives earlier workers' cancellation", async () => {
    const original = new Error("cleanroom reference is execute-only")
    const seen: number[] = []
    const drained: number[] = []
    await expect(
      evaluationWorkers([0, 1, 2, 3], 3, async (value, signal) => {
        seen.push(value)
        if (value === 2) {
          await Bun.sleep(20)
          throw original
        }
        while (!signal.aborted) await Bun.sleep(5)
        expect(signal.reason).toBe(original)
        await Bun.sleep(10)
        drained.push(value)
        throw new Error("evaluation cancelled")
      }),
    ).rejects.toBe(original)
    expect(seen).toEqual([0, 1, 2])
    expect(drained.sort()).toEqual([0, 1])
  })

  test("a synchronous evaluator fault aborts peers and is retained", async () => {
    const original = new Error("synchronous preparation failure")
    const drained: number[] = []
    await expect(
      evaluationWorkers([0, 1, 2], 2, (value, signal) => {
        if (value === 1) throw original
        return (async () => {
          while (!signal.aborted) await Bun.sleep(5)
          drained.push(value)
          throw new Error("evaluation cancelled")
        })()
      }),
    ).rejects.toBe(original)
    expect(drained).toEqual([0])
  })
  test("only one bounded regular inactive artifact can be imported", async () => {
    const root = await directory()
    const store = new Artifacts(path.join(root, "objects"))
    const output = path.join(root, "stage")
    await mkdir(output)
    await Bun.write(path.join(output, "h"), "new harness")
    const digest = await store.candidate(output, "h")
    expect(await Bun.file(await store.get(digest)).text()).toBe("new harness")
    await expect(store.candidate(output, "s")).rejects.toThrow("inactive")
    await Bun.write(path.join(output, "s"), "forbidden strategy")
    await expect(store.candidate(output, "h")).rejects.toThrow("inactive")
  })

  test.each(["symlink", "hardlink", "directory"])("rejects %s artifacts", async (kind) => {
    const root = await directory()
    const store = new Artifacts(path.join(root, "objects"))
    const output = path.join(root, "stage")
    await mkdir(output)
    await Bun.write(path.join(root, "secret"), "authority")
    if (kind === "symlink") await symlink(path.join(root, "secret"), path.join(output, "h"))
    if (kind === "hardlink") await link(path.join(root, "secret"), path.join(output, "h"))
    if (kind === "directory") await mkdir(path.join(output, "h"))
    await expect(store.candidate(output, "h")).rejects.toThrow()
  })

  test("rehashes qualified objects before use", async () => {
    const root = await directory()
    const store = new Artifacts(path.join(root, "objects"))
    const digest = await store.put(new TextEncoder().encode("qualified"))
    const file = await store.get(digest)
    await chmod(file, 0o600)
    await Bun.write(file, "tampered")
    await expect(store.get(digest)).rejects.toThrow("changed")
  })
})

describe.skipIf(!process.env.OPENCODE_OTA_IMAGE)("OTA real isolated processes (no model)", () => {
  test.each(["healthy", "hang"])(
    "operator readmission cold-boots or rolls back the selected pair (%s)",
    async (mode) => {
      const root = await directory()
      const config = await configure(root, mode)
      const artifacts = new Artifacts(path.join(root, "objects"))
      const seed = { s: await artifacts.put(config.seed.s), h: await artifacts.put(config.seed.h) }
      const pair = {
        ...seed,
        h: await artifacts.put(
          new TextEncoder().encode(new TextDecoder().decode(config.seed.h).replace("VERSION = 0", "VERSION = 1")),
        ),
      }
      const ota = new OTA(path.join(root, "ota.sqlite"), config.protocol, seed)
      const rows = config.protocol.tests.map((test) => ({
        id: test.id,
        total: test.total,
        passed: test.total,
        valid: true,
      }))
      const readmission = {
        manifest: hash("operator revision with archived observations; not a model improvement claim"),
        checkpoint: hash("sealed fixture memory"),
        pair,
        evidence: {
          protocol: hash("old protocol; never overwritten"),
          subject: subject(pair),
          job: "old-completed-job",
          rows,
          baseline: { subject: subject(seed), rows },
          receipt: hash("archived fixture receipt"),
        },
      }
      const waiting = { done: false }
      const cancel = (async () => {
        while (!waiting.done) {
          if (ota.read().epoch >= 3) {
            await Bun.write(path.join(root, "CANCEL"), "readmission qualification completed")
            return
          }
          await Bun.sleep(50)
        }
      })()
      try {
        const state = await supervise(root, ota, artifacts, config.driver, readmission)
        expect(state.epoch).toBe(3)
        expect(state.stopped).toBe("cancelled")
        expect(
          (await Bun.file(path.join(root, "receipts/operator-readmission.json")).json()).data.evidence.protocol,
        ).toBe(readmission.evidence.protocol)
        const event = ota.history().find((value) => (value as { type: string }).type === "qualification") as {
          details: { evidence: { protocol: string }; passed: boolean }
        }
        expect(event.details.passed).toBe(true)
        expect(event.details.evidence.protocol).toBe(ota.digest)
        expect(state.active.pair.h).toBe(mode === "healthy" ? pair.h : seed.h)
        expect(Object.keys(state.kernel.attestations)).toHaveLength(mode === "healthy" ? 2 : 1)
      } finally {
        waiting.done = true
        await cancel
        await config.driver.fence()
        ota.db.close()
      }
    },
    90_000,
  )

  test("restart fences an orphan before rolling back, preserving the admitted deadline", async () => {
    const root = await directory()
    const config = await configure(root, "healthy")
    const artifacts = new Artifacts(path.join(root, "objects"))
    const seed = { s: await artifacts.put(config.seed.s), h: await artifacts.put(config.seed.h) }
    const ota = new OTA(path.join(root, "ota.sqlite"), config.protocol, seed)
    const started = ota.begin(0, Date.now())
    const pair = { ...seed, h: await artifacts.put(new TextEncoder().encode("candidate fixture")) }
    const rows = config.protocol.tests.map((test) => ({ ...test, passed: test.total, valid: true }))
    ota.handedOff(started.revision, started.epoch, started.job!.id, Date.now())
    ota.settle(
      ota.read().revision,
      pair,
      {
        protocol: ota.digest,
        subject: subject(pair),
        job: started.job!.id,
        rows,
        baseline: { subject: subject(seed), rows },
        receipt: hash("fixture-state setup, not model evidence"),
      },
      Date.now(),
    )
    const admitted = ota.begin(ota.read().revision, Date.now())
    const sandbox = new Sandbox(root, process.env.OPENCODE_OTA_IMAGE!)
    const orphan = await sandbox.start({ files: {}, argv: ["/usr/bin/python3", "-c", "import time; time.sleep(60)"] })
    // Simulate a supervisor restart with an independently owned live container.
    await Bun.write(path.join(root, "CANCEL"), "stop immediately after recovery")
    try {
      const recovered = await supervise(root, ota, artifacts, config.driver)
      expect(recovered.active.pair).toEqual(seed)
      expect(recovered.epoch).toBe(3)
      expect(recovered.job!.deadline).toBe(admitted.job!.deadline)
      expect(recovered.stopped).toBe("cancelled")
      await expect(orphan.result).rejects.toThrow()
    } finally {
      await sandbox.fence()
      ota.db.close()
    }
  }, 30_000)

  test.each(["healthy", "hang"])(
    "%s: alternation or exact rollback with preserved accounting",
    async (mode) => {
      const root = await directory()
      const config = await configure(root, mode)
      const artifacts = new Artifacts(path.join(root, "objects"))
      const seed = { s: await artifacts.put(config.seed.s), h: await artifacts.put(config.seed.h) }
      const ota = new OTA(path.join(root, "ota.sqlite"), config.protocol, seed)
      const waiting = { done: false }
      const cancel = (async () => {
        while (!waiting.done) {
          if (ota.read().epoch >= 3) {
            await Bun.write(path.join(root, "CANCEL"), "explicit qualification cancellation")
            return
          }
          await Bun.sleep(50)
        }
      })()
      try {
        const state = await supervise(root, ota, artifacts, config.driver)
        expect(state.epoch).toBe(3)
        expect(state.stopped).toBe("cancelled")
        expect(state.active.slot).toBe("s")
        expect(Object.keys(state.kernel.attestations)).toHaveLength(mode === "healthy" ? 2 : 1)
        if (mode === "healthy") {
          expect(state.active.pair.s).not.toBe(seed.s)
          expect(state.active.pair.h).not.toBe(seed.h)
        }
        if (mode === "hang") {
          expect(state.active.pair).toEqual(seed)
          expect(Object.values(state.kernel.contracts)[0].status).toBe("escalated")
          expect(ota.history().some((event) => JSON.stringify(event).includes("progress heartbeat expired"))).toBe(true)
        }
      } finally {
        waiting.done = true
        await cancel
        await config.driver.fence()
        ota.db.close()
      }
    },
    90_000,
  )

  test("candidate cannot modify current pair, read control-plane secrets, or access host network/socket", async () => {
    const root = await directory()
    const sandbox = new Sandbox(root, process.env.OPENCODE_OTA_IMAGE!)
    const current = path.join(root, "s")
    await Bun.write(current, "active strategy")
    await Bun.write(path.join(root, "authority-secret"), "never mounted")
    const worker = await sandbox.start({
      files: { s: current },
      argv: [
        "/usr/bin/python3",
        "-c",
        `
import os, socket
try:
    open('/release/s', 'w').write('mutated')
    raise AssertionError('writable active partition')
except OSError:
    pass
assert not os.path.exists(${JSON.stringify(path.join(root, "authority-secret"))})
assert not os.path.exists('/var/run/docker.sock')
assert len(os.listdir('/sys/class/net')) == 1
assert os.listdir('/sys/class/net') == ['lo']
print('isolated')
`,
      ],
    })
    try {
      await worker.result
      expect((await Bun.file(worker.logfile).text()).trim()).toBe("isolated")
      expect(await Bun.file(current).text()).toBe("active strategy")
    } finally {
      await worker.stop()
      await sandbox.fence()
    }
  }, 30_000)
})
