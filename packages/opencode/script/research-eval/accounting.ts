import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import { digest, read, report, type Event } from "./ledger"

export function stage(operation: ProContractJob.Operation, runs: readonly ResearchModel.Run[]) {
  const id = operation.source.jobID
  if (!id) return "worker" as const
  if (runs.some((run) => run.plan?.jobID === id)) return "plan_review" as const
  if (runs.some((run) => run.reviewJobID === id)) return "review" as const
  if (operation.kind === "verification")
    return runs.some((run) => run.verifierJobID === id && run.purpose === "experiment")
      ? ("experiment" as const)
      : ("verification" as const)
  return "worker" as const
}

// Derived reporting only: the frozen source, ledger and original report are never overwritten.
export async function correct(input: { directory: string; output: string }) {
  const ledger = await read(input.directory)
  const raw = await Bun.file(path.join(input.directory, "events.jsonl")).text()
  const original = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { instanceID: string; event: Event; hash: string })
  const corrections: {
    instanceID: string
    originalRowHash: string
    archiveHash: string
    before: Event
    after: Event
  }[] = []
  const object = async (hash: string): Promise<unknown> => {
    const raw = await Bun.file(path.join(input.directory, "objects", hash)).text()
    if (digest(raw) !== hash) throw new Error("Correction evidence hash mismatch")
    return JSON.parse(raw)
  }
  const histories = new Map<string, Event[]>()
  for (const instance of ledger.manifest.instances) {
    const events = ledger.histories.get(instance.id)!
    const accounting = events.find((event) => event.kind === "accounting")
    if (!accounting) {
      histories.set(instance.id, events)
      continue
    }
    const root = (await object(accounting.archiveHash)) as {
      evidence: string
      history: { at: number; stage: string }[]
      receipts: string[]
    }
    const evidence = (await object(root.evidence)) as {
      operations: ProContractJob.Operation[]
      runs: ResearchModel.Run[]
    }
    const receipts = await Promise.all(
      root.receipts.map(
        async (hash) =>
          (await object(hash)) as { scoredAt?: number; attestedAt?: number; receipt: { decision: { type: string } } },
      ),
    )
    const next = events.map((event): Event => {
      if (event.kind === "usage") {
        const operation = evidence.operations.find((operation) => operation.id === event.value.operationID)
        if (!operation) throw new Error("Missing archived operation")
        return { ...event, value: { ...event.value, stage: stage(operation, evidence.runs) } }
      }
      if (event.kind !== "candidate") return event
      const readyAt = root.history.find((item) => item.stage === "ready")?.at
      if (readyAt === undefined) throw new Error("Missing first ready observation")
      const receipt = receipts.find((item) => item.receipt.decision.type === "accepted")
      // v1 named the post-attestation timestamp scoredAt; the true scoring time was not recorded.
      return {
        ...event,
        readyAt,
        scoredAt: receipt?.attestedAt === undefined ? null : (receipt.scoredAt ?? null),
        attestedAt: receipt?.attestedAt ?? receipt?.scoredAt ?? null,
      }
    })
    next.forEach((event, index) => {
      if (JSON.stringify(event) === JSON.stringify(events[index])) return
      const row = original.find(
        (row) => row.instanceID === instance.id && JSON.stringify(row.event) === JSON.stringify(events[index]),
      )
      if (!row) throw new Error("Missing original ledger row")
      corrections.push({
        instanceID: instance.id,
        originalRowHash: row.hash,
        archiveHash: accounting.archiveHash,
        before: events[index],
        after: event,
      })
    })
    histories.set(instance.id, next)
  }
  await mkdir(input.output)
  const provenance = {
    version: "research-eval-report:2",
    originalDirectory: path.resolve(input.directory),
    reportCodeHash: digest(await Bun.file(path.join(import.meta.dir, "ledger.ts")).text()),
    sourceHash: ledger.manifest.sourceHash,
    ledgerHash: digest(raw),
    originalReportHash: digest(await Bun.file(path.join(input.directory, "report.json")).text()),
    correctionCodeHash: digest(await Bun.file(import.meta.path).text()),
    corrections,
  }
  await Bun.write(path.join(input.output, "corrections.json"), JSON.stringify(provenance, null, 2) + "\n")
  const result = report(ledger.manifest.instances, histories)
  await Bun.write(path.join(input.output, "report.json"), JSON.stringify(result, null, 2) + "\n")
  return { corrections: corrections.length, gates: result.gates, qualification: result.qualification }
}
