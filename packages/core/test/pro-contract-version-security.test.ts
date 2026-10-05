import { describe, expect, test } from "bun:test"
import { chmod, link, mkdir, readdir, readFile, symlink } from "node:fs/promises"
import path from "node:path"
import { ProContractVersion } from "@opencode-ai/core/pro-contract/version"
import { tmpdir } from "./fixture/tmpdir"

describe.skipIf(process.platform !== "linux" || process.arch !== "x64" || !Bun.which("bwrap"))(
  "ProContract executable version isolation",
  () => {
    test("isolates credentials, responsibility storage, evaluator files, and candidate source", async () => {
      await using temporary = await tmpdir()
      const secrets = ["contract.sqlite", "credentials.json", "confirmation.json"].map((name) =>
        path.join(temporary.path, name),
      )
      await Promise.all(secrets.map((filename) => Bun.write(filename, "protected host material")))
      const fixture = await prepare(
        temporary.path,
        `
          import { readFileSync, writeFileSync } from "node:fs"
          const readable = ${JSON.stringify(secrets)}.map((filename) => {
            try { readFileSync(filename); return true } catch { return false }
          })
          const sourceWritable = (() => {
            try { writeFileSync("/version/main.ts", "replacement"); return true } catch { return false }
          })()
          writeFileSync("/workspace/result.txt", "candidate result")
          console.log(JSON.stringify({
            version: 1,
            observations: [{ readable, sourceWritable, database: process.env.OPENCODE_DB ?? null,
              providerConfig: process.env.OPENCODE_MODELS_PATH ?? null }],
            requests: [{ type: "accept", contractID: "untrusted", evidenceHash: "self-approval" }],
            artifacts: ["result.txt"],
          }))
        `,
      )
      await Bun.write(path.join(fixture.workspace, "result.txt"), "original workspace")

      const record = await fixture.runner.run(fixture.input)

      expect(record.status).toBe("completed")
      expect(record.result?.observations).toEqual([
        { readable: [false, false, false], sourceWritable: false, database: null, providerConfig: null },
      ])
      expect(record.result?.requests).toEqual([
        { type: "accept", contractID: "untrusted", evidenceHash: "self-approval" },
      ])
      expect(await Bun.file(path.join(fixture.workspace, "result.txt")).text()).toBe("original workspace")
      expect(await Bun.file(path.join(await fixture.runner.artifactDirectory(record.id), "result.txt")).text()).toBe(
        "candidate result",
      )
      expect(await Promise.all(secrets.map((filename) => Bun.file(filename).text()))).toEqual([
        "protected host material",
        "protected host material",
        "protected host material",
      ])
    })

    test("fails closed without the sandbox instead of running candidate code on the host", async () => {
      await using temporary = await tmpdir()
      const fixture = await prepare(
        temporary.path,
        `console.log(JSON.stringify({version: 1, observations: ["executed"], requests: [], artifacts: []}))`,
        path.join(temporary.path, "missing-bwrap"),
      )

      const record = await fixture.runner.run(fixture.input)

      expect(record.status).toBe("failed")
      expect(record.result).toBeUndefined()
      expect(record.error).toBeDefined()
      expect(record.stdout).toBe("")
      expect(await fixture.runner.read(record.id)).toEqual(record)
    })

    test("rejects symlink artifacts and preserves the failed execution output", async () => {
      await using temporary = await tmpdir()
      const fixture = await prepare(
        temporary.path,
        `
          import { symlinkSync } from "node:fs"
          symlinkSync("/version/main.ts", "/workspace/leak.ts")
          console.log(JSON.stringify({version: 1, observations: [], requests: [], artifacts: ["leak.ts"]}))
        `,
      )

      const record = await fixture.runner.run(fixture.input)

      expect(record.status).toBe("failed")
      expect(record.error).toContain("symbolic")
      expect(record.stdout).toContain("leak.ts")
      expect(record.exitCode).toBe(0)
      expect(record.artifacts).toEqual([])
      expect(await fixture.runner.read(record.id)).toEqual(record)
    })

    test("rejects absolute and parent-relative artifact paths", async () => {
      await using temporary = await tmpdir()
      const fixture = await prepare(
        temporary.path,
        `
          const request = await Bun.stdin.json()
          console.log(JSON.stringify({version: 1, observations: [], requests: [], artifacts: [request.task.path]}))
        `,
      )

      for (const filename of ["../request.json", "/version/main.ts"]) {
        const record = await fixture.runner.run({ ...fixture.input, task: { path: filename } })
        expect(record.status).toBe("failed")
        expect(record.error).toContain("package-relative")
        expect(record.artifacts).toEqual([])
      }
    })

    test("cannot connect to a host loopback evaluator", async () => {
      await using temporary = await tmpdir()
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("hidden evaluator"),
      })
      try {
        const fixture = await prepare(
          temporary.path,
          `
            const connected = await fetch("http://127.0.0.1:${server.port}", { signal: AbortSignal.timeout(500) })
              .then(() => true, () => false)
            console.log(JSON.stringify({version: 1, observations: [{connected}], requests: [], artifacts: []}))
          `,
        )

        const record = await fixture.runner.run(fixture.input)

        expect(record.status).toBe("completed")
        expect(record.result?.observations).toEqual([{ connected: false }])
      } finally {
        await server.stop(true)
      }
    })

    test("successful main exit terminates detached descendants before archiving", async () => {
      await using temporary = await tmpdir()
      const marker = `contract-version-descendant-${crypto.randomUUID()}`
      const fixture = await prepare(
        temporary.path,
        `
          import { writeFileSync } from "node:fs"
          const worker = Bun.spawn(["/runtime/bun", "-e", ${JSON.stringify(
            `const fs = require("node:fs"); const marker = ${JSON.stringify(marker)}; console.log("ready"); setInterval(() => fs.writeFileSync("/workspace/heartbeat.txt", marker), 10)`,
          )}], { detached: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
          const reader = worker.stdout.getReader()
          await reader.read()
          const marker = crypto.randomUUID()
          writeFileSync("/workspace/result.txt", marker)
          console.log(JSON.stringify({version: 1, observations: [{marker}], requests: [], artifacts: ["result.txt"]}))
          process.exit(0)
        `,
      )

      const record = await fixture.runner.run(fixture.input)

      expect(record.status).toBe("completed")
      expect(record.artifacts.map((file) => file.path)).toEqual(["result.txt"])
      expect(await readdir(path.join(fixture.state, "runs", record.id))).not.toContain("workspace")
      expect(await fixture.runner.artifactDirectory(record.id)).toBeDefined()
      const survivors = await sandboxProcesses(marker)
      // Leave no runaway worker behind if a future change breaks namespace cleanup.
      survivors.forEach((entry) => {
        try {
          process.kill(entry.pid, "SIGKILL")
        } catch {
          // The process can finish between the /proc scan and cleanup.
        }
      })
      expect(survivors).toEqual([])
    })

    test("rejects linked source and workspace files rather than exposing shared host inodes", async () => {
      await using temporary = await tmpdir()
      const fixture = await prepare(
        temporary.path,
        `console.log(JSON.stringify({version: 1, observations: [], requests: [], artifacts: []}))`,
      )
      const protectedFile = path.join(temporary.path, "protected.txt")
      await Bun.write(protectedFile, "protected host material")
      await link(protectedFile, path.join(fixture.workspace, "hardlink.txt"))

      const record = await fixture.runner.run(fixture.input)

      expect(record.status).toBe("failed")
      expect(record.error).toContain("unlinked")
      expect(await Bun.file(protectedFile).text()).toBe("protected host material")
      await symlink(protectedFile, path.join(fixture.source, "symlink.txt"))
      await expect(fixture.runner.freeze({ directory: fixture.source, entrypoint: "main.ts" })).rejects.toThrow(
        "symbolic",
      )
    })

    test("binds empty directory semantics into frozen executable identity", async () => {
      await using temporary = await tmpdir()
      const fixture = await prepare(
        temporary.path,
        `
          import { existsSync } from "node:fs"
          console.log(JSON.stringify({version: 1, observations: [{ feature: existsSync("/version/feature") }],
            requests: [], artifacts: []}))
        `,
      )
      await mkdir(path.join(fixture.source, "feature"))

      const updated = await fixture.runner.freeze({ directory: fixture.source, entrypoint: "main.ts" })

      expect(updated.versionHash).not.toBe(fixture.input.versionHash)
      const record = await fixture.runner.run({ ...fixture.input, versionHash: updated.versionHash })
      expect(record.result?.observations).toEqual([{ feature: true }])
      await mkdir(path.join(fixture.state, "versions", updated.versionHash, "source", "tampered"))
      await expect(fixture.runner.inspect(updated.versionHash)).rejects.toThrow("changed")
    })

    test("archives nested selected files with their directory identities", async () => {
      await using temporary = await tmpdir()
      const fixture = await prepare(
        temporary.path,
        `
          import { mkdirSync, writeFileSync } from "node:fs"
          mkdirSync("/workspace/nested")
          writeFileSync("/workspace/nested/result.txt", "retained")
          writeFileSync("/workspace/nested/private.txt", "not selected")
          console.log(JSON.stringify({version: 1, observations: [], requests: [], artifacts: ["nested/result.txt"]}))
        `,
      )

      const record = await fixture.runner.run(fixture.input)

      expect(record.status).toBe("completed")
      const archived = await fixture.runner.artifactDirectory(record.id)
      expect(await Bun.file(path.join(archived, "nested", "result.txt")).text()).toBe("retained")
      expect(await Bun.file(path.join(archived, "nested", "private.txt")).exists()).toBe(false)
    })

    test("rejects an intermediate symlink even when its target stays inside the workspace", async () => {
      await using temporary = await tmpdir()
      const fixture = await prepare(
        temporary.path,
        `
          import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
          mkdirSync("/workspace/actual")
          writeFileSync("/workspace/actual/result.txt", "retained")
          symlinkSync("actual", "/workspace/alias")
          console.log(JSON.stringify({version: 1, observations: [], requests: [], artifacts: ["alias/result.txt"]}))
        `,
      )

      const record = await fixture.runner.run(fixture.input)

      expect(record.status).toBe("failed")
      expect(record.error).toContain("symbolic")
    })

    test("separates the running research executor from its inspected read-only target version", async () => {
      await using temporary = await tmpdir()
      const fixture = await prepare(
        temporary.path,
        `
          import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
          // This research executor is distinct from the solver source it edits.
          if (!existsSync("/target")) {
            console.log(JSON.stringify({version: 1, observations: [{targetAbsent: true}], requests: [], artifacts: []}))
            process.exit(0)
          }
          const original = readFileSync("/target/workflow.ts", "utf8")
          const writable = (() => {
            try { writeFileSync("/target/workflow.ts", "unauthorized replacement"); return true } catch { return false }
          })()
          mkdirSync("/workspace/candidate")
          writeFileSync("/workspace/candidate/workflow.ts", original.replace("parent-v0", "candidate-v1"))
          console.log(JSON.stringify({version: 1, observations: [{original, writable}], requests: [], artifacts: ["candidate"]}))
        `,
      )
      const target = path.join(temporary.path, "target-source")
      const original =
        'console.log(JSON.stringify({version: 1, observations: ["parent-v0"], requests: [], artifacts: []}))\n'
      await mkdir(target)
      await Bun.write(path.join(target, "workflow.ts"), original)
      const parent = await fixture.runner.freeze({ directory: target, entrypoint: "workflow.ts" })

      const record = await fixture.runner.run({ ...fixture.input, targetVersion: parent.versionHash })

      expect(fixture.input.versionHash).not.toBe(parent.versionHash)
      expect(record.status).toBe("completed")
      expect(record.versionHash).toBe(fixture.input.versionHash)
      expect(record.targetVersion).toBe(parent.versionHash)
      expect(record.result?.observations).toEqual([{ original, writable: false }])
      const artifacts = await fixture.runner.artifactDirectory(record.id)
      expect(await Bun.file(path.join(artifacts, "candidate", "workflow.ts")).text()).toBe(
        original.replace("parent-v0", "candidate-v1"),
      )
      const candidate = await fixture.runner.freeze({
        directory: path.join(artifacts, "candidate"),
        entrypoint: "workflow.ts",
      })
      expect(candidate.versionHash).not.toBe(parent.versionHash)
      expect(await fixture.runner.candidate(record.id, candidate.versionHash)).toBe(path.join(artifacts, "candidate"))
      expect(await fixture.runner.inspect(parent.versionHash)).toEqual(parent.manifest)
      expect(await Bun.file(path.join(target, "workflow.ts")).text()).toBe(original)

      const unbound = await fixture.runner.run(fixture.input)
      expect(unbound.status).toBe("completed")
      expect(unbound.result?.observations).toEqual([{ targetAbsent: true }])

      const manifest = path.join(fixture.state, "versions", parent.versionHash, "manifest.json")
      await chmod(manifest, 0o600)
      await Bun.write(manifest, JSON.stringify({ ...parent.manifest, config: { tampered: true } }))
      const rejected = await fixture.runner.run({ ...fixture.input, targetVersion: parent.versionHash })
      expect(rejected.status).toBe("failed")
      expect(rejected.error).toContain("manifest changed")
      expect(rejected.stdout).toBe("")
      expect(rejected.artifacts).toEqual([])
    })

    test("early cancellation joins promptly without orphaning namespace init or detached descendants", async () => {
      await using temporary = await tmpdir()
      const fixture = await prepare(
        temporary.path,
        `
          import { writeFileSync } from "node:fs"
          const input = await Bun.stdin.json()
          if (input.task.started) {
            const code = 'const marker = ' + JSON.stringify(input.task.marker)
              + '; console.log("ready"); setInterval(() => {}, 1000)'
            const worker = Bun.spawn(["/runtime/bun", "-e", code], {
              detached: true, stdin: "ignore", stdout: "pipe", stderr: "ignore",
            })
            await worker.stdout.getReader().read()
            writeFileSync("/workspace/started", "detached worker ready")
          }
          await Bun.sleep(30_000)
          console.log(JSON.stringify({version: 1, observations: [], requests: [], artifacts: []}))
        `,
      )

      for (const delay of [0, 1, 3, 5, 8, 0, 1, 3, 5, 8, 3, 5, null]) {
        const id = crypto.randomUUID()
        const marker = `sandbox-cancellation-child-${id}`
        const controller = new AbortController()
        const location = path.join(fixture.state, "runs", id)
        const running = fixture.runner.run({
          ...fixture.input,
          id,
          task: { started: delay === null, marker },
          deadline: Date.now() + 5_000,
          signal: controller.signal,
        })
        const ready = await waitFor(() =>
          Bun.file(path.join(location, "input.json"))
            .json()
            .then(
              (input: unknown) =>
                input !== null && typeof input === "object" && "complete" in input && input.complete === true,
              () => false,
            ),
        )
        const started =
          delay === null ? await waitFor(() => Bun.file(path.join(location, "workspace", "started")).exists()) : true
        if (delay !== null) await Bun.sleep(delay)
        const cancelledAt = Date.now()
        controller.abort()
        const joined = await Promise.race([
          running.then((record) => ({ record, elapsed: Date.now() - cancelledAt })),
          Bun.sleep(1_500).then(() => undefined),
        ])
        const survivors = await sandboxProcesses(location, marker)
        // A regression must fail the assertion, not strand this test's namespace or its open stdout pipe.
        survivors.forEach((entry) => {
          try {
            process.kill(entry.pid, "SIGKILL")
          } catch {
            // Only these unique run identifiers are eligible for cleanup; an already-dead process is harmless.
          }
        })
        await running
        expect(ready).toBe(true)
        expect(started).toBe(true)
        expect(joined?.record.status).toBe("cancelled")
        expect(joined?.elapsed).toBeLessThan(1_500)
        expect(survivors).toEqual([])
      }
    }, 15_000)

    test("Host SIGKILL preserves verified input without replay and terminates startup or active sandboxes", async () => {
      await using temporary = await tmpdir()
      const fixture = await prepare(
        temporary.path,
        `
          import { writeFileSync } from "node:fs"
          const input = await Bun.stdin.json()
          const code = 'const marker = ' + JSON.stringify(input.task.marker)
            + '; console.log("ready"); setInterval(() => {}, 1000)'
          const worker = Bun.spawn(["/runtime/bun", "-e", code], {
            detached: true, stdin: "ignore", stdout: "pipe", stderr: "ignore",
          })
          await worker.stdout.getReader().read()
          writeFileSync("/workspace/started", "detached worker ready")
          await Bun.sleep(30_000)
          console.log(JSON.stringify({version: 1, observations: [], requests: [], artifacts: []}))
        `,
      )
      await Bun.write(path.join(fixture.workspace, "input.txt"), "retained before Host crash")

      for (const delay of [0, 4, 8, null]) {
        const id = crypto.randomUUID()
        const marker = `sandbox-host-death-child-${id}`
        const location = path.join(fixture.state, "runs", id)
        const host = Bun.spawn(
          [
            process.execPath,
            path.join(import.meta.dir, "fixture", "pro-contract-version-host.ts"),
            fixture.state,
            fixture.input.versionHash,
            fixture.workspace,
            id,
            marker,
          ],
          { cwd: temporary.path, env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        )
        try {
          const captured = await waitFor(() =>
            fixture.runner.input(id).then(
              (input) => input?.complete === true,
              () => false,
            ),
          )
          const started =
            delay === null ? await waitFor(() => Bun.file(path.join(location, "workspace", "started")).exists()) : true
          if (delay !== null) await Bun.sleep(delay)
          const killedAt = Date.now()
          host.kill("SIGKILL")
          await host.exited
          const gone = await waitFor(async () => (await sandboxProcesses(location, marker)).length === 0, 1_000)

          expect(captured).toBe(true)
          expect(started).toBe(true)
          expect(gone).toBe(true)
          expect(Date.now() - killedAt).toBeLessThan(1_500)
          expect((await fixture.runner.input(id))?.complete).toBe(true)
          expect(await Bun.file(path.join(await fixture.runner.inputDirectory(id), "input.txt")).text()).toBe(
            "retained before Host crash",
          )
          expect(await fixture.runner.request(id)).toMatchObject({ versionHash: fixture.input.versionHash })
          await expect(fixture.runner.read(id)).rejects.toThrow("incomplete")
          expect(await Bun.file(path.join(location, "result.json")).exists()).toBe(false)
        } finally {
          if (host.exitCode === null) host.kill("SIGKILL")
          await host.exited
          const survivors = await sandboxProcesses(location, marker)
          survivors.forEach((entry) => {
            try {
              process.kill(entry.pid, "SIGKILL")
            } catch {
              // Cleanup remains restricted to this test's unique Host/run/descendant identifiers.
            }
          })
        }
      }
    }, 15_000)
  },
)

async function sandboxProcesses(...markers: string[]) {
  return (
    await Promise.all(
      (await readdir("/proc"))
        .filter((name) => /^\d+$/.test(name))
        .map(async (name) => ({
          pid: Number(name),
          command: await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => ""),
        })),
    )
  ).filter((entry) => markers.some((marker) => entry.command.includes(marker)))
}

async function waitFor(probe: () => Promise<boolean>, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await probe()) return true
    await Bun.sleep(1)
  }
  return false
}

async function prepare(directory: string, code: string, sandbox?: string) {
  const source = path.join(directory, "source")
  const workspace = path.join(directory, "workspace")
  const state = path.join(directory, "host")
  await Promise.all([mkdir(source), mkdir(workspace)])
  await Bun.write(path.join(source, "main.ts"), code)
  const runner = ProContractVersion.make({ directory: state, sandbox })
  const frozen = await runner.freeze({ directory: source, entrypoint: "main.ts" })
  return {
    runner,
    source,
    workspace,
    state,
    input: { versionHash: frozen.versionHash, task: {}, view: {}, workspace, deadline: Date.now() + 10_000 },
  }
}
