export * as ResearchAdvisoryControl from "./advisory-control"

import { isUtf8 } from "node:buffer"
import { Clock, Effect, Schema } from "effect"
import { ProContract } from "@opencode-ai/core/pro-contract"
import type { ProContractDelivery } from "@opencode-ai/core/pro-contract/delivery"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { ResearchAdvisoryProtocol } from "./advisory-protocol"
import { ResearchFeedback } from "./review-feedback"
import { ResearchFeedbackEvidence } from "./feedback-evidence"
import { ResearchModel } from "./model"
import { ResearchPlanning } from "./planning"
import { ResearchProtocol } from "./protocol"
import { ResearchStore } from "./store"

type Input = Parameters<NonNullable<ProContractDelivery.Handler["command"]>>[0]
class Problem extends Schema.TaggedErrorClass<Problem>()("ResearchProtocolError", {
  code: Schema.String,
  message: Schema.String,
}) {}

const authorize = Effect.fnUntraced(function* (input: Input) {
  const state = yield* ResearchStore.Service
  const bindings = yield* ProContractOpenCode.Service
  const contracts = yield* ProContract.Service
  yield* bindings.authorize(input.execution)
  const contract = (yield* contracts.get(input.execution.contractID))!
  const run = yield* state.get(input.execution.contractID)
  if (
    !run ||
    !ResearchProtocol.advisory(run.input) ||
    contract.pendingRevision ||
    contract.status !== "active" ||
    contract.specHash !== run.specHash ||
    contract.recognition.context?.profile !== ResearchProtocol.profile(run.input) ||
    !ProContractRecognition.same(contract.recognition.context?.target, run.context) ||
    (yield* Clock.currentTimeMillis) >= run.input.spec.budget.deadline
  )
    return yield* new Problem({
      code: "authority_expired",
      message: "Current authorized execution and original deadline are required",
    })
  return run
})

/** The canonical tool injects call identity. Payload equality is never an idempotency key. */
export const command = (input: Input) =>
  Effect.gen(function* () {
    const state = yield* ResearchStore.Service
    const run = yield* authorize(input)
    if (!input.call?.callID || !input.call.messageID)
      return yield* new Problem({
        code: "missing_call_identity",
        message: "Use the canonical Contract tool; the host requires its invocation identity",
      })
    const key = ProContractRecognition.fingerprint({
      contractID: run.id,
      sessionID: input.execution.sessionID,
      ...input.call,
    })
    const prior = yield* state.command(key)
    // Workspace observation must not hold SQLite's writer and block heartbeat/cancellation.
    const observed = yield* (prior ? Effect.succeed(undefined) : observe(input)).pipe(Effect.result)
    return yield* state.atomic(
      Effect.gen(function* () {
        yield* authorize(input)
        const previous = yield* state.command(key)
        if (previous && ProContractRecognition.same(previous.input, input)) return previous.result
        if (previous) {
          const result = rejected(
            "call_conflict",
            "This call identity already names another execution, kind or payload",
          )
          yield* state.recordCommand(crypto.randomUUID(), { input, at: yield* Clock.currentTimeMillis, result }, true)
          return result
        }
        // The inner savepoint rolls back rejected mutations. The outer transaction keeps the rejection receipt.
        const outcome =
          observed._tag === "Failure"
            ? observed
            : yield* state.atomic(dispatch(input, observed.success)).pipe(Effect.result)
        const result =
          outcome._tag === "Success"
            ? outcome.success
            : rejected(
                outcome.failure instanceof Problem
                  ? outcome.failure.code
                  : outcome.failure._tag === "SchemaError"
                    ? "invalid_payload"
                    : "invalid_request",
                outcome.failure.message,
              )
        yield* state.recordCommand(key, { input, at: yield* Clock.currentTimeMillis, result })
        return result
      }),
    )
  }).pipe(Effect.mapError((error) => new ResearchModel.Denied({ message: error.message })))

function rejected(code: string, message: string) {
  return {
    accepted: false,
    error: {
      code,
      field: "payload",
      message,
      protocol: 3,
      recovery:
        "Read research_view with payload:{} for the current schema and legal action objects. Correct the request in a new tool call within current authority; do not invent identities or extend the deadline.",
    },
  }
}

