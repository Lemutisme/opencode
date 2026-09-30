// Trusted release operations. Candidate archives are unpacked only in containers.
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { hash } from "../../core/script/ota-rsi"

export namespace RSIRuntime {
  export const File = Schema.Struct({ path: Schema.String, sha256: Schema.String })
  export type File = typeof File.Type
  export const Release = Schema.Struct({
    kind: Schema.Literal("native-v2-release-v1"),
    source: File,
    dependencies: File,
    bun: File,
    rg: File,
    image: Schema.String,
    entry: Schema.String,
  })
  export type Release = typeof Release.Type

  class ControlFailure extends Error {
    constructor(
      readonly code: number,
      message: string,
    ) {
      super(message)
    }
  }
  export class Rejected extends Error {
    constructor(
      message: string,
      readonly receipt: string,
    ) {
      super(message)
    }
  }

  export async function run(
    argv: string[],
    options: { input?: string; timeout?: number; env?: NodeJS.ProcessEnv; output?: string } = {},
  ) {
    const child = Bun.spawn(argv, {
      stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
      stdout: "pipe",
      stderr: "pipe",
      env: options.env,
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout ?? 60_000)
    try {
      const [out, error, code] = await Promise.all([
        capture(child.stdout, options.output),
        capture(child.stderr, options.output ? options.output + ".stderr" : undefined),
        child.exited,
      ])
      if (code !== 0)
        throw new ControlFailure(
          code,
          `${argv[0]} ${argv[1]} failed (${code}): ${(options.output ? await Bun.file(options.output + ".stderr").text() : error).slice(-4000)}`,
        )
      return out
    } catch (error) {
      child.kill("SIGKILL")
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  export async function ref(file: string): Promise<File> {
    const resolved = await fs.realpath(file)
    const stat = await fs.lstat(resolved)
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("release requires a regular, unshared file")
    return { path: resolved, sha256: (await run(["sha256sum", "--", resolved])).split(" ")[0] }
  }
  export async function checked(value: File) {
    if (!path.isAbsolute(value.path) || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("invalid file identity")
    const observed = await ref(value.path)
    if (observed.path !== value.path || observed.sha256 !== value.sha256) throw new Error("pinned bytes changed")
    return value.path
  }
  export async function release(file: string) {
    const value = Schema.decodeUnknownSync(Schema.fromJsonString(Release))(await Bun.file(file).text())
    if (
      !/^sha256:[a-f0-9]{64}$/.test(value.image) ||
      !/^[a-zA-Z0-9_./-]+\.ts$/.test(value.entry) ||
      value.entry.split("/").includes("..") ||
      path.isAbsolute(value.entry)
    )
      throw new Error("invalid native release")
    await Promise.all([value.source, value.dependencies, value.bun, value.rg].map(checked))
    return value
  }
  export function label(root: string) {
    return hash(path.resolve(root))
  }
  export async function fence(root: string) {
    const ids = (await run(["docker", "ps", "-aq", "--filter", `label=opencode.rsi=${label(root)}`]))
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (ids.length) await run(["docker", "rm", "-f", ...ids])
    if ((await run(["docker", "ps", "-aq", "--filter", `label=opencode.rsi=${label(root)}`])).trim())
      throw new Error("unacknowledged RSI fence")
  }
  const mounts = new Map<string, Promise<string>>()
  export async function materialize(root: string, release: Release) {
    await Promise.all([release.source, release.dependencies, release.bun, release.rg].map(checked))
    const key = root + ":" + hash(JSON.stringify(release))
    const existing = mounts.get(key)
    if (existing) return existing
    const pending = materializeOnce(root, release)
    mounts.set(key, pending)
    return pending
  }
  async function materializeOnce(root: string, release: Release) {
    await Promise.all([release.source, release.dependencies, release.bun, release.rg].map(checked))
    const identity = hash(JSON.stringify(release))
    const volume = `rsi-${label(root).slice(0, 12)}-${identity}`
    const receipt = path.join(root, "releases", identity + ".json")
    if (await Bun.file(receipt).exists()) {
      await run(["docker", "volume", "inspect", volume])
      return volume
    }
    await fs.mkdir(path.dirname(receipt), { recursive: true, mode: 0o700 })
    await run(["docker", "volume", "create", "--label", `opencode.rsi=${label(root)}`, volume])
    const name = `rsi-materialize-${crypto.randomUUID()}`
    try {
      await run(
        [
          "docker",
          "run",
          "-d",
          "--name",
          name,
          "--pull",
          "never",
          "--label",
          `opencode.rsi=${label(root)}`,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--memory",
          "4g",
          "--cpus",
          "2",
          "--pids-limit",
          "64",
          "--user",
          "0:0",
          "--mount",
          `type=volume,src=${volume},dst=/runtime`,
          "--mount",
          `type=bind,src=${release.source.path},dst=/source.tar,readonly`,
          "--mount",
          `type=bind,src=${release.dependencies.path},dst=/dependencies.tar,readonly`,
          "--entrypoint",
          "/bin/sh",
          release.image,
          "-ec",
          'test -z "$(ls -A /runtime)"; chmod 0777 /runtime; sleep 360',
        ],
        { timeout: 300_000 },
      )
      // Same UID as the artifact owner: no DAC override capability is needed.
      await run(
        [
          "docker",
          "exec",
          "--user",
          `${process.getuid!()}:${process.getgid!()}`,
          name,
          "/bin/sh",
          "-ec",
          "tar --no-same-owner --no-same-permissions -xf /source.tar -C /runtime; tar --no-same-owner --no-same-permissions -xf /dependencies.tar -C /runtime",
        ],
        { timeout: 300_000 },
      )
      await Bun.write(receipt, JSON.stringify({ identity, volume, release }))
    } finally {
      await run(["docker", "rm", "-f", name])
    }
    return volume
  }

  export async function build(root: string, parent: Release, patch: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const volume = await materialize(root, parent)
    const directory = path.join(root, "builds", crypto.randomUUID())
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const name = `rsi-build-${crypto.randomUUID()}`
    const stop = () => {
      void run(["docker", "rm", "-f", name]).catch(() => undefined)
    }
    signal.addEventListener("abort", stop, { once: true })
    try {
      await run([
        "docker",
        "create",
        "--name",
        name,
        "--pull",
        "never",
        "--label",
        `opencode.rsi=${label(root)}`,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "12g",
        "--cpus",
        "4",
        "--pids-limit",
        "256",
        "--user",
        `${process.getuid!()}:${process.getgid!()}`,
        "--tmpfs",
        `/work:rw,exec,nosuid,nodev,size=10g,uid=${process.getuid!()},gid=${process.getgid!()},mode=0700`,
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
        "--mount",
        `type=volume,src=${volume},dst=/parent,readonly`,
        "--mount",
        `type=bind,src=${parent.source.path},dst=/source.tar,readonly`,
        "--mount",
        `type=bind,src=${patch},dst=/change.patch,readonly`,
        "--mount",
        `type=bind,src=${parent.bun.path},dst=/bun,readonly`,
        "--mount",
        `type=bind,src=${path.join(import.meta.dir, "rsi-files.py")},dst=/files.py,readonly`,
        "--entrypoint",
        "/bin/sh",
        parent.image,
        "-ec",
        "sleep 1300",
      ])
      await run(["docker", "start", name])
      signal.throwIfAborted()
      await run(
        [
          "docker",
          "exec",
          name,
          "/bin/sh",
          "-ec",
          `
        mkdir /work/repo; tar -xf /source.tar -C /work/repo; cd /work/repo
        export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null HOME=/tmp
        git -c core.hooksPath=/dev/null init -q
        git -c core.hooksPath=/dev/null add --force --all
        git -c core.hooksPath=/dev/null apply --index --whitespace=nowarn /change.patch
        python3 -I /files.py source /work/repo /work/source.tar

      `,
        ],
        { timeout: 1_200_000, output: path.join(directory, "source.log") },
      ).catch((error) => rejectBuild(error, name, directory, "source", parent, patch))
      signal.throwIfAborted()
      // Only a bounded regular archive crosses the host boundary, never extracted source.
      const exporter = Bun.spawn(
        [
          "python3",
          "-I",
          path.join(import.meta.dir, "rsi-files.py"),
          "export",
          path.join(directory, "source.tar"),
          "source.tar",
          String(1024 ** 3),
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      )
      const copy = Bun.spawn(["docker", "exec", name, "tar", "-C", "/work", "-cf", "-", "source.tar"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const stream = copy.stdout.getReader()
      try {
        while (true) {
          const chunk = await stream.read()
          if (chunk.done) break
          exporter.stdin.write(chunk.value)
          await exporter.stdin.flush()
        }
      } finally {
        await stream.cancel()
        exporter.stdin.end()
      }
      const [copied, exported] = await Promise.all([copy.exited, exporter.exited])
      if (copied || exported) throw new Error("release export failed")
      // The compiler may execute candidate preloads. It cannot rewrite the
      // source bytes already exported to the private host directory above.
      await run(
        [
          "docker",
          "exec",
          name,
          "/bin/sh",
          "-ec",
          `
        cp -a /parent/node_modules /work/repo/node_modules
        for p in /parent/packages/*/node_modules; do test ! -d "$p" || cp -a "$p" "/work/repo/packages/$(basename "$(dirname "$p")")/node_modules"; done
      `,
        ],
        { timeout: 300_000, output: path.join(directory, "dependencies.log") },
      )
      await run(
        [
          "docker",
          "exec",
          name,
          "/bin/sh",
          "-ec",
          `cd /work/repo; /bun build ${parent.entry} --target=bun --packages=external --outfile=/work/entry.js`,
        ],
        { timeout: 1_200_000, output: path.join(directory, "compile.log") },
      ).catch((error) => rejectBuild(error, name, directory, "compile", parent, patch))
      signal.throwIfAborted()
      const built = await ref(path.join(directory, "source.tar"))
      const object = path.join(root, "release-objects", built.sha256)
      await fs.mkdir(path.dirname(object), { recursive: true, mode: 0o700 })
      if (!(await Bun.file(object).exists())) {
        await fs.copyFile(built.path, object)
        await fs.chmod(object, 0o400)
      }
      const sealed = { path: object, sha256: built.sha256 }
      await checked(sealed)
      const next: Release = { ...parent, source: sealed }
      await Bun.write(path.join(directory, "release.json"), JSON.stringify(next))
      return new TextEncoder().encode(JSON.stringify(next))
    } finally {
      signal.removeEventListener("abort", stop)
      await run(["docker", "rm", "-f", name])
    }
  }
  async function rejectBuild(
    error: unknown,
    container: string,
    directory: string,
    phase: string,
    parent: Release,
    patch: string,
  ): Promise<never> {
    if (!(error instanceof ControlFailure) || ![1, 128].includes(error.code)) throw error
    const state = JSON.parse(await run(["docker", "inspect", "--format", "{{json .State}}", container]))
    if (!state.Running || state.OOMKilled) throw error
    const receipt = JSON.stringify({
      phase,
      code: error.code,
      parent: parent.source,
      proposal: await ref(patch),
      log: await ref(path.join(directory, phase + ".log.stderr")),
      performanceEvaluated: false,
    })
    await fs.writeFile(path.join(directory, "rejection.json"), receipt, { flag: "wx", mode: 0o400 })
    throw new Rejected(error.message, hash(receipt))
  }

  async function capture(stream: ReadableStream<Uint8Array>, file?: string) {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    const size = { bytes: 0 }
    if (file) await Bun.write(file, "")
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size.bytes += chunk.value.length
        if (size.bytes > 32 * 1024 * 1024) throw new Error("control output bound exceeded")
        if (file) await fs.appendFile(file, chunk.value)
        if (!file) chunks.push(chunk.value)
      }
      return file ? "" : Buffer.concat(chunks).toString()
    } finally {
      await reader.cancel()
    }
  }
}
