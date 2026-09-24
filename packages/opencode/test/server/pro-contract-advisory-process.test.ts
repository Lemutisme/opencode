import { describe, expect } from "bun:test"
import path from "node:path"
import { rm } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import type { ProContract } from "@opencode-ai/core/pro-contract"
import { Hash } from "@opencode-ai/core/util/hash"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import type { ResearchAdvisoryProtocol } from "../../../sdk-next/src/research/advisory-protocol"
import type { ResearchFeedback } from "../../../sdk-next/src/research/review-feedback"
import { collect } from "../../script/research-eval/archive"
import { prepareAdvisoryArchive } from "../../script/research-eval/advisory-archive"
import { InstanceScoring } from "../../script/research-eval/instance-scoring"
import { contractProcess } from "../fixture/contract-process"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, NodeServices.layer, FetchHttpClient.layer))
type Host = Effect.Success<ReturnType<Effect.Success<typeof contractProcess>["startHost"]>>
type View = {
  view: string
  stage: string
  inputs: { id: string; path: string }[]
  reviews: {
    id: string
    availability: string
    material: { planVersion?: number; current: boolean }
    findings: { target: { review: string; finding: string } }[]
  }[]
  evidence: { id: string; label: string }[]
  experiment?: { verdict: string; reason: string; currentPlan: boolean; evidence: string; scope: string }
  actions: { plan?: { kind: string; payload: Record<string, unknown> } }
}
const get = (host: Host, id: string) =>
  host.command("research-get", id).pipe(Effect.map((value) => value as ResearchModel.Run))
const stage = (host: Host, id: string, expected: ResearchModel.Run["stage"]) =>
  pollWithTimeout(
    get(host, id).pipe(
      Effect.flatMap((run) =>
        run.stage === "unavailable" && expected !== "unavailable"
          ? Effect.fail(new Error(`Research unavailable: ${run.reason}`))
          : Effect.succeed(run.stage === expected ? run : undefined),
      ),
    ),
    `Research never reached ${expected}`,
    "30 seconds",
  ).pipe(Effect.tapError(() => host.log().pipe(Effect.tap((text) => Effect.sync(() => console.error(text))))))

