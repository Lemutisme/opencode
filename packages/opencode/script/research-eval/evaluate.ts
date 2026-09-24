import { mkdir, open } from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import type { runInstance } from "./instance"
import type { Oracle, Packet } from "./corpus"
import type { Annotation, Finding } from "./score"
import { prepare, seal, unseal } from "./blind"
import { adjudicate, score } from "./score"
import { candidate } from "./isolation"
import { objective } from "./oracle"
import { digest } from "./ledger"
import { put } from "./archive"
import { codeIdentity } from "./provenance"
import { dimensions } from "./feedback-score"
import { diagnostic } from "./diagnostic"
import { feedbackMaterials, feedbackMeasures } from "./feedback-evaluate"
import { lifecycleMaterials, lifecycleMeasures } from "./lifecycle-evaluate"
import { assertEvaluation } from "./lifecycle-scenarios"
import { checkedTerminal } from "./terminal"
import { lifecycleRevealGate, requireLifecycleAdjudication } from "./lifecycle-blind"
import { ResearchFeedback } from "../../../sdk-next/src/research/review-feedback"

type Result = Awaited<ReturnType<typeof runInstance>>

export async function sealedFile(directory: string, name: "scoring" | "score") {
  const reference = (await Bun.file(path.join(directory, name + "-ref.json")).json()) as { hash: string }
  const bytes = await Bun.file(path.join(directory, name + ".json")).text()
  const retained = await Bun.file(path.join(directory, "archive/objects", reference.hash)).text()
  if (digest(bytes) !== reference.hash || bytes !== retained) throw new Error("Sealed " + name + " changed")
  return bytes
}

export function rubric(oracle: Oracle) {
  if (oracle.entry !== "plan") return oracle.rubric
  return {
    scope: "The execution plan preserves the original goal, fixed data/method, acceptance, authority and deadline.",
    method:
      "No fitting is required for the fixed primary effect. Any proposed exploratory fitting uses train, selection uses validation and independent evaluation uses held-out test once. A plan that chooses test data for selection and calls the same test independent is defective even when labelled exploratory.",
    controls:
      "The planned comparison uses identical data and compute conditions and distinguishes performed from proposed controls.",
    evaluation:
      "Keep every primaryID and the prespecified all-pair two-unit primary criterion. Exploratory diagnostics cannot replace it; the diagnostic split is not the population of the fixed descriptive primary effect.",
    feasibility:
      "Assess the proposed implementation and future verification, including obligations beyond fixed smoke tests. Candidate files are pre-execution background: missing future reports and generated artifacts do not make a feasible plan incorrect. Real ambiguities or unaddressed obligations still block. Public observation IDs, method-array indices and disjoint splits must be consistent.",
  }
}

