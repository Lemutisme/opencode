import path from "node:path"
import { mkdir } from "node:fs/promises"
import { digest, report, type Event, type Instance } from "./ledger"
import { sealedFile, type finalizeScoring } from "./evaluate"
import type { runInstance } from "./instance"
import type { recognize } from "./recognize"
import type { Infrastructure } from "./infrastructure"
import { feedbackReport } from "./feedback-report"
import { score } from "./score"
import { codeIdentity } from "./provenance"
import { stage } from "./accounting"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import type { Transport } from "./provider"

/** Derive a new report from the retained cohort, without rewriting its execution ledger. */
export async function qualification(directory: string, output: string) {
  const bytes = await Bun.file(path.join(directory, "cohort.json")).text()
  const cohort = JSON.parse(bytes) as {
    mode: "development-calibration" | "qualification"
    instances: Instance[]
    configuration: {
      runner: string
      evaluation?: "feedback-v2" | "repair-lifecycle-v1"
      infrastructure?: Infrastructure
      feedbackGuidance?: "closure:1"
    }
  }
  const codeHash = await codeIdentity()
  if (cohort.configuration.runner !== codeHash) throw new Error("Report code differs from the cohort frozen runtime")
  const chain = { hash: digest(bytes) }
  const rows = (await Bun.file(path.join(directory, "events.jsonl")).text())
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const { hash, ...row } = JSON.parse(line) as {
        hash: string
        previous: string
        at: number
        id: string
        status: string
        evidence?: string
      }
      if (row.previous !== chain.hash || digest(JSON.stringify(row)) !== hash || row.id !== cohort.instances[index]?.id)
        throw new Error("Cohort event chain or fixed denominator changed")
      chain.hash = hash
      return row
    })
  if (cohort.configuration.evaluation) {
    if (cohort.mode !== "development-calibration" || cohort.instances.length !== 3)
      throw new Error("V2 qualification is unsupported")
    return feedbackReport({
      evaluation: cohort.configuration.evaluation,
      infrastructure: cohort.configuration.infrastructure,
      feedbackGuidance: cohort.configuration.feedbackGuidance,
      directory,
      output,
      codeHash,
      instances: cohort.instances,
      rows,
      executionTip: chain.hash,
    })
  }
  const histories = new Map<string, Event[]>()
  const references: Record<string, unknown> = {}
  const state = { pending: false, recognition: true, real: true, executed: false }
  for (const instance of cohort.instances) {
    const row = rows.find((item) => item.id === instance.id)
    if (!row?.evidence) {
      histories.set(instance.id, [
        { kind: "stopped", at: row?.at ?? 0, reason: row?.status ?? "not_started", failure: "not_started" },
      ])
      continue
    }
    const raw = await Bun.file(path.join(directory, "objects", row.evidence)).text()
    if (digest(raw) !== row.evidence) throw new Error("Cohort result object changed")
    if (
      ["infrastructure_failure", "cancelled"].includes(row.status) &&
      !(JSON.parse(raw) as { monitored?: unknown }).monitored
    ) {
      const root = JSON.parse(raw) as { retained?: { hash: string }; cleanup?: unknown }
      const retained = root.retained
        ? await Bun.file(path.join(directory, instance.id, "archive/objects", root.retained.hash)).text()
        : undefined
      if (retained && digest(retained) !== root.retained!.hash) throw new Error("Failure evidence changed")
      const failure = retained
        ? (JSON.parse(retained) as {
            mode: string
            codeHash: string
            attempted: boolean
            admitted: boolean
            issuedAt: number
            deadline: number
            agreement: ResearchModel.Input
            records: Transport[]
            partial: { status: string; value?: unknown; reason?: string }[]
          })
        : undefined
      const events: Event[] = []
      if (failure?.attempted) {
        state.executed = true
        if (failure.mode !== "model") state.real = false
        if (failure.codeHash !== codeHash) throw new Error("Failure belongs to another runtime version")
        events.push(
          { kind: "issued", at: failure.issuedAt, deadline: failure.deadline, contractID: failure.agreement.id! },
          { kind: "observation", at: row.at, hash: root.retained!.hash, stage: row.status },
        )
        const operations = (failure.partial[0]?.value ?? []) as ProContractJob.Operation[]
        const runs = (failure.partial[1]?.value ?? []) as { data: ResearchModel.Run }[]
        events.push(
          ...operations.map(
            (operation): Event => ({
              kind: "usage",
              at: row.at,
              value: {
                stage: stage(
                  operation,
                  runs.map((item) => item.data),
                ),
                operationID: operation.id,
                milliseconds: operation.endedAt === undefined ? null : operation.endedAt - operation.startedAt,
                turns: operation.kind === "provider" ? 1 : 0,
                actions: ["tool", "verification"].includes(operation.kind) ? 1 : 0,
                wireRequests: failure.records.filter(
                  (item) =>
                    item.boundary === "provider" &&
                    item.event?.kind === "wire" &&
                    item.event.identity.operationID === operation.id,
                ).length,
                tokens: operation.usage.value?.totalTokens ?? null,
                cost: null,
                unknown: true,
              },
            }),
          ),
        )
        references[instance.id] = {
          failureHash: root.retained!.hash,
          admissionUnknown: !failure.admitted,
          accountingIncomplete: true,
          unaccountedTransport: failure.records.filter(
            (item) => item.event && !operations.some((operation) => operation.id === item.event.identity.operationID),
          ),
          cleanup: root.cleanup,
        }
      }
      events.push({
        kind: "stopped",
        at: row.at,
        reason: row.status,
        failure: row.status === "cancelled" ? "cancelled" : "infrastructure",
      })
      histories.set(instance.id, events)
      continue
    }
    const result = JSON.parse(raw) as Awaited<ReturnType<typeof runInstance>>
    if (result.codeHash !== codeHash) throw new Error("Result belongs to another runtime version")
    state.executed = true
    if (result.mode !== "model") state.real = false
    const target = path.join(directory, instance.id)
    const scoreBytes = (await Bun.file(path.join(target, "score-ref.json")).exists())
      ? await sealedFile(target, "score")
      : undefined
    const scored = scoreBytes ? (JSON.parse(scoreBytes) as Awaited<ReturnType<typeof finalizeScoring>>) : undefined
    if (scored && "evaluation" in scored) throw new Error("Legacy report cannot consume v2 scores")
    if (scored && scored.resultHash !== row.evidence) throw new Error("Score belongs to another retained result")
    const noTarget = !result.monitored.observed.exposed
    const pending =
      (!scored && (instance.track === "probe" ? !noTarget : result.monitored.run.stage === "ready")) ||
      scored?.phaseOne.verdict === "indeterminate" ||
      scored?.reviewer.verdict === "indeterminate"
    state.pending ||= pending
    const measured =
      scored?.measured ??
      score({
        ...result.monitored.observed,
        entry: instance.family.startsWith("P") ? "plan" : "final",
        defective: instance.defective,
        raw: result.monitored.raw,
        findings: [],
        semanticConsistent: false,
        mechanicalBlock: false,
        gateReason: result.monitored.run.stage,
      })
    const recognitionBytes = (await Bun.file(path.join(target, "recognition.json")).exists())
      ? await Bun.file(path.join(target, "recognition.json")).text()
      : undefined
    const receipt = recognitionBytes
      ? (JSON.parse(recognitionBytes) as Awaited<ReturnType<typeof recognize>>)
      : undefined
    if (receipt && (!scoreBytes || receipt.scoreHash !== digest(scoreBytes)))
      throw new Error("Recognition belongs to another score")
    const run = result.monitored.run
    const events: Event[] = [
      { kind: "issued", at: result.issuedAt, deadline: result.deadline!, contractID: run.id },
      { kind: "observation", at: row.at, hash: row.evidence, stage: run.stage },
    ]
    if (measured.mechanismFailure)
      events.push({
        kind: "invariant",
        at: row.at,
        violation: "Observed gate opened despite invalid reviewer protocol",
        evidenceHash: row.evidence,
      })
    if (instance.track === "probe")
      events.push({
        kind: "probe",
        at: row.at,
        label: measured.label,
        exposed: result.monitored.observed.exposed,
        usable: measured.structure && measured.evidence,
        mechanismFailure: measured.mechanismFailure,
        scoreHash: scoreBytes ? digest(scoreBytes) : row.evidence,
      })
    if (instance.track === "research") {
      events.push({
        kind: "candidate",
        at: row.at,
        readyAt: scored?.readyAt,
        scoredAt: scored?.scoredAt,
        attestedAt: receipt?.attestedAt,
        hash: run.subjectHash ?? row.evidence,
        bundleValid: !!run.bundleHash && !!run.published,
        verdict: scored?.verdict ?? "indeterminate",
        scoreHash: scoreBytes ? digest(scoreBytes) : row.evidence,
      })
      if (scored?.verdict === "correct" && receipt?.receipt.decision.type !== "accepted") state.recognition = false
      if (instance.family === "R1")
        events.push({
          kind: "repair",
          at: row.at,
          source: "initial",
          defectHash: instance.packetHash,
          repaired: scored?.verdict === "correct",
        })
    }
    if (result.fault) {
      events.push({ kind: "injection", at: row.at, status: result.fault.status, evidenceHash: row.evidence })
      const recovered = result.fault.recovered as { stopped?: { replan?: boolean }; at?: number } | undefined
      const next =
        result.fault.lineage.find((item) => item.input.previousJobID === result.fault?.oldID) ?? result.fault.lineage[0]
      if (next && result.fault.safe)
        events.push({
          kind: "recovery",
          at: recovered?.at ?? row.at,
          deadline: result.deadline!,
          oldJobID: result.fault.oldID,
          newJobID: next.input.id,
          safe: true,
          replan: recovered?.stopped?.replan === true,
          evidenceHash: row.evidence,
        })
    }
    events.push(...result.usage.map((value): Event => ({ kind: "usage", at: row.at, value })))
    events.push(
      {
        kind: "accounting",
        at: row.at,
        archiveHash: row.evidence,
        operationIDs: result.usage.map((item) => item.operationID),
        unresolvedScoring: pending,
      },
      {
        kind: "stopped",
        at: row.at,
        reason: row.status,
        failure: result.monitored.cancelled ? "cancelled" : result.monitored.timedOut ? "timeout" : undefined,
      },
    )
    histories.set(instance.id, events)
    references[instance.id] = {
      resultHash: row.evidence,
      scoreHash: scoreBytes ? digest(scoreBytes) : null,
      recognitionHash: recognitionBytes ? digest(recognitionBytes) : null,
    }
  }
  const measured = report(cohort.instances, histories)
  const result = {
    ...measured,
    mode: cohort.mode,
    codeHash,
    references,
    executionTip: chain.hash,
    recognitionComplete: state.recognition,
    unresolvedScoring: state.pending,
    qualification:
      cohort.mode !== "qualification" || !state.real || !state.executed
        ? "not_run"
        : state.pending || !state.recognition
          ? "pending"
          : Object.values(measured.gates).every(Boolean)
            ? "passed"
            : "failed",
  }
  await mkdir(output, { recursive: false, mode: 0o700 })
  await Bun.write(path.join(output, "report.json"), JSON.stringify(result, null, 2) + "\n")
  return result
}
