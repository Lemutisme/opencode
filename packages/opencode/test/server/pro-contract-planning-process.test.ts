import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import path from "node:path"
import { mkdir, readdir, rm, symlink } from "node:fs/promises"
import { Hash } from "@opencode-ai/core/util/hash"
import type { ProContract } from "@opencode-ai/schema/pro-contract"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
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
          ? Effect.fail(new Error(run.reason))
          : Effect.succeed(run.stage === expected ? run : undefined),
      ),
    ),
    `Research never reached ${expected}`,
    "30 seconds",
  ).pipe(Effect.tapError(() => host.log().pipe(Effect.tap((text) => Effect.sync(() => console.error(text))))))

const prepare = Effect.fnUntraced(function* (
  fixture: Effect.Success<typeof contractProcess>,
  deadline = Date.now() + 180_000,
  slow = false,
) {
  const harness =
    'const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs");test("answer is correct",()=>{assert.equal(fs.readFileSync("answer.txt","utf8"),"42");fs.writeFileSync("result.txt","fresh proof")})'
  const selected = slow
    ? harness.replace(
        "()=>{assert.equal",
        'async()=>{fs.writeFileSync("result.txt","started");await new Promise(r=>setTimeout(r,3000));assert.equal',
      )
    : harness
  yield* Effect.promise(async () => {
    await Bun.write(
      path.join(fixture.storage, "config/opencode/opencode.json"),
      await Bun.file(path.join(fixture.directory, "opencode.json")).text(),
    )
    await Bun.write(path.join(fixture.directory, "acceptance.cjs"), selected)
    await Bun.write(path.join(fixture.directory, "answer.txt"), "wrong")
    await Bun.write(path.join(fixture.directory, "data.txt"), "original data")
  })
  return {
    planning: true,
    id: `pct_plan_${crypto.randomUUID()}`,
    scope: "plan-e2e",
    source: { directory: fixture.directory },
    model: { providerID: "local", id: "researcher" },
    spec: {
      trigger: { type: "immediate" },
      goal: "Deliver the correct answer",
      brief: "Set answer.txt to 42. Refine implementation within this task; keep acceptance.cjs fixed.",
      requires: [],
      authority: ["filesystem.read", "filesystem.write", "process.execute"],
      budget: { deadline },
      evidence: { type: "principal", claim: "Independently tested result" },
      resolution: { maxAttempts: 3, retryDelay: 1 },
    },
    manifest: {
      version: 1,
      reviewPolicy: { version: 1 },
      requirements: ["answer.txt contains 42"],
      include: ["acceptance.cjs", "answer.txt", "data.txt", "result.txt", "opencode.json"],
      dependencies: [],
      verification: {
        adapter: "node-test-tap:1",
        executable: "/usr/bin/node",
        executableHash: Hash.sha256(Buffer.from(yield* Effect.promise(() => Bun.file("/usr/bin/node").arrayBuffer()))),
        tests: ["acceptance.cjs"],
        harness: [{ path: "acceptance.cjs", hash: Hash.sha256(selected) }],
        expectedTests: ["answer is correct"],
        minimumTests: 1,
        maximumSkipped: 0,
        timeout: 10_000,
      },
      artifacts: [{ path: "result.txt", kind: "generated" }],
      reviewer: {
        model: { providerID: "local", id: "researcher" },
        agent: "build",
        instructions: "Check the original task, fixed method constraints, plan and evidence.",
      },
    },
  }
})
const plan = (run: ResearchModel.Run) => ({
  version: (run.plan?.value.version ?? 0) + 1,
  agreement: { revision: run.revision, specHash: run.specHash, manifestHash: run.manifestHash },
  scope: "within_task",
  question: "Does the answer meet the task?",
  hypothesis: "The correct answer is 42",
  baseline: "Initial answer is wrong",
  implementation: "Edit answer.txt",
  method: "Use the fixed acceptance test",
  controls: "Keep acceptance harness unchanged",
  data: "Use original data.txt",
  evaluation: "Exact answer and real test pass; does not replace external acceptance",
  uncertainties: "Does not establish general scientific reliability",
  protected: [{ path: "data.txt", hash: Hash.sha256("original data") }],
})
const verdict = (run: ResearchModel.Run, scope = "within_task", decision = "accept") => ({
  version: 1,
  scope,
  verdict: decision,
  summary: "Plan checked against original task",
  findings:
    decision === "changes_requested"
      ? [
          {
            id: "P1",
            severity: "blocking",
            path: "plan.method",
            reason: "Missing control",
            resolution: "Document the control",
          },
        ]
      : [],
  claims: [{ text: "Plan remains within the task", evidence: [run.plan!.hash] }],
})

