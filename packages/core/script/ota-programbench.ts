// Independent official scorer. This module is pinned outside both S and H.
import { mkdir, readdir, writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import { checked, reference, run } from "./ota-native"
import type { FileRef } from "./ota-native"
import type { Driver } from "./ota-supervisor"

export async function evaluate(input: Parameters<Driver["evaluate"]>[0] & { root: string }) {
  const config = (await Bun.file(process.env.OPENCODE_OTA_PROFILE!).json()) as {
    provider: { upstream: string; keyEnvironment?: string }
    programbench: {
      runner: string
      commit: string
      python: string
      bridge: FileRef
      configuration: FileRef
      metadata: FileRef
      evaluator: unknown
      assignments: Record<string, { instance: string; seed: number }>
      safety: Record<string, FileRef>
    }
  }
  const plan = config.programbench
  if (plan.safety[input.test.id]) {
    const file = await checked(plan.safety[input.test.id])
    const evidence = (await Bun.file(file).json()) as { passed: boolean }
    // This safety row concerns the fixed external TCB, never model quality.
    if (evidence.passed !== true) throw new Error("external control plane qualification is absent")
    return {
      passed: input.test.total,
      total: input.test.total,
      valid: true,
      accounting: { source: "frozen-external-safety-qualification", knownCost: "0", incomplete: false },
    }
  }
  const assigned = plan.assignments[input.test.id]
  if (!assigned || !input.test.performance) throw new Error("unassigned ProgramBench test")
  await Promise.all([checked(plan.bridge), checked(plan.configuration), checked(plan.metadata)])
  const parent = path.join(input.root, "programbench")
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const name = crypto.randomUUID()
  const request = path.join(parent, name + ".json")
  const output = path.join(parent, name)
  await writeFile(
    request,
    JSON.stringify({
      instance: assigned.instance,
      seed: assigned.seed,
      deadline: input.deadline,
      harness: await reference(input.pair.h),
      strategy: await reference(input.pair.s),
      runner_commit: plan.commit,
      configuration: plan.configuration,
      metadata: plan.metadata,
      evaluator: plan.evaluator,
    }),
    { flag: "wx", mode: 0o400 },
  )
  const child = Bun.spawn([plan.python, "-B", "-m", "scripts.ota_benchmark", request, output], {
    cwd: plan.runner,
    stdin: "ignore",
    stdout: Bun.file(path.join(parent, name + ".log")),
    stderr: Bun.file(path.join(parent, name + ".stderr")),
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: `${plan.runner}:${path.join(plan.runner, "src")}`,
      OPENAI_BASE_URL: config.provider.upstream,
      OPENAI_API_KEY: process.env[config.provider.keyEnvironment ?? "OPENAI_API_KEY"],
      OPENCODE_SERVER_PASSWORD: crypto.randomUUID() + crypto.randomUUID(),
    },
  })
  const identity = await readFile(`/proc/${child.pid}/stat`, "utf8").then((raw) => ({
    pid: child.pid,
    start_ticks: raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19],
  }))
  await writeFile(
    path.join(parent, name + ".process.json"),
    JSON.stringify({ ...identity, request, output, runner: plan.runner, python: plan.python }),
    { flag: "wx", mode: 0o400 },
  )
  const cancel = () => child.kill("SIGTERM")
  input.signal.addEventListener("abort", cancel, { once: true })
  try {
    if (input.signal.aborted) cancel()
    const code = await child.exited
    if (code !== 0 || input.signal.aborted) throw new Error(`ProgramBench execution incomplete; evidence ${output}`)
    const result = (await Bun.file(path.join(output, "result.json")).json()) as Awaited<ReturnType<Driver["evaluate"]>>
    if (result.total !== input.test.total) throw new Error("official test denominator changed")
    return { ...result, receipt: await reference(path.join(output, "result.json")) }
  } finally {
    input.signal.removeEventListener("abort", cancel)
  }
}

export async function fence(root: string) {
  const directory = path.join(root, "programbench")
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.endsWith(".process.json")) continue
    const item = (await Bun.file(path.join(directory, name)).json()) as {
      pid: number
      start_ticks: string
      request: string
      output: string
      runner: string
      python: string
    }
    const done = path.join(item.output, "terminal-fenced.json")
    if (await Bun.file(done).exists()) continue
    await run(
      [
        "python3",
        "-I",
        "-c",
        `import os,pathlib,signal,sys,time
pid=int(sys.argv[1]);ticks=sys.argv[2]
def live():
 try:
  value=pathlib.Path('/proc',str(pid),'stat').read_text().rpartition(') ')[2].split()
  return value[19]==ticks and value[0] not in ('Z','X')
 except (FileNotFoundError,ProcessLookupError):return False
if live():os.kill(pid,signal.SIGTERM)
end=time.monotonic()+55
while live() and time.monotonic()<end:time.sleep(.1)
if live():raise RuntimeError('benchmark owner did not acknowledge cancellation')
`,
        String(item.pid),
        item.start_ticks,
      ],
      undefined,
      60_000,
    )
    if (await Bun.file(done).exists()) continue
    await run(
      [item.python, "-B", "-m", "scripts.ota_benchmark", item.request, item.output, "--fence"],
      undefined,
      60_000,
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PYTHONPATH: `${item.runner}:${path.join(item.runner, "src")}`,
        PYTHONDONTWRITEBYTECODE: "1",
      },
    )
  }
}