const start = Effect.fnUntraced(function* (planning: boolean, reviewerAgent = "build") {
  const fixture = yield* contractProcess
  const llm = yield* TestLLMServer
  const harness =
    'const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs");test("answer is correct",()=>{assert.equal(fs.readFileSync("answer.txt","utf8"),"42");fs.writeFileSync("result.txt","actual evidence")})'
  yield* Effect.promise(async () => {
    await Bun.write(
      path.join(fixture.storage, "config/opencode/opencode.json"),
      await Bun.file(path.join(fixture.directory, "opencode.json")).text(),
    )
    await Bun.write(path.join(fixture.directory, "acceptance.cjs"), harness)
    await Bun.write(path.join(fixture.directory, "answer.txt"), "wrong")
    await Bun.write(path.join(fixture.directory, "data.txt"), "original data")
  })
  const input = {
    planning,
    id: `pct_advisory_${crypto.randomUUID()}`,
    scope: "advisory-v3-production",
    source: { directory: fixture.directory },
    model: { providerID: "local", id: "researcher" },
    spec: {
      trigger: { type: "immediate" },
      goal: "Deliver the correct answer",
      brief: "Set answer.txt to 42; preserve protected inputs.",
      requires: [],
      authority: ["filesystem.read", "filesystem.write", "process.execute"],
      budget: { deadline: Date.now() + 21_600_000 },
      evidence: { type: "principal", claim: "Externally recognized candidate" },
      resolution: { retryDelay: 1 },
    },
    manifest: {
      version: 1,
      requirements: ["answer.txt contains 42"],
      include: ["acceptance.cjs", "answer.txt", "data.txt", "result.txt", "opencode.json"],
      dependencies: [],
      verification: {
        adapter: "node-test-tap:1",
        executable: "/usr/bin/node",
        executableHash: Hash.sha256(Buffer.from(yield* Effect.promise(() => Bun.file("/usr/bin/node").arrayBuffer()))),
        tests: ["acceptance.cjs"],
        harness: [{ path: "acceptance.cjs", hash: Hash.sha256(harness) }],
        expectedTests: ["answer is correct"],
        minimumTests: 1,
        maximumSkipped: 0,
        timeout: 10_000,
      },
      artifacts: [{ path: "result.txt", kind: "generated" }],
      reviewer: {
        model: { providerID: "local", id: "researcher" },
        agent: reviewerAgent,
        instructions: "Review the task and evidence independently.",
      },
    },
  }
  const host = yield* fixture.startHost(true, { research: true })
  const gate = Promise.withResolvers<void>()
  yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
  yield* llm.push(reply().tool("read", { path: "answer.txt" }).wait(gate.promise))
  const run = (yield* host.command("research-issue", input.id, input)) as ResearchModel.Run
  yield* llm.wait(1)
  expect(run.input.manifest.reviewPolicy).toEqual({ version: 3, plan: "advisory", delivery: "advisory" })
  expect(run.input.manifest.feedbackProtocol).toBeUndefined()
  return { fixture, host, llm, input, run, gate, calls: 1 }
})
type State = Effect.Success<ReturnType<typeof start>>
const advance = Effect.fnUntraced(function* (s: State, actions: ReturnType<typeof reply>[], reviewer = false) {
  const gate = Promise.withResolvers<void>()
  yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
  yield* s.llm.push(
    ...actions,
    reply()
      .tool("read", { path: reviewer ? "evidence/materials.json" : "answer.txt" })
      .wait(gate.promise),
  )
  s.gate.resolve()
  yield* s.llm.wait(s.calls + actions.length + 1)
  return { ...s, gate, calls: s.calls + actions.length + 1, run: yield* get(s.host, s.input.id) }
})
const toolResult = Effect.fnUntraced(function* (s: State) {
  const input = (yield* s.llm.inputs).at(-1) as { messages: { role: string; content: string }[] }
  return JSON.parse(input.messages.filter((message) => message.role === "tool").at(-1)!.content) as {
    result: View & { accepted: boolean; error?: { code: string } }
  }
})
const view = Effect.fnUntraced(function* (s: State) {
  const next = yield* advance(s, [reply().tool("contract_request", { kind: "research_view", payload: {} })])
  const result = yield* toolResult(next)
  expect(result.result.accepted).toBe(true)
  return { ...next, view: result.result }
})
const review = Effect.fnUntraced(function* (s: State, malformed: boolean) {
  const run = yield* stage(s.host, s.input.id, s.run.plan && !s.run.verificationHash ? "plan_review" : "review")
  const map = JSON.parse(
    String(
      yield* s.host.command(
        "research-object",
        run.stage === "plan_review" ? run.plan!.referencesHash! : run.referencesHash!,
      ),
    ),
  ) as ResearchFeedback.References
  const raw = malformed
    ? "malformed independent report retained verbatim"
    : JSON.stringify({
        version: 2,
        verdict: "changes_requested",
        ...(map.phase === "plan" ? { scope: "within_task" } : {}),
        summary: "The correct fixed answer is insufficient for an unrequested universal claim",
        findings: [
          {
            id: "F1",
            severity: "P1",
            path: "answer.txt",
            reason: "This does not prove a universal claim",
            resolution: "Retain this limit",
            evidence: [{ jobID: map.jobID, id: map.entries[0].id }],
          },
        ],
        claims: [{ text: "Inspect this exact material", evidence: [{ jobID: map.jobID, id: map.entries[0].id }] }],
      })
  const next = yield* advance(s, [reply().text(raw).stop()])
  const after = yield* stage(s.host, s.input.id, map.phase === "plan" ? "execution" : "feedback")
  if (map.phase === "plan") expect(after.plan?.admitted).toBe(true)
  return { ...next, run: after, raw }
})

