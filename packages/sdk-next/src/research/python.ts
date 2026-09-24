export * as ResearchPython from "./python"

import { Option, Schema } from "effect"
import type { ResearchModel } from "./model"

// Only the trusted Node controller emits this JSON. Python logs use stderr.
// Script checks are finite evidence, not proof against a malicious imported module.
export const runnerSource = String.raw`import { spawn } from "node:child_process"
import { realpathSync, mkdtempSync, mkdirSync, openSync, closeSync, rmSync, readFileSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
const config = JSON.parse(process.argv[2])
const root = realpathSync(process.cwd())
const scratch = mkdtempSync(path.join(path.dirname(root), "python-scratch-"))
const cases = []
const bootstrap = "import os, sys, runpy, traceback\nos.write(3, b'started\\n')\nsys.path.insert(0, os.getcwd())\ntry:\n runpy.run_path(sys.argv[1], run_name='__main__')\nexcept BaseException:\n traceback.print_exc()\n os.write(3, b'failed\\n')\n sys.exit(1)\nos.write(3, b'passed\\n')\n"
const binaries = [config.python, config.isolation]
try {
  for (const binary of binaries) {
    if (createHash("sha256").update(readFileSync(binary.executable)).digest("hex") !== binary.executableHash)
      throw new Error("Pinned Python or isolation executable changed; algorithm edits cannot repair this")
  }
  const outputs = config.outputs.map(file => {
    const target = path.resolve(root, file)
    if (!target.startsWith(root + path.sep)) throw new Error("Output escapes candidate")
    mkdirSync(path.dirname(target), { recursive: true })
    if (!realpathSync(path.dirname(target)).startsWith(root + path.sep) && realpathSync(path.dirname(target)) !== root)
      throw new Error("Output parent escapes candidate")
    closeSync(openSync(target, "wx", 0o600))
    return { path: target, time: statSync(target, { bigint: true }).mtimeNs }
  })
  for (const [index, file] of config.tests.entries()) {
    const result = await new Promise(resolve => {
      const child = spawn(config.isolation.executable, [
        "--supervise", "--tree",
        ...["/usr", "/lib", "/lib64", "/dev/null", "/dev/urandom", "/proc/self/maps", root].flatMap(p => ["--read", p]),
        ...["/dev/null", scratch, ...outputs.map(item => item.path)].flatMap(p => ["--write", p]),
        "--", config.python.executable, "-I", "-B", "-u", "-c", bootstrap, file,
      ], {
        cwd: root, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: scratch, TMPDIR: scratch,
          OMP_NUM_THREADS: "1", MKL_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", CUDA_VISIBLE_DEVICES: "" },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      })
      // The supervisor stays in the executor group and cleans its child group.
      child.stdout.pipe(process.stderr, { end: false })
      child.stderr.pipe(process.stderr, { end: false })
      const observed = { status: "", error: undefined }
      child.stdio[3].on("data", data => { observed.status += data; if (observed.status.length > 128) child.kill("SIGTERM") })
      child.on("error", failure => { observed.error = String(failure) })
      child.on("close", (exit, signal) => resolve({ exit, signal, ...observed }))
    })
    const started = result.status.startsWith("started\n")
    const completed = (result.status === "started\npassed\n" && result.exit === 0) || (result.status === "started\nfailed\n" && result.exit === 1)
    cases.push({ name: config.expectedTests[index], path: file,
      state: !started ? "not_started" : completed && result.signal === null ? "completed" : "interrupted",
      passed: result.exit === 0 && result.status === "started\npassed\n",
      exit: result.exit, signal: result.signal, error: result.error })
    if (!started || !completed) break
  }
  for (const item of outputs) {
    if (statSync(item.path, { bigint: true }).mtimeNs === item.time) rmSync(item.path)
  }
} catch (error) {
  cases.push({ name: config.expectedTests[cases.length], path: config.tests[cases.length],
    state: "not_started", passed: false, error: String(error), exit: null, signal: null })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(JSON.stringify({ version: "python-script:1", cases }))
process.exitCode = cases.length === config.tests.length && cases.every(item => item.passed) ? 0 : 1
`

const Output = Schema.Struct({
  version: Schema.Literal("python-script:1"),
  cases: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
      state: Schema.Literals(["not_started", "completed", "interrupted"]),
      passed: Schema.Boolean,
      exit: Schema.NullOr(Schema.Int),
      signal: Schema.NullOr(Schema.String),
      error: Schema.optional(Schema.String),
    }),
  ),
})

export function parsePython(
  text: string,
  protocol: Pick<ResearchModel.Manifest["verification"], "tests" | "expectedTests">,
) {
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text).pipe(
    Option.flatMap(Schema.decodeUnknownOption(Output)),
  )
  if (Option.isNone(decoded))
    return {
      verdict: "unavailable" as const,
      reason:
        "Python controller output missing or incomplete; startup/completion is unknown. Inspect retained logs; this is not a failed algorithm test.",
      tests: [],
    }
  const rows = decoded.value.cases
  const tests = rows.map((item) => ({ name: item.name, passed: item.passed, skipped: false, todo: false }))
  if (
    rows.length > protocol.tests.length ||
    rows.some((item, index) => item.path !== protocol.tests[index] || item.name !== protocol.expectedTests[index])
  )
    return {
      verdict: "unavailable" as const,
      reason: "Python check identity does not match the frozen manifest",
      tests,
    }
  const unavailable = rows.find((item) => item.state !== "completed")
  if (unavailable)
    return {
      verdict: "unavailable" as const,
      reason:
        unavailable.state === "not_started"
          ? "Python did not start the protected check. Inspect the interpreter/isolation startup logs; algorithm edits cannot repair a host startup or permission configuration failure."
          : "Python execution was interrupted or ended without a completion record; no test success is established. Inspect retained logs and interruption state.",
      tests,
    }
  if (
    rows.length !== protocol.tests.length ||
    rows.some((item) => item.signal !== null || item.passed !== (item.exit === 0))
  )
    return { verdict: "unavailable" as const, reason: "Python check results are incomplete or inconsistent", tests }
  return rows.every((item) => item.passed)
    ? {
        verdict: "passed" as const,
        reason:
          "The protected Python scripts ran and completed successfully; scientific correctness still requires independent assessment",
        tests,
      }
    : {
        verdict: "failed" as const,
        reason: "Python started and the protected checks failed; inspect the retained traceback and test output",
        tests,
      }
}
