import { open } from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:net"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import { sealedFile, type finalizeScoring, type prepareScoring } from "./evaluate"
import { unseal } from "./blind"
import { adjudicate } from "./score"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import type { runInstance } from "./instance"
import { start } from "./host"
import { launcher } from "./isolation"
import { digest } from "./ledger"
import { put } from "./archive"
import { codeIdentity } from "./provenance"

/** Resume only the idle ready host to submit an exact, independently scored attestation. */
export async function recognize(input: { directory: string; bun: string; timeout: number }) {
  const scoreBytes = await sealedFile(input.directory, "score")
  const score = JSON.parse(scoreBytes) as Awaited<ReturnType<typeof finalizeScoring>>
  const scoring = JSON.parse(await sealedFile(input.directory, "scoring")) as Awaited<ReturnType<typeof prepareScoring>>
  const bytes = await Bun.file(path.join(input.directory, "archive/objects", score.resultHash)).text()
  if (digest(bytes) !== score.resultHash || score.resultHash !== scoring.resultHash)
    throw new Error("Recognition scoring provenance differs")
  const result = JSON.parse(bytes) as Awaited<ReturnType<typeof runInstance>>
  if (result.codeHash !== (await codeIdentity())) throw new Error("Recognition code differs from the frozen runtime")
  const candidate = await unseal(path.join(input.directory, "blind"), result.monitored.raw)
  if (
    JSON.stringify(candidate.phaseOne) !== JSON.stringify(score.phaseOne) ||
    JSON.stringify(adjudicate(score.reviewer.first, score.reviewer.second, score.reviewer.resolution)) !==
      JSON.stringify(score.reviewer)
  )
    throw new Error("Recognition annotations differ from sealed scoring")
  if (
    score.verdict !== "correct" ||
    score.phaseOne.verdict !== "correct" ||
    !scoring.objective ||
    Object.values(scoring.objective).includes(false) ||
    score.subjectHash !== result.monitored.run.subjectHash ||
    score.bundleHash !== result.monitored.run.bundleHash ||
    result.monitored.run.stage !== "ready" ||
    !result.monitored.run.published
  )
    throw new Error("Exact recognition requires an independently correct ready candidate")
  // The already-ready path needs no provider. Any unexpected request is denied at the socket.
  const denied = { requests: 0 }
  const server = createServer((socket) => {
    denied.requests++
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const host = await start({
    storage: path.join(input.directory, "host"),
    directory: path.join(input.directory, "workspace"),
    launcher: await launcher(path.join(input.directory, "isolation")),
    port: (server.address() as { port: number }).port,
    bun: input.bun,
    timeout: input.timeout,
  }).catch((error) => {
    server.close()
    throw error
  })
  const completion = { stopped: false, receiptHash: undefined as string | undefined }
  try {
    const current = (await host.command("research-get", result.monitored.run.id)) as ResearchModel.Run
    const operations = (await host.command("operations", current.id)) as ProContractJob.Operation[]
    const original = result.monitored.evidence.operations
    if (
      operations.some(
        (item) =>
          item.kind === "provider" && (item.status === "running" || !original.some((before) => before.id === item.id)),
      )
    )
      throw new Error("Unexpected provider activity before recognition")
    if (
      denied.requests ||
      current.stage !== "ready" ||
      current.bundleHash !== score.bundleHash ||
      JSON.stringify(current.published) !== JSON.stringify(result.monitored.run.published)
    )
      throw new Error("Ready subject changed before exact recognition")
    const receipt = (await host.command("root-attest", current.id, {
      contractID: current.id,
      expected: current.published,
      evidenceHash: current.bundleHash,
      operationID:
        "s6c-attest-" + digest(JSON.stringify([current.id, current.published, current.bundleHash, digest(scoreBytes)])),
    })) as { decision: { type: string } }
    if (receipt.decision.type !== "accepted") throw new Error("Exact attestation was not accepted")
    const value = {
      scoreHash: await put(path.join(input.directory, "archive"), scoreBytes),
      receipt,
      readyAt: score.readyAt,
      scoredAt: score.scoredAt,
      attestedAt: Date.now(),
    }
    // The attestation may already be durable even when cleanup subsequently fails.
    completion.receiptHash = await put(path.join(input.directory, "archive"), value)
    await host.stop()
    completion.stopped = true
    const file = await open(path.join(input.directory, "recognition.json"), "wx", 0o600)
    await file.writeFile(JSON.stringify(value, null, 2) + "\n")
    await file.sync()
    await file.close()
    return value
  } catch (error) {
    const cleanup = completion.stopped
      ? { complete: true }
      : await host.stop().then(
          () => ({ complete: true }),
          (reason) => ({ complete: false, reason: String(reason) }),
        )
    completion.stopped = true
    const hash = await put(path.join(input.directory, "archive"), {
      failure: String(error),
      receiptHash: completion.receiptHash,
      cleanup,
      at: Date.now(),
    })
    const file = await open(path.join(input.directory, "recognition-failures.jsonl"), "a", 0o600)
    await file.writeFile(JSON.stringify({ hash }) + "\n")
    await file.sync()
    await file.close()
    throw error
  } finally {
    server.close()
    if (!completion.stopped) await host.stop()
  }
}