const observe = Effect.fnUntraced(function* (input: Input) {
  if (!["inspect_inputs", "plan", "read_evidence"].includes(input.kind)) return undefined
  const state = yield* ResearchStore.Service
  const bindings = yield* ProContractOpenCode.Service
  const run = yield* authorize(input)
  const selected = yield* Schema.decodeUnknownEffect(ResearchAdvisoryProtocol.Action)(input.payload)
  if (
    !run.advisoryView ||
    selected.view !== run.advisoryView.id ||
    run.advisoryView.basis !== ResearchAdvisoryProtocol.basis(run) ||
    !ProContractRecognition.same(run.advisoryView.execution, input.execution)
  )
    return yield* new Problem({ code: "stale_view", message: "Refresh and choose materials again" })
  if (input.kind === "read_evidence") {
    const binding = yield* bindings.get(run.id)
    if (
      !run.input.spec.authority.includes("filesystem.read") ||
      (binding?.admission?.capabilities && !binding.admission.capabilities.includes("read"))
    )
      return yield* new Problem({
        code: "authority_expired",
        message: "The current admission does not delegate evidence reads",
      })
    const request = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        view: Schema.String,
        evidence: Schema.String,
        offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        length: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(16_384)),
      }),
      { onExcessProperty: "error" },
    )(input.payload)
    const source = (yield* ResearchFeedbackEvidence.advisorySources(run)).find((item) => item.id === request.evidence)
    if (!source)
      return yield* new Problem({ code: "unknown_reference", message: "Evidence selector is not in the current view" })
    const bytes = yield* state.bytes(source.hash)
    if (request.offset > bytes.length)
      return yield* new Problem({ code: "invalid_payload", message: "Offset exceeds the retained evidence" })
    const slice = Buffer.from(bytes.subarray(request.offset, request.offset + request.length))
    yield* authorize(input)
    return {
      view: selected.view,
      result: {
        accepted: true,
        view: selected.view,
        evidence: source.id,
        label: source.label,
        totalBytes: bytes.length,
        offset: request.offset,
        eof: request.offset + slice.length === bytes.length,
        encoding: isUtf8(slice) ? "utf8" : "base64",
        content: slice.toString(isUtf8(slice) ? "utf8" : "base64"),
      },
    }
  }
  const request =
    input.kind === "plan"
      ? yield* Schema.decodeUnknownEffect(ResearchAdvisoryProtocol.Plan, { onExcessProperty: "error" })(input.payload)
      : yield* Schema.decodeUnknownEffect(Schema.Struct({ view: Schema.String, paths: Schema.Array(Schema.String) }), {
          onExcessProperty: "error",
        })(input.payload)
  const paths =
    "paths" in request
      ? request.paths
      : request.protected.map((id) => {
          return run.advisoryView!.inputs.find((_, index) => `i${index + 1}` === id)?.path
        })
  if (paths.some((name) => !name || !run.input.manifest.include.some((included) => included === name)))
    return yield* new Problem({
      code: "unknown_reference",
      message: "Select inputs from this view and original include list",
    })
  const files = paths.filter((name) => name !== undefined)
  const inspected = files.length
    ? yield* ResearchPlanning.command({
        ...input,
        kind: "inspect_inputs",
        payload: { paths: files },
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ protected: ResearchModel.Plan.fields.protected }))),
      )
    : { protected: [] }
  yield* authorize(input)
  return { view: selected.view, inspected }
})

