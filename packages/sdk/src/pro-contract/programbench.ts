export * as ContractProgramBench from "./programbench"

import path from "node:path"
import { Schema } from "effect"

const File = Schema.Struct({ path: Schema.String, sha256: Schema.String })
export const Input = Schema.Struct({
  bridge: File,
  configuration: File,
  python: File,
  instance: Schema.String,
  total: Schema.Int,
  scoringTrust: Schema.Literal("official-programbench-normal-use"),
})
export type Input = typeof Input.Type

export async function checked(input: Input) {
  for (const file of [input.bridge, input.configuration, input.python]) {
    if (!path.isAbsolute(file.path) || Bun.SHA256.hash(await Bun.file(file.path).bytes(), "hex") !== file.sha256)
      throw new Error("Frozen ProgramBench bridge/configuration/interpreter changed")
  }
  const config = Schema.decodeUnknownSync(Schema.Struct({ instance: Schema.String, image: Schema.String }))(
    await Bun.file(input.configuration.path).json(),
  )
  if (config.instance !== input.instance || input.total <= 0) throw new Error("ProgramBench instance identity differs")
  return config
}

/** Only the host calls the qualified bridge. No Docker socket or private scorer
 * input is ever mounted into the native solver. The bridge owns its containers. */
export async function grade(input: {
  root: string
  workspace: string
  deadline: number
  signal: AbortSignal
  verifier: Input
}) {
  await checked(input.verifier)
  input.signal.throwIfAborted()
  if (Date.now() >= input.deadline) throw new Error("Original deadline reached before official grading")
  const output = path.join(input.root, "official")
  const child = Bun.spawn(
    [
      input.verifier.python.path,
      "-I",
      "-B",
      input.verifier.bridge.path,
      "--config",
      input.verifier.configuration.path,
      "--workspace",
      input.workspace,
      "--output",
      output,
      "--deadline",
      String(input.deadline),
      "--owner",
      String(process.pid),
    ],
    {
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", PYTHONDONTWRITEBYTECODE: "1" },
      stdin: "ignore",
      stdout: Bun.file(path.join(input.root, "bridge.stdout")),
      stderr: Bun.file(path.join(input.root, "bridge.stderr")),
    },
  )
  const cancel = () => child.kill("SIGTERM")
  input.signal.addEventListener("abort", cancel, { once: true })
  const timer = setTimeout(cancel, Math.max(1, input.deadline - Date.now()))
  if (input.signal.aborted) cancel()
  try {
    const code = await child.exited
    const fence = Schema.decodeUnknownSync(Schema.Struct({ acknowledged: Schema.Boolean }))(
      await Bun.file(path.join(output, "FENCE.json")).json(),
    )
    const score = Schema.decodeUnknownSync(
      Schema.Struct({
        passed: Schema.NullOr(Schema.Int),
        total: Schema.NullOr(Schema.Int),
        valid: Schema.Boolean,
        instance: Schema.String,
        deadline: Schema.Number,
        configHash: Schema.String,
        cleanupAcknowledged: Schema.Boolean,
        executedTests: Schema.optional(Schema.Int),
      }),
    )(await Bun.file(path.join(output, "RESULT.json")).json())
    // Cleanup is checked before cancellation so an abort cannot hide orphaned grading.
    if (!fence.acknowledged || !score.cleanupAcknowledged)
      throw new Error(`Official grader cleanup is unacknowledged: ${output}`)
    await Bun.write(
      path.join(input.root, "FENCED.json"),
      JSON.stringify({ acknowledged: true, exitCode: code, deadline: input.deadline, source: output }),
    )
    if (
      code !== 0 ||
      !score.valid ||
      score.instance !== input.verifier.instance ||
      score.deadline !== input.deadline ||
      score.configHash !== input.verifier.configuration.sha256 ||
      score.total !== input.verifier.total ||
      score.passed === null ||
      score.passed < 0 ||
      score.passed > score.total ||
      score.executedTests === undefined
    )
      throw new Error(`Unavailable or mismatched official evidence: ${output}`)
    input.signal.throwIfAborted()
    if (Date.now() >= input.deadline) throw new Error("Official evidence arrived after the original deadline")
    const result: { passed: number; total: number; valid: boolean; feedback?: string } = {
      passed: score.passed,
      total: score.total,
      valid: true,
    }
    await Bun.write(path.join(input.root, "stdout.json"), JSON.stringify(result))
    return { result, root: input.root }
  } finally {
    clearTimeout(timer)
    input.signal.removeEventListener("abort", cancel)
    // SIGTERM requests the bridge's own group/container fence, never just killing
    // a Python parent and pretending that Docker work has ended.
    if (child.exitCode === null && child.signalCode === null) cancel()
    await child.exited
  }
}
