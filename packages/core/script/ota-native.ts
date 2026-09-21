import { Database } from "bun:sqlite"
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { hash } from "./ota-rsi"

export type FileRef = { path: string; sha256: string }
export type Release = { kind: "opencode-release-v1"; source: FileRef; binary: FileRef; image: string; build: FileRef }
export type Provider = {
  gateway: FileRef
  model: string
  effort: string
  upstream: string
  key: string
  fixture?: boolean
}

export async function checked(ref: FileRef) {
  if (!path.isAbsolute(ref.path) || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error("invalid release reference")
  const info = await lstat(ref.path)
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(ref.path)) !== ref.path)
    throw new Error("release reference is not a canonical regular file")
  const result = await run(["sha256sum", "--", ref.path])
  if (result.split(" ")[0] !== ref.sha256) throw new Error("release or supply bytes changed")
  return ref.path
}

export async function reference(file: string): Promise<FileRef> {
  return { path: path.resolve(file), sha256: (await run(["sha256sum", "--", file])).split(" ")[0] }
}

export async function release(file: string) {
  const value = (await Bun.file(file).json()) as Release
  if (value.kind !== "opencode-release-v1" || !/^sha256:[a-f0-9]{64}$/.test(value.image))
    throw new Error("invalid full harness release")
  await Promise.all([checked(value.binary), checked(value.source), checked(value.build)])
  return value
}

