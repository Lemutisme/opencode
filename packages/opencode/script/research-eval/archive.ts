import { lstat, mkdir, open, readFile, readlink } from "node:fs/promises"
import path from "node:path"
import { digest } from "./ledger"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import type { SessionMessage } from "@opencode-ai/schema/session-message"

export async function put(directory: string, value: unknown) {
  const bytes = typeof value === "string" || value instanceof Uint8Array ? value : JSON.stringify(value, null, 2) + "\n"
  const hash = digest(bytes)
  await mkdir(path.join(directory, "objects"), { recursive: true, mode: 0o700 })
  const file = path.join(directory, "objects", hash)
  const handle = await open(file, "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST" || digest(await readFile(file)) !== hash) throw error
    return undefined
  })
  if (handle) {
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
  }
  return hash
}

// The controller calls read-only host APIs. Capture messages even when parsing rejected the final report.
export async function collect(input: {
  directory: string
  run: ResearchModel.Run
  storage?: string
  command: (action: string, id: string, input?: unknown) => Promise<unknown>
}) {
  const versions = (await input.command("research-history", input.run.id)) as {
    version: number
    data: ResearchModel.Run
  }[]
  const runs = versions.toSorted((a, b) => a.version - b.version).map((item) => item.data)
  const operations = (await input.command("operations", input.run.id)) as ProContractJob.Operation[]
  const sessions = await Promise.all(
    [...new Set(operations.map((item) => item.source.sessionID))].map(async (sessionID) => ({
      sessionID,
      messages: await input.command("session-context", "", { sessionID }),
    })),
  )
  const jobIDs = [
    ...new Set(
      [
        ...runs.flatMap((run) => [
          run.plan?.jobID,
          run.verifierJobID,
          run.reviewJobID,
          run.retryJobID,
          run.recoverJobID,
        ]),
        ...operations.map((item) => item.source.jobID),
      ].filter((id): id is string => !!id),
    ),
  ]
  const jobs = await Promise.all(
    jobIDs.map(async (id) => {
      const job = (await input.command("job-get", id)) as ProContractJob.Job
      const messages = (await input.command("session-context", "", {
        sessionID: job.input.sessionID,
      })) as SessionMessage.Message[]
      return { job, messages, hash: await put(input.directory, { job, messages }) }
    }),
  )
  const pending = runs
    .flatMap((run) => [
      run.manifestHash,
      run.bundleHash,
      run.materialsHash,
      run.verificationHash,
      run.reviewHash,
      run.referencesHash,
      run.feedback?.outcomeHash,
      run.feedback?.responseHash,
      ...(run.feedbackHistory ?? []).flatMap((item) => [item.outcomeHash, item.responseHash]),
      ...(run.completionHashes ?? []),
      ...(run.advisoryRecords ?? []),
      run.submissionHash,
      run.plan?.hash,
      run.plan?.reportHash,
      run.plan?.materialsHash,
      run.plan?.admissionHash,
      run.plan?.referencesHash,
      run.experiment?.verificationHash,
      run.lastExperiment?.verificationHash,
    ])
    .filter((hash): hash is string => !!hash)
  const snapshots: { identity: string; archiveHash: string }[] = []
  if (input.storage) {
    const identities = [
      ...new Set(
        runs
          .flatMap((run) => [run.sourceSnapshot, run.subjectHash, run.plan?.subjectHash, run.experiment?.subjectHash])
          .filter((hash): hash is string => !!hash),
      ),
    ]
    const references = await Array.fromAsync(
      new Bun.Glob("data/**/snapshot/references/**/*.json").scan({ cwd: input.storage, absolute: true }),
    )
    const retained = await Promise.all(
      references.map(
        async (file) => (await Bun.file(file).json()) as { snapshot: string; repository: { gitDirectory: string } },
      ),
    )
    for (const identity of identities) {
      const reference = retained.find((item) => item.snapshot === identity)
      if (!reference) throw new Error("Missing retained candidate snapshot " + identity)
      const child = Bun.spawn(
        ["git", "--git-dir", reference.repository.gitDirectory, "archive", "--format=tar", identity],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        },
      )
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
      const [exit, bytes, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
      ])
      clearTimeout(timer)
      if (exit) throw new Error("Snapshot archive failed: " + error)
      snapshots.push({ identity, archiveHash: await put(input.directory, new Uint8Array(bytes)) })
    }
  }
  const objects = new Set<string>()
  const unavailable: string[] = []
  // Hash links include raw reports, replay output and retained artifacts. Missing objects are explicit.
  while (pending.length) {
    const hash = pending.shift()!
    if (objects.has(hash) || unavailable.includes(hash)) continue
    const value = await input.command("research-object", hash).then(
      (value) => String(value),
      () => undefined,
    )
    if (value === undefined || digest(value) !== hash) {
      unavailable.push(hash)
      continue
    }
    await put(input.directory, value)
    objects.add(hash)
    pending.push(
      ...[...value.matchAll(/"([a-f0-9]{64})"/g)].map((match) => match[1]).filter((linked) => !objects.has(linked)),
    )
  }
  return {
    runs,
    sessions,
    snapshots,
    jobs,
    operations,
    objects: [...objects],
    unavailable,
    hash: await put(input.directory, {
      runs,
      sessions,
      snapshots,
      run: input.run,
      jobs: jobs.map((item) => item.hash),
      operations,
      objects: [...objects],
      unavailable,
    }),
  }
}

// Only deterministic fixtures call this: their isolated storage contains no real provider credentials.
// Preserve SQLite/WAL, logs and retained trees even when the host API is already dead.
export async function retainFailure(input: { directory: string; id: string; storage: string; workspace: string }) {
  const root = path.join(input.directory, "failures", input.id)
  await mkdir(path.dirname(root), { recursive: true })
  await mkdir(root)
  for (const [name, source] of [
    ["storage", input.storage],
    ["workspace", input.workspace],
  ]) {
    const child = Bun.spawn(["cp", "-a", "--", source, path.join(root, name)], { stdout: "ignore", stderr: "pipe" })
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000)
    const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
    clearTimeout(timer)
    if (exit) throw new Error("Failed to preserve fixture evidence: " + error)
  }
  const files: Record<string, { hash: string; link?: string }> = {}
  for await (const file of new Bun.Glob("**/*").scan({
    cwd: root,
    dot: true,
    onlyFiles: false,
    followSymlinks: false,
  })) {
    const stat = await lstat(path.join(root, file))
    if (stat.isSymbolicLink()) {
      const link = await readlink(path.join(root, file))
      files[file] = { hash: digest(link), link }
    }
    if (stat.isFile())
      files[file] = { hash: digest(new Uint8Array(await Bun.file(path.join(root, file)).arrayBuffer())) }
  }
  return { root: path.relative(input.directory, root), manifestHash: await put(input.directory, files) }
}
