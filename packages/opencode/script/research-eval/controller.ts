import type { ResearchModel } from "../../../sdk-next/src/research/model"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import type { SessionMessage } from "@opencode-ai/schema/session-message"
import { evidence, firstTarget, target } from "./driver"
import { digest } from "./ledger"
import { collect, put } from "./archive"
import { ResearchFeedback } from "../../../sdk-next/src/research/review-feedback"
import { Schema } from "effect"
import type { Observation } from "./observe"

export type Port = { command: (action: string, id: string, input?: unknown) => Promise<unknown> }

/** Autonomous monitoring has no oracle, candidate preparation or model-answer input. */
export async function monitor(input: {
  port: Port
  contractID: string
  entry: "plan" | "final" | "research" | "followup"
  evaluation?: "feedback-v2" | "repair-lifecycle-v1" | "advisory-v3"
  deadline: number
  archive: string
  storage?: string
  observations: () => readonly Observation[]
  signal?: AbortSignal
}) {
  const autonomous = input.entry === "research" || input.entry === "followup"
  const history: { at: number; hash: string; stage: string }[] = []
  const challenged = new Set<string>()
  const receipts: string[] = []
  const state = { version: -1 }
  while (true) {
    const current = (await input.port.command("research-get", input.contractID)) as ResearchModel.Run
    const versions = (await input.port.command("research-history", input.contractID)) as {
      version: number
      data: ResearchModel.Run
    }[]
    const runs = versions.map((item) => item.data)
    const rejectedPlan =
      input.entry === "final" ? runs.find((item) => item.plan?.reportHash && !item.plan.approved) : undefined
    const run = autonomous
      ? (runs.toSorted((a, b) => a.version - b.version).find((item) => item.stage === "ready") ?? current)
      : (firstTarget(runs, input.entry === "plan" ? "plan" : "final") ?? rejectedPlan ?? current)
    if (run.input.spec.budget.deadline !== input.deadline) throw new Error("Research deadline changed")
    if (run.version !== state.version) {
      history.push({ at: Date.now(), stage: run.stage, hash: await put(input.archive, run) })
      state.version = run.version
    }
    const observed = target(
      run,
      input.entry === "plan" ? "plan" : "final",
      input
        .observations()
        .filter((event) => event.kind === "wire" || event.kind === "response")
        .map((event) => event.identity.jobID),
    )
    if (input.evaluation)
      observed.exposed = input
        .observations()
        .some(
          (event) => (event.kind === "wire" || event.kind === "response") && event.identity.jobID === observed.jobID,
        )
    const terminal = ["unavailable", "cancelled", "released", "accepted"].includes(run.stage)
    const timedOut = Date.now() >= input.deadline
    const cancelled = input.signal?.aborted === true
    if (
      (!autonomous && observed.decided) ||
      (autonomous && run.stage === "ready") ||
      terminal ||
      !!rejectedPlan ||
      timedOut ||
      cancelled
    ) {
      observed.evidence = await evidence(run, input.entry === "plan" ? "plan" : "final", async (hash) =>
        String(await input.port.command("research-object", hash)),
      )
      const job = observed.jobID
        ? ((await input.port.command("job-get", observed.jobID)) as ProContractJob.Job)
        : undefined
      const messages = job
        ? ((await input.port.command("session-context", "", {
            sessionID: job.input.sessionID,
          })) as SessionMessage.Message[])
        : []
      const final = messages.findLast((message) => message.type === "assistant" && !!message.time.completed)
      const capturedRaw =
        final?.type === "assistant"
          ? final.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
          : ""
      const firstReview = input.evaluation
        ? await firstReviewAttempt(runs, input.port, input.observations())
        : undefined
      const finalOutcome =
        input.evaluation && run.reviewHash
          ? Schema.decodeUnknownSync(ResearchFeedback.Outcome)(
              JSON.parse(String(await input.port.command("research-object", run.reviewHash))),
            )
          : undefined
      const raw = finalOutcome
        ? finalOutcome.rawHash
          ? String(await input.port.command("research-object", finalOutcome.rawHash))
          : ""
        : capturedRaw
      // A ready full task waits for external scoring; probe cancellation never supplies scoring feedback.
      if (
        !["accepted", "released", "cancelled"].includes(current.stage) &&
        (!autonomous || timedOut || cancelled || terminal)
      )
        await input.port.command("research-cancel", input.contractID, {
          reason: timedOut
            ? "Original evaluation deadline"
            : cancelled
              ? "Explicit evaluation cancellation"
              : input.entry === "research"
                ? "Terminal evaluation state"
                : rejectedPlan
                  ? "Final probe prerequisite plan declined"
                  : "Probe target observation complete",
        })
      const transportHash = await put(input.archive, input.observations())
      const archive = await collect({ ...input, directory: input.archive, run, command: input.port.command })
      return {
        run,
        ...(input.evaluation ? { firstReview } : {}),
        observed,
        job,
        raw,
        evidence: archive,
        transportHash,
        receipts,
        history,
        timedOut,
        cancelled,
        prerequisiteBlocked: !!rejectedPlan,
        capturedAt: Date.now(),
      }
    }
    if (
      !input.evaluation &&
      input.entry === "research" &&
      run.stage === "changes_requested" &&
      run.published &&
      run.reviewHash &&
      run.bundleHash
    ) {
      const identity = JSON.stringify(run.published)
      if (!challenged.has(identity)) {
        const report = JSON.parse(
          String(await input.port.command("research-object", run.reviewHash)),
        ) as ResearchModel.ReviewReport
        const findings = report.review.findings.filter((finding) => finding.severity === "blocking")
        if (report.review.verdict !== "changes_requested" || !findings.length)
          throw new Error("Challenge requires the original blocking findings")
        const receipt = await input.port.command("root-challenge", input.contractID, {
          contractID: input.contractID,
          expected: run.published,
          operationID: "eval-challenge-" + digest(JSON.stringify([run.id, run.published, run.bundleHash])),
          evidenceHash: run.bundleHash,
          disclosure: "executor",
          summary: JSON.stringify(findings),
        })
        receipts.push(await put(input.archive, { identity, findings, receipt }))
        challenged.add(identity)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(100, input.deadline - Date.now()))))
  }
}