describe("Host-bound advisory v3 actual workflow", () => {
  for (const planning of [false, true])
    for (const malformed of [false, true]) {
      it.live(
        `zero responses submit with planning=${planning}, unavailable=${malformed}`,
        () =>
          Effect.gen(function* () {
            const initial = yield* view(yield* start(planning))
            const planned = planning
              ? yield* review(
                  yield* advance(initial, [reply().tool("contract_request", initial.view.actions.plan!)], true),
                  malformed,
                )
              : initial
            const execution = yield* view(planned)
            const written = yield* advance(execution, [reply().tool("write", { path: "answer.txt", content: "42" })])
            const tested = planning
              ? yield* advance(written, [
                  reply().tool("contract_request", { kind: "experiment", payload: { view: execution.view.view } }),
                ])
              : written
            const before = yield* view(tested)
            const inspected = planning
              ? yield* advance(before, [
                  reply().tool("contract_request", {
                    kind: "read_evidence",
                    payload: {
                      view: before.view.view,
                      evidence:
                        before.view.evidence.find((item) => item.label === "experiment:artifacts/result.txt")?.id ??
                        before.view.evidence.at(-1)!.id,
                      offset: 0,
                      length: 16384,
                    },
                  }),
                ])
              : before
            const prepared = yield* advance(
              inspected,
              [
                reply().tool("contract_request", {
                  kind: "prepare_candidate",
                  payload: { view: before.view.view, summary: "Actual fixed result", uncertainties: [] },
                }),
              ],
              true,
            )
            const feedback = yield* view(yield* review(prepared, malformed))
            expect(feedback.view.reviews.at(-1)!.availability).toBe(malformed ? "unavailable" : "available")
            // A schema error is recoverable in the same live admission; no legacy union fallback or fake response.
            const invalid = yield* advance(feedback, [
              reply().tool("contract_request", {
                kind: "review_response",
                payload: { view: feedback.view.view, wrong: "not a valid note" },
              }),
            ])
            expect((yield* toolResult(invalid)).result.accepted).toBe(false)
            expect((yield* get(invalid.host, invalid.input.id)).stage).toBe("feedback")
            yield* invalid.llm.push(
              reply().tool("contract_request", { kind: "submit_candidate", payload: { view: feedback.view.view } }),
            )
            invalid.gate.resolve()
            const ready = yield* stage(invalid.host, invalid.input.id, "ready")
            expect(ready.feedbackHistory?.every((entry) => !entry.responseHash)).toBe(true)
            const bundle = JSON.parse(
              String(yield* invalid.host.command("research-object", ready.bundleHash!)),
            ) as ResearchAdvisoryProtocol.Bundle
            expect(bundle.version).toBe(3)
            expect(bundle.treatment).toEqual({ status: "not_provided" })
            expect(bundle.records.map((item) => item.record.kind)).toEqual(["submission"])
            expect(bundle.feedback).toHaveLength(planning ? 2 : 1)
            for (const entry of bundle.feedback) {
              expect(entry.outcome.availability).toBe(malformed ? "unavailable" : "available")
              expect(entry.unaddressed).toEqual(malformed ? [] : ["F1"])
              expect(entry.raw).toContain(malformed ? "malformed independent" : "unrequested universal claim")
            }
            if (!planning && !malformed) {
              const directory = path.join(invalid.fixture.storage, "measurement-archive")
              const archived = yield* Effect.promise(() =>
                collect({
                  directory,
                  run: ready,
                  storage: invalid.fixture.storage,
                  command: (action, id, input) => Effect.runPromise(invalid.host.command(action, id, input)),
                }),
              )
              const materials = yield* Effect.promise(() =>
                prepareAdvisoryArchive({
                  directory,
                  archiveHash: archived.hash,
                  files: ["answer.txt", "acceptance.cjs"],
                  timeout: 10_000,
                }),
              )
              expect(materials.candidate.files["answer.txt"]).toBe("42")
              expect(materials.audit.completion).toBe("absent")
              expect(materials.feedback.trajectory.snapshots.some((item) => item.files["answer.txt"] === "wrong")).toBe(
                true,
              )
              expect(materials.feedback.finalCandidate.files["answer.txt"]).toBe("42")
              expect(materials.feedback.trajectory.archive.sessions.length).toBeGreaterThan(0)
              expect(materials.feedback.trajectory.jobs.length).toBeGreaterThan(0)
              const context = (role: string, rater: string) => ({ id: role, execution: "isolated-" + role, rater })
              const scoring = new InstanceScoring(":memory:", {
                version: "advisory-measurement:1",
                reveal: "instance-isolated:1",
                codeHash: "a".repeat(64),
                unavailable: "not_scored",
                instances: [
                  {
                    id: "actual-host",
                    contractID: ready.id,
                    agreementHash: ready.inputHash,
                    files: materials.source.files,
                    started: ready.input.spec.budget.deadline - 21_600_000,
                    deadline: ready.input.spec.budget.deadline,
                    roles: {
                      candidate: [context("ca", "a"), context("cb", "b")],
                      candidateAdjudicator: context("cj", "judge"),
                      feedback: [context("fa", "a"), context("fb", "b")],
                      feedbackAdjudicator: context("fj", "judge"),
                    },
                  },
                ],
                rubric: {
                  correct: { dimension: "research_result", question: "Actual answer is 42?" },
                  actualRepair: {
                    dimension: "feedback_handling",
                    question: "Was wrong changed to 42 and independently verified?",
                  },
                  reviewer: {
                    dimension: "reviewer_judgment",
                    question: "Does a universal claim belong to the original task?",
                  },
                  completion: {
                    dimension: "audit_completeness",
                    question: "Is there a supported new completion declaration?",
                  },
                },
              })
              yield* Effect.addFinalizer(() => Effect.sync(() => scoring.close()))
              scoring.prepare("actual-host", {
                ...materials,
                infrastructure: { status: "completed", mode: "deterministic-fixture" },
              })
              expect(() => scoring.grant("actual-host", "feedback", "fa")).toThrow("own complete")
              for (const phase of ["candidate", "feedback"] as const) {
                for (const id of phase === "candidate" ? ["ca", "cb"] : ["fa", "fb"]) {
                  const grant = scoring.grant("actual-host", phase, id)
                  if (phase === "candidate") expect(JSON.stringify(grant.material)).not.toContain("changes_requested")
                  if (phase === "feedback") expect(JSON.stringify(grant.material)).toContain("changes_requested")
                  scoring.rate(grant.receipt, {
                    context: id,
                    rater: grant.context.rater,
                    materialHash: grant.materialHash,
                    rubricHash: grant.rubricHash,
                    items: Object.fromEntries(
                      Object.keys(grant.rubric).map((key) => [
                        key,
                        key === "completion"
                          ? { status: "not_observed", value: null, reason: "No completion declaration", evidence: [] }
                          : {
                              status: "scored",
                              value: key !== "reviewer",
                              reason: "Scripted fixture assertion, not a model capability score",
                              evidence: [grant.materialHash],
                            },
                      ]),
                    ),
                  })
                }
                scoring.seal("actual-host", phase)
              }
              const row = scoring.report().rows[0]
              expect(row.feedbackHandling.researcher.actualRepair.value).toBe(true)
              expect(row.auditCompleteness.judgments.completion.status).toBe("not_observed")
            }
            const contract = (yield* invalid.host.command("get", ready.id)) as { status: string }
            expect(contract.status).not.toBe("discharged")
            const receipt = (yield* invalid.host.command("root-attest", ready.id, {
              contractID: ready.id,
              expected: ready.published,
              evidenceHash: ready.bundleHash,
              operationID: crypto.randomUUID(),
            })) as ProContract.OperationReceipt
            expect(receipt.decision.type).toBe("accepted")
            yield* stage(invalid.host, ready.id, "accepted")
          }),
        90_000,
      )
    }
})