const start = Effect.fnUntraced(function* (options?: { denials?: boolean; deadline?: number; slow?: boolean }) {
  const fixture = yield* contractProcess
  const llm = yield* TestLLMServer
  const input = yield* prepare(fixture, options?.deadline, options?.slow)
  const host = yield* fixture.startHost(true, { research: true })
  const gate = Promise.withResolvers<void>()
  if (options?.denials)
    yield* llm.push(
      reply().tool("write", { path: "answer.txt", content: "unauthorized" }),
      reply().tool("bash", { command: "printf unauthorized > answer.txt", description: "Try process before plan" }),
      reply().tool("contract_check", {}),
      reply().tool("contract_request", { kind: "experiment", payload: {} }),
      reply().tool("contract_report_ready", { summary: "premature", uncertainties: [] }),
    )
  yield* llm.push(
    reply().tool("contract_request", { kind: "inspect_inputs", payload: { paths: ["data.txt"] } }),
    reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
  )
  yield* host.command("research-issue", input.id, input)
  const calls = options?.denials ? 7 : 2
  yield* llm.wait(calls)
  const messages = ((yield* llm.inputs).at(-1) as { messages: { role: string; content: string }[] }).messages
  const inspected = JSON.parse(messages.filter((message) => message.role === "tool").at(-1)!.content) as {
    result: { protected: { path: string; hash: string }[] }
  }
  expect(inspected.result.protected).toEqual([{ path: "data.txt", hash: Hash.sha256("original data") }])
  const run = yield* get(host, input.id)
  return { fixture, llm, input, host, gate, run, calls, protected: inspected.result.protected }
})

const approve = Effect.fnUntraced(function* (
  started: Effect.Success<ReturnType<typeof start>>,
  before?: ReturnType<typeof reply>[],
) {
  const gate = Promise.withResolvers<void>()
  if (before) yield* started.llm.push(...before)
  yield* started.llm.push(
    reply().tool("contract_request", { kind: "plan", payload: { ...plan(started.run), protected: started.protected } }),
    reply().tool("read", { path: "evidence/materials.json" }).wait(gate.promise),
  )
  started.gate.resolve()
  yield* started.llm.wait(started.calls + (before?.length ?? 0) + 2)
  const run = yield* get(started.host, started.input.id)
  expect(run.stage).toBe("plan_review")
  const materials = JSON.parse(String(yield* started.host.command("research-object", run.plan!.materialsHash!)))
  expect(materials).toMatchObject({
    phase: "planning",
    candidateRole: "pre_execution_background",
    subjectHash: run.plan!.subjectHash,
    planHash: run.plan!.hash,
  })
  return { gate, run, calls: started.calls + (before?.length ?? 0) + 2 }
})

