import { describe, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, Exit, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import path from "node:path"
import { rm } from "node:fs/promises"
import { Hash } from "@opencode-ai/core/util/hash"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import type { ProContract } from "@opencode-ai/schema/pro-contract"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import type { ResearchFeedback } from "../../../sdk-next/src/research/review-feedback"
import type { ResearchFeedbackEvidence } from "../../../sdk-next/src/research/feedback-evidence"
import { ResearchProtocol } from "../../../sdk-next/src/research/protocol"
import { contractProcess } from "../fixture/contract-process"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, NodeServices.layer, FetchHttpClient.layer))
type Host = Effect.Success<ReturnType<Effect.Success<typeof contractProcess>["startHost"]>>
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
  ).pipe(
    Effect.tapError(() =>
      get(host, id).pipe(
        Effect.tap((run) => Effect.sync(() => console.error("CURRENT", run.stage, run.reason, run.feedback))),
      ),
    ),
    Effect.tapError(() =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const last = (yield* llm.inputs).at(-1) as { messages: { role: string; content?: unknown }[] } | undefined
        console.error(last?.messages.filter((message) => message.role === "tool").slice(-3))
      }),
    ),
    Effect.tapError(() => host.log().pipe(Effect.tap((text) => Effect.sync(() => console.error(text))))),
  )

const start = Effect.fnUntraced(function* (options?: {
  planning?: boolean
  lifecycle?: boolean
  feedbackGuidance?: "closure:1"
  policy?: ResearchModel.Manifest["reviewPolicy"]
  deadline?: number
  reviewerAgent?: string
  checkpoints?: boolean
}) {
  const fixture = yield* contractProcess
  const llm = yield* TestLLMServer
  const harness =
    'const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs");test("answer is correct",()=>{assert.equal(fs.readFileSync("answer.txt","utf8"),"42");fs.writeFileSync("result.txt","fresh proof")})'
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
    planning: options?.planning ?? false,
    id: `pct_feedback_${crypto.randomUUID()}`,
    scope: "research-feedback-e2e",
    source: { directory: fixture.directory },
    model: { providerID: "local", id: "researcher" },
    spec: {
      trigger: { type: "immediate" },
      goal: "Deliver the correct answer",
      brief:
        "Set answer.txt to 42; preserve data and the acceptance harness. Address independent review within this task.",
      requires: [],
      authority: ["filesystem.read", "filesystem.write", "process.execute"],
      budget: { deadline: options?.deadline ?? Date.now() + 21_600_000 },
      evidence: { type: "principal", claim: "Externally recognized research candidate" },
      resolution: { retryDelay: 1 },
    },
    manifest: {
      version: 1,
      ...(!options?.lifecycle ? { feedbackProtocol: "response:1" } : {}),
      ...(options?.feedbackGuidance ? { feedbackGuidance: options.feedbackGuidance } : {}),
      reviewPolicy: options?.policy ?? { version: 2, plan: "advisory", delivery: "advisory" },
      requirements: ["answer.txt contains 42"],
      include: ["acceptance.cjs", "answer.txt", "data.txt", "notes.txt", "result.txt", "opencode.json"],
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
        agent: options?.reviewerAgent ?? "build",
        instructions: "Review the original task and actual evidence.",
      },
    },
  }
  const host = yield* fixture.startHost(true, { research: true, checkpoints: options?.checkpoints })
  const gate = Promise.withResolvers<void>()
  yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
  yield* llm.push(reply().tool("read", { path: "answer.txt" }).wait(gate.promise))
  const run = (yield* host.command("research-issue", input.id, input)) as ResearchModel.Run
  yield* llm.wait(1)
  return { fixture, host, llm, input, run, gate, calls: 1 }
})

const plan = (run: ResearchModel.Run) => ({
  version: (run.plan?.value.version ?? 0) + 1,
  agreement: { revision: run.revision, specHash: run.specHash, manifestHash: run.manifestHash },
  scope: "within_task",
  question: "Does the candidate meet the fixed task?",
  hypothesis: "42 satisfies the acceptance predicate",
  baseline: "The initial answer is wrong",
  implementation: "Write answer.txt, then request the formal experiment",
  method: "Use the fixed acceptance harness",
  controls: "Preserve the original harness and data",
  data: "Use the original data.txt",
  evaluation: "Require the exact answer and real test pass",
  uncertainties: "This demonstrates only the fixed predicate",
  protected: [{ path: "data.txt", hash: Hash.sha256("original data") }],
})

const review = Effect.fnUntraced(function* (s: Effect.Success<ReturnType<typeof start>>) {
  const gate = Promise.withResolvers<void>()
  yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
  const actions = s.input.planning
    ? [reply().tool("contract_request", { kind: "plan", payload: plan(s.run) })]
    : [
        reply().tool("write", { path: "answer.txt", content: "42" }),
        reply().tool("contract_report_ready", { summary: "Candidate implemented", uncertainties: [] }),
      ]
  yield* s.llm.push(...actions, reply().tool("read", { path: "evidence/materials.json" }).wait(gate.promise))
  s.gate.resolve()
  yield* s.llm.wait(s.calls + actions.length + 1)
  const run = yield* stage(s.host, s.input.id, s.input.planning ? "plan_review" : "review")
  const references = JSON.parse(
    String(
      yield* s.host.command("research-object", s.input.planning ? run.plan!.referencesHash! : run.referencesHash!),
    ),
  ) as ResearchFeedback.References
  return { ...s, run, references, gate, calls: s.calls + actions.length + 1 }
})

const wire = (map: ResearchFeedback.References, severity: "blocking" | "P1" | "note" = "blocking") => ({
  version: 2,
  ...(map.phase === "plan" ? { scope: "within_task" } : {}),
  verdict: "changes_requested",
  summary: "An independent concern remains",
  findings: [
    {
      id: "concern",
      severity,
      path: map.phase === "plan" ? "plan.method" : "answer.txt",
      reason: "Explain why the fixed answer is sufficient",
      resolution: "State the evidence and limits",
      impact: "The fixed predicate does not establish a universal result",
      evidence: [{ jobID: map.jobID, id: map.entries[0].id }],
      escalation: "Retain the limitation for external consideration",
    },
  ],
  claims: [{ text: "Review bound materials", evidence: [{ jobID: map.jobID, id: map.entries[0].id }] }],
})

const feedback = Effect.fnUntraced(function* (
  s: Effect.Success<ReturnType<typeof review>>,
  raw = JSON.stringify(wire(s.references)),
) {
  const gate = Promise.withResolvers<void>()
  yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
  yield* s.llm.push(
    reply().text(raw).usage({ input: 17, output: 9 }).stop(),
    reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
  )
  s.gate.resolve()
  yield* s.llm.wait(s.calls + 2)
  const run = yield* stage(s.host, s.input.id, "feedback")
  const outcome = JSON.parse(
    String(yield* s.host.command("research-object", run.feedback!.outcomeHash)),
  ) as ResearchFeedback.Outcome
  return { ...s, run, raw, outcome, gate, calls: s.calls + 2 }
})

const response = (
  run: ResearchModel.Run,
  action: "continue" | "repair" | "submit",
  disposition: "fixed" | "rebutted" | "unresolved" | "repair_planned" = "rebutted",
) => ({
  ...(ResearchProtocol.lifecycle(run.input) ? { version: 2, planChange: "retain" } : {}),
  outcomeHash: run.feedback!.outcomeHash,
  responses: [
    {
      findingID: "concern",
      disposition,
      reason: "The exact task requires only the fixed predicate; the broader claim remains outside this evidence",
    },
  ],
  summary: "Addressed the independent opinion and retained the scientific limit",
  action,
})