// These are scripted mechanism checks, not observations of model research ability.
for (const mutation of ["changed", "missing"] as const)
  it.live(
    `protected input ${mutation} gives usable failure guidance and retains the accepted blocked report`,
    () =>
      Effect.gen(function* () {
        const initial = yield* view(yield* start(true))
        const inspected = yield* advance(initial, [
          reply().tool("contract_request", {
            kind: "inspect_inputs",
            payload: { view: initial.view.view, paths: ["data.txt"] },
          }),
        ])
        const inputs = (yield* toolResult(inspected)).result
        const planned = yield* view(
          yield* review(
            yield* advance(
              inspected,
              [
                reply().tool("contract_request", {
                  kind: "plan",
                  payload: { ...inputs.actions.plan!.payload, protected: ["i1"] },
                }),
              ],
              true,
            ),
            false,
          ),
        )
        // Inject corruption into this temporary fixture, then exercise the real capture and verifier.
        yield* Effect.promise(async () => {
          const file = path.join(planned.run.workspace.directory, "data.txt")
          if (mutation === "missing") return rm(file)
          await Bun.write(file, "changed data")
        })
        const failed = yield* view(
          yield* advance(planned, [
            reply().tool("contract_request", { kind: "experiment", payload: { view: planned.view.view } }),
          ]),
        )
        expect(failed.run.stage).toBe("exploration")
        expect(failed.run.plan?.admitted).toBe(false)
        expect(failed.run.plan?.value.protected).toEqual(planned.run.plan?.value.protected)
        expect(failed.run.executionPrompt).toContain(JSON.stringify({ path: "data.txt", status: mutation }))
        expect(failed.run.executionPrompt).toContain("A new plan cannot remove or rebind existing protected inputs")
        expect(failed.run.executionPrompt).toContain("no direct restoration action")
        expect(failed.run.executionPrompt).toContain("contract_report_blocked")
        expect(failed.run.executionPrompt).not.toContain("submit the next plan version")
        expect((yield* failed.fixture.binding(failed.input.id)).admission?.capabilities).toEqual([
          "read",
          "observe",
          "control",
        ])
        const unchanged = yield* advance(failed, [
          reply().tool("write", { path: "answer.txt", content: "unauthorized restoration" }),
          reply().tool("contract_request", {
            kind: "plan",
            payload: { ...failed.view.actions.plan!.payload, protected: [] },
          }),
        ])
        expect((yield* toolResult(unchanged)).result.error?.code).toBe("protected_input_changed")
        expect(
          yield* Effect.promise(() => Bun.file(path.join(failed.run.workspace.directory, "answer.txt")).text()),
        ).toBe("wrong")
        const noExperiment = yield* advance(unchanged, [
          reply().tool("contract_request", { kind: "experiment", payload: { view: failed.view.view } }),
        ])
        expect((yield* toolResult(noExperiment)).result.accepted).toBe(false)
        const noSubmission = yield* advance(noExperiment, [
          reply().tool("contract_request", { kind: "submit_candidate", payload: { view: failed.view.view } }),
        ])
        expect((yield* toolResult(noSubmission)).result.accepted).toBe(false)
        const reason = `data.txt is ${mutation}; I cannot restore it with current read-only authority. Cause uncertain.`
        yield* noSubmission.llm.push(reply().tool("contract_report_blocked", { reason }))
        noSubmission.gate.resolve()
        const stopped = yield* stage(noSubmission.host, noSubmission.input.id, "unavailable")
        expect(((yield* noSubmission.host.command("root-info", stopped.id)) as ProContract.Info).blocked?.reason).toBe(
          reason,
        )
        expect(stopped.reason).toContain(`Researcher reported blocked: ${JSON.stringify(reason)}`)
        expect(stopped.reason).toContain("does not independently establish the cause")
        expect(stopped.reason).not.toContain("Worker stopped without a delivery request")
        expect(stopped.bundleHash).toBeUndefined()
        expect(stopped.input.spec.budget).toEqual(initial.input.spec.budget)

        if (mutation === "missing") return
        // Explicit existing host recovery starts a new Session; its unrelated closure must not inherit the old report.
        const gate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
        const calls = (yield* noSubmission.llm.inputs).length
        yield* noSubmission.llm.push(reply().tool("read", { path: "answer.txt" }).wait(gate.promise))
        yield* noSubmission.host.command("research-recover", stopped.id)
        yield* noSubmission.llm.wait(calls + 1)
        yield* noSubmission.host.command("close", stopped.id)
        gate.resolve()
        const closed = yield* stage(noSubmission.host, stopped.id, "unavailable")
        expect(((yield* noSubmission.host.command("root-info", stopped.id)) as ProContract.Info).blocked?.reason).toBe(
          reason,
        )
        expect(closed.reason).toBe("Worker stopped without a delivery request; explicit recovery is required")
        expect(closed.input.spec.budget).toEqual(initial.input.spec.budget)
      }),
    90_000,
  )