/** Build phase one from retained subject bytes, never the mutable worker directory. */
export async function prepareScoring(input: {
  directory: string
  result: Result
  packet: Packet
  oracle: Oracle
  launcher: string
  timeout: number
}) {
  const run = input.result.monitored.run
  assertEvaluation({
    evaluation: input.result.evaluation,
    scenario: input.packet.version,
    manifest: run.input.manifest,
  })
  const v2 = !!input.result.evaluation
  const planOnly = !v2 && input.oracle.entry === "plan"
  if (input.result.codeHash !== (await codeIdentity()))
    throw new Error("Scoring code differs from the executed frozen runtime")
  const archive = path.join(input.directory, "archive")
  const object = async (hash: string) => {
    const bytes = await Bun.file(path.join(archive, "objects", hash)).text()
    if (digest(bytes) !== hash) throw new Error("Scoring object identity mismatch")
    return bytes
  }
  const files: Record<string, string> = {}
  const rawEvidence: Record<string, string> = {}
  const snapshot = input.result.monitored.evidence.snapshots.find(
    (item) => item.identity === (planOnly ? run.plan?.subjectHash : run.subjectHash),
  )
  if (!snapshot && (!v2 || run.subjectHash)) throw new Error("No retained candidate for blind scoring")
  if (!snapshot) rawEvidence["delivery.json"] = JSON.stringify({ status: "not_submitted", quality: "indeterminate" })
  if (snapshot) {
    const tar = path.join(archive, "objects", snapshot.archiveHash)
    if (digest(new Uint8Array(await Bun.file(tar).arrayBuffer())) !== snapshot.archiveHash)
      throw new Error("Candidate archive changed")
    for (const file of Object.keys(input.packet.files)) {
      const child = Bun.spawn(["tar", "-xOf", tar, "--", file], { stdout: "pipe", stderr: "pipe" })
      const timer = setTimeout(() => child.kill("SIGKILL"), input.timeout)
      const chunks: Uint8Array[] = []
      const size = { bytes: 0 }
      const reader = child.stdout.getReader()
      while (true) {
        const next = await reader.read()
        if (next.done) break
        const chunk = next.value
        size.bytes += chunk.length
        if (size.bytes > 16 * 1024 * 1024) {
          child.kill("SIGKILL")
          break
        }
        chunks.push(chunk)
      }
      const exit = await child.exited
      clearTimeout(timer)
      if (exit || size.bytes > 16 * 1024 * 1024)
        throw new Error("Candidate file missing or exceeds scoring operation limit")
      files[file] = Buffer.concat(chunks).toString("utf8")
    }
  }
  if (run.plan) files["plan.json"] = JSON.stringify(run.plan.value)
  const external = {
    value: undefined as (ReturnType<typeof objective> & { diagnostic?: boolean }) | undefined,
    diagnostic: undefined as Awaited<ReturnType<typeof diagnostic>> | undefined,
  }
  if (snapshot && !planOnly && run.verificationHash) {
    const verification = JSON.parse(await object(run.verificationHash)) as ResearchModel.Verification
    const evidence = verification.evidence.find((item) => item.path === "artifacts/result.json")
    if (!evidence) throw new Error("Frozen verification has no result artifact")
    rawEvidence["result.json"] = await object(evidence.hash)
    const directory = path.join(input.directory, "candidate-execution")
    await mkdir(directory, { mode: 0o700 })
    const output = await candidate({
      launcher: input.launcher,
      directory,
      source: files["analysis.mjs"],
      inputs: input.oracle.inputs,
      timeout: input.timeout,
    })
    external.value = objective(input.oracle, {
      report: files["report.json"],
      raw: rawEvidence["result.json"],
      values: output.values,
    })
    if (v2 && input.oracle.instance.family === "P1") {
      external.diagnostic = await diagnostic({
        launcher: input.launcher,
        directory: path.join(input.directory, "diagnostic-execution"),
        source: files["analysis.mjs"],
        report: files["report.json"],
        raw: rawEvidence["result.json"],
        data: JSON.parse(input.packet.files["data.json"]),
        timeout: input.timeout,
      })
      external.value.diagnostic = external.diagnostic.valid
      rawEvidence["diagnostic-execution.json"] = JSON.stringify(external.diagnostic)
    }
    await put(archive, { output, objective: external.value, diagnostic: external.diagnostic })
  }
  const blind = await prepare(path.join(input.directory, "blind"), {
    agreement: input.packet.brief,
    files,
    rawEvidence,
    rubric: v2 ? input.oracle.rubric : rubric(input.oracle),
  })
  const value = {
    ...(v2
      ? { evaluation: input.result.evaluation, diagnostic: external.diagnostic, candidateAvailable: !!snapshot }
      : {}),
    codeHash: input.result.codeHash,
    ...blind,
    objective: external.value,
    subjectHash: snapshot?.identity ?? "unsubmitted:" + run.id,
    bundleHash: run.bundleHash,
    resultHash: await put(archive, input.result),
    oracleHash: await put(archive, input.oracle),
    readyAt: input.result.monitored.history.find((item) => item.stage === "ready")?.at,
  }
  const file = await open(path.join(input.directory, "scoring.json"), "wx", 0o600)
  await file.writeFile(JSON.stringify(value, null, 2) + "\n")
  await file.sync()
  await file.close()
  const reference = await open(path.join(input.directory, "scoring-ref.json"), "wx", 0o600)
  await reference.writeFile(JSON.stringify({ hash: await put(archive, value) }) + "\n")
  await reference.sync()
  await reference.close()
  return value
}

