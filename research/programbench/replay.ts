export * as Replay from "./replay"

import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import path from "node:path"
import { Endpoint } from "./endpoint"

type Entry = {
  path: string
  kind: "directory" | "file" | "symlink"
  metadata: Record<string, string>
  sha256?: string
  target?: string
}

/** Read-only historical diagnosis, never admission, grading, or receipt repair.
 * The output directory must be new and outside the historical cohort. */
export async function replay(root: string, output: string) {
  if (path.resolve(root) !== root || await fs.realpath(root) !== root)
    throw new Error("Historical root must be canonical")
  if (path.resolve(output) !== output || output === root || output.startsWith(root + path.sep)
    || root.startsWith(output + path.sep)) throw new Error("Audit output must be separate from historical artifacts")
  if (await fs.realpath(path.dirname(output)) !== path.dirname(output)) throw new Error("Audit parent must be canonical")
  await fs.mkdir(output, { mode: 0o700 })
  const before = await inventory(root)
  await write(path.join(output, "before.json"), before)
  const result = await inspect(root).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error: error instanceof Error ? error.message : String(error) }),
  )
  const after = await inventory(root)
  await write(path.join(output, "after.json"), after)
  const changed = differences(before, after)
  const audit = {
    version: 1,
    kind: "historical-receipt-diagnostic-only",
    historicalRoot: root,
    generatedAt: Date.now(),
    source: await Promise.all(["endpoint.ts", "replay.ts"].map(async (name) => ({
      path: path.join(import.meta.dir, name), sha256: await sha256(path.join(import.meta.dir, name)),
    }))),
    custody: {
      scope: "Entire historical cohort, recursively; symlinks recorded but never followed; file bytes stream-hashed",
      metadata: "type, device, inode, mode, owner, group, link count, size, mtime, ctime; atime excluded because reads may update it",
      beforeEntries: before.length,
      afterEntries: after.length,
      files: before.filter((entry) => entry.kind === "file").length,
      bytes: before.filter((entry) => entry.kind === "file").reduce((sum, entry) => sum + Number(entry.metadata.size), 0),
      beforeSHA256: await sha256(path.join(output, "before.json")),
      afterSHA256: await sha256(path.join(output, "after.json")),
      unchanged: changed.length === 0,
      changed,
    },
    limitations: [
      "This is retrospective diagnostic evidence, not a preregistered admission, a new score, a retry, or a performance result.",
      "No historical ENDPOINT, CLASSIFICATION, RESULT, ledger, cancellation marker, timestamp, or deadline is rewritten.",
      "No model, scorer, Docker, or provider is invoked. Private grader assertions and stdout payloads are not displayed.",
      "Current process absence is checked using the original PID/birth identities; no historical process stack is reconstructed.",
    ],
    error: result.error ?? null,
    diagnosis: result.value ?? null,
  }
  await write(path.join(output, "audit.json"), audit)
  if (changed.length) throw new Error("Historical artifacts changed during read-only replay; see audit.json")
  if (result.error) throw new Error(result.error)
  return audit
}

