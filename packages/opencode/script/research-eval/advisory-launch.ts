import path from "node:path"
import { mkdir, open } from "node:fs/promises"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import { freezeAdvisory, checkAdvisory, object, runtimeMatches } from "./advisory-config"
import { InstanceScoring, type Freeze } from "./instance-scoring"
import { rateAdvisory } from "./advisory-rater"
import { prepareAdvisoryArchive } from "./advisory-archive"
import { failureScope, measures, type Judgment } from "./advisory-measurement"
import { runInstance } from "./instance"
import type { hostEvidence } from "./host-evidence"
import { put } from "./archive"
import { checkObservation } from "./advisory-observation"
import { observeAdvisory } from "./advisory-opinions"

type Audit = Awaited<ReturnType<typeof hostEvidence>>

/** Shared production/fixture path. Never reads oracle answers to steer research. */
export async function launchAdvisory(value: unknown, output: string, signal: AbortSignal) {
  const directory = path.resolve(output)
  const checked = await checkAdvisory(value)
  const config = checked.config
  if (
    [config.worker, config.reviewer, ...Object.values(config.raters).map((item) => item.model)].some(
      (model) => model.credentialEnv !== null && !process.env[model.credentialEnv]?.trim(),
    )
  )
    throw new Error("Frozen provider credential source unavailable before any instance attempt")
  await mkdir(directory, { recursive: false, mode: 0o700 })
  const registry = checked.frozen.examples.map((example) => {
    const context = (rater: string) => ({ id: crypto.randomUUID(), execution: crypto.randomUUID(), rater })
    return {
      id: example.packet.id,
      files: Object.keys(example.packet.files).sort(),
      roles: {
        candidate: [context(config.raters.first.id), context(config.raters.second.id)],
        candidateAdjudicator: context(config.raters.adjudicator.id),
        feedback: [context(config.raters.first.id), context(config.raters.second.id)],
        feedbackAdjudicator: context(config.raters.adjudicator.id),
      } satisfies Freeze["instances"][number]["roles"],
    }
  })
  const cohortHash = await put(directory, {
    version: config.version,
    freeze: checked.pointer,
    registry,
    at: Date.now(),
  })
  await Bun.write(path.join(directory, "cohort.json"), JSON.stringify({ hash: cohortHash }, null, 2) + "\n")
  const events = await open(path.join(directory, "events.jsonl"), "wx", 0o600)
  const state = { stopped: false, previous: cohortHash }
  const rows: {
    id: string
    status: string
    evidence?: string
    ratings: { execution: string; phase: string; result: Awaited<ReturnType<typeof rateAdvisory>> }[]
    measurement: ReturnType<InstanceScoring["report"]>["rows"][number]
  }[] = []
  const persist = async (row: (typeof rows)[number]) => {
    const event = { previous: state.previous, at: Date.now(), row }
    state.previous = await put(directory, event)
    await events.writeFile(JSON.stringify({ ...event, hash: state.previous }) + "\n")
    await events.sync()
  }
  try {
    for (const registered of registry) {
      const row: (typeof rows)[number] = {
        id: registered.id,
        status: "not_started",
        ratings: [],
        measurement: {
          id: registered.id,
          ...measures({
            candidate: undefined,
            feedback: undefined,
            candidateStatus: "unknown",
            rubric: config.version === "advisory-observation:1" ? {} : checked.frozen.rubric,
            audit: { status: "not_scored" },
            infrastructure: {
              status: "not_started",
              reason: signal.aborted ? "explicit_cancel" : "shared_safety_unknown",
            },
          }),
          version: checked.frozen.measurement,
          ...(config.version === "advisory-observation:1" ? { formalScoring: "not_run" } : {}),
          candidateSeal: undefined,
          feedbackSeal: undefined,
        },
      }
      rows.push(row)
      if (signal.aborted || state.stopped) {
        await persist(row)
        continue
      }
      const example = checked.frozen.examples.find((item) => item.packet.id === registered.id)!
      const instance = path.join(directory, registered.id)
      const outcome = await runInstance({
        mode: config.mode,
        directory: instance,
        packet: example.packet,
        entry: "research",
        evaluation: "advisory-v3",
        infrastructure: config.infrastructure,
        fixtureFault: config.fixtureFaults?.[registered.id],
        routes: {
          worker: {
            ...config.worker,
            credential: config.worker.credentialEnv === null ? null : (process.env[config.worker.credentialEnv] ?? ""),
          },
          reviewer: {
            ...config.reviewer,
            credential:
              config.reviewer.credentialEnv === null ? null : (process.env[config.reviewer.credentialEnv] ?? ""),
          },
        },
        limits: { worker: config.worker, reviewer: config.reviewer },
        timeouts: config.timeouts,
        bun: config.bun,
        node: config.node,
        signal,
        frozenCode: checked.frozen.runner,
      }).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error: String(error) }),
      )
      const archive = path.join(instance, "archive")
      const retained = await (async () => {
        if (outcome.result)
          return {
            result: outcome.result,
            failure: undefined,
            audit: outcome.result.auditHash ? await object<Audit>(archive, outcome.result.auditHash) : undefined,
          }
        const ref = (await Bun.file(path.join(instance, "failure.json")).json()) as { hash: string }
        const failure = await object<{ auditHash?: string; agreement?: ResearchModel.Input; transportHash?: string }>(
          archive,
          ref.hash,
        )
        return {
          result: undefined,
          failure: { hash: ref.hash, ...failure },
          audit: failure.auditHash ? await object<Audit>(archive, failure.auditHash) : undefined,
        }
      })().catch((error: unknown) => ({ result: outcome.result, failure: { reason: String(error) }, audit: undefined }))
      const inspection = await checkObservation({
        directory: instance,
        checked,
        packet: example.packet,
        result: outcome.result,
      }).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error: String(error) }),
      )
      const audit = inspection.value?.audit ?? retained.audit
      const confirmed = inspection.value?.confirmed === true
      const intact = await runtimeMatches(checked.frozen.runner)
      const infrastructure = {
        status: outcome.error
          ? "failed"
          : outcome.result?.monitored.cancelled
            ? "cancelled"
            : outcome.result?.monitored.timedOut
              ? "deadline"
              : "completed",
        failure: outcome.error,
        observationError: inspection.error,
        retained: retained.failure,
        audit,
        scope: failureScope({
          phase: "research",
          operation: confirmed ? "stopped" : "unknown",
          cleanup: confirmed ? "confirmed" : "unknown",
          isolation: "instance",
          integrity: intact ? "intact" : "broken",
          evidence: [await put(directory, retained)],
        }),
        accounting: {
          original: audit && "operations" in audit ? audit.operations : undefined,
          reported: outcome.result?.usage,
          transportHash:
            outcome.result?.transportHash ??
            (retained.failure && "transportHash" in retained.failure ? retained.failure.transportHash : undefined),
          supplements: [],
          reconciliation: "not_performed",
          completeness: "unknown",
          liveRace: "unresolved",
        },
      }
      state.stopped = infrastructure.scope.scope === "shared"
      row.evidence = await put(directory, { outcome, infrastructure })
      row.status = outcome.error ? "infrastructure_failure" : infrastructure.status
      try {
        if (!intact) throw new Error("Frozen runtime changed; no new measurement grants or requests")
        if (!inspection.value) throw new Error(inspection.error)
        if (config.version === "advisory-observation:1") {
          row.measurement = await observeAdvisory({
            directory: instance,
            checked,
            registered,
            result: outcome.result,
            inspection: inspection.value,
            infrastructure,
            evidence: row.evidence!,
            signal,
          })
          if (!(await runtimeMatches(checked.frozen.runner))) state.stopped = true
          await persist(row)
          continue
        }
        const agreement = inspection.value.agreement
        const admission = inspection.value.attempt
        const freeze: Freeze = {
          version: "advisory-measurement:1",
          reveal: "instance-isolated:1",
          codeHash: checked.frozen.runner,
          unavailable: "not_scored",
          rubric: checked.frozen.rubric,
          instances: [
            {
              ...registered,
              contractID: agreement.id!,
              agreementHash: ProContractRecognition.fingerprint(agreement),
              started: admission.issuedAt,
              deadline: admission.deadline,
            },
          ],
        }
        await Bun.write(
          path.join(instance, "measurement-freeze.json"),
          JSON.stringify({ cohortHash, freeze }, null, 2) + "\n",
        )
        const scoring = new InstanceScoring(path.join(instance, "measurement.sqlite"), freeze)
        try {
          const candidate = outcome.result?.monitored.run
          if (candidate?.stage === "ready") {
            const exported = await prepareAdvisoryArchive({
              directory: archive,
              archiveHash: outcome.result!.monitored.evidence.hash,
              files: registered.files,
              timeout: config.timeouts.extraction,
            })
            scoring.prepare(row.id, { ...exported, infrastructure })
          } else {
            if (
              !audit ||
              audit.state !== "stable_copy" ||
              !audit.runs ||
              !audit.history ||
              !audit.operations ||
              !audit.preparation ||
              !audit.contracts ||
              !confirmed
            )
              throw new Error("Terminal observation is not exhaustive or cleanup remains unknown")
            const runs = [...audit.runs, ...audit.history.map((item) => item.data)]
            // Ledger usage may remain unknown after the supervisor proves every process stopped.
            scoring.terminal(
              row.id,
              {
                agreement,
                ...(outcome.result ? { result: outcome.result } : {}),
                reason: outcome.error ?? candidate?.reason ?? candidate?.stage ?? "issuance_failed",
                inspection: {
                  contractID: agreement.id!,
                  at: audit.capturedAt,
                  stopped: "confirmed",
                  cleanup: "confirmed",
                  exhaustive: true,
                  runs,
                  pendingOperations: [],
                },
              },
              { reason: outcome.error, runs, evidence: retained, accounting: infrastructure.accounting },
              infrastructure,
            )
          }
          await scoreInstance({
            scoring,
            registered,
            config,
            directory: path.join(instance, "ratings"),
            signal,
            codeHash: checked.frozen.runner,
            records: row.ratings,
          })
        } catch (error) {
          scoring.gap(row.id, String(error), { evidence: row.evidence })
        } finally {
          row.measurement = scoring.report().rows[0]
          scoring.close()
        }
      } catch (error) {
        row.measurement.infrastructure = {
          facts: infrastructure,
          gaps: [{ reason: String(error), evidence: row.evidence }],
        }
      }
      if (!(await runtimeMatches(checked.frozen.runner))) state.stopped = true
      await persist(row)
    }
    const report = {
      version: config.version,
      mode: config.mode,
      freeze: checked.pointer,
      denominator: registry.length,
      measurement: checked.frozen.measurement,
      reveal: checked.frozen.reveal,
      rows,
      finalEvent: state.previous,
      qualification: "not_run",
      externalRecognition: "not_run",
      realModelCapability: config.mode === "local-fixture" ? "not_measured" : "requires_independent_interpretation",
    }
    await Bun.write(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n")
    return report
  } finally {
    await events.close()
  }
}