const nextReview = Effect.fnUntraced(function* (
  s: Effect.Success<ReturnType<typeof feedback>>,
  actions: ReturnType<typeof reply>[],
  phase: "plan" | "delivery" = "delivery",
) {
  const gate = Promise.withResolvers<void>()
  yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
  yield* s.llm.push(...actions, reply().tool("read", { path: "evidence/materials.json" }).wait(gate.promise))
  s.gate.resolve()
  yield* s.llm.wait(s.calls + actions.length + 1)
  const run = yield* stage(s.host, s.input.id, phase === "plan" ? "plan_review" : "review")
  const references = JSON.parse(
    String(
      yield* s.host.command("research-object", phase === "plan" ? run.plan!.referencesHash! : run.referencesHash!),
    ),
  ) as ResearchFeedback.References
  expect(references.promptVersion).toBe(2)
  const prompt = JSON.stringify((yield* s.llm.inputs).at(-1))
  expect(prompt).toContain("Allowed evidence selectors")
  expect(prompt).not.toContain("Allowed evidence references")
  return { ...s, run, references, gate, calls: s.calls + actions.length + 1 }
})

const completion = (run: ResearchModel.Run, responseHash: string) => ({
  responseHash,
  findingID: "concern",
  ...(run.plan ? { planHash: run.plan.hash } : {}),
  subjectHash: run.subjectHash!,
  verificationHash: run.verificationHash!,
  disposition: "fixed",
  reason: "The current retained result file demonstrates the tested predicate; no broader claim is made",
  evidence: [Hash.sha256("fresh proof")],
})

const expireAfterArchive = Effect.fnUntraced(function* (
  s: Effect.Success<ReturnType<typeof start>>,
  checkpoint: string,
) {
  yield* Effect.addFinalizer(() => s.host.command("checkpoint-release", checkpoint).pipe(Effect.ignore))
  yield* pollWithTimeout(
    s.host.command("checkpoint-status", checkpoint).pipe(Effect.map((reached) => (reached ? true : undefined))),
    "Actual archive I/O did not reach the checkpoint before expiry",
    "5 seconds",
  )
  expect(Date.now()).toBeLessThan(s.input.spec.budget.deadline)
  yield* Effect.sleep(Math.max(1, s.input.spec.budget.deadline - Date.now() + 100))
  yield* s.host.command("checkpoint-release", checkpoint)
  return yield* stage(s.host, s.input.id, "unavailable")
})

