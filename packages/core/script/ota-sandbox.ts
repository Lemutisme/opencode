import { mkdir, open } from "node:fs/promises"
import path from "node:path"
import { hash } from "./ota-rsi.js"

/** Offline sandbox for adapters and qualification. Real provider execution needs
 * the existing credential-isolated gateway, NOT --network=host or API keys here.
 * Individual resource bounds are infrastructure guards, not cumulative budgets.
 */
export class Sandbox {
  readonly label: string

  constructor(
    readonly root: string,
    readonly image: string,
  ) {
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("pinned image ID required")
    this.label = hash(path.resolve(root))
  }

  async fence() {
    const found = await command(["docker", "ps", "-aq", "--filter", `label=opencode.ota=${this.label}`])
    const ids = found.trim().split(/\s+/).filter(Boolean)
    if (ids.length) await command(["docker", "rm", "-f", ...ids])
    if ((await command(["docker", "ps", "-aq", "--filter", `label=opencode.ota=${this.label}`])).trim())
      throw new Error("owned containers did not stop")
  }

  async start(input: { files: Record<string, string>; output?: string; argv: string[] }) {
    if (!input.argv.length) throw new Error("explicit sandbox command required")
    const name = `ota-${this.label.slice(0, 12)}-${crypto.randomUUID()}`
    await mkdir(path.join(this.root, "transport"), { recursive: true, mode: 0o700 })
    const logfile = path.join(this.root, "transport", `${name}.log`)
    const argv = [
      "docker",
      "create",
      "--pull",
      "never",
      "--name",
      name,
      "--label",
      `opencode.ota=${this.label}`,
      "--network",
      "none",
      "--read-only",
      "--init",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "128",
      "--memory",
      "1g",
      "--cpus",
      "2",
      "--user",
      `${process.getuid!()}:${process.getgid!()}`,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
      "--tmpfs",
      "/home/agent:rw,nosuid,nodev,size=16m,mode=1777",
      "--env",
      "HOME=/home/agent",
      "--workdir",
      "/tmp",
      "--entrypoint",
      input.argv[0],
    ]
    Object.entries(input.files).forEach(([name, file]) => {
      if (!/^[a-z][a-z0-9_.-]*$/.test(name) || !path.isAbsolute(file) || file.includes(","))
        throw new Error("invalid sandbox mount")
      argv.push("--mount", `type=bind,src=${file},dst=/release/${name},readonly`)
    })
    if (input.output) {
      if (!path.isAbsolute(input.output) || input.output.includes(",")) throw new Error("invalid output mount")
      argv.push("--mount", `type=bind,src=${input.output},dst=/candidate`)
    }
    await command([...argv, this.image, ...input.argv.slice(1)])
    const stream = Bun.spawn(["docker", "start", "-a", name], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const result = Promise.all([
      stream.exited,
      capture(stream.stdout, logfile),
      capture(stream.stderr, logfile + ".stderr"),
    ]).then(async () => {
      const state = JSON.parse(await command(["docker", "inspect", "--format", "{{json .State}}", name]))
      if (state.Running || state.OOMKilled || state.ExitCode !== 0)
        throw new Error(`sandbox exit ${state.ExitCode}, OOM=${state.OOMKilled}`)
    })
    // Observe failure immediately, even if a caller is still starting its monitor.
    void result.catch(() => undefined)
    return {
      name,
      result,
      logfile,
      stop: async () => {
        await command(["docker", "rm", "-f", name])
        await stream.exited
        if ((await command(["docker", "ps", "-aq", "--filter", `name=^/${name}$`])).trim())
          throw new Error("sandbox still exists")
      },
    }
  }
}

async function capture(stream: ReadableStream<Uint8Array>, file: string) {
  const output = await open(file, "wx", 0o600)
  const count = { bytes: 0 }
  try {
    for await (const chunk of stream) {
      count.bytes += chunk.length
      if (count.bytes > 8 * 1024 * 1024) throw new Error("individual sandbox output exceeded infrastructure bound")
      await output.writeFile(chunk)
    }
  } finally {
    await output.close()
  }
}

async function command(argv: string[]) {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`sandbox control failed (${argv[1]}): ${err}`)
    return out
  } finally {
    clearTimeout(timer)
  }
}
