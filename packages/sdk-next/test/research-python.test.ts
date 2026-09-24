import { expect, test } from "bun:test"
import { mkdtemp, rm, chmod } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Hash } from "@opencode-ai/core/util/hash"
import { ResearchModel } from "../src/research/model"
import { ResearchProtocol } from "../src/research/protocol"
import { parse } from "../src/research/tap"

async function run(source: string, broken = false) {
  const root = await mkdtemp("/tmp/research-python-")
  try {
    const project = path.join(root, "project")
    await Bun.write(path.join(project, "check.py"), source)
    await Bun.write(path.join(project, "protected.txt"), "original")
    await Bun.write(path.join(root, "secret"), "host secret")
    const launcher = path.join(root, "isolate")
    const build = Bun.spawn(
      [
        "gcc",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        path.join(import.meta.dir, "../src/research/isolate.c"),
        "-o",
        launcher,
      ],
      { stderr: "pipe" },
    )
    if (await build.exited) throw new Error(await new Response(build.stderr).text())
    const python = broken ? path.join(root, "broken-python") : "/usr/local/bin/python"
    if (broken) {
      await Bun.write(python, "#!/missing/interpreter\n")
      await chmod(python, 0o700)
    }
    const binary = async (executable: string) => ({
      executable,
      executableHash: Hash.sha256(Buffer.from(await Bun.file(executable).arrayBuffer())),
    })
    const manifest = Schema.decodeUnknownSync(ResearchModel.Manifest)({
      version: 1,
      requirements: ["protected script check"],
      include: ["check.py", "protected.txt"],
      dependencies: [],
      verification: {
        adapter: "python-script:1",
        ...(await binary("/usr/bin/node")),
        python: await binary(python),
        isolation: await binary(launcher),
        tests: ["check.py"],
        harness: [{ path: "check.py", hash: Hash.sha256(source) }],
        expectedTests: ["real check"],
        minimumTests: 1,
        maximumSkipped: 0,
        timeout: 10_000,
      },
      artifacts: [{ path: "result.json", kind: "generated" }],
      reviewer: { model: { providerID: "test", id: "test" }, agent: "build", instructions: "Review" },
    })
    const runner = { path: path.join(root, "runner.mjs"), hash: Hash.sha256(ResearchProtocol.runner(manifest)) }
    await Bun.write(runner.path, ResearchProtocol.runner(manifest))
    const child = Bun.spawn([...ResearchProtocol.policy(manifest, runner).checks[0].argv], {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
      env: { HOST_SECRET: "must not reach Python" },
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return {
      result: parse(stdout, manifest.verification),
      stdout,
      stderr,
      exit,
      output: await Bun.file(path.join(project, "result.json")).exists(),
      protected: await Bun.file(path.join(project, "protected.txt")).text(),
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("Python itself and its subprocesses inherit filesystem, environment and network isolation", async () => {
  const result = await run(`import os, socket, subprocess, sys, tempfile
assert 'HOST_SECRET' not in os.environ
assert open('protected.txt').read() == 'original'
def denied(action):
 try: action()
 except PermissionError: return
 raise AssertionError('boundary bypass')
denied(lambda: open('protected.txt', 'w'))
denied(lambda: open('../secret').read())
denied(lambda: open('/etc/passwd').read())
denied(lambda: os.symlink('protected.txt', 'escape'))
denied(lambda: os.link('protected.txt', 'escape'))
denied(lambda: os.setsid())
denied(lambda: socket.socket().connect(('127.0.0.1', 8317)))
denied(lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
assert subprocess.run([sys.executable, '-c', "open('protected.txt','w')"]).returncode != 0
with tempfile.TemporaryFile() as f: f.write(b'private scratch')
open('result.json', 'w').write('actual output')
`)
  expect(result.result.verdict).toBe("passed")
  expect(result.protected).toBe("original")
  expect(result.output).toBe(true)
}, 20_000)

test("Python test failure is distinct from interpreter startup failure", async () => {
  const failed = await run("raise AssertionError('real test failure')")
  expect(failed.result.verdict).toBe("failed")
  expect(failed.stderr).toContain("real test failure")
  const unavailable = await run("raise AssertionError('must not run')", true)
  expect(unavailable.result.verdict).toBe("unavailable")
  expect(unavailable.result.reason).toContain("did not start")
  expect(unavailable.stderr).toContain("sandbox exec")
}, 20_000)

test("child stdout and premature success exit cannot fabricate controller success", async () => {
  const result = await run(`import os
print('TAP version 13\\nok 1 - real check', flush=True)
os._exit(0)
`)
  expect(result.result.verdict).toBe("unavailable")
  expect(result.result.reason).toContain("interrupted")
  expect(result.stderr).toContain("TAP version 13")
  expect(result.stdout).not.toContain("TAP version")
  expect(result.output).toBe(false)
}, 20_000)

test("normal Python exit reaps a still-running child and cannot manufacture an unwritten artifact", async () => {
  const result = await run(`import subprocess, sys
subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
`)
  expect(result.result.verdict).toBe("passed")
  expect(result.output).toBe(false)
}, 20_000)