describe("Planned Researcher production workflow", () => {
  it.live(
    "observes input hashes without approval and rejects escaped, non-file and oversized reads",
    () =>
      Effect.gen(function* () {
        const s = yield* start()
        yield* Effect.promise(async () => {
          await mkdir(path.join(s.run.workspace.directory, "directory"))
          await Bun.write(path.join(s.fixture.storage, "outside.txt"), "outside")
          await symlink(
            path.join(s.fixture.storage, "outside.txt"),
            path.join(s.run.workspace.directory, "escaped.txt"),
          )
          await Bun.write(path.join(s.run.workspace.directory, "large.txt"), new Uint8Array(17 * 1024 * 1024))
          await Bun.write(path.join(s.run.workspace.directory, "aggregate.txt"), new Uint8Array(9 * 1024 * 1024))
        })
        const requests = [
          ["../outside.txt"],
          ["escaped.txt"],
          ["directory"],
          ["large.txt"],
          ["aggregate.txt", "aggregate.txt"],
          [],
          Array.from({ length: 65 }, () => "data.txt"),
        ]
        const gate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
        yield* s.llm.push(
          ...requests.map((paths) => reply().tool("contract_request", { kind: "inspect_inputs", payload: { paths } })),
          reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
        )
        s.gate.resolve()
        yield* s.llm.wait(s.calls + requests.length + 1)
        const inputs = yield* s.llm.inputs
        expect(JSON.stringify(inputs[s.calls])).toContain(Hash.sha256("original data"))
        const observed = JSON.stringify(inputs.at(-1))
        expect(observed).toContain("literal workspace file paths")
        expect(observed).toContain("escapes the researcher workspace")
        expect(observed).toContain("must be a regular file")
        expect(observed).toContain("per-operation byte limit")
        const current = yield* get(s.host, s.input.id)
        expect(current.stage).toBe("exploration")
        expect(current.plan).toBeUndefined()
        expect(current.context).toEqual(s.run.context)
        expect((yield* s.fixture.binding(s.input.id)).admission?.open).toBe(true)
        expect((yield* s.fixture.operations(s.input.id)).some((item) => item.kind === "verification")).toBe(false)
        yield* s.host.command("research-cancel", s.input.id)
        gate.resolve()
      }),
    45_000,
  )
  it.live(
    "requires a fresh plan after an external revision petition is rejected",
    () =>
      Effect.gen(function* () {
        const s = yield* start()
        const a = yield* approve(s)
        yield* s.llm.push(
          reply()
            .text(JSON.stringify(verdict(a.run)))
            .stop(),
          reply().tool("write", { path: "answer.txt", content: "42" }),
          reply().tool("contract_request", { kind: "experiment", payload: {} }),
          reply().tool("contract_propose_revision", { goal: "Different task", reason: "Request external change" }),
        )
        a.gate.resolve()
        yield* s.llm.wait(a.calls + 4)
        const stopped = yield* stage(s.host, s.input.id, "unavailable")
        expect(stopped.plan!.approved).toBe(false)
        expect(stopped.experiment).toBeUndefined()
        expect(stopped.replan).toBe(true)
        const pending = (yield* s.host.command("root-info", s.input.id)) as ProContract.Info
        expect(pending.pendingRevision).toBeDefined()
        yield* s.host.command("root-revision-decision", s.input.id, {
          contractID: s.input.id,
          expected: pending.recognition!.pending!,
          operationID: crypto.randomUUID(),
          accept: false,
        })
        yield* pollWithTimeout(
          s.fixture.binding(s.input.id).pipe(Effect.map((binding) => (binding.dispatched ? undefined : true))),
          "Revoked worker did not finish cleanup",
          "20 seconds",
        )
        const gate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
        yield* s.llm.push(
          reply().tool("write", { path: "answer.txt", content: "unauthorized" }),
          reply().tool("contract_request", { kind: "experiment", payload: {} }),
          reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
        )
        yield* s.host.command("research-recover", s.input.id, { retry: true })
        yield* s.llm.wait(a.calls + 7)
        const recovered = yield* get(s.host, s.input.id)
        expect(recovered.stage).toBe("exploration")
        expect(recovered.plan!.approved).toBe(false)
        expect(recovered.experiment).toBeUndefined()
        expect(recovered.context.version).toBeGreaterThan(s.run.context.version)
        expect(recovered.specHash).toBe(s.run.specHash)
        expect(recovered.input.spec.budget.deadline).toBe(s.input.spec.budget.deadline)
        expect(
          yield* Effect.promise(() => Bun.file(path.join(recovered.workspace.directory, "answer.txt")).text()),
        ).toBe("42")
        const fresh = yield* approve({ ...s, run: recovered, gate, calls: a.calls + 7 })
        expect(fresh.run.plan!.value.version).toBe(2)
        expect(fresh.run.plan!.jobID).not.toBe(a.run.plan!.jobID)
        expect(fresh.run.plan!.approved).toBeUndefined()
        yield* s.host.command("research-cancel", s.input.id)
        fresh.gate.resolve()
      }),
    60_000,
  )
  for (const crash of [false, true]) {
    it.live(
      crash
        ? "does not replay an unknown formal experiment until explicit recovery"
        : "cancels a running restricted formal experiment and retains interruption evidence",
      () =>
        Effect.gen(function* () {
          const s = yield* start({ slow: true })
          const a = yield* approve(s)
          yield* s.llm.push(
            reply()
              .text(JSON.stringify(verdict(a.run)))
              .stop(),
            reply().tool("write", { path: "answer.txt", content: "42" }),
            reply().tool("contract_request", { kind: "experiment", payload: {} }),
          )
          a.gate.resolve()
          yield* pollWithTimeout(
            Effect.tryPromise(async () => {
              const directory = path.join(s.fixture.storage, "tmp/opencode/pro-contract-replay")
              for (const entry of await readdir(directory)) {
                if (!entry.startsWith(`${s.input.id}-`)) continue
                const file = Bun.file(path.join(directory, entry, "project/result.txt"))
                if ((await file.exists()) && (await file.text()) === "started") return true
              }
            }).pipe(Effect.orElseSucceed(() => undefined)),
            "Restricted test child never started",
            "20 seconds",
          )
          const before = yield* get(s.host, s.input.id)
          expect(before.purpose).toBe("experiment")
          expect(before.stage).toBe("verification")
          if (!crash) {
            yield* s.host.command("research-cancel", s.input.id)
            expect((yield* get(s.host, s.input.id)).stage).toBe("cancelled")
            expect((yield* get(s.host, s.input.id)).experiment).toBeUndefined()
            expect(
              (yield* s.fixture.operations(s.input.id)).some(
                (item) => item.kind === "verification" && item.status === "interrupted",
              ),
            ).toBe(true)
            return
          }
          yield* s.host.kill
          const restarted = yield* s.fixture.startHost(true, { research: true })
          const stopped = yield* pollWithTimeout(
            get(restarted, s.input.id).pipe(Effect.map((run) => (run.stage === "unavailable" ? run : undefined))),
            "Unknown formal experiment did not stop",
            "45 seconds",
          )
          expect(stopped.experiment).toBeUndefined()
          expect(stopped.replan === true).toBe(stopped.context.version !== before.context.version)
          expect(stopped.plan!.approved).toBe(stopped.replan ? false : true)
          yield* Effect.sync(() =>
            console.info("S5 experiment recovery", {
              replan: stopped.replan === true,
              originalContext: before.context.version,
              recoveredContext: stopped.context.version,
            }),
          )
          expect(yield* s.llm.calls).toBe(a.calls + 3)
          const gate = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
          yield* s.llm.push(reply().tool("read", { path: "answer.txt" }).wait(gate.promise))
          // Coordinator and verifier leases expire independently; unavailable does not prove job cleanup.
          yield* pollWithTimeout(
            restarted.command("job-get", before.verifierJobID!).pipe(
              Effect.map((value) => {
                const job = value as { leaseExpiresAt?: number }
                return (job.leaseExpiresAt ?? 0) <= Date.now() ? true : undefined
              }),
            ),
            "Prior verifier lease did not expire before explicit recovery",
            "35 seconds",
          )
          yield* restarted.command("research-recover", s.input.id, { retry: true })
          yield* s.llm.wait(a.calls + 4).pipe(Effect.timeout("20 seconds"))
          if (stopped.replan) {
            const planning = yield* get(restarted, s.input.id)
            expect(planning.stage).toBe("exploration")
            expect(planning.plan!.approved).toBe(false)
            expect(planning.experiment).toBeUndefined()
            const fresh = yield* approve({ ...s, host: restarted, run: planning, gate, calls: a.calls + 4 })
            expect(fresh.run.plan!.value.version).toBe(before.plan!.value.version + 1)
            expect(fresh.run.plan!.jobID).not.toBe(before.plan!.jobID)
            const resumed = Promise.withResolvers<void>()
            yield* Effect.addFinalizer(() => Effect.sync(() => resumed.resolve()))
            yield* s.llm.push(
              reply()
                .text(JSON.stringify(verdict(fresh.run)))
                .stop(),
              reply().tool("contract_request", { kind: "experiment", payload: {} }),
              reply().tool("read", { path: "answer.txt" }).wait(resumed.promise),
            )
            fresh.gate.resolve()
            yield* s.llm.wait(fresh.calls + 3).pipe(Effect.timeout("20 seconds"))
          }
          const recovered = yield* get(restarted, s.input.id)
          expect(recovered.experiment).toBeDefined()
          if (!stopped.replan) expect(recovered.plan!.reportHash).toBe(before.plan!.reportHash)
          const report = JSON.parse(
            (yield* restarted.command("research-object", recovered.experiment!.verificationHash)) as string,
          ) as ResearchModel.Verification
          expect(report.jobID).not.toBe(before.verifierJobID)
          const job = (yield* restarted.command("job-get", report.jobID)) as { input: { previousJobID: string } }
          if (!stopped.replan) expect(job.input.previousJobID).toBe(before.verifierJobID!)
          expect(
            (yield* s.fixture.operations(s.input.id)).some(
              (item) => item.source.jobID === before.verifierJobID && item.status === "unknown",
            ),
          ).toBe(true)
          expect(recovered.input.spec.budget.deadline).toBe(s.input.spec.budget.deadline)
          yield* restarted.command("research-cancel", s.input.id)
          gate.resolve()
        }),
      80_000,
    )
  }
  it.live(
    "never renews an expired task deadline to accept a late plan review",
    () =>
      Effect.gen(function* () {
        const s = yield* start({ deadline: Date.now() + 12_000 })
        const a = yield* approve(s)
        yield* Effect.addFinalizer(() => Effect.sync(() => a.gate.resolve()))
        const stopped = yield* stage(s.host, s.input.id, "unavailable")
        expect(stopped.input.spec.budget.deadline).toBe(s.input.spec.budget.deadline)
        expect(stopped.plan?.approved).not.toBe(true)
        expect((yield* s.fixture.binding(s.input.id)).admission?.open).toBe(false)
        expect((yield* s.host.command("research-recover", s.input.id, { retry: true }).pipe(Effect.exit))._tag).toBe(
          "Failure",
        )
        a.gate.resolve()
        expect((yield* s.fixture.operations(s.input.id)).some((item) => item.kind === "verification")).toBe(false)
      }),
    30_000,
  )
  for (const recovering of [false, true]) {
    it.live(
      recovering
        ? "recovers a valid unavailable final review and preserves exact recognition identity"
        : "enforces phases and completes plan review, real experiment, delivery and external recognition",
      () =>
        Effect.gen(function* () {
          const s = yield* start({ denials: !recovering })
          expect(s.run.stage).toBe("exploration")
          expect(yield* Effect.promise(() => Bun.file(path.join(s.run.workspace.directory, "answer.txt")).text())).toBe(
            "wrong",
          )
          const approved = yield* approve(s)
          const experimentGate = Promise.withResolvers<void>()
          yield* s.llm.push(
            reply()
              .text(JSON.stringify(verdict(approved.run)))
              .usage({ input: 11, output: 7 })
              .stop(),
            reply().tool("bash", {
              command: "printf evil > data.txt; node acceptance.cjs",
              description: "Try to bypass experiment admission",
            }),
            reply().tool("write", { path: "answer.txt", content: "42" }),
            reply().tool("contract_request", { kind: "experiment", payload: {} }),
            reply().tool("read", { path: "answer.txt" }).wait(experimentGate.promise),
          )
          approved.gate.resolve()
          yield* s.llm.wait(approved.calls + 5)
          const executed = yield* get(s.host, s.input.id)
          expect(executed.plan?.approved).toBe(true)
          expect(executed.experiment?.planHash).toBe(executed.plan!.hash)
          expect(executed.experiment?.approvalHash).toBe(executed.plan!.reportHash)
          expect(
            yield* Effect.promise(() => Bun.file(path.join(executed.workspace.directory, "data.txt")).text()),
          ).toBe("original data")
          const finalGate = Promise.withResolvers<void>()
          yield* s.llm.push(
            reply().tool("contract_request", {
              kind: "read_experiment",
              payload: { path: "artifacts/result.txt", offset: 0, length: 16384 },
            }),
            reply().tool("contract_report_ready", {
              summary: "Answer and formal experiment complete",
              uncertainties: [],
            }),
            reply().tool("read", { path: "evidence/materials.json" }).wait(finalGate.promise),
          )
          experimentGate.resolve()
          yield* s.llm.wait(approved.calls + 8)
          const reviewing = yield* get(s.host, s.input.id)
          expect(reviewing.stage).toBe("review")
          const requests = yield* s.llm.inputs
          const delivered = JSON.stringify(requests[approved.calls + 6])
          expect(delivered).toContain("fresh proof")
          expect(delivered).toContain(executed.experiment!.verificationHash)
          expect(delivered).toContain("post-experiment evidence inspection and delivery decision")
          expect(delivered).not.toContain("CURRENT STAGE: implementation before a valid formal experiment")
          expect(reviewing.subjectHash).toBe(executed.experiment!.subjectHash)
          expect(
            yield* Effect.promise(() => Bun.file(path.join(executed.workspace.directory, "result.txt")).exists()),
          ).toBe(false)
          yield* s.llm.push(
            reply()
              .text(
                JSON.stringify({
                  version: 1,
                  verdict: recovering ? "unavailable" : "accept",
                  summary: "Original task satisfied",
                  findings: [],
                  claims: [
                    {
                      text: "Actual tests and method support delivery",
                      evidence: [
                        reviewing.verificationHash,
                        reviewing.plan!.reportHash,
                        reviewing.experiment!.verificationHash,
                      ],
                    },
                  ],
                }),
              )
              .usage({ input: 13, output: 5 })
              .stop(),
          )
          finalGate.resolve()
          if (recovering) {
            const unavailable = yield* stage(s.host, s.input.id, "unavailable")
            expect(unavailable.context).toEqual(reviewing.context)
            const retryGate = Promise.withResolvers<void>()
            yield* s.llm.push(reply().tool("read", { path: "evidence/materials.json" }).wait(retryGate.promise))
            yield* s.host.command("research-recover", s.input.id, { retry: true })
            yield* s.llm.wait(approved.calls + 10)
            const retrying = yield* get(s.host, s.input.id)
            expect(retrying.reviewJobID).not.toBe(reviewing.reviewJobID)
            yield* s.llm.push(
              reply()
                .text(
                  JSON.stringify({
                    version: 1,
                    verdict: "accept",
                    summary: "Evidence now available",
                    findings: [],
                    claims: [{ text: "Fixed task verified", evidence: [retrying.verificationHash] }],
                  }),
                )
                .stop(),
            )
            retryGate.resolve()
          }
          const ready = yield* stage(s.host, s.input.id, "ready")
          const finalVerification = JSON.parse(
            (yield* s.host.command("research-object", ready.verificationHash!)) as string,
          ) as ResearchModel.Verification
          const finalReplay = JSON.parse(
            (yield* s.host.command("research-object", finalVerification.replay.evidenceHash)) as string,
          ) as { protectedBefore: { path: string; hash: string }[]; protected: { path: string; hash: string }[] }
          expect(
            finalReplay.protectedBefore.some(
              (file) => file.path === "data.txt" && file.hash === Hash.sha256("original data"),
            ),
          ).toBe(true)
          expect(
            finalReplay.protected.some(
              (file) => file.path === "data.txt" && file.hash === Hash.sha256("original data"),
            ),
          ).toBe(true)
          expect(ready.plan!.jobID).not.toBe(ready.reviewJobID)
          expect(ready.input.spec.budget.deadline).toBe(s.input.spec.budget.deadline)
          expect((yield* s.fixture.binding(s.input.id)).attempts).toBe(1)
          for (const hash of [ready.plan!.reportHash!, ready.experiment!.verificationHash]) {
            const file = path.join(s.fixture.storage, "data/opencode/pro-contract/blobs", hash)
            const bytes = yield* Effect.promise(() => Bun.file(file).arrayBuffer())
            yield* Effect.promise(() => rm(file))
            expect(
              (yield* s.host
                .command("root-attest", s.input.id, {
                  contractID: s.input.id,
                  expected: ready.published,
                  evidenceHash: ready.bundleHash,
                  operationID: crypto.randomUUID(),
                })
                .pipe(Effect.exit))._tag,
            ).toBe("Failure")
            yield* Effect.promise(() => Bun.write(file, "tampered"))
            expect(
              (yield* s.host
                .command("root-attest", s.input.id, {
                  contractID: s.input.id,
                  expected: ready.published,
                  evidenceHash: ready.bundleHash,
                  operationID: crypto.randomUUID(),
                })
                .pipe(Effect.exit))._tag,
            ).toBe("Failure")
            yield* Effect.promise(async () => {
              await rm(file)
              await Bun.write(file, bytes)
            })
          }
          const receipt = (yield* s.host.command("root-attest", s.input.id, {
            contractID: s.input.id,
            expected: ready.published,
            evidenceHash: ready.bundleHash,
            operationID: crypto.randomUUID(),
          })) as ProContract.OperationReceipt
          expect(receipt.decision.type).toBe("accepted")
          yield* stage(s.host, s.input.id, "accepted")
          const operations = yield* s.fixture.operations(s.input.id)
          expect(operations.some((item) => item.source.jobID === ready.plan!.jobID && item.kind === "provider")).toBe(
            true,
          )
          expect(operations.filter((item) => item.kind === "verification").length).toBe(2)
          expect(yield* s.llm.misses).toHaveLength(0)
        }),
      90_000,
    )
  }

  it.live(
    "worker reads bounded experiment evidence, rejects foreign paths and corrupt blobs, and can inspect failed experiments",
    () =>
      Effect.gen(function* () {
        const s = yield* start()
        const a = yield* approve(s, [
          reply().tool("contract_request", {
            kind: "read_experiment",
            payload: { path: "artifacts/result.txt", offset: 0, length: 5 },
          }),
        ])
        const firstGate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => firstGate.resolve()))
        yield* s.llm.push(
          reply()
            .text(JSON.stringify(verdict(a.run)))
            .stop(),
          reply().tool("write", { path: "answer.txt", content: "42" }),
          reply().tool("contract_request", { kind: "experiment", payload: {} }),
          reply().tool("read", { path: "answer.txt" }).wait(firstGate.promise),
        )
        a.gate.resolve()
        const firstCalls = a.calls + 4
        yield* s.llm.wait(firstCalls)
        const executed = yield* get(s.host, s.input.id)
        expect(executed.lastExperiment).toEqual(executed.experiment)
        const requests = [
          { path: "../result.txt", offset: 0, length: 5 },
          { path: "/etc/passwd", offset: 0, length: 5 },
          { path: "artifacts/answer.txt", offset: 0, length: 5 },
          { path: "artifacts/result.txt", offset: 12, length: 5 },
          { path: "artifacts/result.txt", offset: -1, length: 5 },
          { path: "artifacts/result.txt", offset: 0, length: 16385 },
          { path: "artifacts/result.txt", offset: 0, length: 5, verificationHash: "f".repeat(64) },
          { path: "artifacts/result.txt", offset: 0, length: 5 },
          { path: "artifacts/result.txt", offset: 6, length: 16384 },
        ]
        const readGate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => readGate.resolve()))
        yield* s.llm.push(
          ...requests.map((payload) => reply().tool("contract_request", { kind: "read_experiment", payload })),
          reply().tool("read", { path: "answer.txt" }).wait(readGate.promise),
        )
        firstGate.resolve()
        const readCalls = firstCalls + requests.length + 1
        yield* s.llm.wait(readCalls)
        const inputs = yield* s.llm.inputs
        const messages = (inputs.at(-1) as { messages: { role: string; content: string }[] }).messages
        const outputs = messages
          .filter((item) => item.role === "tool" && item.content.startsWith('{"requested":true'))
          .map((item) => JSON.parse(item.content).result)
        expect(outputs).toContainEqual(
          expect.objectContaining({
            verificationHash: executed.experiment!.verificationHash,
            subjectHash: executed.experiment!.subjectHash,
            path: "artifacts/result.txt",
            hash: Hash.sha256("fresh proof"),
            totalBytes: 11,
            offset: 0,
            returnedBytes: 5,
            content: "fresh",
            encoding: "utf8",
            eof: false,
          }),
        )
        expect(outputs).toContainEqual(
          expect.objectContaining({ offset: 6, returnedBytes: 5, content: "proof", eof: true }),
        )
        expect(JSON.stringify(messages)).toContain("evidence allowlist")
        expect(JSON.stringify(messages)).toContain("requested offset is invalid")
        expect((yield* get(s.host, s.input.id)).lastExperiment).toEqual(executed.lastExperiment)
        expect((yield* s.fixture.binding(s.input.id)).admission?.open).toBe(true)
        expect(
          yield* Effect.promise(() => Bun.file(path.join(executed.workspace.directory, "result.txt")).exists()),
        ).toBe(false)
        const blob = path.join(s.fixture.storage, "data/opencode/pro-contract/blobs", Hash.sha256("fresh proof"))
        yield* Effect.promise(async () => {
          await rm(blob)
          await Bun.write(blob, "false proof")
        })
        const corruptGate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => corruptGate.resolve()))
        yield* s.llm.push(
          reply().tool("contract_request", {
            kind: "read_experiment",
            payload: { path: "artifacts/result.txt", offset: 0, length: 16384 },
          }),
          reply().tool("read", { path: "answer.txt" }).wait(corruptGate.promise),
        )
        readGate.resolve()
        const corruptCalls = readCalls + 2
        yield* s.llm.wait(corruptCalls)
        expect(JSON.stringify((yield* s.llm.inputs).at(-1))).toContain("missing, oversized or corrupt")
        yield* Effect.promise(async () => {
          await rm(blob)
          await Bun.write(blob, "fresh proof")
        })
        const failedGate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => failedGate.resolve()))
        yield* s.llm.push(
          reply().tool("write", { path: "answer.txt", content: "wrong" }),
          reply().tool("contract_request", { kind: "experiment", payload: {} }),
          reply().tool("contract_request", {
            kind: "read_experiment",
            payload: { path: "check-0-stdout.txt", offset: 0, length: 16384 },
          }),
          reply().tool("read", { path: "answer.txt" }).wait(failedGate.promise),
        )
        corruptGate.resolve()
        yield* s.llm.wait(corruptCalls + 4)
        const failed = yield* get(s.host, s.input.id)
        expect(failed.stage).toBe("execution")
        expect(failed.experiment).toBeUndefined()
        expect(failed.lastExperiment!.verificationHash).not.toBe(executed.lastExperiment!.verificationHash)
        expect(failed.executionPrompt).toContain("This experiment did not pass and cannot support delivery")
        const observed = JSON.stringify((yield* s.llm.inputs).at(-1))
        expect(observed).toContain("not ok 1")
        expect(observed).toContain(failed.lastExperiment!.verificationHash)
        expect((yield* s.fixture.operations(s.input.id)).filter((item) => item.kind === "verification")).toHaveLength(2)
        yield* s.host.command("research-cancel", s.input.id)
        failedGate.resolve()
      }),
    90_000,
  )

  for (const scope of ["unclear", "needs_principal_revision"]) {
    it.live(
      `rejects authorization overrides and does not admit a reviewer acceptance with scope ${scope}`,
      () =>
        Effect.gen(function* () {
          const s = yield* start()
          const p = plan(s.run)
          const a = yield* approve(s, [
            reply().tool("contract_request", { kind: "plan", payload: { ...p, authority: ["network"] } }),
            reply().tool("contract_request", { kind: "plan", payload: { ...p, deadline: Date.now() + 999999 } }),
            reply().tool("contract_request", {
              kind: "plan",
              payload: { ...p, agreement: { ...p.agreement, revision: 2 } },
            }),
            reply().tool("contract_request", {
              kind: "plan",
              payload: { ...p, protected: [{ path: "acceptance.cjs", hash: "a".repeat(64) }] },
            }),
          ])
          expect(a.run.plan!.value.version).toBe(1)
          const gate = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
          yield* s.llm.push(
            reply()
              .text(JSON.stringify(verdict(a.run, scope)))
              .stop(),
            reply().tool("write", { path: "answer.txt", content: "bad" }),
            reply().tool("contract_request", { kind: "experiment", payload: {} }),
            reply().tool("read", { path: "answer.txt" }).wait(gate.promise),
          )
          a.gate.resolve()
          yield* s.llm.wait(a.calls + 4)
          const denied = yield* get(s.host, s.input.id)
          expect(denied.stage).toBe("exploration")
          expect(denied.plan!.approved).toBe(false)
          expect(denied.experiment).toBeUndefined()
          expect(
            yield* Effect.promise(() => Bun.file(path.join(denied.workspace.directory, "answer.txt")).text()),
          ).toBe("wrong")
          expect((yield* s.fixture.operations(s.input.id)).some((item) => item.kind === "verification")).toBe(false)
          expect(((yield* s.host.command("root-info", s.input.id)) as ProContract.Info).specHash).toBe(s.run.specHash)
          yield* s.host.command("research-cancel", s.input.id)
          gate.resolve()
        }),
      60_000,
    )
  }

  it.live(
    "invalidates experiments on candidate edits and plan approval on protected-input changes, then reviews an in-scope replacement",
    () =>
      Effect.gen(function* () {
        const s = yield* start()
        const a = yield* approve(s)
        const changedGate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => changedGate.resolve()))
        yield* s.llm.push(
          reply()
            .text(JSON.stringify(verdict(a.run)))
            .stop(),
          reply().tool("write", { path: "answer.txt", content: "42" }),
          reply().tool("contract_request", { kind: "experiment", payload: {} }),
          reply().tool("contract_request", {
            kind: "read_experiment",
            payload: { path: "artifacts/result.txt", offset: 0, length: 16384 },
          }),
          reply().tool("write", { path: "answer.txt", content: "43" }),
          reply().tool("contract_report_ready", { summary: "stale experiment", uncertainties: [] }),
          reply().tool("read", { path: "answer.txt" }).wait(changedGate.promise),
        )
        a.gate.resolve()
        yield* s.llm.wait(a.calls + 7)
        const changed = yield* get(s.host, s.input.id)
        expect(changed.stage).toBe("execution")
        expect(changed.experiment).toBeUndefined()
        expect(changed.lastExperiment).toBeDefined()
        expect(changed.executionPrompt).toContain("implementation before a valid formal experiment")
        expect(changed.plan!.approved).toBe(true)
        const staleGate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => staleGate.resolve()))
        yield* s.llm.push(
          reply().tool("write", { path: "data.txt", content: "new split" }),
          reply().tool("contract_request", { kind: "experiment", payload: {} }),
          reply().tool("read", { path: "data.txt" }).wait(staleGate.promise),
        )
        changedGate.resolve()
        yield* s.llm.wait(a.calls + 10)
        const stale = yield* get(s.host, s.input.id)
        expect(stale.stage).toBe("exploration")
        expect(stale.plan!.approved).toBe(false)
        expect(stale.experiment).toBeUndefined()
        expect(stale.lastExperiment).toBeUndefined()
        const nextGate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => nextGate.resolve()))
        yield* s.llm.push(
          reply().tool("contract_request", {
            kind: "plan",
            payload: {
              ...plan(stale),
              data: "Use a new in-task split, preserving the fixed Principal harness",
              protected: [{ path: "data.txt", hash: Hash.sha256("new split") }],
            },
          }),
          reply().tool("read", { path: "evidence/materials.json" }).wait(nextGate.promise),
        )
        staleGate.resolve()
        yield* s.llm.wait(a.calls + 12)
        const replacement = yield* get(s.host, s.input.id)
        expect(replacement.plan!.value.version).toBe(2)
        expect(replacement.plan!.hash).not.toBe(stale.plan!.hash)
        expect(replacement.plan!.approved).toBeUndefined()
        expect(replacement.experiment).toBeUndefined()
        const executedGate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => executedGate.resolve()))
        yield* s.llm.push(
          reply()
            .text(JSON.stringify(verdict(replacement)))
            .stop(),
          reply().tool("write", { path: "answer.txt", content: "42" }),
          reply().tool("contract_request", { kind: "experiment", payload: {} }),
          reply().tool("read", { path: "answer.txt" }).wait(executedGate.promise),
        )
        nextGate.resolve()
        yield* s.llm.wait(a.calls + 16)
        const executed = yield* get(s.host, s.input.id)
        expect(executed.experiment?.planHash).toBe(replacement.plan!.hash)
        expect(executed.experiment?.approvalHash).not.toBe(stale.plan!.reportHash)
        expect(executed.input.spec.budget.deadline).toBe(s.input.spec.budget.deadline)
        expect(executed.specHash).toBe(s.run.specHash)
        expect((yield* s.fixture.binding(s.input.id)).attempts).toBe(1)
        yield* s.host.command("research-cancel", s.input.id)
        executedGate.resolve()
      }),
    90_000,
  )

  it.live(
    "cancels an independent plan review and refuses its late acceptance after restart",
    () =>
      Effect.gen(function* () {
        const s = yield* start()
        const a = yield* approve(s)
        yield* s.llm.push(
          reply()
            .text(JSON.stringify(verdict(a.run)))
            .stop(),
        )
        const cancelled = (yield* s.host.command("research-cancel", s.input.id)) as ResearchModel.Run
        a.gate.resolve()
        expect(cancelled.stage).toBe("cancelled")
        expect(cancelled.plan?.approved).not.toBe(true)
        expect((yield* s.fixture.binding(s.input.id)).admission?.open).toBe(false)
        yield* s.host.kill
        const restarted = yield* s.fixture.startHost(true, { research: true })
        expect((yield* get(restarted, s.input.id)).stage).toBe("cancelled")
        expect((yield* restarted.command("research-recover", s.input.id).pipe(Effect.exit))._tag).toBe("Failure")
        expect((yield* s.fixture.operations(s.input.id)).some((item) => item.kind === "verification")).toBe(false)
      }),
    60_000,
  )

  it.live(
    "requires explicit recovery of an unknown plan reviewer without renewing the original deadline",
    () =>
      Effect.gen(function* () {
        const s = yield* start()
        yield* s.llm.push(
          reply().tool("contract_request", { kind: "plan", payload: plan(s.run) }),
          reply().text("Review in progress").hang(),
        )
        s.gate.resolve()
        yield* s.llm.wait(s.calls + 2).pipe(Effect.timeout("20 seconds"))
        const before = yield* get(s.host, s.input.id)
        expect(before.stage).toBe("plan_review")
        expect(before.plan!.jobID).toBeDefined()
        yield* s.host.kill
        const restarted = yield* s.fixture.startHost(true, { research: true })
        const stopped = yield* pollWithTimeout(
          get(restarted, s.input.id).pipe(Effect.map((run) => (run.stage === "unavailable" ? run : undefined))),
          "Plan reviewer crash was not classified",
          "45 seconds",
        )
        expect(yield* s.llm.calls).toBe(s.calls + 2)
        expect(stopped.input.spec.budget.deadline).toBe(s.input.spec.budget.deadline)
        expect(stopped.plan?.approved).not.toBe(true)
        expect(stopped.replan === true).toBe(stopped.context.version !== before.context.version)
        const gate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
        yield* s.llm.push(
          reply()
            .tool("read", { path: stopped.replan ? "answer.txt" : "evidence/materials.json" })
            .wait(gate.promise),
        )
        yield* restarted.command("research-recover", s.input.id, { retry: true })
        yield* s.llm.wait(s.calls + 3).pipe(Effect.timeout("20 seconds"))
        const restored = yield* get(restarted, s.input.id)
        const replanned = stopped.replan
          ? yield* approve({ ...s, host: restarted, run: restored, gate, calls: s.calls + 3 })
          : undefined
        const fresh = replanned?.run ?? restored
        if (replanned) expect(fresh.plan!.value.version).toBe(before.plan!.value.version + 1)
        expect(fresh.plan!.jobID).not.toBe(before.plan!.jobID)
        const job = (yield* restarted.command("job-get", fresh.plan!.jobID!)) as { input: { previousJobID: string } }
        if (!stopped.replan) expect(job.input.previousJobID).toBe(before.plan!.jobID!)
        expect((yield* s.fixture.operations(s.input.id)).some((item) => item.status === "unknown")).toBe(true)
        expect(fresh.specHash).toBe(s.run.specHash)
        yield* restarted.command("research-cancel", s.input.id)
        gate.resolve()
        replanned?.gate.resolve()
      }),
    90_000,
  )
})
