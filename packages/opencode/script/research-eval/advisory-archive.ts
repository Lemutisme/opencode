import path from "node:path"
import { isUtf8 } from "node:buffer"
import { Schema } from "effect"
import { ResearchModel } from "../../../sdk-next/src/research/model"
import { ResearchProtocol } from "../../../sdk-next/src/research/protocol"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { digest } from "./ledger"
import { advisoryMaterials } from "./advisory-measurement"
import type { collect } from "./archive"

/** Read only the immutable host export. Never select candidate files from the current working tree. */
export async function prepareAdvisoryArchive(input: {
  directory: string
  archiveHash: string
  files: string[]
  timeout: number
}) {
  if (
    !Number.isInteger(input.timeout) ||
    input.timeout <= 0 ||
    input.timeout > 30_000 ||
    !input.files.length ||
    new Set(input.files).size !== input.files.length ||
    input.files.some((file) => !ResearchProtocol.literal(file) || /[\x00-\x1f\x7f]/.test(file))
  )
    throw new Error("Explicit bounded extraction and literal frozen file allowlist are required")
  const object = async (hash: string) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid archive object identity")
    const bytes = new Uint8Array(await Bun.file(path.join(input.directory, "objects", hash)).arrayBuffer())
    if (digest(bytes) !== hash) throw new Error("Archived object is unavailable or corrupt")
    return bytes
  }
  const raw = JSON.parse(Buffer.from(await object(input.archiveHash)).toString("utf8")) as Omit<
    Awaited<ReturnType<typeof collect>>,
    "jobs"
  > & { run: ResearchModel.Run; jobs: string[] }
  const run = raw.run
  Schema.decodeUnknownSync(ResearchModel.Input)(run.input)
  if (ProContractRecognition.fingerprint(run.input) !== run.inputHash)
    throw new Error("Archived agreement identity changed")
  if (run.input.manifest.reviewPolicy?.version !== 3 || !run.bundleHash || !["ready", "accepted"].includes(run.stage))
    throw new Error("A submitted v3 candidate is required for advisory candidate scoring")
  if (!raw.runs.some((row) => JSON.stringify(row) === JSON.stringify(run)))
    throw new Error("Final run is not in the retained host history")
  if (input.files.some((file) => !run.input.manifest.include.some((item) => item === file)))
    throw new Error("Scoring file allowlist is outside the original candidate manifest")
  const snapshots = raw.snapshots.filter((item) => item.identity === run.subjectHash)
  if (snapshots.length !== 1) throw new Error("Candidate snapshot mapping is absent or ambiguous")
  const restored = await Promise.all(
    raw.snapshots.map(async (snapshot) => {
      const archive = await object(snapshot.archiveHash)
      const files = await readTextSnapshot(archive, input.files, input.timeout)
      return { ...snapshot, files, absent: input.files.filter((file) => !(file in files)) }
    }),
  )
  const files = restored.find((snapshot) => snapshot.identity === run.subjectHash)!.files
  if (input.files.some((file) => !(file in files)))
    throw new Error("Frozen candidate allowlist contains an absent file")
  const evidence: Record<string, string> = {}
  for (const hash of raw.objects) evidence[hash] = Buffer.from(await object(hash)).toString("utf8")
  if (!evidence[run.bundleHash] || !run.verificationHash || !evidence[run.verificationHash])
    throw new Error("Candidate delivery evidence is incomplete")
  const verification = Schema.decodeUnknownSync(ResearchModel.Verification)(JSON.parse(evidence[run.verificationHash]))
  if (verification.subjectHash !== run.subjectHash || verification.manifestHash !== run.manifestHash)
    throw new Error("Verification belongs to another candidate")
  const source = {
    archiveHash: input.archiveHash,
    contractID: run.id,
    agreementHash: run.inputHash,
    deadline: run.input.spec.budget.deadline,
    files: input.files,
  }
  const prepared = advisoryMaterials({
    run,
    bundle: JSON.parse(evidence[run.bundleHash]),
    bundleHash: run.bundleHash,
    evidence,
    candidate: {
      subjectHash: run.subjectHash!,
      archiveHash: snapshots[0].archiveHash,
      task: run.input.spec,
      files,
      plan: run.plan ? JSON.parse(evidence[run.plan.hash]) : null,
      verification: {
        record: verification,
        artifacts: Object.fromEntries(
          verification.evidence.map((item) => {
            if (!(item.hash in evidence)) throw new Error("Verification artifact is absent from the archive")
            return [item.path, { hash: item.hash, bytes: evidence[item.hash] }]
          }),
        ),
      },
    },
  })
  return {
    source,
    ...prepared,
    feedback: {
      ...prepared.feedback,
      source,
      finalCandidate: prepared.candidate,
      trajectory: {
        archive: raw,
        snapshots: restored,
        jobs: await Promise.all(
          raw.jobs.map(async (hash) => ({ hash, value: JSON.parse(Buffer.from(await object(hash)).toString("utf8")) })),
        ),
      },
    },
  }
}

export async function readTextSnapshot(archive: Uint8Array, selected: string[], timeout: number) {
  const listed = await extract(archive, ["-tf", "-", "--quoting-style=literal"], timeout)
  const names = listed.toString("utf8").trimEnd().split("\n")
  const files: Record<string, string> = {}
  for (const file of selected) {
    if (names.includes(file + "/")) throw new Error("Text scoring supports exactly one regular file per selected path")
    if (!names.includes(file)) continue
    const description = await extract(archive, ["-tvf", "-", "--quoting-style=literal", "--", file], timeout)
    const entries = description.toString("utf8").trimEnd().split("\n")
    if (entries.length !== 1 || !entries[0].startsWith("-"))
      throw new Error("Text scoring supports exactly one regular file per selected path")
    const bytes = await extract(archive, ["-xOf", "-", "--", file], timeout)
    if (!isUtf8(bytes)) throw new Error("This text scoring adapter cannot silently transcode a binary candidate file")
    files[file] = bytes.toString("utf8")
  }
  return files
}

async function extract(archive: Uint8Array, args: string[], timeout: number) {
  const child = Bun.spawn(["tar", ...args], { stdin: archive, stdout: "pipe", stderr: "ignore" })
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout)
  const chunks: Uint8Array[] = []
  const reader = child.stdout.getReader()
  let size = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.length
    if (size > 16 * 1024 * 1024) {
      child.kill("SIGKILL")
      break
    }
    chunks.push(chunk.value)
  }
  const exit = await child.exited
  clearTimeout(timer)
  if (exit || size > 16 * 1024 * 1024)
    throw new Error("Archived snapshot cannot be restored within the scoring operation limit")
  return Buffer.concat(chunks)
}
