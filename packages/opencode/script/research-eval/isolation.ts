import { mkdir, realpath, readdir, access } from "node:fs/promises"
import path from "node:path"
import { digest } from "./ledger"

const boundarySource = await Bun.file(path.join(import.meta.dir, "../../../sdk-next/src/research/isolate.c")).text()
export async function launcher(directory: string) {
  const source = path.join(directory, "isolate-" + digest(boundarySource).slice(0, 16) + ".c")
  const output = source.slice(0, -2)
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Evaluation isolation requires Linux x64 and Landlock ABI 6")
  if (!(await Bun.file(output).exists())) {
    await mkdir(directory, { recursive: true })
    await Bun.write(source, boundarySource)
    const child = Bun.spawn(["gcc", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", output], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000)
    const result = await Promise.all([child.exited, new Response(child.stderr).text()])
    clearTimeout(timer)
    if (result[0]) throw new Error(`Cannot compile evaluation isolation: ${result[1]}`)
  }
  return output
}

export async function execute(input: {
  launcher: string
  directory: string
  argv: string[]
  read?: string[]
  port?: number
  timeout: number
  stdin?: string
}) {
  const child = Bun.spawn(
    [
      input.launcher,
      "--tree",
      ...["/usr", "/lib", "/lib64", "/dev/null", "/dev/urandom", ...(input.read ?? [])].flatMap((file) => [
        "--read",
        file,
      ]),
      "--write",
      "/dev/null",
      "--write",
      await realpath(input.directory),
      ...(input.port === undefined ? [] : ["--tcp", String(input.port)]),
      "--",
      ...input.argv,
    ],
    {
      detached: true,
      cwd: input.directory,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: input.directory, OPENSSL_CONF: "/dev/null" },
      stdin: input.stdin === undefined ? "ignore" : new Blob([input.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const terminate = () => {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  const exited = child.exited.then((exit) => {
    terminate()
    return exit
  })
  const state = { timedOut: false, truncated: false }
  const timer = setTimeout(() => {
    state.timedOut = true
    terminate()
  }, input.timeout)
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = []
    const size = { bytes: 0 }
    const reader = stream.getReader()
    while (true) {
      const item = await reader.read()
      if (item.done) break
      const chunk = item.value
      if (size.bytes + chunk.length > 1_048_576) {
        state.truncated = true
        terminate()
        break
      }
      size.bytes += chunk.length
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  const [exit, stdout, stderr] = await Promise.all([exited, collect(child.stdout), collect(child.stderr)])
  clearTimeout(timer)
  return { exit, stdout, stderr, ...state }
}

export async function hostBoundary(input: {
  launcher: string
  storage: string
  directory: string
  port: number
  bun: string
  entry?: "evaluation"
}) {
  const root = path.resolve(import.meta.dir, "../../../..")
  const dependencies = (await readdir(path.join(root, "packages")))
    .filter((name) => name !== "opencode")
    .map((name) => path.join(root, "packages", name))
  const read = [
    "/usr",
    "/lib",
    "/lib64",
    "/dev/null",
    "/dev/urandom",
    "/etc/ssl",
    "/etc/ld.so.cache",
    "/etc/passwd",
    "/etc/nsswitch.conf",
    "/proc/self/maps",
    input.bun,
    path.join(root, "node_modules"),
    path.join(root, "package.json"),
    path.join(root, "bun.lock"),
    ...dependencies,
    path.join(root, "packages/opencode/package.json"),
    path.join(root, "packages/opencode/tsconfig.json"),
    path.join(root, "packages/opencode/src"),
    path.join(root, "packages/opencode/node_modules"),
    path.join(
      root,
      input.entry === "evaluation"
        ? "packages/opencode/script/research-eval/host-process.ts"
        : "packages/opencode/test/fixture/contract-driver-process.ts",
    ),
    path.join(root, "packages/opencode/test/tool/fixtures/models-api.json"),
  ]
  const existing = (
    await Promise.all(
      read.map(
        async (file) =>
          await access(file).then(
            () => file,
            () => undefined,
          ),
      ),
    )
  ).filter((file): file is string => !!file)
  return [
    input.launcher,
    ...(input.entry === "evaluation" ? ["--supervise"] : []),
    "--list",
    root,
    ...existing.flatMap((file) => ["--read", file]),
    "--write",
    "/dev/null",
    "--write",
    input.storage,
    "--write",
    input.directory,
    "--tcp",
    String(input.port),
    "--",
  ]
}

// Candidate modules are never imported into the process holding the oracle.
export async function candidate(input: {
  launcher: string
  directory: string
  source: string
  inputs: unknown[]
  timeout: number
}) {
  await Bun.write(path.join(input.directory, "candidate.mjs"), input.source)
  await Bun.write(
    path.join(input.directory, "run.mjs"),
    `import {rate} from './candidate.mjs'; let text=''; for await(const chunk of process.stdin) text+=chunk; const input=JSON.parse(text); console.log(JSON.stringify(input.map(row=>rate(row.values,row.threshold))))`,
  )
  const output = await execute({ ...input, argv: ["/usr/bin/node", "run.mjs"], stdin: JSON.stringify(input.inputs) })
  if (output.exit || output.timedOut || output.truncated) return { ...output, values: undefined }
  const { Schema, Option } = await import("effect")
  const values = Schema.decodeUnknownOption(
    Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Schema.Array(Schema.NullOr(Schema.Number)))),
  )(output.stdout.trim())
  return { ...output, values: Option.getOrUndefined(values) }
}