/** Select the earliest created job before looking for its result, including absent/partial output. */
export async function firstReviewAttempt(
  runs: readonly ResearchModel.Run[],
  port: Port,
  observations: readonly Observation[],
) {
  const ordered = runs.toSorted((a, b) => a.version - b.version)
  const initial = ordered.find((run) => !!run.plan?.jobID)
  if (!initial?.plan?.jobID) return undefined
  const job = (await port.command("job-get", initial.plan.jobID)) as ProContractJob.Job
  const outcomeHash = ordered.find((run) => run.plan?.jobID === initial.plan!.jobID && run.plan?.reportHash)?.plan
    ?.reportHash
  const outcome = outcomeHash
    ? Schema.decodeUnknownSync(ResearchFeedback.Outcome)(
        JSON.parse(String(await port.command("research-object", outcomeHash))),
      )
    : undefined
  if (
    outcome &&
    (outcome.jobID !== job.input.id ||
      outcome.planHash !== initial.plan.hash ||
      outcome.fingerprint !== job.fingerprint ||
      outcome.generation !== job.generation)
  )
    throw new Error("Initial review attempt changed identity")
  const messages = outcome
    ? []
    : ((await port.command("session-context", "", { sessionID: job.input.sessionID })) as SessionMessage.Message[])
  const message = messages.findLast((item) => item.type === "assistant")
  const raw = outcome
    ? outcome.rawHash
      ? String(await port.command("research-object", outcome.rawHash))
      : ""
    : (message?.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n") ?? "")
  return {
    runVersion: initial.version,
    plan: initial.plan,
    job,
    outcomeHash,
    outcome,
    raw,
    capture: outcome?.capture ?? (message ? "partial" : "absent"),
    availability: outcome?.availability ?? "unavailable",
    exposed: observations.some(
      (item) => (item.kind === "wire" || item.kind === "response") && item.identity.jobID === job.input.id,
    ),
  }
}