describe("Versioned independent review feedback production workflow", () => {
  it.live(
    "closure retains unavailable outcomes and empty historical responses after authorized repair",
    () =>
      Effect.gen(function* () {
        const s = yield* start({ lifecycle: true, feedbackGuidance: "closure:1" })
        const initial = yield* feedback(yield* review(s), "original malformed report")
        const original = {
          ...response(initial.run, "repair", "unresolved"),
          responses: [],
          summary: "Repair optional wording; original review unavailable, no defect asserted",
        }
        const next = yield* feedback(
          yield* nextReview(initial, [
            reply().tool("contract_request", { kind: "review_response", payload: original }),
            reply().tool("write", { path: "notes.txt", content: "Scope is the fixed predicate only" }),
            reply().tool("contract_report_ready", { summary: "Updated authorized wording", uncertainties: [] }),
          ]),
        )
        const view = JSON.parse(
          next.run
            .executionPrompt!.split("Closeout state (identity applicability is not semantic completion): ")[1]
            .split("\n")[0],
        )
        expect(view.history).toHaveLength(1)
        expect(view.history[0].outcome.availability).toBe("unavailable")
        expect(view.history[0].raw).toBe("original malformed report")
        expect(view.history[0].response).toEqual(original)
        expect(view.targets).toEqual([])
        yield* s.llm.push(
          reply().tool("contract_request", {
            kind: "review_response",
            payload: response(next.run, "submit", "unresolved"),
          }),
        )
        next.gate.resolve()
        const ready = yield* stage(s.host, s.input.id, "ready")
        expect(ready.completionHashes ?? []).toEqual([])
        expect(ready.input.spec.budget.deadline).toBe(s.input.spec.budget.deadline)
      }),
    60000,
  )

  for (const corrupt of ["current-review", "prior-response", "artifact"] as const)
    it.live(
      `lifecycle completion rejects corrupt ${corrupt} evidence without a completion event`,
      () =>
        Effect.gen(function* () {
          const s = yield* start({ planning: true, lifecycle: true })
          const initial = yield* feedback(yield* review(s))
          const rationale = "Independently retained response evidence"
          const rationaleHash = Hash.sha256(rationale)
          yield* Effect.promise(() =>
            Bun.write(path.join(s.fixture.storage, "data/opencode/pro-contract/blobs", rationaleHash), rationale),
          )
          const intended = response(initial.run, "continue", "repair_planned")
          const final = yield* feedback(
            yield* nextReview(initial, [
              reply().tool("contract_request", {
                kind: "review_response",
                payload: {
                  ...intended,
                  responses: intended.responses.map((item) => ({ ...item, evidence: [rationaleHash] })),
                },
              }),
              reply().tool("write", { path: "answer.txt", content: "42" }),
              reply().tool("contract_request", { kind: "experiment", payload: {} }),
              reply().tool("contract_report_ready", { summary: "Verified candidate", uncertainties: [] }),
            ]),
          )
          const hash =
            corrupt === "current-review"
              ? final.run.reviewHash!
              : corrupt === "prior-response"
                ? rationaleHash
                : Hash.sha256("fresh proof")
          const file = path.join(s.fixture.storage, "data/opencode/pro-contract/blobs", hash)
          const original = yield* Effect.promise(() => Bun.file(file).arrayBuffer())
          yield* Effect.promise(async () => {
            await rm(file)
            await Bun.write(file, "corrupt archive bytes")
          })
          const gate = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
          yield* s.llm.push(
            reply().tool("contract_request", {
              kind: "review_completion",
              payload: completion(final.run, final.run.feedbackHistory![0].responseHash!),
            }),
            reply().tool("contract_request", {
              kind: "read_review_evidence",
              payload: { source: "verification", path: "artifacts/result.txt", offset: 0, length: 16384 },
            }),
            reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
          )
          final.gate.resolve()
          yield* s.llm.wait(final.calls + 3)
          expect((yield* get(s.host, s.input.id)).completionHashes).toBeUndefined()
          expect(JSON.stringify((yield* s.llm.inputs).at(-1))).toContain("corrupt")
          const versions = (yield* s.host.command("research-history", s.input.id)) as { data: ResearchModel.Run }[]
          expect(versions.every((item) => !item.data.completionHashes?.length)).toBe(true)
          yield* Effect.promise(() => Bun.write(file, original))
          yield* s.host.command("research-cancel", s.input.id)
          gate.resolve()
        }),
      90_000,
    )

  for (const kind of ["review_completion", "read_review_evidence"] as const)
    it.live(
      `lifecycle ${kind} rechecks the original deadline after actual evidence I/O`,
      () =>
        Effect.gen(function* () {
          const s = yield* start({ planning: true, lifecycle: true, checkpoints: true, deadline: Date.now() + 35_000 })
          const initial = yield* feedback(yield* review(s))
          const final = yield* feedback(
            yield* nextReview(initial, [
              reply().tool("contract_request", {
                kind: "review_response",
                payload: response(initial.run, "continue", "repair_planned"),
              }),
              reply().tool("write", { path: "answer.txt", content: "42" }),
              reply().tool("contract_request", { kind: "experiment", payload: {} }),
              reply().tool("contract_report_ready", { summary: "Verified candidate", uncertainties: [] }),
            ]),
          )
          const checkpoint =
            kind === "review_completion"
              ? "put:" + ProContractRecognition.fingerprint(final.run)
              : "json:" + final.run.verificationHash!
          yield* s.host.command("checkpoint-arm", checkpoint)
          yield* s.llm.push(
            reply().tool("contract_request", {
              kind,
              payload:
                kind === "review_completion"
                  ? completion(final.run, final.run.feedbackHistory![0].responseHash!)
                  : { source: "verification", path: "artifacts/result.txt", offset: 0, length: 16384 },
            }),
          )
          final.gate.resolve()
          const stopped = yield* expireAfterArchive(s, checkpoint)
          expect(stopped.completionHashes).toBeUndefined()
          expect(stopped.feedback?.responseHash).toBeUndefined()
          const versions = (yield* s.host.command("research-history", s.input.id)) as { data: ResearchModel.Run }[]
          expect(versions.every((item) => !item.data.completionHashes?.length)).toBe(true)
          expect(stopped.input.spec.budget.deadline).toBe(s.input.spec.budget.deadline)
          expect(stopped.bundleHash).toBeUndefined()
        }),
      60_000,
    )

  for (const feedbackGuidance of [undefined, "closure:1"] as const) {
    it.live(
      `lifecycle repair intentions replan, verify and append exact evidence claims without semantic approval (${feedbackGuidance ?? "legacy"})`,
      () =>
        Effect.gen(function* () {
          const s = yield* start({ planning: true, lifecycle: true, feedbackGuidance })
          expect(s.run.input.manifest.feedbackProtocol).toBe("repair-lifecycle:1")
          expect(((yield* s.host.command("research-issue", s.input.id, s.input)) as ResearchModel.Run).inputHash).toBe(
            s.run.inputHash,
          )
          const omitted = { ...s.input.manifest }
          delete omitted.feedbackGuidance
          const retry = yield* s.host.command("research-issue", s.input.id, { ...s.input, manifest: omitted })
          expect((retry as ResearchModel.Run).inputHash).toBe(s.run.inputHash)
          if (!feedbackGuidance) {
            const changed = yield* s.host
              .command("research-issue", s.input.id, {
                ...s.input,
                manifest: { ...s.input.manifest, feedbackGuidance: "closure:1" },
              })
              .pipe(Effect.exit)
            expect(Exit.isFailure(changed)).toBe(true)
          }
          for (const manifest of [
            { ...s.input.manifest, feedbackGuidance: "closure:1", feedbackProtocol: "response:1" },
            {
              ...s.input.manifest,
              feedbackGuidance: "closure:1",
              feedbackProtocol: "repair-lifecycle:1",
              reviewPolicy: { version: 1 },
            },
          ]) {
            const id = `pct_invalid_${crypto.randomUUID()}`
            const rejected = yield* s.host.command("research-issue", id, { ...s.input, id, manifest }).pipe(Effect.exit)
            expect(Exit.isFailure(rejected)).toBe(true)
          }
          const initial = yield* feedback(yield* review(s))
          const revised = yield* feedback(
            yield* nextReview(
              initial,
              [
                reply().tool("contract_request", {
                  kind: "review_response",
                  payload: { ...response(initial.run, "repair", "repair_planned"), planChange: "revise" },
                }),
                reply().tool("contract_request", {
                  kind: "plan",
                  payload: {
                    ...plan(initial.run),
                    method: "Use the fixed acceptance harness and retain the finite limit",
                  },
                }),
              ],
              "plan",
            ),
          )
          expect(revised.run.plan?.value.version).toBe(2)
          expect(revised.run.plan?.admitted).toBe(false)
          const final = yield* feedback(
            yield* nextReview(revised, [
              reply().tool("contract_request", {
                kind: "review_response",
                payload: response(revised.run, "continue", "repair_planned"),
              }),
              reply().tool("write", { path: "answer.txt", content: "42" }),
              reply().tool("contract_request", { kind: "experiment", payload: {} }),
              reply().tool("contract_report_ready", { summary: "Tested repaired implementation", uncertainties: [] }),
            ]),
          )
          if (feedbackGuidance) {
            const prompt = final.run.executionPrompt!
            const view = JSON.parse(
              prompt.split("Closeout state (identity applicability is not semantic completion): ")[1].split("\n")[0],
            )
            expect(view.currentPlan.value.version).toBe(2)
            expect(view.history[0].response.summary).toBe(response(initial.run, "repair").summary)
            expect(view.history[0].outcome).toEqual(initial.outcome)
            expect(
              view.targets.map(
                (item: { original: { plan: { value: { version: number } } } }) => item.original.plan.value.version,
              ),
            ).toEqual([1, 2])
            expect(view.targets.map((item: { state: string }) => item.state)).toEqual([
              "pending_intent",
              "pending_intent",
            ])
            expect(view.targets[0].key.findingID).toBe(view.targets[1].key.findingID)
            expect(view.targets[0].key.outcomeHash).not.toBe(view.targets[1].key.outcomeHash)
            expect(view.targets[0].original.finding.reason).toBe(initial.outcome.review!.findings[0].reason)
            expect(view.targets[0].response.disposition).toBe("repair_planned")
            expect(prompt.indexOf("1. Inspect plan")).toBeLessThan(prompt.indexOf("3. Before the final response"))
            expect(prompt.indexOf("review_completion")).toBeLessThan(prompt.indexOf("LAST:"))
            expect(prompt).toContain("already satisfied before feedback")
            expect(prompt).toContain("no completion record is required merely to submit")
            const changed = yield* s.host
              .command("research-issue", s.input.id, {
                ...s.input,
                manifest: { ...s.input.manifest, feedbackGuidance: "invalid" },
              })
              .pipe(Effect.exit)
            expect(Exit.isFailure(changed)).toBe(true)
          } else expect(final.run.executionPrompt).not.toContain("Closeout state")
          const payload = completion(final.run, final.run.feedbackHistory![0].responseHash!)
          const gate = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
          const invalid = [
            { ...payload, responseHash: "f".repeat(64) },
            { ...payload, findingID: "other-finding" },
            { ...payload, planHash: initial.run.plan!.hash },
            { ...payload, subjectHash: "older-candidate" },
            { ...payload, verificationHash: "e".repeat(64) },
            { ...payload, evidence: [final.run.manifestHash] },
            { ...payload, previousHash: "d".repeat(64) },
          ]
          yield* s.llm.push(
            reply().tool("write", { path: "answer.txt", content: "cannot write in feedback" }),
            ...invalid.map((value) => reply().tool("contract_request", { kind: "review_completion", payload: value })),
            reply().tool("contract_request", {
              kind: "review_response",
              payload: response(final.run, "submit", "fixed"),
            }),
            reply().tool("contract_request", {
              kind: "read_review_evidence",
              payload: { source: "verification", path: "../answer.txt", offset: 0, length: 16 },
            }),
            reply().tool("contract_request", {
              kind: "read_review_evidence",
              payload: { source: "verification", path: "artifacts/result.txt", offset: 0, length: 5 },
            }),
            reply().tool("contract_request", {
              kind: "read_review_evidence",
              payload: { source: "experiment", path: "artifacts/result.txt", offset: 5, length: 16384 },
            }),
            reply().tool("contract_request", { kind: "review_completion", payload }),
            reply().tool("contract_request", { kind: "review_completion", payload }),
            reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
          )
          final.gate.resolve()
          yield* s.llm.wait(final.calls + invalid.length + 8)
          const current = yield* get(s.host, s.input.id)
          expect(current.completionHashes).toHaveLength(1)
          expect(current.feedback?.responseHash).toBeUndefined()
          expect(
            yield* Effect.promise(() => Bun.file(path.join(current.workspace.directory, "answer.txt")).text()),
          ).toBe("42")
          const transcript = JSON.stringify((yield* s.llm.inputs).at(-1))
          for (const message of [
            "absent or ambiguous",
            "original response",
            "identity",
            "allowlist",
            "predecessor",
            "fresh",
            "proof",
            "repeated",
          ])
            expect(transcript).toContain(message)
          const correction = {
            ...payload,
            previousHash: current.completionHashes![0],
            disposition: "unresolved",
            reason: "The original universal limitation remains",
          }
          yield* s.llm.push(
            reply().tool("contract_request", { kind: "review_completion", payload: correction }),
            reply().tool("contract_request", {
              kind: "review_completion",
              payload: { ...payload, reason: "stale predecessor" },
            }),
            reply().tool("contract_request", {
              kind: "review_response",
              payload: response(current, "submit", "unresolved"),
            }),
          )
          gate.resolve()
          const ready = yield* stage(s.host, s.input.id, "ready")
          const bundle = (yield* s.host.command("research-bundle", s.input.id)) as ResearchFeedbackEvidence.Bundle
          expect(bundle.feedbackProtocol).toBe("repair-lifecycle:1")
          expect(bundle.feedback.map((item) => item.response.responses[0].disposition)).toEqual([
            "repair_planned",
            "repair_planned",
            "unresolved",
          ])
          expect(bundle.completions?.map((item) => item.completion.request.disposition)).toEqual([
            "fixed",
            "unresolved",
          ])
          expect(bundle.completions?.every((item) => item.current)).toBe(true)
          expect(ready.completionHashes).toHaveLength(2)
          expect(ready.input.spec.budget).toEqual({ deadline: s.input.spec.budget.deadline })
          const receipt = (yield* s.host.command("root-attest", s.input.id, {
            contractID: s.input.id,
            expected: ready.published,
            evidenceHash: ready.bundleHash,
            operationID: crypto.randomUUID(),
          })) as ProContract.OperationReceipt
          expect(receipt.decision.type).toBe("accepted")
          yield* stage(s.host, s.input.id, "accepted")
          expect(yield* s.llm.misses).toHaveLength(0)
        }),
      120_000,
    )

    it.live(
      `delivery method changes replan and preserve old completion identity while distinguishing removal (${feedbackGuidance ?? "legacy"})`,
      () =>
        Effect.gen(function* () {
          const s = yield* start({ planning: true, lifecycle: true, feedbackGuidance })
          const initial = yield* feedback(yield* review(s))
          const first = yield* feedback(
            yield* nextReview(initial, [
              reply().tool("contract_request", {
                kind: "review_response",
                payload: response(initial.run, "continue", "repair_planned"),
              }),
              reply().tool("write", { path: "answer.txt", content: "42" }),
              reply().tool("write", { path: "notes.txt", content: "Optional diagnostic retained" }),
              reply().tool("contract_request", { kind: "experiment", payload: {} }),
              reply().tool("contract_report_ready", { summary: "First candidate", uncertainties: [] }),
            ]),
          )
          const payload = completion(first.run, first.run.feedbackHistory![0].responseHash!)
          const revised = yield* feedback(
            yield* nextReview(
              first,
              [
                reply().tool("contract_request", { kind: "review_completion", payload }),
                reply().tool("contract_request", {
                  kind: "review_response",
                  payload: { ...response(first.run, "repair", "repair_planned"), planChange: "revise" },
                }),
                reply().tool("contract_request", { kind: "experiment", payload: {} }),
                reply().tool("contract_request", {
                  kind: "plan",
                  payload: {
                    ...plan(first.run),
                    method: "Remove the optional diagnostic, retain only the fixed acceptance predicate",
                  },
                }),
              ],
              "plan",
            ),
          )
          expect(revised.run.plan?.value.version).toBe(2)
          expect(revised.run.experiment).toBeUndefined()
          const next = yield* nextReview(revised, [
            reply().tool("contract_request", {
              kind: "review_response",
              payload: response(revised.run, "continue", "unresolved"),
            }),
            reply().tool("write", {
              path: "notes.txt",
              content: "Optional diagnostic removed; only the required predicate is retained",
            }),
            reply().tool("contract_request", { kind: "experiment", payload: {} }),
            reply().tool("contract_report_ready", {
              summary: "Diagnostic removed; no implementation repair claimed",
              uncertainties: [],
            }),
          ])
          const materials = JSON.parse(String(yield* s.host.command("research-object", next.run.materialsHash!)))
          expect(materials.previousCompletionClaims).toHaveLength(1)
          expect(materials.previousCompletionClaims[0].current).toBe(false)
          expect(
            yield* Effect.promise(() =>
              Bun.file(
                path.join(next.run.reviewDirectory!, "evidence", materials.previousCompletionClaims[0].hash),
              ).exists(),
            ),
          ).toBe(true)
          const final = yield* feedback(next, "malformed reviewer output")
          if (feedbackGuidance) {
            const view = JSON.parse(
              final.run
                .executionPrompt!.split("Closeout state (identity applicability is not semantic completion): ")[1]
                .split("\n")[0],
            )
            expect(view.currentReview.availability).toBe("unavailable")
            expect(view.currentReview.findings).toEqual([])
            expect(view.targets[0].state).toBe("historical_claim_only")
            expect(view.targets[0].claims[0].current).toBe(false)
            expect(view.targets[1].key.outcomeHash).not.toBe(view.targets[0].key.outcomeHash)
            expect(view.currentPlan.value.method).toContain("Remove the optional diagnostic")
          }
          const removed = {
            ...completion(final.run, final.run.feedbackHistory![1].responseHash!),
            disposition: "removed",
          }
          yield* s.llm.push(
            reply().tool("contract_request", { kind: "review_completion", payload }),
            reply().tool("contract_request", { kind: "review_completion", payload: removed }),
            reply().tool("contract_request", {
              kind: "review_response",
              payload: { ...response(final.run, "submit", "unresolved"), responses: [] },
            }),
          )
          final.gate.resolve()
          yield* stage(s.host, s.input.id, "ready")
          const bundle = (yield* s.host.command("research-bundle", s.input.id)) as ResearchFeedbackEvidence.Bundle
          expect(bundle.verdict).toBe("unavailable")
          expect(bundle.completions?.map((item) => [item.current, item.completion.request.disposition])).toEqual([
            [false, "fixed"],
            [true, "removed"],
          ])
          expect(bundle.feedback[1].response).toMatchObject({
            planChange: "revise",
            responses: [{ disposition: "repair_planned" }],
          })
          expect(bundle.feedback.at(-1)?.raw).toBe("malformed reviewer output")
          expect(yield* s.llm.misses).toHaveLength(0)
        }),
      120_000,
    )
  }

  for (const feedbackGuidance of [undefined, "closure:1"] as const) {
    it.live(
      `final-only lifecycle repairs remain in scope and pending intentions may be submitted honestly (${feedbackGuidance ?? "legacy"})`,
      () =>
        Effect.gen(function* () {
          const s = yield* start({ lifecycle: true, feedbackGuidance })
          const initial = yield* feedback(yield* review(s))
          if (feedbackGuidance) {
            expect(initial.run.executionPrompt).toContain("This final-only task has no execution plan")
            expect(initial.run.executionPrompt).not.toContain("with currentPlan")
          }
          const final = yield* feedback(
            yield* nextReview(initial, [
              reply().tool("contract_request", {
                kind: "review_response",
                payload: { ...response(initial.run, "repair", "repair_planned"), planChange: "revise" },
              }),
              reply().tool("contract_request", {
                kind: "review_response",
                payload: response(initial.run, "repair", "repair_planned"),
              }),
              reply().tool("write", { path: "notes.txt", content: "Finite predicate evidence only" }),
              reply().tool("contract_report_ready", { summary: "Clarified limitation", uncertainties: [] }),
            ]),
          )
          const gate = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
          yield* s.llm.push(
            reply().tool("contract_request", {
              kind: "read_review_evidence",
              payload: { source: "experiment", path: "artifacts/result.txt", offset: 0, length: 16384 },
            }),
            reply().tool("contract_request", {
              kind: "read_review_evidence",
              payload: { source: "verification", path: "artifacts/result.txt", offset: 0, length: 16384 },
            }),
            reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
          )
          final.gate.resolve()
          yield* s.llm.wait(final.calls + 3)
          expect(JSON.stringify((yield* s.llm.inputs).at(-1))).toContain("fresh proof")
          expect((yield* get(s.host, s.input.id)).completionHashes).toBeUndefined()
          yield* s.llm.push(
            reply().tool("contract_request", {
              kind: "review_response",
              payload: response(final.run, "submit", "repair_planned"),
            }),
          )
          gate.resolve()
          yield* stage(s.host, s.input.id, "ready")
          const bundle = (yield* s.host.command("research-bundle", s.input.id)) as ResearchFeedbackEvidence.Bundle
          expect(bundle.feedback.map((item) => item.response.responses[0].disposition)).toEqual([
            "repair_planned",
            "repair_planned",
          ])
          expect(bundle.completions).toEqual([])
          expect(bundle.experiment).toBeUndefined()
        }),
      90_000,
    )
  }

  it.live(
    "rechecks the original deadline after real response archival before committing feedback",
    () =>
      Effect.gen(function* () {
        const s = yield* start({ deadline: Date.now() + 20_000, checkpoints: true })
        const f = yield* feedback(yield* review(s))
        const payload = response(f.run, "submit")
        const checkpoint = "put:" + ProContractRecognition.fingerprint(payload)
        yield* s.host.command("checkpoint-arm", checkpoint)
        yield* s.llm.push(reply().tool("contract_request", { kind: "review_response", payload }))
        f.gate.resolve()
        const stopped = yield* expireAfterArchive(s, checkpoint)
        expect(stopped.feedback?.responseHash).toBeUndefined()
        expect(stopped.feedbackHistory?.[0].responseHash).toBeUndefined()
        expect(stopped.plan?.admissionHash).toBeUndefined()
        expect(stopped.bundleHash).toBeUndefined()
        const versions = (yield* s.host.command("research-history", s.input.id)) as { data: ResearchModel.Run }[]
        expect(versions.every((item) => item.data.feedbackHistory?.every((entry) => !entry.responseHash) ?? true)).toBe(
          true,
        )
        expect(
          ((yield* s.host.command("root-info", s.input.id)) as ProContract.Info).recognition?.handoff,
        ).toBeUndefined()
      }),
    45_000,
  )

  it.live(
    "rolls back the Core handoff when the deadline passes during actual bundle archival",
    () =>
      Effect.gen(function* () {
        const s = yield* start({ deadline: Date.now() + 20_000, checkpoints: true })
        const f = yield* feedback(yield* review(s))
        yield* s.host.command("checkpoint-arm", "review-archived")
        yield* s.llm.push(
          reply().tool("contract_request", { kind: "review_response", payload: response(f.run, "submit") }),
        )
        f.gate.resolve()
        const stopped = yield* expireAfterArchive(s, "review-archived")
        expect(stopped.feedbackHistory?.[0].responseHash).toBeTruthy()
        expect(stopped.bundleHash).toBeUndefined()
        expect(stopped.published).toBeUndefined()
        const contract = (yield* s.host.command("root-info", s.input.id)) as ProContract.Info
        expect(contract.recognition?.handoff).toBeUndefined()
        expect(contract.status).not.toBe("verification")
        const versions = (yield* s.host.command("research-history", s.input.id)) as { data: ResearchModel.Run }[]
        expect(versions.some((item) => item.data.stage === "ready")).toBe(false)
      }),
    45_000,
  )

  it.live(
    "does not admit an experiment after evidence reads cross the original deadline",
    () =>
      Effect.gen(function* () {
        const s = yield* start({ planning: true, deadline: Date.now() + 25_000, checkpoints: true })
        const f = yield* feedback(yield* review(s))
        const gate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
        yield* s.llm.push(
          reply().tool("contract_request", { kind: "review_response", payload: response(f.run, "continue") }),
          reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
        )
        f.gate.resolve()
        yield* s.llm.wait(f.calls + 2)
        const run = yield* stage(s.host, s.input.id, "execution")
        const checkpoint = "json:" + run.plan!.admissionHash!
        yield* s.host.command("checkpoint-arm", checkpoint)
        yield* s.llm.push(reply().tool("contract_request", { kind: "experiment", payload: {} }))
        gate.resolve()
        const stopped = yield* expireAfterArchive(s, checkpoint)
        expect(stopped.experiment).toBeUndefined()
        const versions = (yield* s.host.command("research-history", s.input.id)) as { data: ResearchModel.Run }[]
        expect(versions.some((item) => item.data.purpose === "experiment")).toBe(false)
        expect((yield* s.fixture.operations(s.input.id)).some((item) => item.kind === "verification")).toBe(false)
      }),
    50_000,
  )

  it.live(
    "persisted historical tasks without policy retain mandatory review through exact issuance retry",
    () =>
      Effect.gen(function* () {
        const s = yield* start({ policy: { version: 1 } })
        yield* s.host.command("research-cancel", s.input.id)
        s.gate.resolve()
        const cancelled = yield* stage(s.host, s.input.id, "cancelled")
        const manifest = { ...cancelled.input.manifest }
        delete manifest.reviewPolicy
        delete manifest.feedbackProtocol
        const input = { ...cancelled.input, manifest }
        const historical = {
          ...cancelled,
          input,
          inputHash: ProContractRecognition.fingerprint(input),
          manifestHash: ProContractRecognition.fingerprint(manifest),
          version: cancelled.version + 1,
        }
        // Seed only this isolated, already-cancelled fixture with a pre-policy durable row.
        // The production issuer and its exact-retry hash check remain in the child process.
        yield* Effect.promise(() =>
          Bun.write(
            path.join(s.fixture.storage, "data/opencode/pro-contract/blobs", historical.manifestHash),
            ProContractRecognition.canonical(manifest),
          ),
        )
        yield* Effect.sync(() => {
          using db = new Database(path.join(s.fixture.storage, "opencode.db"))
          db.exec("PRAGMA busy_timeout = 5000")
          db.transaction(() => {
            db.query("UPDATE sdk_research_run_v1 SET version = ?, data = ? WHERE id = ?").run(
              historical.version,
              JSON.stringify(historical),
              historical.id,
            )
            db.query("INSERT INTO sdk_research_event_v1 (id, version, data) VALUES (?, ?, ?)").run(
              historical.id,
              historical.version,
              JSON.stringify(historical),
            )
          })()
        })
        const retried = (yield* s.host.command("research-issue", s.input.id, input)) as ResearchModel.Run
        expect(retried.stage).toBe("cancelled")
        expect(retried.input.manifest.reviewPolicy).toBeUndefined()
        expect(retried.inputHash).toBe(historical.inputHash)
        expect(retried.manifestHash).toBe(historical.manifestHash)
        expect(ResearchProtocol.required(retried.input, "plan")).toBe(true)
        expect(ResearchProtocol.required(retried.input, "delivery")).toBe(true)
        const downgraded = yield* s.host
          .command("research-issue", s.input.id, {
            ...input,
            manifest: { ...manifest, reviewPolicy: { version: 2, plan: "advisory", delivery: "advisory" } },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(downgraded)).toBe(true)
        expect((yield* get(s.host, s.input.id)).inputHash).toBe(historical.inputHash)
      }),
    60_000,
  )

  it.live(
    "persisted v2 tasks without feedbackProtocol retain response:1 semantics through exact retries",
    () =>
      Effect.gen(function* () {
        const s = yield* start()
        yield* s.host.command("research-cancel", s.input.id)
        s.gate.resolve()
        const cancelled = yield* stage(s.host, s.input.id, "cancelled")
        const manifest = { ...cancelled.input.manifest }
        delete manifest.feedbackProtocol
        const input = { ...cancelled.input, manifest }
        const historical = {
          ...cancelled,
          input,
          inputHash: ProContractRecognition.fingerprint(input),
          manifestHash: ProContractRecognition.fingerprint(manifest),
          version: cancelled.version + 1,
        }
        // Seed only this isolated, already-cancelled fixture with a pre-lifecycle durable row.
        // The production issuer and its exact-retry hash check remain in the child process.
        yield* Effect.promise(() =>
          Bun.write(
            path.join(s.fixture.storage, "data/opencode/pro-contract/blobs", historical.manifestHash),
            ProContractRecognition.canonical(manifest),
          ),
        )
        yield* Effect.sync(() => {
          using db = new Database(path.join(s.fixture.storage, "opencode.db"))
          db.exec("PRAGMA busy_timeout = 5000")
          db.transaction(() => {
            db.query("UPDATE sdk_research_run_v1 SET version = ?, data = ? WHERE id = ?").run(
              historical.version,
              JSON.stringify(historical),
              historical.id,
            )
            db.query("INSERT INTO sdk_research_event_v1 (id, version, data) VALUES (?, ?, ?)").run(
              historical.id,
              historical.version,
              JSON.stringify(historical),
            )
          })()
        })
        const retried = (yield* s.host.command("research-issue", s.input.id, input)) as ResearchModel.Run
        expect(retried.stage).toBe("cancelled")
        expect(retried.input.manifest.reviewPolicy).toEqual({ version: 2, plan: "advisory", delivery: "advisory" })
        expect(retried.input.manifest.feedbackProtocol).toBeUndefined()
        expect(ResearchProtocol.lifecycle(retried.input)).toBe(false)
        expect(retried.inputHash).toBe(historical.inputHash)
        expect(retried.manifestHash).toBe(historical.manifestHash)
        expect(ResearchProtocol.required(retried.input, "plan")).toBe(false)
        expect(ResearchProtocol.required(retried.input, "delivery")).toBe(false)
        const downgraded = yield* s.host
          .command("research-issue", s.input.id, {
            ...input,
            manifest: { ...manifest, feedbackProtocol: "repair-lifecycle:1" },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(downgraded)).toBe(true)
        expect((yield* get(s.host, s.input.id)).inputHash).toBe(historical.inputHash)
      }),
    60_000,
  )

  for (const lifecycle of [false, true])
    it.live(
      `advisory P1 opinion supports a response, formal experiment and an independently reviewable candidate (lifecycle=${lifecycle})`,
      () =>
        Effect.gen(function* () {
          const s = yield* start({ planning: true, lifecycle })
          expect(s.run.input.manifest.reviewPolicy).toEqual({ version: 2, plan: "advisory", delivery: "advisory" })
          const retried = (yield* s.host.command("research-issue", s.input.id, s.input)) as ResearchModel.Run
          expect(retried.inputHash).toBe(s.run.inputHash)
          expect(retried.manifestHash).toBe(s.run.manifestHash)
          const changed = yield* s.host
            .command("research-issue", s.input.id, {
              ...s.input,
              manifest: { ...s.input.manifest, reviewPolicy: { version: 2, plan: "required", delivery: "required" } },
            })
            .pipe(Effect.exit)
          expect(Exit.isFailure(changed)).toBe(true)
          const reviewed = yield* review(s)
          const f = yield* feedback(reviewed, JSON.stringify(wire(reviewed.references, "P1")))
          expect(f.outcome).toMatchObject({
            availability: "available",
            capture: "complete",
            review: { verdict: "changes_requested", findings: [{ severity: "P1" }] },
          })
          expect(f.outcome.resolved[0].hash).toBe(reviewed.references.entries[0].hash)
          const gate = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
          yield* s.llm.push(
            reply().tool("contract_request", { kind: "review_response", payload: response(f.run, "continue") }),
            reply().tool("write", { path: "answer.txt", content: "42" }),
            reply().tool("contract_request", { kind: "experiment", payload: {} }),
            reply().tool("contract_report_ready", {
              summary: "Experiment proves the fixed predicate",
              uncertainties: ["No universal claim"],
            }),
            reply().tool("read", { path: "evidence/materials.json" }).wait(gate.promise),
          )
          f.gate.resolve()
          yield* s.llm.wait(f.calls + 5)
          const run = yield* stage(s.host, s.input.id, "review")
          expect(run.plan?.admitted).toBe(true)
          expect(run.plan?.approved).not.toBe(true)
          expect(run.experiment?.approvalHash).toBe(run.plan?.admissionHash)
          expect(run.input.spec.budget).toEqual({ deadline: s.input.spec.budget.deadline })
          const references = JSON.parse(
            String(yield* s.host.command("research-object", run.referencesHash!)),
          ) as ResearchFeedback.References
          const final = yield* feedback({ ...f, run, references, gate, calls: f.calls + 5 })
          const repairedGate = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => repairedGate.resolve()))
          yield* s.llm.push(
            reply().tool("contract_request", {
              kind: "review_response",
              payload: response(final.run, "repair", "unresolved"),
            }),
            reply().tool("write", {
              path: "notes.txt",
              content: "The fixed acceptance predicate is supported; no universal claim is made.",
            }),
            reply().tool("contract_request", { kind: "experiment", payload: {} }),
            reply().tool("contract_report_ready", {
              summary: "Added the requested explanation and repeated the formal experiment",
              uncertainties: ["Finite evidence"],
            }),
            reply().tool("read", { path: "evidence/materials.json" }).wait(repairedGate.promise),
          )
          final.gate.resolve()
          yield* s.llm.wait(final.calls + 5)
          const repaired = yield* stage(s.host, s.input.id, "review")
          expect(repaired.subjectHash).not.toBe(run.subjectHash)
          expect(repaired.experiment?.verificationHash).not.toBe(run.experiment?.verificationHash)
          expect(repaired.plan?.reportHash).toBe(run.plan?.reportHash)
          const repairedMap = JSON.parse(
            String(yield* s.host.command("research-object", repaired.referencesHash!)),
          ) as ResearchFeedback.References
          const latest = yield* feedback({
            ...final,
            run: repaired,
            references: repairedMap,
            gate: repairedGate,
            calls: final.calls + 5,
          })
          yield* s.llm.push(
            reply().tool("contract_request", {
              kind: "review_response",
              payload: response(latest.run, "submit", lifecycle ? "unresolved" : "fixed"),
            }),
          )
          latest.gate.resolve()
          const ready = yield* stage(s.host, s.input.id, "ready")
          const bundle = (yield* s.host.command("research-bundle", s.input.id)) as ResearchFeedbackEvidence.Bundle
          expect(bundle).toMatchObject({
            version: 2,
            verdict: "changes_requested",
            policy: { version: 2, plan: "advisory", delivery: "advisory" },
          })
          expect(bundle.feedback).toHaveLength(3)
          expect(bundle.feedback[0].raw).toBe(f.raw)
          expect(bundle.feedback[0].response.responses[0].disposition).toBe("rebutted")
          expect(bundle.feedback[1].response.responses[0].disposition).toBe("unresolved")
          expect(bundle.feedback[1].outcome.review?.findings[0].escalation).toContain("external")
          expect(bundle.feedback[2].response.responses[0].disposition).toBe(lifecycle ? "unresolved" : "fixed")
          expect(((yield* s.host.command("root-info", s.input.id)) as ProContract.Info).status).toBe("verification")
          expect(
            (yield* s.fixture.operations(s.input.id)).filter(
              (item) => item.kind === "provider" && item.source.jobID === ready.reviewJobID,
            ).length,
          ).toBe(2)
          expect(yield* s.llm.misses).toHaveLength(0)
        }),
      90_000,
    )

  it.live(
    "malformed reviewer output is retained as unavailable and advisory submission never fabricates accept",
    () =>
      Effect.gen(function* () {
        const s = yield* start()
        const f = yield* feedback(
          yield* review(s),
          '{"version":2,"verdict":"accept","claims":[{"evidence":["' + "a".repeat(63) + '"]}]}',
        )
        expect(f.outcome).toMatchObject({ availability: "unavailable", capture: "complete", jobStatus: "completed" })
        expect(f.outcome.review).toBeUndefined()
        expect(yield* s.host.command("research-object", f.outcome.rawHash!)).toBe(f.raw)
        yield* s.llm.push(
          reply().tool("contract_request", {
            kind: "review_response",
            payload: {
              outcomeHash: f.run.feedback!.outcomeHash,
              responses: [],
              summary: "Reviewer format failed; submit the mechanically verified candidate with that limitation",
              action: "submit",
            },
          }),
        )
        f.gate.resolve()
        const ready = yield* stage(s.host, s.input.id, "ready")
        const bundle = (yield* s.host.command("research-bundle", s.input.id)) as ResearchFeedbackEvidence.Bundle
        expect(bundle.verdict).toBe("unavailable")
        expect(bundle.feedback[0].outcome.availability).toBe("unavailable")
        expect(bundle.feedback[0].raw).toBe(f.raw)
        expect(bundle.feedback[0].response.responses).toEqual([])
        expect(ready.stage).toBe("ready")
        expect(((yield* s.host.command("root-info", s.input.id)) as ProContract.Info).status).toBe("verification")
        expect(
          (yield* s.fixture.operations(s.input.id)).filter(
            (item) => item.kind === "provider" && item.source.jobID === ready.reviewJobID,
          ).length,
        ).toBe(2)
        expect(yield* s.llm.misses).toHaveLength(0)
        const receipt = (yield* s.host.command("root-attest", s.input.id, {
          contractID: s.input.id,
          expected: ready.published,
          evidenceHash: ready.bundleHash,
          operationID: crypto.randomUUID(),
        })) as ProContract.OperationReceipt
        expect(receipt.decision.type).toBe("accepted")
        expect((yield* stage(s.host, s.input.id, "accepted")).bundleHash).toBe(ready.bundleHash)
      }),
    60_000,
  )

  it.live(
    "feedback denies writes and incomplete, foreign or duplicated responses without asking for a task revision",
    () =>
      Effect.gen(function* () {
        const s = yield* start()
        const f = yield* feedback(yield* review(s))
        const valid = response(f.run, "submit")
        const gate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
        const invalid = [
          { ...valid, responses: [] },
          { ...valid, outcomeHash: "f".repeat(64) },
          { ...valid, responses: [...valid.responses, ...valid.responses] },
          { ...valid, responses: [{ ...valid.responses[0], findingID: "foreign" }] },
        ]
        yield* s.llm.push(
          reply().tool("write", { path: "answer.txt", content: "unauthorized" }),
          ...invalid.map((payload) => reply().tool("contract_request", { kind: "review_response", payload })),
          reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
        )
        f.gate.resolve()
        yield* s.llm.wait(f.calls + invalid.length + 2)
        const current = yield* get(s.host, s.input.id)
        expect(current.stage).toBe("feedback")
        expect(current.feedback?.responseHash).toBeUndefined()
        expect(yield* Effect.promise(() => Bun.file(path.join(current.workspace.directory, "answer.txt")).text())).toBe(
          "42",
        )
        const transcript = JSON.stringify((yield* s.llm.inputs).at(-1))
        expect(transcript).toContain("Every original finding needs exactly one response")
        expect(transcript).toContain("Review response identity changed")
        expect(((yield* s.host.command("root-info", s.input.id)) as ProContract.Info).pendingRevision).toBeUndefined()
        yield* s.llm.push(reply().tool("contract_request", { kind: "review_response", payload: valid }))
        gate.resolve()
        yield* stage(s.host, s.input.id, "ready")
      }),
    60_000,
  )

  for (const lifecycle of [false, true])
    it.live(
      `explicit required review refuses non-accept continuation and permits an in-scope plan repair (lifecycle=${lifecycle})`,
      () =>
        Effect.gen(function* () {
          const s = yield* start({
            lifecycle,
            planning: true,
            policy: { version: 2, plan: "required", delivery: "required" },
          })
          const f = yield* feedback(yield* review(s))
          const gate = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
          yield* s.llm.push(
            reply().tool("contract_request", { kind: "review_response", payload: response(f.run, "continue") }),
            reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
          )
          f.gate.resolve()
          yield* s.llm.wait(f.calls + 2)
          expect((yield* get(s.host, s.input.id)).stage).toBe("feedback")
          expect(JSON.stringify((yield* s.llm.inputs).at(-1))).toContain(
            "explicitly requires an available independent accept",
          )
          const repair = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => repair.resolve()))
          yield* s.llm.push(
            reply().tool("contract_request", {
              kind: "review_response",
              payload: response(f.run, "repair", "unresolved"),
            }),
            reply().tool("read", { path: "answer.txt" }).wait(repair.promise),
          )
          gate.resolve()
          yield* s.llm.wait(f.calls + 4)
          const current = yield* stage(s.host, s.input.id, "exploration")
          expect(current.plan?.admitted).toBe(false)
          expect(current.feedbackHistory?.[0].responseHash).toBeTruthy()
          expect(current.input.spec.budget.deadline).toBe(s.input.spec.budget.deadline)
          expect(((yield* s.host.command("root-info", s.input.id)) as ProContract.Info).pendingRevision).toBeUndefined()
          yield* s.host.command("research-cancel", s.input.id)
          repair.resolve()
        }),
      60_000,
    )

  it.live(
    "a reference from a different review job remains unavailable even when its target hash is valid",
    () =>
      Effect.gen(function* () {
        const s = yield* start()
        const r = yield* review(s)
        const raw = wire(r.references)
        const f = yield* feedback(
          r,
          JSON.stringify({
            ...raw,
            claims: [
              { text: "Foreign reference", evidence: [{ jobID: "older-review-job", id: r.references.entries[0].id }] },
            ],
          }),
        )
        expect(f.outcome.availability).toBe("unavailable")
        expect(f.outcome.error).toContain("another review job")
        expect(f.outcome.review).toBeUndefined()
        expect(f.outcome.resolved).toEqual([])
        expect(yield* s.host.command("research-object", f.outcome.rawHash!)).toBe(f.raw)
        yield* s.host.command("research-cancel", s.input.id)
        f.gate.resolve()
      }),
    60_000,
  )

  it.live(
    "a candidate changed during feedback cannot reuse the reviewed verification to become ready",
    () =>
      Effect.gen(function* () {
        const s = yield* start()
        const f = yield* feedback(yield* review(s))
        yield* Effect.promise(() => Bun.write(path.join(f.run.workspace.directory, "answer.txt"), "43"))
        const gate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
        yield* s.llm.push(
          reply().tool("contract_request", { kind: "review_response", payload: response(f.run, "submit") }),
          reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
        )
        f.gate.resolve()
        yield* s.llm.wait(f.calls + 2)
        const repaired = yield* stage(s.host, s.input.id, "execution")
        expect(repaired.bundleHash).toBeUndefined()
        expect(repaired.verificationHash).toBeUndefined()
        expect(repaired.feedbackHistory?.[0].responseHash).toBeTruthy()
        expect(repaired.input.spec.budget.deadline).toBe(s.input.spec.budget.deadline)
        expect(repaired.executionPrompt).toContain("Candidate changed after review")
        yield* s.host.command("research-cancel", s.input.id)
        gate.resolve()
      }),
    60_000,
  )

  it.live(
    "advisory submission remains blocked by a corrupted formal experiment artifact",
    () =>
      Effect.gen(function* () {
        const s = yield* start()
        const f = yield* feedback(yield* review(s))
        const file = path.join(s.fixture.storage, "data/opencode/pro-contract/blobs", Hash.sha256("fresh proof"))
        yield* Effect.promise(async () => {
          await rm(file)
          await Bun.write(file, "corrupted proof")
        })
        const gate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
        yield* s.llm.push(
          reply().tool("contract_request", { kind: "review_response", payload: response(f.run, "submit") }),
          reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
        )
        f.gate.resolve()
        yield* s.llm.wait(f.calls + 2)
        const stopped = yield* get(s.host, s.input.id)
        expect(stopped.stage).toBe("feedback")
        expect(stopped.bundleHash).toBeUndefined()
        expect(stopped.published).toBeUndefined()
        expect(stopped.feedbackHistory?.[0].responseHash).toBeUndefined()
        expect(JSON.stringify((yield* s.llm.inputs).at(-1))).toContain("corrupt")
        expect(((yield* s.host.command("root-info", s.input.id)) as ProContract.Info).status).not.toBe("accepted")
        yield* s.host.command("research-cancel", s.input.id)
        gate.resolve()
      }),
    60_000,
  )

  for (const lifecycle of [false, true])
    it.live(
      `explicit required delivery cannot submit an unavailable review but can reopen authorized repair (lifecycle=${lifecycle})`,
      () =>
        Effect.gen(function* () {
          const s = yield* start({ lifecycle, policy: { version: 2, plan: "advisory", delivery: "required" } })
          const f = yield* feedback(yield* review(s), "reviewer produced no valid JSON")
          const gate = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
          const payload = {
            ...(lifecycle ? { version: 2, planChange: "retain" } : {}),
            outcomeHash: f.run.feedback!.outcomeHash,
            responses: [],
            summary: "Reviewer unavailable; retain the missing assessment",
            action: "submit",
          }
          yield* s.llm.push(
            reply().tool("contract_request", { kind: "review_response", payload }),
            reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
          )
          f.gate.resolve()
          yield* s.llm.wait(f.calls + 2)
          const current = yield* get(s.host, s.input.id)
          expect(current.stage).toBe("feedback")
          expect(current.bundleHash).toBeUndefined()
          expect(current.feedback?.responseHash).toBeUndefined()
          expect(JSON.stringify((yield* s.llm.inputs).at(-1))).toContain(
            "explicitly requires an available independent accept",
          )
          const repair = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => repair.resolve()))
          yield* s.llm.push(
            reply().tool("contract_request", { kind: "review_response", payload: { ...payload, action: "repair" } }),
            reply().tool("read", { path: "answer.txt" }).wait(repair.promise),
          )
          gate.resolve()
          yield* s.llm.wait(f.calls + 4)
          expect((yield* stage(s.host, s.input.id, "execution")).feedbackHistory?.[0].responseHash).toBeTruthy()
          yield* s.host.command("research-cancel", s.input.id)
          repair.resolve()
        }),
      60_000,
    )

  it.live(
    "a reviewer unavailable before launch yields honest absent feedback and allows advisory submission",
    () =>
      Effect.gen(function* () {
        const s = yield* start({ reviewerAgent: "missing-reviewer-agent" })
        const gate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
        yield* s.llm.push(
          reply().tool("write", { path: "answer.txt", content: "42" }),
          reply().tool("contract_report_ready", { summary: "Verified candidate", uncertainties: [] }),
          reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
        )
        s.gate.resolve()
        yield* s.llm.wait(s.calls + 3)
        const run = yield* stage(s.host, s.input.id, "feedback")
        const outcome = JSON.parse(
          String(yield* s.host.command("research-object", run.feedback!.outcomeHash)),
        ) as ResearchFeedback.Outcome
        expect(outcome.availability).toBe("unavailable")
        expect(outcome.capture).toBe("absent")
        expect(outcome.rawHash).toBeUndefined()
        expect(outcome.review).toBeUndefined()
        yield* s.llm.push(
          reply().tool("contract_request", {
            kind: "review_response",
            payload: {
              outcomeHash: run.feedback!.outcomeHash,
              responses: [],
              summary: "Reviewer agent was unavailable; submit verified candidate with no independent opinion",
              action: "submit",
            },
          }),
        )
        gate.resolve()
        const ready = yield* stage(s.host, s.input.id, "ready")
        const bundle = (yield* s.host.command("research-bundle", s.input.id)) as ResearchFeedbackEvidence.Bundle
        expect(bundle.verdict).toBe("unavailable")
        expect(bundle.feedback[0].outcome.capture).toBe("absent")
        expect(bundle.feedback[0].raw).toBeUndefined()
        expect(ready.bundleHash).toBeTruthy()
        expect(
          (yield* s.fixture.operations(s.input.id)).filter((item) => item.kind === "provider" && !!item.source.jobID),
        ).toHaveLength(0)
        expect(yield* s.llm.misses).toHaveLength(0)
      }),
    60_000,
  )

  it.live(
    "feedback cannot renew the original deadline and retains all completed reviewer accounting",
    () =>
      Effect.gen(function* () {
        const s = yield* start({ deadline: Date.now() + 18_000 })
        const f = yield* feedback(yield* review(s))
        const stopped = yield* stage(s.host, s.input.id, "unavailable")
        expect(stopped.reason?.toLowerCase()).toContain("deadline")
        expect(stopped.input.spec.budget.deadline).toBe(s.input.spec.budget.deadline)
        expect(stopped.bundleHash).toBeUndefined()
        expect(stopped.feedbackHistory?.[0].responseHash).toBeUndefined()
        const operations = yield* s.fixture.operations(s.input.id)
        expect(operations.every((item) => item.source.deadline === s.input.spec.budget.deadline)).toBe(true)
        expect(operations.some((item) => item.source.jobID === f.run.reviewJobID && item.kind === "provider")).toBe(
          true,
        )
        f.gate.resolve()
      }),
    60_000,
  )
})