/** Seal candidate-only judgments before creating any reviewer-facing materials. */
export async function sealCandidate(input: {
  directory: string
  first: Annotation
  second: Annotation
  resolution?: Annotation
}) {
  const bound = JSON.parse(await sealedFile(input.directory, "scoring")) as Awaited<ReturnType<typeof prepareScoring>>
  if (bound.codeHash !== (await codeIdentity())) throw new Error("Candidate scoring code changed after freeze")
  const bytes = await Bun.file(path.join(input.directory, "archive/objects", bound.resultHash)).text()
  if (digest(bytes) !== bound.resultHash) throw new Error("Scoring input changed")
  const result = JSON.parse(bytes) as Result
  assertEvaluation({ evaluation: result.evaluation, manifest: result.monitored.run.input.manifest })
  if (result.infrastructure && !bound.candidateAvailable)
    throw new Error("No candidate: use seal-terminal, not quality ratings")
  if (result.evaluation === "repair-lifecycle-v1") requireLifecycleAdjudication(input)
  await seal(path.join(input.directory, "blind"), input.first, input.second, input.resolution)
  if (result.evaluation === "repair-lifecycle-v1")
    return {
      pending: true,
      raw: "",
      candidateHash: bound.candidateHash,
      rubricHash: bound.rubricHash,
      rubric: {} as Record<string, string>,
      findingIDs: [] as string[],
    }
  await unseal(path.join(input.directory, "blind"), result.monitored.raw)
  if (result.evaluation === "feedback-v2") {
    const oracleBytes = await Bun.file(path.join(input.directory, "archive/objects", bound.oracleHash)).text()
    if (digest(oracleBytes) !== bound.oracleHash) throw new Error("Oracle changed")
    const value = await feedbackMaterials(result, JSON.parse(oracleBytes), async (hash, raw) => {
      const bytes = await Bun.file(path.join(input.directory, "archive/objects", hash)).text()
      if (digest(bytes) !== hash) throw new Error("Feedback object changed")
      return raw ? bytes : JSON.parse(bytes)
    })
    const file = await open(path.join(input.directory, "blind/reviewer.json"), "wx", 0o600)
    await file.writeFile(JSON.stringify(value, null, 2) + "\n")
    await file.sync()
    await file.close()
    return value
  }
  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(
      Schema.UnknownFromJsonString.pipe(
        Schema.decodeTo(Schema.Struct({ findings: Schema.Array(Schema.Struct({ id: Schema.String })) })),
      ),
    )(result.monitored.raw),
  )
  const findingIDs = decoded?.findings.map((item) => item.id) ?? []
  const dimensions = ["located", "mechanism", "consequence", "supported", "target"]
  const rubric = {
    semanticConsistent: "The raw verdict agrees with its reasons and claims.",
    ...Object.fromEntries(
      findingIDs.flatMap((id) => dimensions.map((dimension) => [`${id}.${dimension}`, `${dimension}: ${id}`])),
    ),
  }
  const value = {
    raw: result.monitored.raw,
    candidateHash: digest(result.monitored.raw),
    rubric,
    rubricHash: digest(JSON.stringify(rubric)),
    findingIDs,
  }
  const file = await open(path.join(input.directory, "blind/reviewer.json"), "wx", 0o600)
  await file.writeFile(JSON.stringify(value, null, 2) + "\n")
  await file.sync()
  await file.close()
  return value
}