export async function run(argv: string[], input?: string, timeout = 30_000, env?: Record<string, string | undefined>) {
  const child = Bun.spawn(argv, {
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout)
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const chunks = []
    const size = { value: 0 }
    for await (const chunk of stream) {
      size.value += chunk.length
      if (size.value > 32 * 1024 * 1024) {
        child.kill("SIGKILL")
        throw new Error("control output bound exceeded")
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString()
  }
  try {
    const [output, error, code] = await Promise.all([read(child.stdout), read(child.stderr), child.exited])
    if (code !== 0) throw new Error(`control command ${argv[0]} failed (${code}): ${error.slice(-2000)}`)
    return output
  } finally {
    clearTimeout(timer)
  }
}

const instances = new Set<Native>()
const shell = path.join(import.meta.dir, "ota-release.sh")
const control = `import base64,http.client,json,os,sys
v=json.load(sys.stdin);c=http.client.HTTPConnection('127.0.0.1',4096,timeout=10)
h={'Content-Type':'application/json','Authorization':'Basic '+base64.b64encode(('opencode:'+os.environ['OPENCODE_SERVER_PASSWORD']).encode()).decode()}
c.request(v['method'],v['path'],body=json.dumps(v['body']) if v.get('body') is not None else None,headers=h)
r=c.getresponse();b=r.read(16777217);assert len(b)<=16777216
print(json.dumps({'status':r.status,'body':b.decode()}))`

/** Full OpenCode runs inside the container; only the socket gateway is on host.
 * The gateway is the existing deadline-only, SO_PEERCRED-fenced implementation.
 */
export class Native {
  readonly name: string
  private gateway?: ReturnType<typeof Bun.spawn>
  private stopped = false
  private closing?: Promise<void>
  private launching: Promise<void> = Promise.resolve()

  constructor(
    readonly root: string,
    readonly directory: string,
    readonly provider: Provider,
  ) {
    instances.add(this)
    this.name = `ota-native-${hash(root).slice(0, 12)}-${crypto.randomUUID()}`
  }

  launch(input: { release: Release; state: string; policy: string; payload: object; deadline: number }) {
    this.launching = this.boot(input)
    return this.launching
  }

  private async boot(input: { release: Release; state: string; policy: string; payload: object; deadline: number }) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await checked(this.provider.gateway)
    await checked(input.release.binary)
    await checked(input.release.source)
    if (this.stopped) throw new Error("startup fenced")
    const channel = path.join(this.directory, "channel")
    const ledger = path.join(this.directory, "gateway")
    await mkdir(ledger, { mode: 0o700 })
    const issue = path.join(this.directory, "issue.json")
    await Bun.write(issue, JSON.stringify({ startedAt: (input.deadline - 21_600_000) / 1000, payload: input.payload }))
    this.gateway = Bun.spawn(
      [
        "python3",
        this.provider.gateway.path,
        "--channel",
        channel,
        "--control",
        ledger,
        "--model",
        this.provider.model,
        "--effort",
        this.provider.effort,
        "--issue",
        issue,
      ],
      {
        stdin: "ignore",
        stdout: Bun.file(path.join(this.directory, "gateway.log")),
        stderr: Bun.file(path.join(this.directory, "gateway-error.log")),
        env: {
          PATH: process.env.PATH,
          HOME: "/nonexistent",
          OPENAI_BASE_URL: this.provider.upstream,
          OPENAI_API_KEY: this.provider.key,
        },
      },
    )
    const until = Date.now() + 10_000
    while (!(await Bun.file(path.join(ledger, "gateway.json")).exists())) {
      if (this.stopped || Date.now() >= until || this.gateway.exitCode !== null)
        throw new Error("gateway did not start")
      await Bun.sleep(50)
    }
    for (const name of ["home", "data", "cache", "config/opencode", "work", "tmp"])
      await stateDirectory(input.state, name)
    const config = path.join(input.state, "config/opencode/opencode.jsonc")
    const configInfo = await lstat(config).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    if (configInfo && (!configInfo.isFile() || configInfo.isSymbolicLink() || configInfo.nlink !== 1))
      throw new Error("unsafe private configuration path")
    if (!configInfo)
      await writeFile(
        config,
        JSON.stringify({
          permission: { "*": "allow", question: "deny", contract_issue: "deny", contract_revision: "deny" },
        }),
        { flag: "wx", mode: 0o600 },
      )
    const env = path.join(this.directory, "runtime.env")
    await writeFile(
      env,
      [
        "HOME=/state/home",
        "XDG_DATA_HOME=/state/data",
        "XDG_STATE_HOME=/state/state",
        "XDG_CACHE_HOME=/state/cache",
        "XDG_CONFIG_HOME=/state/config",
        "TMPDIR=/state/tmp",
        "OPENCODE_DB=/state/data/opencode.db",
        "OPENCODE_DISABLE_DEFAULT_PLUGINS=true",
        "OPENCODE_DISABLE_MODELS_FETCH=true",
        "OPENCODE_PROCONTRACT_DISABLED=0",
        "OPENAI_API_KEY=offline-gateway-only",
        "OPENAI_BASE_URL=http://programbench-provider.invalid/v1",
        "OPENCODE_PROVIDER_SOCKET=/channel/provider.sock",
        `OPENCODE_SERVER_PASSWORD=${crypto.randomUUID()}`,
      ].join("\n"),
      { mode: 0o600, flag: "wx" },
    )
    await run([
      "docker",
      "create",
      "--name",
      this.name,
      "--pull",
      "never",
      "--label",
      `opencode.ota=${hash(this.root)}`,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      `${process.getuid!()}:${process.getgid!()}`,
      "--pids-limit",
      "512",
      "--memory",
      "8g",
      "--cpus",
      "4",
      "--log-driver",
      "local",
      "--log-opt",
      "max-size=4m",
      "--log-opt",
      "max-file=2",
      "--tmpfs",
      "/tmp:rw,exec,nosuid,nodev,size=256m,mode=1777",
      "--env-file",
      env,
      "--mount",
      `type=bind,src=${input.release.binary.path},dst=/runtime/opencode,readonly`,
      "--mount",
      `type=bind,src=${input.release.source.path},dst=/release/source.tar,readonly`,
      "--mount",
      `type=bind,src=${input.policy},dst=/release/strategy,readonly`,
      "--mount",
      `type=bind,src=${input.state},dst=/state`,
      "--mount",
      `type=bind,src=${channel},dst=/channel,readonly`,
      "--workdir",
      "/state/work",
      "--entrypoint",
      "/runtime/opencode",
      input.release.image,
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4096",
    ])
    await Bun.write(
      path.join(this.directory, "container.json"),
      JSON.stringify({ name: this.name, release: input.release, state: input.state, deadline: input.deadline }),
    )
    if (this.stopped) throw new Error("startup fenced")
    await run(["docker", "start", this.name])
    if (this.stopped) throw new Error("startup fenced")
    await run([
      "docker",
      "exec",
      this.name,
      "/bin/sh",
      "-eu",
      "-c",
      "if [ ! -e /state/work/.git ]; then cd /state/work; git -c core.hooksPath=/dev/null init -q; git -c core.hooksPath=/dev/null -c user.name=OTA -c user.email=ota@localhost -c commit.gpgsign=false commit --allow-empty -qm workspace; fi",
    ])
    if (this.stopped) throw new Error("startup fenced")
    const pid = Number((await run(["docker", "inspect", "--format", "{{.State.Pid}}", this.name])).trim())
    const info = await readFile(`/proc/${pid}/stat`, "utf8")
    await Bun.write(
      path.join(ledger, "runtime.json"),
      JSON.stringify({ pid, start_ticks: info.slice(info.lastIndexOf(")") + 2).split(" ")[19] }),
    )
  }

  async request(method: string, url: string, body?: unknown) {
    if (this.stopped) throw new Error("native worker fenced")
    const response = JSON.parse(
      await run(
        ["docker", "exec", "-i", this.name, "python3", "-I", "-c", control],
        JSON.stringify({ method, path: url, body }),
        15_000,
      ),
    ) as { status: number; body: string }
    if (response.status < 200 || response.status >= 300)
      throw new Error(`native API ${method} ${url}: HTTP ${response.status}`)
    return response.body ? (JSON.parse(response.body) as unknown) : undefined
  }

  async execute(payload: { id: string }, deadline: number) {
    const until = Math.min(deadline, Date.now() + 180_000)
    while (
      !(await this.request("GET", "/global/health").then(
        () => true,
        () => false,
      ))
    ) {
      if (this.stopped || Date.now() >= until) throw new Error("native startup did not become ready")
      await Bun.sleep(100)
    }
    // One durable admission, never a host-side model/tool loop or implicit retry.
    await this.request("POST", "/api/contract", payload)
    while (!this.stopped && Date.now() < deadline) {
      const value = (await this.request("GET", `/api/contract/${payload.id}`)) as {
        data: { status: string; spec: { budget: { deadline: number } } }
      }
      if (value.data.spec.budget.deadline !== deadline) throw new Error("native original deadline changed")
      if (["verification", "escalated", "released", "discharged"].includes(value.data.status))
        await Bun.write(path.join(this.directory, "terminal.json"), JSON.stringify(value))
      if (value.data.status === "verification") {
        await Bun.write(path.join(this.directory, "handoff.json"), JSON.stringify(value))
        return
      }
      if (["escalated", "released", "discharged"].includes(value.data.status))
        throw new Error(`unexpected native termination: ${value.data.status}`)
      await Bun.sleep(200)
    }
    throw new Error("native worker stopped or original deadline reached")
  }

  async progress() {
    const db = new Database(path.join(this.directory, "gateway/requests.db"), { readonly: true })
    try {
      db.exec("PRAGMA busy_timeout=2000")
      const row = db.query<{ n: number }, []>("SELECT count(*) AS n FROM request WHERE terminal_at IS NOT NULL").get()!
      return row.n - 1
    } finally {
      db.close()
    }
  }

  close() {
    return (this.closing ??= this.stop())
  }

  private async stop() {
    this.stopped = true
    await this.launching.catch(() => undefined)
    // Close provider admission first, including when Docker control is unhealthy.
    if (this.gateway) {
      this.gateway.kill("SIGTERM")
      await this.gateway.exited
    }
    const exists = (await run(["docker", "ps", "-aq", "--filter", `name=^/${this.name}$`])).trim()
    if (exists) {
      await run(["docker", "stop", "--time", "3", this.name])
      try {
        await Bun.write(path.join(this.directory, "server.log"), await run(["docker", "logs", this.name]))
      } finally {
        await run(["docker", "rm", "-f", this.name])
      }
    }
    await Bun.write(path.join(this.directory, "stopped.json"), JSON.stringify({ fenced: true, at: Date.now() }))
    instances.delete(this)
  }
}

// Called only while the namespace is fenced. Never follow a guest-created link
// during host-side preparation, artifact export or grading.
export async function stateDirectory(root: string, relative: string) {
  if ((await realpath(root)) !== root) throw new Error("noncanonical state root")
  if (!relative.split("/").every((part) => /^[a-z][a-z0-9_-]*$/.test(part))) throw new Error("invalid state path")
  const parts = relative.split("/")
  for (const [index] of parts.entries()) {
    const directory = path.join(root, ...parts.slice(0, index + 1))
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("unsafe private state directory")
    if (!info) await mkdir(directory, { mode: 0o700 })
  }
}

export async function artifact(root: string, name: string, limit = 16 * 1024 * 1024) {
  if (!/^[a-z][a-z0-9_.-]*$/.test(name)) throw new Error("invalid artifact basename")
  const file = path.join(root, name)
  const info = await lstat(file)
  if ((await realpath(file)) !== file || !info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > limit)
    throw new Error("unsafe artifact path or size")
  const bytes = await Bun.file(file).bytes()
  if (bytes.length !== info.size) throw new Error("artifact changed while reading")
  return bytes
}

export async function fence(root: string) {
  // Diagnostic failure must not skip the independent orphan fence.
  const closing = await Promise.allSettled(
    [...instances].filter((item) => item.root === root).map((item) => item.close()),
  )
  await run(["bash", shell, "fence", root])
  const native = path.join(root, "native")
  const directories = await readdir(native).catch(() => [])
  for (const name of directories) {
    const file = path.join(native, name, "gateway/gateway.json")
    if (!(await Bun.file(file).exists())) continue
    await run([
      "python3",
      "-I",
      "-c",
      `import json,os,pathlib,signal,sys,time
v=json.load(open(sys.argv[1]));p=pathlib.Path('/proc')/str(v['pid'])/'stat'
def same():
 try:return p.read_text().rpartition(') ')[2].split()[19]==v['start_ticks']
 except (FileNotFoundError,ProcessLookupError):return False
if same():
 os.kill(v['pid'],signal.SIGTERM)
 for _ in range(50):
  if not same():break
  time.sleep(.02)
 if same():os.kill(v['pid'],signal.SIGKILL)
`,
      file,
    ])
  }
  if (closing.some((item) => item.status === "rejected"))
    await Bun.write(
      path.join(root, `fence-diagnostic-${Date.now()}.json`),
      JSON.stringify(closing.map((item) => (item.status === "rejected" ? String(item.reason) : "closed"))),
    )
  for (const item of instances) if (item.root === root) instances.delete(item)
}