it.live(
  "host binds plan revisions, preserves disagreement and submits without a new explanation",
  () =>
    Effect.gen(function* () {
      const initial = yield* view(yield* start(true))
      const bypass = yield* advance(initial, [
        reply().tool("contract_request", {
          kind: "resume_work",
          payload: { view: initial.view.view },
        }),
      ])
      expect((yield* toolResult(bypass)).result.error?.code).toBe("plan_required")
      const inspected = yield* advance(bypass, [
        reply().tool("contract_request", {
          kind: "inspect_inputs",
          payload: { view: initial.view.view, paths: ["data.txt", "answer.txt"] },
        }),
      ])
      const inputs = (yield* toolResult(inspected)).result
      expect(inputs.inputs).toEqual([
        { id: "i1", path: "data.txt" },
        { id: "i2", path: "answer.txt" },
      ])
      expect(inputs.actions.plan!.payload.protected).toEqual([])
      const planned = yield* view(
        yield* review(
          yield* advance(
            inspected,
            [
              reply().tool("contract_request", {
                kind: "plan",
                payload: { ...inputs.actions.plan!.payload, protected: ["i1"] },
              }),
            ],
            true,
          ),
          false,
        ),
      )
      expect(planned.run.plan?.value.protected).toHaveLength(1)
      expect(planned.run.plan?.value.protected).toMatchObject([
        { path: "data.txt", hash: Hash.sha256("original data") },
      ])
      expect(planned.view.inputs).toEqual([{ id: "i1", path: "data.txt" }])
      expect(planned.view.actions.plan!.payload.protected).toEqual(["i1"])
      const previous = planned.run.plan!.hash
      const invalid = yield* advance(planned, [
        reply().tool("contract_request", {
          kind: "plan",
          payload: { ...planned.view.actions.plan!.payload, protected: [] },
        }),
      ])
      expect((yield* toolResult(invalid)).result.error?.code).toBe("protected_input_changed")
      const tampered = yield* advance(invalid, [reply().tool("write", { path: "data.txt", content: "changed" })])
      const refreshed = yield* advance(tampered, [
        reply().tool("contract_request", {
          kind: "inspect_inputs",
          payload: { view: planned.view.view, paths: ["answer.txt"] },
        }),
      ])
      const nextView = (yield* toolResult(refreshed)).result
      expect(nextView.inputs).toEqual([
        { id: "i1", path: "data.txt" },
        { id: "i2", path: "answer.txt" },
      ])
      expect(nextView.actions.plan!.payload.protected).toEqual(["i1"])
      const changed = yield* advance(refreshed, [reply().tool("contract_request", nextView.actions.plan!)])
      expect((yield* toolResult(changed)).result.error?.code).toBe("state_conflict")
      const restored = yield* advance(changed, [reply().tool("write", { path: "data.txt", content: "original data" })])
      const revised = yield* view(
        yield* review(
          yield* advance(
            restored,
            [
              reply().tool("contract_request", {
                kind: "plan",
                payload: {
                  ...nextView.actions.plan!.payload,
                  method: "Keep the bounded original task; no universal diagnostic",
                },
              }),
            ],
            true,
          ),
          false,
        ),
      )
      expect(revised.run.plan?.value.version).toBe(2)
      expect(revised.run.plan?.hash).not.toBe(previous)
      expect(revised.run.plan?.value.protected).toEqual(planned.run.plan?.value.protected)
      expect(revised.view.reviews.map((item) => item.material)).toEqual([
        expect.objectContaining({ planVersion: 1, current: false }),
        expect.objectContaining({ planVersion: 2, current: true }),
      ])
      const failed = yield* view(
        yield* advance(revised, [
          reply().tool("contract_request", { kind: "experiment", payload: { view: revised.view.view } }),
        ]),
      )
      expect(failed.view.experiment).toMatchObject({ verdict: "failed", currentPlan: true })
      expect(failed.run.executionPrompt).toContain("verdict failed")
      expect(failed.run.executionPrompt).toContain("cannot support delivery")
      expect(failed.run.experiment).toBeUndefined()
      const premature = yield* advance(failed, [
        reply().tool("contract_request", {
          kind: "prepare_candidate",
          payload: { view: failed.view.view, summary: "Incorrect premature delivery", uncertainties: [] },
        }),
      ])
      expect((yield* toolResult(premature)).result.error?.code).toBe("verification_required")
      const written = yield* advance(premature, [reply().tool("write", { path: "answer.txt", content: "42" })])
      const tested = yield* view(
        yield* advance(written, [
          reply().tool("contract_request", {
            kind: "experiment",
            payload: { view: failed.view.view },
          }),
        ]),
      )
      expect(tested.view.experiment).toMatchObject({ verdict: "passed", currentPlan: true })
      expect(tested.view.experiment?.evidence).toBe(
        tested.view.evidence.find((item) => item.label === "experiment")?.id,
      )
      expect(tested.run.executionPrompt).toContain("verdict passed")
      expect(tested.run.executionPrompt).toContain("not copied into your workspace")
      expect(tested.run.executionPrompt).toContain("Do not repeat the experiment merely to retrieve the same output")
      expect(tested.run.executionPrompt).toContain("submit_candidate")
      const feedback = yield* view(
        yield* review(
          yield* advance(
            tested,
            [
              reply().tool("contract_request", {
                kind: "prepare_candidate",
                payload: { view: tested.view.view, summary: "Bounded result", uncertainties: [] },
              }),
            ],
            true,
          ),
          false,
        ),
      )
      const reason = "The task requires only the fixed answer 42; no universal claim is made. Keep this scoped result."
      const noted = yield* advance(feedback, [
        reply().tool("contract_request", {
          kind: "review_response",
          payload: { view: feedback.view.view, reason },
        }),
        reply().tool("contract_request", {
          kind: "review_response",
          payload: {
            view: feedback.view.view,
            reason,
            target: feedback.view.reviews.at(-1)!.findings[0].target,
            disposition: "rebutted",
          },
        }),
      ])
      yield* noted.llm.push(
        reply().tool("contract_request", {
          kind: "submit_candidate",
          payload: { view: feedback.view.view },
        }),
      )
      noted.gate.resolve()
      const ready = yield* stage(noted.host, noted.input.id, "ready")
      const bundle = JSON.parse(
        String(yield* noted.host.command("research-object", ready.bundleHash!)),
      ) as ResearchAdvisoryProtocol.Bundle
      expect(bundle.treatment.status).toBe("provided")
      expect(bundle.treatment.text).toContain(reason)
      expect(bundle.feedback.map((entry) => entry.unaddressed)).toEqual([["F1"], ["F1"], []])
      expect(bundle.records.map((item) => item.record.kind)).toEqual(["response", "response", "submission"])
      expect(bundle.commands.some((row) => JSON.stringify(row).includes("protected_input_changed"))).toBe(true)
      expect(bundle.commandConflicts).toEqual([])
    }),
  120_000,
)