const dispatch = Effect.fnUntraced(function* (input: Input, observed: Effect.Success<ReturnType<typeof observe>>) {
  const state = yield* ResearchStore.Service
  const bindings = yield* ProContractOpenCode.Service
  const run = yield* authorize(input)
  if (!["execution", "exploration", "feedback"].includes(run.stage))
    return yield* new Problem({
      code: "invalid_stage",
      message: "This stage has no worker research actions; wait for the host checkpoint",
    })
  if (input.kind === "research_view") {
    yield* Schema.decodeUnknownEffect(Schema.Struct({}), { onExcessProperty: "error" })(input.payload)
    const basis = ResearchAdvisoryProtocol.basis(run)
    const view =
      run.advisoryView?.basis === basis && ProContractRecognition.same(run.advisoryView.execution, input.execution)
        ? run.advisoryView
        : { id: crypto.randomUUID(), basis, execution: input.execution, inputs: run.plan?.value.protected ?? [] }
    const next = run.advisoryView === view ? run : yield* state.save(run, { ...run, advisoryView: view })
    return yield* present(next)
  }
  const selected = yield* Schema.decodeUnknownEffect(ResearchAdvisoryProtocol.Action)(input.payload)
  if (
    !run.advisoryView ||
    selected.view !== run.advisoryView.id ||
    run.advisoryView.basis !== ResearchAdvisoryProtocol.basis(run) ||
    !ProContractRecognition.same(run.advisoryView.execution, input.execution)
  )
    return yield* new Problem({
      code: "stale_view",
      message: "The selected view belongs to an old execution or changed materials; refresh and choose again",
    })
  if (input.kind === "inspect_inputs") {
    const request = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ view: Schema.String, paths: Schema.Array(Schema.String) }),
      { onExcessProperty: "error" },
    )(input.payload)
    if (request.paths.some((path) => !run.input.manifest.include.some((included) => included === path)))
      return yield* new Problem({
        code: "wrong_owner",
        message: "Select additional protected input paths from the original manifest include list",
      })
    if (!observed?.inspected || observed.view !== run.advisoryView.id)
      return yield* new Problem({ code: "stale_view", message: "Refresh the view and inspect inputs again" })
    const inspected = observed.inspected
    const after = yield* authorize(input)
    const next = yield* state.save(after, {
      ...after,
      advisoryView: {
        ...run.advisoryView,
        id: crypto.randomUUID(),
        inputs: [
          ...(run.plan?.value.protected ?? []).filter(
            (file) => !inspected.protected.some((current) => current.path === file.path),
          ),
          ...inspected.protected,
        ],
      },
    })
    return yield* present(next)
  }
  if (input.kind === "plan") {
    const request = yield* Schema.decodeUnknownEffect(ResearchAdvisoryProtocol.Plan, { onExcessProperty: "error" })(
      input.payload,
    )
    if (new Set(request.protected).size !== request.protected.length)
      return yield* new Problem({ code: "unknown_reference", message: "Protected input selectors must be unique" })
    const protectedFiles = request.protected.map((id) =>
      run.advisoryView!.inputs.find((_, index) => `i${index + 1}` === id),
    )
    if (protectedFiles.some((file) => !file))
      return yield* new Problem({
        code: "unknown_reference",
        message: "Use only the input selectors returned in this view",
      })
    const files = protectedFiles.filter((file) => file !== undefined)
    if (
      files.length &&
      (!observed?.inspected ||
        observed.view !== run.advisoryView.id ||
        !ProContractRecognition.same(files, observed.inspected.protected))
    )
      return yield* new Problem({
        code: "state_conflict",
        message: "Protected input bytes or view changed after inspection",
      })
    if (
      run.plan?.value.protected.some((old) => !files.some((file) => file.path === old.path && file.hash === old.hash))
    )
      return yield* new Problem({
        code: "protected_input_changed",
        message: "Plan revision cannot remove or rebind protected inputs",
      })
    const { view: omitted, protected: selectors, ...content } = request
    yield* ResearchPlanning.command({
      ...input,
      payload: {
        ...content,
        version: (run.plan?.value.version ?? 0) + 1,
        agreement: { revision: run.revision, specHash: run.specHash, manifestHash: run.manifestHash },
        protected: files,
      },
    })
    return { accepted: true, action: "plan", admissionClosed: true }
  }
  if (input.kind === "experiment") {
    yield* Schema.decodeUnknownEffect(ResearchAdvisoryProtocol.Action, { onExcessProperty: "error" })(input.payload)
    yield* ResearchPlanning.command({ ...input, payload: {} })
    return { accepted: true, action: "experiment", admissionClosed: true }
  }
  if (input.kind === "read_evidence") {
    if (!observed?.result || observed.view !== run.advisoryView.id)
      return yield* new Problem({ code: "stale_view", message: "Refresh and select evidence again" })
    return observed.result
  }
  if (input.kind === "prepare_candidate") {
    const request = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        view: Schema.String,
        summary: Schema.NonEmptyString,
        uncertainties: Schema.Array(Schema.NonEmptyString),
      }),
      { onExcessProperty: "error" },
    )(input.payload)
    if (
      run.stage !== "execution" ||
      (run.input.planning &&
        (!run.experiment ||
          run.experiment.planHash !== run.plan?.hash ||
          run.experiment.approvalHash !== run.plan?.admissionHash))
    )
      return yield* new Problem({
        code: "verification_required",
        message: "Prepare the candidate after the current plan's successful formal experiment",
      })
    yield* close(input, run)
    yield* state.save(run, {
      ...run,
      stage: "freezing",
      purpose: undefined,
      request: { execution: input.execution, summary: request.summary, uncertainties: request.uncertainties },
      captureID: crypto.randomUUID(),
      captureStarted: undefined,
      reason: undefined,
    })
    return { accepted: true, action: "prepare_candidate", admissionClosed: true }
  }
  if (input.kind === "resume_work") {
    const request = yield* Schema.decodeUnknownEffect(ResearchAdvisoryProtocol.Resume, { onExcessProperty: "error" })(
      input.payload,
    )
    if (request.replan && !run.input.planning)
      return yield* new Problem({ code: "invalid_payload", message: "This final-only task has no plan stage" })
    if (run.input.planning && !request.replan && !ResearchProtocol.planAdmitted(run))
      return yield* new Problem({
        code: "plan_required",
        message: "Submit an authorized plan before opening implementation",
      })
    yield* close(input, run)
    const next: ResearchModel.Run = {
      ...run,
      stage: request.replan ? "exploration" : "execution",
      admissionPending: true,
      plan: request.replan && run.plan ? { ...run.plan, admitted: false, admissionHash: undefined } : run.plan,
      experiment: undefined,
      lastExperiment: undefined,
      subjectHash: undefined,
      verificationHash: undefined,
      verifierJobID: undefined,
      reviewJobID: undefined,
      reviewHash: undefined,
      referencesHash: undefined,
      materialsHash: undefined,
      reviewDirectory: undefined,
      reviewPreparation: undefined,
      captureStarted: undefined,
      captureID: undefined,
      request: undefined,
      feedback: undefined,
      submission: undefined,
      submissionHash: undefined,
      advisoryView: undefined,
      round: run.round + 1,
      reviewVersion: run.reviewVersion + 1,
    }
    yield* state.save(run, { ...next, executionPrompt: ResearchProtocol.advisoryPrompt(next, next.stage) })
    return { accepted: true, action: "resume_work", admissionClosed: true }
  }
  if (input.kind === "submit_candidate") {
    const request = yield* Schema.decodeUnknownEffect(ResearchAdvisoryProtocol.Submit, { onExcessProperty: "error" })(
      input.payload,
    )
    const invalid = yield* ResearchFeedbackEvidence.completionBasis(run)
    if (invalid) return yield* new Problem({ code: "verification_required", message: invalid })
    const hash = yield* record(run, { kind: "submission", reason: request.treatment, evidence: [] })
    yield* close(input, run)
    yield* state.save(run, {
      ...run,
      advisoryRecords: [...(run.advisoryRecords ?? []), hash],
      submissionHash: hash,
      submission: true,
      stage: "freezing",
      captureStarted: undefined,
      captureID: crypto.randomUUID(),
      admissionPending: false,
    })
    return { accepted: true, action: "submit_candidate", admissionClosed: true }
  }
  if (["review_response", "review_intent", "review_completion"].includes(input.kind)) {
    const request = yield* Schema.decodeUnknownEffect(ResearchAdvisoryProtocol.Note, { onExcessProperty: "error" })(
      input.payload,
    )
    const entry = request.target
      ? run.feedbackHistory?.find((_, index) => `r${index + 1}` === request.target!.review)
      : undefined
    const outcome = entry
      ? yield* state.json(entry.outcomeHash).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchFeedback.Outcome)))
      : undefined
    if (request.target && !outcome?.review?.findings.some((finding) => finding.id === request.target!.finding))
      return yield* new Problem({
        code: "unknown_reference",
        message: "Select a finding from this view; identical IDs in different reviews are different targets",
      })
    const target =
      entry && request.target ? { outcomeHash: entry.outcomeHash, findingID: request.target.finding } : undefined
    const records = yield* ResearchFeedbackEvidence.advisoryRecords(run)
    const previous = target
      ? records.findLast((item) => ProContractRecognition.same(item.record.target, target))
      : undefined
    if (request.previous !== (previous ? `a${records.indexOf(previous) + 1}` : undefined))
      return yield* new Problem({
        code: "state_conflict",
        message: "The target's previous record changed; refresh and append a correction",
      })
    const sources = yield* ResearchFeedbackEvidence.advisorySources(run)
    const evidence = (request.evidence ?? []).map((id) => sources.find((source) => source.id === id))
    if (evidence.some((source) => !source))
      return yield* new Problem({ code: "unknown_reference", message: "Use evidence selectors from this view only" })
    if (input.kind === "review_completion") {
      const invalid = yield* ResearchFeedbackEvidence.completionBasis(run)
      if (invalid || !target || !request.disposition || !evidence.length)
        return yield* new Problem({
          code: "verification_required",
          message: invalid ?? "A completion needs an original finding, disposition and current evidence",
        })
    }
    const hash = yield* record(run, {
      kind: input.kind === "review_completion" ? "completion" : input.kind === "review_intent" ? "intent" : "response",
      target,
      previousHash: previous?.hash,
      disposition: request.disposition,
      reason: request.reason,
      evidence: evidence.filter((source) => source !== undefined).map((source) => source.hash),
    })
    yield* authorize(input)
    yield* state.save(run, { ...run, advisoryRecords: [...(run.advisoryRecords ?? []), hash] })
    return { accepted: true, record: `a${records.length + 1}`, admissionClosed: false, claimOnly: true }
  }
  return yield* new Problem({
    code: "protocol_mismatch",
    message: "Unknown v3 action; research_view lists the current protocol",
  })
})

