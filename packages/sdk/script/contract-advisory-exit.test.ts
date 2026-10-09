import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ContractAdvisory } from "./contract-advisory"

for (const mode of ["prompt", "snapshot", "evidence-hang", "evidence-fail", "signal", "unsettled-evidence"] as const)
  test(`${mode}: subprocess enforces settlement deadline without awaiting exports or host.close`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "advisory-exit-"))
    const childRoot = path.join(root, "worker")
    await fs.mkdir(path.join(root, "bin"))
    await Bun.write(
      path.join(root, "bin/git"),
      `#!/bin/sh
case "$*" in
  *write-tree*)
    if [ -f "$ADVISORY_FIXTURE_ROOT/stall" ]; then
      printf '%s\\n' "$$" > "$ADVISORY_FIXTURE_ROOT/stalled-pid"
      exec /usr/bin/python3 -c 'import time; time.sleep(60)'
    fi
    ;;
esac
exec /usr/bin/git "$@"
`,
    )
    await fs.chmod(path.join(root, "bin/git"), 0o755)
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "contract-advisory-exit.fixture.ts"), mode, childRoot],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          OPENCODE_DB: path.join(root, "unused.sqlite"),
          ADVISORY_FIXTURE_ROOT: childRoot,
          PATH: path.join(root, "bin") + ":" + process.env.PATH,
        },
      },
    )
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
    const output = (async () => {
      let text = ""
      const reader = child.stdout.getReader()
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) return text
          text += new TextDecoder().decode(next.value)
          if (mode === "signal" && text.includes("READY")) child.kill("SIGTERM")
        }
      } finally {
        reader.releaseLock()
      }
    })()
    const error = new Response(child.stderr).text()
    try {
      const code = await child.exited
      await output
      const stderr = await error
      expect({
        code,
        stderr: code === (mode === "signal" ? 0 : ContractAdvisory.unsettledExitCode) ? "" : stderr,
      }).toEqual({
        code: mode === "signal" ? 0 : ContractAdvisory.unsettledExitCode,
        stderr: "",
      })
      if (mode === "signal") {
        expect(stderr).not.toContain("is unsettled")
        expect(await Bun.file(path.join(childRoot, "closing")).exists()).toBe(true)
        expect(await Bun.file(path.join(childRoot, "state/delivery.jsonl")).exists()).toBe(false)
        expect(await Bun.file(path.join(childRoot, "state/advisory.jsonl")).text()).toContain('"outcome":"aborted"')
        return
      }
      expect(stderr).toContain("is unsettled; exiting worker (86)")
      expect(await Bun.file(path.join(childRoot, "closing")).exists()).toBe(false)
      const journal = path.join(
        childRoot,
        "state",
        mode.startsWith("evidence-") ? "advisory-start.jsonl" : "advisory.jsonl",
      )
      const records = (await Bun.file(journal).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const start = records[0]
      expect(Date.now() - start.time).toBeLessThan(1200)
      if (mode === "snapshot") expect(await Bun.file(path.join(childRoot, "stalled-pid")).exists()).toBe(true)
      if (mode !== "snapshot") expect(await Bun.file(path.join(childRoot, "admitted")).exists()).toBe(true)
      if (mode === "unsettled-evidence") {
        expect(records).toHaveLength(2)
        expect(records[1]).toMatchObject({
          type: "ended",
          sequence: start.sequence,
          outcome: "unsettled",
          prompted: true,
        })
        expect(await Bun.file(path.join(childRoot, "state/advisory/1/prompt.txt")).text()).toContain("fixture progress")
        expect(await Bun.file(path.join(childRoot, "state/advisory/1/opinion.txt")).text()).toBe("")
        expect(await Bun.file(path.join(childRoot, "state/advisory/1/events.json")).json()).toEqual([])
      }
    } finally {
      clearTimeout(timer)
      child.kill("SIGKILL")
      await child.exited
      const stalled = Bun.file(path.join(childRoot, "stalled-pid"))
      if (await stalled.exists()) {
        try {
          process.kill(Number((await stalled.text()).trim()), "SIGKILL")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      }
      await output
      await error
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 20_000)