it.live(
  "reviewer startup failure is an honest unavailable checkpoint with zero-response submission",
  () =>
    Effect.gen(function* () {
      const initial = yield* view(yield* start(false, "missing-reviewer-agent"))
      const written = yield* advance(initial, [reply().tool("write", { path: "answer.txt", content: "42" })])
      const prepared = yield* advance(written, [
        reply().tool("contract_request", {
          kind: "prepare_candidate",
          payload: { view: initial.view.view, summary: "Verified answer", uncertainties: [] },
        }),
      ])
      const feedback = yield* view({ ...prepared, run: yield* stage(prepared.host, prepared.input.id, "feedback") })
      yield* feedback.llm.push(
        reply().tool("contract_request", { kind: "submit_candidate", payload: { view: feedback.view.view } }),
      )
      feedback.gate.resolve()
      const ready = yield* stage(feedback.host, feedback.input.id, "ready")
      const bundle = JSON.parse(
        String(yield* feedback.host.command("research-object", ready.bundleHash!)),
      ) as ResearchAdvisoryProtocol.Bundle
      expect(bundle.feedback[0].outcome).toMatchObject({ availability: "unavailable", capture: "absent" })
      expect(bundle.feedback[0].outcome.review).toBeUndefined()
      expect(bundle.feedback[0].raw).toBeUndefined()
      expect(bundle.treatment.status).toBe("not_provided")
    }),
  60_000,
)