async function inspect(root: string) {
  const protocol = await Bun.file(path.join(root, "PROTOCOL.json")).json() as {
    cohortToken: string
    assignments: Endpoint.Assignment[]
  }
  const frozen = await Bun.file(path.join(root, "FROZEN.json")).json() as {
    protocolSHA256: string
    files: { path: string; sha256: string }[]
  }
  if (await sha256(path.join(root, "PROTOCOL.json")) !== frozen.protocolSHA256)
    throw new Error("Historical protocol no longer matches its frozen hash")
  const originalParser = frozen.files.find((entry) => entry.path === path.join(root, "endpoint.ts"))
  if (!originalParser || await sha256(originalParser.path) !== originalParser.sha256)
    throw new Error("Historical endpoint source no longer matches its frozen hash")
  const originalController = frozen.files.find((entry) => entry.path === path.join(root, "launch.py"))
  if (!originalController || await sha256(originalController.path) !== originalController.sha256)
    throw new Error("Historical cancellation controller no longer matches its frozen hash")
  const cancellation = await Bun.file(path.join(root, "CANCELLATION.json")).json() as { requested: number; reason: string }
  const ids = (await fs.readdir(path.join(root, "runs"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  const cases = []
  for (const id of ids) {
    const directory = path.join(root, "runs", id)
    const input = await derive(root, id, protocol)
    const recorded = await Bun.file(path.join(directory, "ENDPOINT.json")).json() as {
      outcome: string
      finished: number
      artifacts: { path: string; sha256: string }[]
    }
    const classification = await Bun.file(path.join(directory, "CLASSIFICATION.json")).json() as { errors: string[] }
    for (const reference of recorded.artifacts) {
      if (!reference.path.startsWith(directory + path.sep) || await fs.realpath(reference.path) !== reference.path
        || await sha256(reference.path) !== reference.sha256) throw new Error(`Historical receipt artifact mismatch: ${id}`)
    }
    const campaignCancel = path.join(directory, "campaign", "CANCEL")
    const campaignCancelledAt = await Bun.file(campaignCancel).exists() ? (await fs.stat(campaignCancel)).mtimeMs : null
    if (campaignCancelledAt !== null && (campaignCancelledAt + 1 < cancellation.requested * 1000
      || await Bun.file(campaignCancel).text() !== `Cancelled by owning cohort: ${cancellation.reason}\n`))
      throw new Error("Campaign cancellation is not the documented subsequent owning-cohort cancellation")
    const observation = boundary(recorded.finished, cancellation.requested)
    const historical = await Endpoint.inspect(input, observation)
    const present = await Endpoint.inspect(input)
    // This separate hypothetical probe tests expiry without removing the actual
    // CANCEL marker. Like every inspect result it cannot be published/admitted.
    const expiryProbe = await Endpoint.inspect(input, { diagnostic: true, observedAt: Date.now(), cancelled: false })
    cases.push({
      id,
      provenance: {
        inputSources: ["ADMISSION.json", "ADMITTED.json", "PROTOCOL.json assignment", "RESULT.json summary",
          "campaign/FINAL_SCORE.json checkpoint when present", "FAILURE.json host error when present"],
        admissionID: input.admission.admissionID,
        started: input.admission.started,
        originalDeadline: input.admission.deadline,
        checkpoint: input.checkpoint ?? null,
        hostErrorPresent: input.hostError !== undefined,
        originalAborted: input.aborted,
        recordedEndpointArtifactHashesVerified: recorded.artifacts.length,
        boundary: observation,
        cancellationRequestedMilliseconds: cancellation.requested * 1000,
        campaignCancellation: { present: campaignCancelledAt !== null, mtimeMilliseconds: campaignCancelledAt,
          matchesSubsequentOwningCohortCancellation: campaignCancelledAt !== null },
        presentTimeBeyondOriginalDeadline: Date.now() > input.admission.deadline,
      },
      recorded: { outcome: recorded.outcome, errors: classification.errors, finished: recorded.finished },
      historical,
      present,
      expiryProbe: { note: "Diagnostic-only hypothetical CANCEL-absent check; real CANCEL is untouched", inspection: expiryProbe },
    })
  }
  return { originalParser, originalController, protocolSHA256: frozen.protocolSHA256, cases }
}

/** Boundary derived from durable records, not a new clock/deadline for work. */
export function boundary(observedAt: number, cancellationRequestedSeconds: number) {
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0
    || !Number.isFinite(cancellationRequestedSeconds) || cancellationRequestedSeconds <= 0)
    throw new Error("Invalid recorded diagnostic boundary")
  return { diagnostic: true as const, observedAt, cancelled: cancellationRequestedSeconds * 1000 <= observedAt }
}

async function derive(root: string, id: string, protocol: { cohortToken: string; assignments: Endpoint.Assignment[] }): Promise<Endpoint.Input> {
  const directory = path.join(root, "runs", id)
  const admission = await Bun.file(path.join(directory, "ADMISSION.json")).json() as Endpoint.Admission
  const admitted = await Bun.file(path.join(directory, "ADMITTED.json")).json() as { task: Endpoint.Input["task"] }
  const result = await Bun.file(path.join(directory, "RESULT.json")).json() as Endpoint.Input["summary"] & { outcome: string }
  const assignment = protocol.assignments.find((entry) => entry.id === id)
  if (!assignment || admission.id !== id || admission.cohortRoot !== root || admission.cohortToken !== protocol.cohortToken)
    throw new Error("Historical assignment/admission identity mismatch")
  for (const reference of [assignment.profile, assignment.task]) {
    if (await sha256(reference.path) !== reference.sha256) throw new Error("Historical assigned input hash mismatch")
  }
  const final = await Bun.file(path.join(directory, "campaign", "FINAL_SCORE.json")).exists()
    ? await Bun.file(path.join(directory, "campaign", "FINAL_SCORE.json")).json() as { checkpoint: string } : undefined
  const failure = await Bun.file(path.join(directory, "FAILURE.json")).exists()
    ? await Bun.file(path.join(directory, "FAILURE.json")).json() as { error: string } : undefined
  if (failure && typeof failure.error !== "string") throw new Error("Invalid historical host error")
  return {
    directory, admission, assignment, task: admitted.task, checkpoint: final?.checkpoint,
    aborted: result.outcome === "cancelled", hostError: failure?.error,
    summary: {
      contract: result.contract, proposals: result.proposals, comparisons: result.comparisons,
      selectedMethod: result.selectedMethod, seedMethod: result.seedMethod,
    },
  }
}

/** Record every entry, but never follow a historical symlink outside custody. */
export async function inventory(root: string): Promise<Entry[]> {
  const entries: Entry[] = []
  async function visit(file: string) {
    const stat = await fs.lstat(file, { bigint: true })
    const metadata = Object.fromEntries([
      "dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs",
    ].map((key) => [key, String(stat[key as keyof typeof stat])]))
    const name = path.relative(root, file) || "."
    if (stat.isSymbolicLink()) {
      entries.push({ path: name, kind: "symlink", metadata, target: await fs.readlink(file) })
      return
    }
    if (stat.isDirectory()) {
      entries.push({ path: name, kind: "directory", metadata })
      for (const child of (await fs.readdir(file)).sort()) await visit(path.join(file, child))
      return
    }
    if (!stat.isFile()) throw new Error(`Unsupported historical artifact type: ${name}`)
    const hash = await sha256(file)
    const checked = await fs.lstat(file, { bigint: true })
    if (stat.ino !== checked.ino || stat.dev !== checked.dev || stat.size !== checked.size
      || stat.mtimeNs !== checked.mtimeNs || stat.ctimeNs !== checked.ctimeNs)
      throw new Error(`Historical artifact changed while hashing: ${name}`)
    entries.push({ path: name, kind: "file", metadata, sha256: hash })
  }
  await visit(root)
  return entries
}

export function differences(before: Entry[], after: Entry[]) {
  const previous = new Map(before.map((entry) => [entry.path, JSON.stringify(entry)]))
  const current = new Map(after.map((entry) => [entry.path, JSON.stringify(entry)]))
  return Array.from(new Set([...previous.keys(), ...current.keys()])).sort()
    .filter((name) => previous.get(name) !== current.get(name))
}

async function sha256(file: string) {
  const hash = new Bun.CryptoHasher("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function write(file: string, value: unknown) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
}

if (import.meta.main) {
  const [root, output] = process.argv.slice(2)
  if (!root || !output) throw new Error("Usage: bun replay.ts <historical-cohort-root> <new-audit-directory>")
  const audit = await replay(root, output)
  console.log(JSON.stringify({ audit: path.join(output, "audit.json"), unchanged: audit.custody.unchanged,
    files: audit.custody.files, cases: audit.diagnosis?.cases.map((entry) => ({
      id: entry.id, recorded: entry.recorded.outcome, diagnostic: entry.historical.classification.outcome,
      present: entry.present.classification.outcome,
    })) }))
}