const close = Effect.fnUntraced(function* (input: Input, run: ResearchModel.Run) {
  const bindings = yield* ProContractOpenCode.Service
  yield* authorize(input)
  const binding = yield* bindings.get(run.id)
  if (!binding) return yield* new Problem({ code: "authority_expired", message: "Worker binding disappeared" })
  const closed = yield* bindings.setAdmission({
    expected: binding,
    context: run.context,
    open: false,
    reason: "Explicit research action recorded; waiting for cleanup",
  })
  if (!closed.binding) return yield* new Problem({ code: "state_conflict", message: closed.conflict! })
})

const record = Effect.fnUntraced(function* (
  run: ResearchModel.Run,
  content: Pick<
    ResearchAdvisoryProtocol.Record,
    "kind" | "target" | "previousHash" | "disposition" | "reason" | "evidence"
  >,
) {
  const state = yield* ResearchStore.Service
  for (const hash of content.evidence) yield* state.bytes(hash)
  return yield* state.put({
    version: 3,
    contractID: run.id,
    manifestHash: run.manifestHash,
    context: run.context,
    basisHash: yield* state.put(run),
    basisVersion: run.version,
    recordedAt: yield* Clock.currentTimeMillis,
    planHash: run.plan?.hash,
    subjectHash: run.subjectHash,
    verificationHash: run.verificationHash,
    ...content,
  })
})