for (const tamper of ["candidate", "evidence"] as const)
  it.live(
    `advisory submission still rejects changed ${tamper}`,
    () =>
      Effect.gen(function* () {
        const initial = yield* view(yield* start(false))
        const written = yield* advance(initial, [reply().tool("write", { path: "answer.txt", content: "42" })])
        const feedback = yield* view(
          yield* review(
            yield* advance(
              written,
              [
                reply().tool("contract_request", {
                  kind: "prepare_candidate",
                  payload: { view: initial.view.view, summary: "Verified answer", uncertainties: [] },
                }),
              ],
              true,
            ),
            false,
          ),
        )
        yield* Effect.promise(async () => {
          if (tamper === "candidate") {
            await Bun.write(path.join(feedback.run.workspace.directory, "answer.txt"), "43")
            return
          }
          const file = path.join(
            feedback.fixture.storage,
            "data/opencode/pro-contract/blobs",
            Hash.sha256("actual evidence"),
          )
          await rm(file)
          await Bun.write(file, "corrupt evidence")
        })
        const submitted = yield* advance(feedback, [
          reply().tool("contract_request", { kind: "submit_candidate", payload: { view: feedback.view.view } }),
        ])
        const after =
          tamper === "candidate"
            ? yield* stage(submitted.host, submitted.input.id, "execution")
            : yield* get(submitted.host, submitted.input.id)
        expect(after.bundleHash).toBeUndefined()
        expect(after.published).toBeUndefined()
        expect(after.input.spec.budget.deadline).toBe(initial.input.spec.budget.deadline)
        if (tamper === "evidence") {
          expect(after.stage).toBe("feedback")
          expect((yield* toolResult(submitted)).result.accepted).toBe(false)
        }
        if (tamper === "candidate") {
          expect(after.verificationHash).toBeUndefined()
          expect(after.executionPrompt).toContain("research_view")
        }
        yield* submitted.host.command("research-cancel", submitted.input.id)
        submitted.gate.resolve()
      }),
    60_000,
  )
