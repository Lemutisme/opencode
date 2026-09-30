import { Database } from "bun:sqlite"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { RSIRuntime } from "./rsi-runtime"
import type { Pair } from "../../core/script/ota-rsi"

export namespace RSINative {
  const Handoff = Schema.Struct({
    digest: Schema.String,
    summary: Schema.String,
    deadline: Schema.Number,
    authoritativeCompletion: Schema.Literal(false),
  })
  export type Provider = {
    gateway: RSIRuntime.File
    model: string
    effort: string
    upstream: string
    key: string
    fixture?: boolean
  }
  export type Scope = {
    database: string
    protocol: string
    epoch: number
    job: string
    phase: "running" | "evaluating"
    incumbent: Pair
  }
  export type Input = {
    release: RSIRuntime.Release
    strategy: string
    deadline: number
    artifact: string
    goal: string
    scope: Scope
    source?: RSIRuntime.Release
    files?: Record<string, RSIRuntime.File>
    image?: string
  }
  export class Process {
    readonly id = crypto.randomUUID()
    readonly name = `rsi-worker-${this.id}`
    readonly directory: string
    private gateway?: ReturnType<typeof Bun.spawn>
    private closed?: Promise<void>
    private stopped = false
    private deadline = 0
    private launching: Promise<void> = Promise.resolve()
    constructor(
      readonly root: string,
      readonly provider: Provider,
    ) {
      this.directory = path.join(root, "native", this.id)
    }
    launch(input: Input) {
      this.deadline = input.deadline
      this.launching = this.boot(input)
      return this.launching
    }
    private async boot(input: Input) {
      const volume = await RSIRuntime.materialize(this.root, input.release)
      if (this.stopped) throw new Error("startup cancelled")
      await RSIRuntime.checked(this.provider.gateway)
      for (const dir of ["control", "admission", "channel", "candidate", "state"])
        await fs.mkdir(path.join(this.directory, dir), { recursive: true, mode: dir === "control" ? 0o700 : 0o755 })
      await Bun.write(path.join(this.directory, "control/scope.json"), JSON.stringify(input.scope))
      await Bun.write(path.join(this.directory, "control/active"), "active")
      await Bun.write(path.join(this.directory, "admission/active"), "active")
      await Bun.write(
        path.join(this.directory, "admission/worker.json"),
        JSON.stringify({
          id: `ses_${this.id.replaceAll("-", "")}`,
          deadline: input.deadline,
          model: this.provider.model,
          effort: this.provider.effort,
          goal: input.goal,
          artifact: input.artifact,
        }),
      )
      await Bun.write(
        path.join(this.directory, "issue.json"),
        JSON.stringify({
          startedAt: (input.deadline - 21600000) / 1000,
          payload: { budget: { deadline: input.deadline } },
        }),
      )
      this.gateway = Bun.spawn(
        [
          "python3",
          path.join(import.meta.dir, "rsi-gateway.py"),
          "--gateway",
          this.provider.gateway.path,
          "--owner",
          String(process.pid),
          "--scope",
          path.join(this.directory, "control/scope.json"),
          "--channel",
          path.join(this.directory, "channel"),
          "--control",
          path.join(this.directory, "control"),
          "--issue",
          path.join(this.directory, "issue.json"),
          "--model",
          this.provider.model,
          "--effort",
          this.provider.effort,
        ],
        {
          stdin: "ignore",
          stdout: Bun.file(path.join(this.directory, "gateway.log")),
          stderr: Bun.file(path.join(this.directory, "gateway.stderr")),
          env: {
            PATH: process.env.PATH,
            HOME: "/nonexistent",
            OPENAI_BASE_URL: this.provider.upstream,
            OPENAI_API_KEY: this.provider.key,
            PYTHONDONTWRITEBYTECODE: "1",
          },
        },
      )
      const until = Math.min(Date.now() + 30_000, input.deadline)
      while (!(await Bun.file(path.join(this.directory, "control/gateway.json")).exists())) {
        if (this.stopped || Date.now() >= until || this.gateway.exitCode !== null)
          throw new Error("gateway unavailable")
        await Bun.sleep(25)
      }
      const argv = [
        "docker",
        "create",
        "--name",
        this.name,
        "--pull",
        "never",
        "--label",
        `opencode.rsi=${RSIRuntime.label(this.root)}`,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        `${process.getuid!()}:${process.getgid!()}`,
        "--log-driver",
        "local",
        "--log-opt",
        "max-size=4m",
        "--log-opt",
        "max-file=2",
        "--pids-limit",
        "512",
        "--memory",
        "8g",
        "--cpus",
        "4",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
        "--mount",
        `type=volume,src=${volume},dst=/runtime,readonly`,
        "--mount",
        `type=bind,src=${input.release.bun.path},dst=/runtime-bun,readonly`,
        "--mount",
        `type=bind,src=${input.release.rg.path},dst=/tools/rg,readonly`,
        "--mount",
        `type=bind,src=${input.strategy},dst=/strategy,readonly`,
      ]
      for (const name of ["admission", "channel", "candidate", "state"])
        argv.push(
          "--mount",
          `type=bind,src=${path.join(this.directory, name)},dst=/${name}${["admission", "channel"].includes(name) ? ",readonly" : ""}`,
        )
      if (input.source) {
        await RSIRuntime.checked(input.source.source)
        argv.push("--mount", `type=bind,src=${input.source.source.path},dst=/parent-source.tar,readonly`)
      }
      for (const [name, file] of Object.entries(input.files ?? {})) {
        if (!/^[a-z][a-z0-9_.-]*$/.test(name)) throw new Error("invalid task mount")
        argv.push("--mount", `type=bind,src=${await RSIRuntime.checked(file)},dst=/task/${name},readonly`)
      }
      for (const [key, value] of Object.entries({
        HOME: "/state/home",
        XDG_DATA_HOME: "/state/data",
        XDG_CONFIG_HOME: "/state/config",
        XDG_CACHE_HOME: "/state/cache",
        XDG_STATE_HOME: "/state/state",
        PATH: "/tools:/usr/local/bin:/usr/bin:/bin",
      }))
        argv.push("--env", `${key}=${value}`)
      if (input.image && !/^sha256:[a-f0-9]{64}$/.test(input.image)) throw new Error("task image must be pinned")
      await RSIRuntime.run([
        ...argv,
        "--workdir",
        "/candidate",
        "--entrypoint",
        "/runtime-bun",
        input.image ?? input.release.image,
        `/runtime/${input.release.entry}`,
      ])
      if (this.stopped) throw new Error("startup cancelled")
      await RSIRuntime.run(["docker", "start", this.name])
      const pid = Number((await RSIRuntime.run(["docker", "inspect", "--format", "{{.State.Pid}}", this.name])).trim())
      const raw = await Bun.file(`/proc/${pid}/stat`).text()
      await Bun.write(
        path.join(this.directory, "control/runtime.json"),
        JSON.stringify({
          pid,
          start_ticks: raw
            .slice(raw.lastIndexOf(")") + 1)
            .trim()
            .split(/\s+/)[19],
        }),
      )
      if (input.source)
        await RSIRuntime.run(
          [
            "docker",
            "exec",
            this.name,
            "/bin/sh",
            "-ec",
            `mkdir /candidate/source; tar -xf /parent-source.tar -C /candidate/source; cd /candidate/source; export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null; git -c core.hooksPath=/dev/null init -q; git -c core.hooksPath=/dev/null add --force --all; git -c core.hooksPath=/dev/null -c user.name=RSI -c user.email=rsi@localhost commit -qm parent`,
          ],
          { timeout: 120_000 },
        )
      if (this.stopped) throw new Error("startup cancelled")
      await Bun.write(path.join(this.directory, "admission/ready"), "ready")
    }
    async complete() {
      await this.launching
      while (!this.stopped) {
        const state = JSON.parse(await RSIRuntime.run(["docker", "inspect", "--format", "{{json .State}}", this.name]))
        if (!state.Running) {
          await RSIRuntime.run(["docker", "logs", this.name], { output: path.join(this.directory, "worker.log") })
          if (state.OOMKilled || state.ExitCode !== 0) throw new Error("native H execution failed")
          await this.close()
          const handoff = await readHandoff(path.join(this.directory, "state/handoff.json"))
          if (handoff.deadline !== this.deadline) throw new Error("handoff deadline changed")
          return handoff
        }
        await Bun.sleep(100)
      }
      throw new Error("native execution cancelled")
    }
    async progress() {
      const file = path.join(this.directory, "control/requests.db")
      if (!(await Bun.file(file).exists())) return -1
      const db = new Database(file, { readonly: true })
      db.exec("PRAGMA busy_timeout=4000")
      try {
        return db
          .query<{ n: number }, []>("SELECT count(*)-1 AS n FROM request WHERE outcome='response.completed'")
          .get()!.n
      } finally {
        db.close()
      }
    }
    close() {
      this.closed ??= this.stop()
      return this.closed
    }
    private async stop() {
      this.stopped = true
      await Promise.all(
        ["control/active", "admission/active"].map((file) => fs.rm(path.join(this.directory, file), { force: true })),
      )
      await this.launching.catch(() => undefined)
      const exists = (await RSIRuntime.run(["docker", "ps", "-aq", "--filter", `name=^/${this.name}$`])).trim()
      if (exists) {
        await RSIRuntime.run(["docker", "logs", this.name], { output: path.join(this.directory, "worker.log") }).catch(
          () => undefined,
        )
        await RSIRuntime.run(["docker", "rm", "-f", this.name])
      }
      if (this.gateway && this.gateway.exitCode === null) {
        this.gateway.kill("SIGTERM")
        const timeout = setTimeout(() => this.gateway!.kill("SIGKILL"), 5_000)
        try {
          await this.gateway.exited
        } finally {
          clearTimeout(timeout)
        }
      }
      if ((await RSIRuntime.run(["docker", "ps", "-aq", "--filter", `name=^/${this.name}$`])).trim())
        throw new Error("worker fence unacknowledged")
      await Bun.write(path.join(this.directory, "FENCED.json"), JSON.stringify({ name: this.name, time: Date.now() }))
    }
    async artifact(name: string, digest: string) {
      const file = path.join(this.directory, "candidate", name)
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 16 * 1024 * 1024)
        throw new Error("invalid handoff file")
      const bytes = await Bun.file(file).bytes()
      if (Bun.SHA256.hash(bytes, "hex") !== digest) throw new Error("artifact changed after handoff")
      return bytes
    }
    async accounting() {
      const file = path.join(this.directory, "control/requests.db")
      const db = new Database(file, { readonly: true })
      db.exec("PRAGMA busy_timeout=4000")
      const rows = db.query("SELECT * FROM request").all()
      db.close()
      const output = path.join(this.directory, "ACCOUNTING.json")
      await Bun.write(output, JSON.stringify({ rows, fixture: !!this.provider.fixture }))
      return { source: output, knownCost: this.provider.fixture ? "0" : null, incomplete: !this.provider.fixture }
    }
  }
  export async function readHandoff(file: string) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 1024 * 1024)
        throw new Error("invalid handoff record")
      const bytes = await handle.readFile()
      if (bytes.length !== stat.size) throw new Error("handoff changed while reading")
      const value = Schema.decodeUnknownSync(Schema.fromJsonString(Handoff))(bytes.toString())
      if (!/^[a-f0-9]{64}$/.test(value.digest) || value.summary.length > 8192)
        throw new Error("invalid handoff coordinates")
      return value
    } finally {
      await handle.close()
    }
  }
}