/** Phase two judgments bind the revealed reviewer message; raw accept keeps priority. */
export async function finalizeScoring(input: {
  directory: string
  first: Annotation
  second: Annotation
  resolution?: Annotation
}) {
  const bound = JSON.parse(await sealedFile(input.directory, "scoring")) as Awaited<ReturnType<typeof prepareScoring>>
  if (bound.codeHash !== (await codeIdentity())) throw new Error("Reviewer scoring code changed after freeze")
  const object = async (hash: string): Promise<unknown> => {
    const bytes = await Bun.file(path.join(input.directory, "archive/objects", hash)).text()
    if (digest(bytes) !== hash) throw new Error("Scoring input changed")
    return JSON.parse(bytes)
  }
  const result = (await object(bound.resultHash)) as Result
  assertEvaluation({ evaluation: result.evaluation, manifest: result.monitored.run.input.manifest })
  if (result.evaluation === "repair-lifecycle-v1") {
    requireLifecycleAdjudication(input)
    await lifecycleRevealGate(input.directory, result)
  }
  const oracle = (await object(bound.oracleHash)) as Oracle
  if (result.infrastructure && !bound.candidateAvailable)
    return finalizeFeedback(input, bound, result, oracle, {
      verdict: "indeterminate",
      absence: await checkedTerminal(input.directory, result.codeHash),
    })
  const candidate = await unseal(path.join(input.directory, "blind"), result.monitored.raw)
  if (result.evaluation) return finalizeFeedback(input, bound, result, oracle, candidate.phaseOne)
  const reviewer = adjudicate(input.first, input.second, input.resolution)
  // Reviewer annotations bind the revealed raw message and the complete semantic rubric.
  const revealed = (await Bun.file(path.join(input.directory, "blind/reviewer.json")).json()) as Awaited<
    ReturnType<typeof sealCandidate>
  >
  const findingIDs = revealed.findingIDs
  const criteria = ["located", "mechanism", "consequence", "supported", "target"] as const
  const rubric = {
    semanticConsistent: "The raw verdict agrees with its reasons and claims.",
    ...Object.fromEntries(
      findingIDs.flatMap((id) => criteria.map((dimension) => [`${id}.${dimension}`, `${dimension}: ${id}`])),
    ),
  }
  if (
    input.first.candidateHash !== digest(result.monitored.raw) ||
    input.first.rubricHash !== digest(JSON.stringify(rubric)) ||
    JSON.stringify(Object.keys(reviewer.items).sort()) !== JSON.stringify(Object.keys(rubric).sort())
  )
    throw new Error("Reviewer annotations do not bind the revealed message and complete rubric")
  const findings: Finding[] = findingIDs.map((id) => ({
    id,
    ...Object.fromEntries(criteria.map((key) => [key, reviewer.items[`${id}.${key}`] === true])),
  })) as Finding[]
  const verdict =
    candidate.phaseOne.verdict === "incorrect" || (bound.objective && Object.values(bound.objective).includes(false))
      ? "incorrect"
      : candidate.phaseOne.verdict === "indeterminate" || (oracle.entry !== "plan" && !bound.objective)
        ? "indeterminate"
        : "correct"
  const probe = {
    ...result.monitored.observed,
    entry: oracle.entry === "plan" ? ("plan" as const) : ("final" as const),
    raw: result.monitored.raw,
    defective: oracle.entry === "research" ? verdict === "incorrect" : oracle.instance.defective,
    findings,
    semanticConsistent: reviewer.items.semanticConsistent === true,
    mechanicalBlock: false,
    gateReason: result.monitored.run.stage,
  }
  const measured = score(probe)
  if (oracle.entry === "research" && verdict === "indeterminate" && measured.label === "valid_accept")
    measured.label = "unavailable"
  const feedback = await Promise.all(
    (result.monitored.run.feedbackHistory ?? []).map(async (item) => {
      const outcome = Schema.decodeUnknownSync(ResearchFeedback.Outcome)(await object(item.outcomeHash))
      const response = item.responseHash
        ? Schema.decodeUnknownSync(ResearchFeedback.Response)(await object(item.responseHash))
        : undefined
      if (
        outcome.phase !== item.phase ||
        outcome.contractID !== result.monitored.run.id ||
        (response && ResearchFeedback.validateResponse(outcome, response))
      )
        throw new Error("Feedback scoring identity differs from the retained review outcome")
      return { ...item, availability: outcome.availability, findings: outcome.review?.findings ?? [], response }
    }),
  )
  const targetHash = oracle.entry === "plan" ? result.monitored.run.plan?.reportHash : result.monitored.run.reviewHash
  const review =
    result.monitored.run.input.manifest.reviewPolicy?.version === 2 && targetHash
      ? {
          outcomeHash: targetHash,
          outcome: Schema.decodeUnknownSync(ResearchFeedback.Outcome)(await object(targetHash)),
        }
      : undefined
  const references = review
    ? Schema.decodeUnknownSync(ResearchFeedback.References)(await object(review.outcome.referencesHash))
    : undefined
  const value = {
    resultHash: bound.resultHash,
    subjectHash: bound.subjectHash,
    bundleHash: bound.bundleHash,
    phaseOne: candidate.phaseOne,
    reviewer,
    measured,
    dimensions: dimensions({
      reviewer: probe,
      reviewerTruth: oracle.entry === "research" && verdict === "indeterminate" ? "indeterminate" : "known",
      ...(review && references ? { review: { ...review, references } } : {}),
      feedback: { applicable: result.monitored.run.input.manifest.reviewPolicy?.version === 2, records: feedback },
      delivery: {
        candidateHash: bound.subjectHash,
        quality: verdict,
        bundleHash: bound.bundleHash,
        readyAt: bound.readyAt,
        attestedAt: null,
      },
    }),
    verdict,
    readyAt: bound.readyAt,
    scoredAt: Date.now(),
    attestedAt: null,
    qualification: "pending_cohort_review",
  } as const
  const file = await open(path.join(input.directory, "score.json"), "wx", 0o600)
  await file.writeFile(JSON.stringify(value, null, 2) + "\n")
  await file.sync()
  await file.close()
  const reference = await open(path.join(input.directory, "score-ref.json"), "wx", 0o600)
  await reference.writeFile(JSON.stringify({ hash: await put(path.join(input.directory, "archive"), value) }) + "\n")
  await reference.sync()
  await reference.close()
  return value
}