async function scoreInstance(input: {
  scoring: InstanceScoring
  registered: Pick<Freeze["instances"][number], "id" | "roles">
  config: Awaited<ReturnType<typeof checkAdvisory>>["config"]
  directory: string
  signal: AbortSignal
  codeHash: string
  records: { execution: string; phase: string; result: Awaited<ReturnType<typeof rateAdvisory>> }[]
}) {
  await mkdir(input.directory, { recursive: false, mode: 0o700 })
  for (const phase of ["candidate", "feedback"] as const) {
    if (phase === "candidate" && input.scoring.report().rows[0].researchResult.candidate === "absent") continue
    const roles = input.registered.roles
    const pair = phase === "candidate" ? roles.candidate : roles.feedback
    const judgments: Judgment[] = []
    for (const [index, context] of pair.entries()) {
      if (input.signal.aborted) throw new Error("Scoring cancelled; no further material exposure")
      if (!(await runtimeMatches(input.codeHash))) throw new Error("Frozen scoring runtime changed")
      const grant = input.scoring.grant(input.registered.id, phase, context.id)
      const rated = await rateAdvisory({
        ...input,
        grant,
        model: index === 0 ? input.config.raters.first.model : input.config.raters.second.model,
      })
      input.records.push({ execution: context.execution, phase, result: rated })
      if (!(await runtimeMatches(input.codeHash))) throw new Error("Frozen scoring runtime changed")
      if (!rated.judgment) {
        input.scoring.gap(input.registered.id, "Independent scorer unavailable", rated)
        continue
      }
      input.scoring.rate(grant.receipt, rated.judgment)
      judgments.push(rated.judgment)
    }
    if (judgments.length !== 2) throw new Error("Two independent judgments unavailable; phase remains unsealed")
    if (
      Object.keys(judgments[0].items).some(
        (key) =>
          judgments[0].items[key].status !== judgments[1].items[key].status ||
          judgments[0].items[key].value !== judgments[1].items[key].value,
      )
    ) {
      if (input.signal.aborted) throw new Error("Scoring cancelled before adjudication")
      const context = phase === "candidate" ? roles.candidateAdjudicator : roles.feedbackAdjudicator
      if (!(await runtimeMatches(input.codeHash))) throw new Error("Frozen scoring runtime changed")
      const grant = input.scoring.grant(input.registered.id, phase, context.id)
      const rated = await rateAdvisory({ ...input, grant, model: input.config.raters.adjudicator.model })
      input.records.push({ execution: context.execution, phase, result: rated })
      if (!(await runtimeMatches(input.codeHash))) throw new Error("Frozen scoring runtime changed")
      if (!rated.judgment) throw new Error("Independent adjudicator unavailable; phase remains unsealed")
      input.scoring.rate(grant.receipt, rated.judgment)
    }
    if (!(await runtimeMatches(input.codeHash))) throw new Error("Frozen scoring runtime changed")
    input.scoring.seal(input.registered.id, phase)
  }
}

if (import.meta.main) {
  const [command, config, output] = process.argv.slice(2)
  if (!config || !["freeze", "check", "run"].includes(command) || (command !== "check" && !output))
    throw new Error(
      "Usage: bun advisory-launch.ts freeze SETUP.json NEW_FREEZE | check DEPLOYMENT.json | run DEPLOYMENT.json NEW_BATCH",
    )
  const controller = new AbortController()
  process.once("SIGINT", () => controller.abort())
  process.once("SIGTERM", () => controller.abort())
  console.log(
    JSON.stringify(
      command === "freeze"
        ? await freezeAdvisory(await Bun.file(config).json(), output)
        : command === "check"
          ? await checkAdvisory(await Bun.file(config).json())
          : await launchAdvisory(await Bun.file(config).json(), output, controller.signal),
      null,
      2,
    ),
  )
}