const present = Effect.fnUntraced(function* (run: ResearchModel.Run) {
  const state = yield* ResearchStore.Service
  const view = run.advisoryView!.id
  const reviews = yield* Effect.forEach(run.feedbackHistory ?? [], (entry, index) =>
    Effect.gen(function* () {
      const outcome = yield* state
        .json(entry.outcomeHash)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchFeedback.Outcome)))
      const plan = outcome.planHash
        ? yield* state.json(outcome.planHash).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.Plan)))
        : undefined
      return {
        id: `r${index + 1}`,
        phase: entry.phase,
        availability: outcome.availability,
        material: {
          planVersion: plan?.version,
          round: outcome.round,
          reviewVersion: outcome.reviewVersion,
          current: entry.outcomeHash === (entry.phase === "plan" ? run.plan?.reportHash : run.reviewHash),
        },
        error: outcome.error,
        summary: outcome.review?.summary,
        findings:
          outcome.review?.findings.map((finding) => ({
            target: { review: `r${index + 1}`, finding: finding.id },
            severity: finding.severity,
            path: finding.path,
            reason: finding.reason,
            resolution: finding.resolution,
            impact: finding.impact,
          })) ?? [],
      }
    }),
  )
  const records = yield* ResearchFeedbackEvidence.advisoryRecords(run)
  const sources = yield* ResearchFeedbackEvidence.advisorySources(run)
  const experimentSource = sources.find((source) => source.label === "experiment")
  const experiment = experimentSource
    ? yield* state
        .json(experimentSource.hash)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResearchModel.Verification)))
    : undefined
  const binding = run.lastExperiment ?? run.experiment
  const plan = run.plan
    ? { ...run.plan.value, agreement: undefined, protected: run.plan.value.protected.map((file) => file.path) }
    : undefined
  return {
    accepted: true,
    protocol: 3,
    view,
    stage: run.stage,
    plan,
    requirements: run.input.manifest.requirements,
    candidateFiles: run.input.manifest.include,
    inputs: run.advisoryView!.inputs.map((file, index) => ({ id: `i${index + 1}`, path: file.path })),
    inputGuidance:
      "Inspection does not protect a file. The plan example retains existing protected paths; select additional inputs only if their bytes must remain immutable. Do not select code or reports you intend to edit. Existing protected inputs cannot be removed or rebound by a plan revision, and their bytes are rechecked when submitting a plan.",
    experiment: experiment && {
      verdict: experiment.verdict,
      reason: experiment.reason,
      currentPlan: binding?.planHash === run.plan?.hash && binding?.approvalHash === run.plan?.admissionHash,
      evidence: experimentSource!.id,
      scope: "Captured bytes only; later workspace changes require a new experiment.",
    },
    reviews,
    records: records.map((item, index) => ({
      id: `a${index + 1}`,
      current: item.current,
      kind: item.record.kind,
      target: item.record.target
        ? {
            review: `r${run.feedbackHistory!.findIndex((entry) => entry.outcomeHash === item.record.target!.outcomeHash) + 1}`,
            finding: item.record.target.findingID,
          }
        : undefined,
      reason: item.record.reason,
      disposition: item.record.disposition,
    })),
    evidence: sources.map((source) => ({ id: source.id, label: source.label })),
    actions: {
      ...(run.input.planning && run.stage !== "feedback"
        ? {
            plan: {
              kind: "plan",
              payload: {
                view,
                scope: "within_task",
                question: "research question",
                hypothesis: "testable hypothesis",
                baseline: "comparison",
                implementation: "implementation steps",
                method: "authorized method",
                controls: "controls",
                data: "data use",
                evaluation: "evaluation procedure",
                uncertainties: "known limits",
                protected: run.advisoryView!.inputs.flatMap((file, index) =>
                  run.plan?.value.protected.some((old) => old.path === file.path) ? [`i${index + 1}`] : [],
                ),
              },
            },
            inspect_inputs: { kind: "inspect_inputs", payload: { view, paths: ["choose an original include path"] } },
            experiment: { kind: "experiment", payload: { view } },
          }
        : {}),
      ...(run.stage === "execution"
        ? {
            prepare_candidate: {
              kind: "prepare_candidate",
              payload: { view, summary: "actual result and evidence", uncertainties: [] },
            },
          }
        : {}),
      ...(run.stage === "feedback" ? { submit_candidate: { kind: "submit_candidate", payload: { view } } } : {}),
      resume_work: { kind: "resume_work", payload: { view, replan: false } },
      read_evidence: {
        kind: "read_evidence",
        payload: { view, evidence: sources[0]?.id ?? "select evidence", offset: 0, length: 16384 },
      },
      optional_response: {
        kind: "review_response",
        payload: { view, reason: "brief factual treatment or retained disagreement" },
      },
      optional_record_schema: {
        kinds: ["review_response", "review_intent", "review_completion"],
        required: ["view", "reason"],
        optional: [
          "target:{review,finding}",
          "previous: latest target record ID",
          "disposition:adopted|repair_planned|rebutted|unresolved|fixed|removed",
          "evidence: current evidence selector IDs",
        ],
        completion:
          "Requires a finding, disposition and current verified evidence; this is a claim, never a submission prerequisite.",
      },
    },
  }
})