async function finalizeFeedback(
  input: { directory: string; first: Annotation; second: Annotation; resolution?: Annotation },
  bound: Awaited<ReturnType<typeof prepareScoring>>,
  result: Result,
  oracle: Oracle,
  phaseOne:
    | ReturnType<typeof adjudicate>
    | { verdict: "indeterminate"; absence: Awaited<ReturnType<typeof checkedTerminal>> },
) {
  const object = async (hash: string, raw?: boolean) => {
    const bytes = await Bun.file(path.join(input.directory, "archive/objects", hash)).text()
    if (digest(bytes) !== hash) throw new Error("Feedback object changed")
    return raw ? bytes : JSON.parse(bytes)
  }
  const material =
    result.evaluation === "repair-lifecycle-v1"
      ? await lifecycleMaterials(result, oracle, object, input.directory)
      : await feedbackMaterials(result, oracle, object)
  const revealed = await Bun.file(path.join(input.directory, "blind/reviewer.json")).text()
  if (revealed !== JSON.stringify(material, null, 2) + "\n") throw new Error("Revealed v2 material changed")
  const verdict = !bound.candidateAvailable
    ? "indeterminate"
    : phaseOne.verdict === "incorrect" || (bound.objective && Object.values(bound.objective).includes(false))
      ? "incorrect"
      : phaseOne.verdict === "indeterminate" || !bound.objective
        ? "indeterminate"
        : "correct"
  const measured =
    "lifecycle" in material.material
      ? lifecycleMeasures({
          result,
          oracle,
          material: material as Awaited<ReturnType<typeof lifecycleMaterials>>,
          ratings: input,
          diagnostic: bound.diagnostic,
          verdict,
        })
      : feedbackMeasures({ result, oracle, material, ratings: input, diagnostic: bound.diagnostic, verdict })
  const value = {
    evaluation: result.evaluation!,
    resultHash: bound.resultHash,
    subjectHash: bound.subjectHash,
    bundleHash: bound.bundleHash,
    phaseOne,
    reviewer: adjudicate(input.first, input.second, input.resolution),
    measured: {
      label: measured.finalReviewer.label,
      structure: "structure" in measured.finalReviewer && measured.finalReviewer.structure,
      evidence: "evidence" in measured.finalReviewer && measured.finalReviewer.evidence,
      mechanismFailure: false,
    },
    dimensions: measured,
    verdict,
    readyAt: bound.readyAt,
    scoredAt: Date.now(),
    attestedAt: null,
    qualification: "not_run",
  } as const
  const file = await open(path.join(input.directory, "score.json"), "wx", 0o600)
  await file.writeFile(JSON.stringify(value, null, 2) + "\n")
  await file.sync()
  await file.close()
  const reference = await open(path.join(input.directory, "score-ref.json"), "wx", 0o600)
  await reference.writeFile(JSON.stringify({ hash: await put(path.join(input.directory, "archive"), value) }) + "\n")
  await reference.sync()
  await reference.close()
  return value
}

/** Explicit fifth-round reveal, gated on all model-cohort candidate judgments. */
export async function revealFeedback(directory: string) {
  const bound = JSON.parse(await sealedFile(directory, "scoring")) as Awaited<ReturnType<typeof prepareScoring>>
  if (bound.codeHash !== (await codeIdentity())) throw new Error("Lifecycle reveal code changed after freeze")
  const object = async (hash: string, raw?: boolean) => {
    const bytes = await Bun.file(path.join(directory, "archive/objects", hash)).text()
    if (digest(bytes) !== hash) throw new Error("Lifecycle reveal object changed")
    return raw ? bytes : JSON.parse(bytes)
  }
  const result = (await object(bound.resultHash)) as Result
  if (result.evaluation !== "repair-lifecycle-v1") throw new Error("Separate reveal requires lifecycle evaluation")
  await lifecycleRevealGate(directory, result)
  const value = await lifecycleMaterials(result, (await object(bound.oracleHash)) as Oracle, object, directory)
  const file = await open(path.join(directory, "blind/reviewer.json"), "wx", 0o600)
  await file.writeFile(JSON.stringify(value, null, 2) + "\n")
  await file.sync()
  await file.close()
  return value
}
