import path from "node:path"
import { mkdir } from "node:fs/promises"
import { digest, duration, type Instance } from "./ledger"
import { sealedFile, type finalizeScoring } from "./evaluate"
import type { runInstance } from "./instance"
import type { recognize } from "./recognize"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import type { Transport } from "./provider"
import type { Bootstrap } from "./probe"
import { assertEvaluation } from "./lifecycle-scenarios"
import { stage } from "./accounting"
import { checkedTerminal } from "./terminal"
import type { Infrastructure } from "./infrastructure"

/** V2 development report never applies the legacy mandatory-accept qualification invariant. */
export async function feedbackReport(input: {
  evaluation?: "feedback-v2" | "repair-lifecycle-v1"
  infrastructure?: Infrastructure
  feedbackGuidance?: "closure:1"
  directory: string
  output: string
  codeHash: string
  instances: Instance[]
  rows: { id: string; status: string; evidence?: string }[]
  executionTip: string
}) {
  const evaluation = input.evaluation ?? "feedback-v2"
  const rows = await Promise.all(
    input.instances.map(async (instance) => {
      const row = input.rows.find((item) => item.id === instance.id)
      const terminal =
        input.infrastructure && (await Bun.file(path.join(input.directory, instance.id, "terminal-ref.json")).exists())
          ? await checkedTerminal(path.join(input.directory, instance.id), input.codeHash)
          : undefined
      const fallback = {
        ...(terminal ? { terminal } : {}),
        id: instance.id,
        status: row?.status ?? "not_started",
        resultHash: row?.evidence,
        scoring: "not_scored",
      }
      if (!row?.evidence) return fallback
      const bytes = await Bun.file(path.join(input.directory, "objects", row.evidence)).text()
      if (digest(bytes) !== row.evidence) throw new Error("V2 cohort evidence changed")
      const result = JSON.parse(bytes) as Awaited<ReturnType<typeof runInstance>>
      if (!result.monitored) {
        const wrapper = JSON.parse(bytes) as { instance?: string; retained?: { hash: string }; cleanup?: unknown }
        if (!wrapper.retained && result.feedbackGuidance !== input.feedbackGuidance)
          throw new Error("Unstarted feedback guidance changed")
        if (!wrapper.retained)
          return { ...fallback, failure: wrapper, accountingIncomplete: true, usage: [], admission: "unknown" }
        const retained = await Bun.file(
          path.join(input.directory, instance.id, "archive/objects", wrapper.retained.hash),
        ).text()
        if (digest(retained) !== wrapper.retained.hash) throw new Error("V2 retained failure changed")
        const failure = JSON.parse(retained) as {
          codeHash: string
          contractID?: string
          evaluation: string
          mode: string
          attempted: boolean
          admitted: boolean
          issuedAt: number
          deadline: number
          infrastructure?: Infrastructure
          feedbackGuidance?: "closure:1"
          agreement?: ResearchModel.Input
          bootstrap?: Bootstrap
          records: Transport[]
          transportHash: string
          auditHash?: string
          partial: { status: string; value?: unknown; reason?: string }[]
        }
        if (
          failure.feedbackGuidance !== input.feedbackGuidance ||
          (failure.agreement && failure.agreement.manifest?.feedbackGuidance !== input.feedbackGuidance)
        )
          throw new Error("Failure feedback guidance changed")
        if (JSON.stringify(failure.infrastructure) !== JSON.stringify(input.infrastructure))
          throw new Error("Failure infrastructure policy changed")
        if (
          failure.codeHash !== input.codeHash ||
          failure.evaluation !== evaluation ||
          failure.deadline !== failure.issuedAt + duration ||
          (input.infrastructure && wrapper.instance !== instance.id)
        )
          throw new Error("V2 failure identity or original deadline differs")
        if (input.infrastructure && !failure.agreement && failure.contractID !== "pct_eval_" + instance.id)
          throw new Error("Pre-issuance failure belongs to another instance")
        if (input.infrastructure && !failure.agreement) {
          const attempt = await Bun.file(path.join(input.directory, instance.id, "attempt.json")).json()
          if (
            attempt.contractID !== failure.contractID ||
            attempt.feedbackGuidance !== input.feedbackGuidance ||
            attempt.codeHash !== failure.codeHash ||
            attempt.evaluation !== failure.evaluation ||
            attempt.mode !== failure.mode ||
            attempt.issuedAt !== failure.issuedAt ||
            attempt.deadline !== failure.deadline ||
            JSON.stringify(attempt.infrastructure) !== JSON.stringify(input.infrastructure)
          )
            throw new Error("Pre-issuance attempt identity changed")
          for (const hash of [failure.transportHash, failure.auditHash]) {
            if (!hash) throw new Error("Pre-issuance evidence reference missing")
            const bytes = await Bun.file(path.join(input.directory, instance.id, "archive/objects", hash)).text()
            if (digest(bytes) !== hash) throw new Error("Pre-issuance evidence changed")
          }
          return {
            ...fallback,
            failureHash: wrapper.retained.hash,
            admission: "unknown",
            accountingIncomplete: true,
            usage: [],
            terminal: terminal ?? "not_sealed",
            source: failure.mode,
            issuedAt: failure.issuedAt,
            deadline: failure.deadline,
          }
        }
        if (!failure.agreement) throw new Error("Failure agreement missing")
        if (
          failure.codeHash !== input.codeHash ||
          failure.evaluation !== evaluation ||
          failure.agreement.id !== "pct_eval_" + instance.id ||
          failure.deadline !== failure.issuedAt + duration ||
          failure.agreement.spec.budget.deadline !== failure.deadline
        )
          throw new Error("V2 failure identity or original deadline differs")
        assertEvaluation({ evaluation, manifest: failure.agreement.manifest })
        const transport = await Bun.file(
          path.join(input.directory, instance.id, "archive/objects", failure.transportHash),
        ).text()
        if (digest(transport) !== failure.transportHash) throw new Error("V2 failure transport changed")
        const operations = (
          failure.partial[0]?.status === "fulfilled" ? failure.partial[0].value : []
        ) as ProContractJob.Operation[]
        const runs = (failure.partial[1]?.status === "fulfilled" ? failure.partial[1].value : []) as {
          data: ResearchModel.Run
        }[]
        return {
          ...fallback,
          failureHash: wrapper.retained.hash,
          source: failure.mode,
          admission: failure.admitted ? "admitted" : failure.attempted ? "attempted" : "not_attempted",
          issuedAt: failure.issuedAt,
          deadline: failure.deadline,
          accountingIncomplete: true,
          cleanup: wrapper.cleanup,
          unaccountedTransport: failure.records.filter(
            (item) => item.event && !operations.some((operation) => operation.id === item.event.identity.operationID),
          ),
          usage: operations.map((operation) => ({
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
                item.event.kind === "wire" &&
                item.event.identity.operationID === operation.id,
            ).length,
            origin: operation.id === failure.bootstrap?.identity.operationID ? "script:initial-plan-only" : "host",
            tokens:
              operation.id === failure.bootstrap?.identity.operationID
                ? null
                : (operation.usage.value?.totalTokens ?? null),
            cost: null,
            unknown: operation.id === failure.bootstrap?.identity.operationID || operation.usage.state === "unknown",
          })),
        }
      }
      if (JSON.stringify(result.infrastructure) !== JSON.stringify(input.infrastructure))
        throw new Error("Result infrastructure policy changed")
      if (result.codeHash !== input.codeHash || result.evaluation !== evaluation)
        throw new Error("V2 report execution identity differs")
      assertEvaluation({ evaluation, manifest: result.monitored.run.input.manifest })
      if (
        result.feedbackGuidance !== input.feedbackGuidance ||
        result.monitored.run.input.manifest.feedbackGuidance !== input.feedbackGuidance
      )
        throw new Error("Result feedback guidance changed")
      const directory = path.join(input.directory, instance.id)
      const scoreBytes = (await Bun.file(path.join(directory, "score-ref.json")).exists())
        ? await sealedFile(directory, "score")
        : undefined
      const score = scoreBytes ? (JSON.parse(scoreBytes) as Awaited<ReturnType<typeof finalizeScoring>>) : undefined
      if (score && (!("evaluation" in score) || score.evaluation !== evaluation || score.resultHash !== row.evidence))
        throw new Error("V2 score belongs to another result or policy")
      const recognition = (await Bun.file(path.join(directory, "recognition.json")).exists())
        ? ((await Bun.file(path.join(directory, "recognition.json")).json()) as Awaited<ReturnType<typeof recognize>>)
        : undefined
      if (recognition && (!scoreBytes || recognition.scoreHash !== digest(scoreBytes)))
        throw new Error("Recognition binds another score")
      return {
        ...fallback,
        ...(terminal ? { terminal } : {}),
        source: result.mode,
        firstAttempt: result.monitored.firstReview,
        ready: result.monitored.run.stage === "ready",
        dimensions: score?.dimensions,
        scoreHash: scoreBytes ? digest(scoreBytes) : null,
        recognition: recognition ?? null,
        usage: result.usage,
        issuedAt: result.issuedAt,
        deadline: result.deadline,
        scoring: score ? "scored" : "not_scored",
      }
    }),
  )
  const value = {
    evaluation,
    ...(input.infrastructure ? { infrastructure: input.infrastructure, sealingRule: "candidate-or-terminal:1" } : {}),
    ...(input.feedbackGuidance ? { feedbackGuidance: input.feedbackGuidance } : {}),
    mode: "development-calibration",
    denominator: input.instances.length,
    codeHash: input.codeHash,
    rows,
    executionTip: input.executionTip,
    qualification: "not_run",
    capabilityClaim: "Development observations only; local-fixture results establish wiring, not model capability",
  }
  await mkdir(input.output, { recursive: false, mode: 0o700 })
  await Bun.write(path.join(input.output, "report.json"), JSON.stringify(value, null, 2) + "\n")
  return value
}
