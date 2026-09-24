import { afterAll, beforeAll, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import path from "node:path"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { corpus, publish } from "../../script/research-eval/corpus"
import { bindPlan, issue, recoveryJobs } from "../../script/research-eval/driver"
import { create, digest, read, report } from "../../script/research-eval/ledger"
import { score } from "../../script/research-eval/score"
import { candidate, hostBoundary, launcher } from "../../script/research-eval/isolation"
import { stage } from "../../script/research-eval/accounting"
import { source } from "../../script/research-eval/freeze"
import { monitor } from "../../script/research-eval/controller"
import { collect, put, retainFailure } from "../../script/research-eval/archive"
import { objective } from "../../script/research-eval/oracle"
import {
  active,
  cleanup,
  gateway,
  killAtProcess,
  processIdentity,
  testProcess,
  window,
  type Observation,
  type ProcessIdentity,
} from "../../script/research-eval/observe"
import { mkdir } from "node:fs/promises"
import { contractProcess } from "../fixture/contract-process"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, NodeServices.layer, FetchHttpClient.layer))
const examples =
  process.env.S6B_MATRIX === "1"
    ? corpus("qualification")
    : corpus("development").filter(
        (item) => item.oracle.instance.repeat === 1 && ["P1", "F2", "R3"].includes(item.oracle.instance.family),
      )
const archive = process.env.S6B_ARTIFACTS
beforeAll(async () => {
  if (!archive) return
  await mkdir(archive, { recursive: true })
  const snapshot = await source(path.resolve(import.meta.dir, "../../../.."), path.join(archive, "source"))
  await create(
    archive,
    examples.map((item) => item.oracle.instance),
    snapshot.hash,
  )
  await put(archive, {
    mode: "deterministic-selfcheck",
    packets: examples,
    bun: Bun.version,
    node: (await new Response(Bun.spawn(["/usr/bin/node", "--version"], { stdout: "pipe" }).stdout).text()).trim(),
    reviewer: "scripted HTTP responses; no model ability measurement",
  })
}, 60_000)
afterAll(async () => {
  if (!archive || !(await Bun.file(path.join(archive, "manifest.json")).exists())) return
  const ledger = await read(archive)
  await Bun.write(
    path.join(archive, "report.json"),
    JSON.stringify(report(ledger.manifest.instances, ledger.histories), null, 2) + "\n",
  )
})

describe("S6b deterministic production calibration (not model qualification)", () => {
  for (const example of examples) {
    it.live(
      `${example.oracle.instance.family} ${example.oracle.minimumDisposition} repeat ${example.oracle.instance.repeat} follows real research gates`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* contractProcess
          const llm = yield* TestLLMServer
          const observations: Observation[] = []
          const fault = {
            attempted: false,
            killed: false,
            host: undefined as ProcessIdentity | undefined,
            processes: [] as ProcessIdentity[],
            before: undefined as ResearchModel.Run | undefined,
          }
          const proxy = yield* Effect.promise(() =>
            gateway({
              upstream: new URL(llm.url),
              timeout: 30_000,
              identify: async () => {
                const operations = (
                  await Effect.runPromise(fixture.operations(`pct_eval_${example.packet.id}`))
                ).filter((item) => item.kind === "provider" && item.status === "running")
                if (operations.length !== 1) throw new Error("Ambiguous active provider operation")
                const operation = operations[0]
                return {
                  contractID: operation.source.contractID,
                  jobID: operation.source.jobID ?? "worker",
                  operationID: operation.id,
                  sessionID: operation.source.sessionID,
                }
              },
              observe: (event) => {
                observations.push(event)
                if (
                  example.oracle.fault !== "provider" ||
                  fault.attempted ||
                  event.kind !== "response" ||
                  event.identity.jobID === "worker" ||
                  !fault.host
                )
                  return
                fault.attempted = true
                process.kill(fault.host.pid, "SIGKILL")
                observations.push({ kind: "kill", at: performance.now(), identity: event.identity, host: fault.host })
                fault.killed = true
              },
            }),
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => proxy.close()))
          const gates: ReturnType<typeof Promise.withResolvers<void>>[] = []
          const gate = () => {
            const value = Promise.withResolvers<void>()
            gates.push(value)
            return value
          }
          yield* Effect.addFinalizer(() => Effect.sync(() => gates.forEach((item) => item.resolve())))
          yield* Effect.promise(async () => {
            const configuration = (await Bun.file(path.join(fixture.directory, "opencode.json")).text()).replace(
              llm.url,
              new URL(new URL(llm.url).pathname, proxy.url).href,
            )
            await Bun.write(path.join(fixture.directory, "opencode.json"), configuration)
            await Bun.write(path.join(fixture.storage, "config/opencode/opencode.json"), configuration)
            await Promise.all(
              Object.entries(publish(example.packet).files).map(([file, content]) =>
                Bun.write(path.join(fixture.directory, file), content),
              ),
            )
          })
          const sandbox = yield* Effect.promise(async () =>
            hostBoundary({
              launcher: await launcher(fixture.storage),
              storage: fixture.storage,
              directory: fixture.directory,
              port: Number(proxy.url.port),
              bun: process.execPath,
            }),
          )
          yield* Effect.promise(async () => {
            const child = Bun.spawn([...sandbox, "/usr/bin/git", "rev-parse", "--show-toplevel"], {
              cwd: fixture.directory,
              env: {
                PATH: "/usr/bin:/bin",
                HOME: fixture.storage,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
              },
              stdout: "pipe",
              stderr: "pipe",
            })
            const [exit, stdout, stderr] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ])
            expect({ exit, stdout: stdout.trim(), stderr }).toEqual({ exit: 0, stdout: fixture.directory, stderr: "" })
          })
          const current = { host: yield* fixture.startHost(true, { research: true, sandbox }) }
          fault.host = yield* Effect.promise(() => processIdentity(current.host.child.pid))
          const host = {
            command: (...args: Parameters<typeof current.host.command>) =>
              Effect.suspend(() => current.host.command(...args)),
            log: () => Effect.suspend(() => current.host.log()),
          }
          const issuedAt = Date.now()
          const input = issue(publish(example.packet), {
            directory: fixture.directory,
            contractID: `pct_eval_${example.packet.id}`,
            issuedAt,
            worker: { providerID: "local", id: "researcher" } as ResearchModel.Input["model"],
            reviewer: { providerID: "local", id: "researcher" } as ResearchModel.Input["model"],
            executable: "/usr/bin/node",
            executableHash: digest(
              new Uint8Array(yield* Effect.promise(() => Bun.file("/usr/bin/node").arrayBuffer())),
            ),
            timeout: 10_000,
          })
          const captureDirectory = archive ?? `/tmp/research-eval-capture-${crypto.randomUUID()}`
          yield* Effect.addFinalizer((exit) =>
            Effect.promise(async () => {
              if (!archive || Exit.isSuccess(exit)) return
              const ledger = await read(archive)
              if (ledger.histories.get(example.packet.id)?.some((event) => event.kind === "stopped")) return
              const error = Cause.pretty(exit.cause)
              const partial =
                current.host.child.exitCode !== null
                  ? { unavailable: "Host already exited" }
                  : await Effect.runPromise(host.command("research-get", input.id))
                      .then(
                        async (run) =>
                          await collect({
                            directory: archive,
                            storage: fixture.storage,
                            run: run as ResearchModel.Run,
                            command: (action, id, input) => Effect.runPromise(host.command(action, id, input)),
                          }),
                        (error) => ({ unavailable: String(error) }),
                      )
                      .catch((error) => ({ unavailable: String(error) }))
              if (current.host.child.exitCode === null) current.host.child.kill("SIGKILL")
              await current.host.child.exited
              await cleanup(fault.processes)
              const retained = await retainFailure({
                directory: archive,
                id: example.packet.id,
                storage: fixture.storage,
                workspace: fixture.directory,
              })
              const hash = await put(archive, { error, partial, observations, retained })
              if (ledger.histories.get(example.packet.id)?.some((event) => event.kind === "issued"))
                await ledger.append(example.packet.id, { kind: "observation", at: Date.now(), hash, stage: "failed" })
              if (
                example.oracle.fault &&
                ledger.histories.get(example.packet.id)?.some((event) => event.kind === "issued") &&
                !ledger.histories.get(example.packet.id)?.some((event) => event.kind === "injection")
              )
                await ledger.append(example.packet.id, {
                  kind: "injection",
                  at: Date.now(),
                  status: window(observations, example.oracle.fault),
                  evidenceHash: hash,
                })
              await ledger.append(example.packet.id, {
                kind: "stopped",
                at: Date.now(),
                reason: error,
                failure: /timeout|timed out/i.test(error)
                  ? "timeout"
                  : /provider/i.test(error)
                    ? "provider"
                    : "infrastructure",
              })
            }),
          )
          const get = host.command("research-get", input.id).pipe(Effect.map((run) => run as ResearchModel.Run))
          const wait = (predicate: (run: ResearchModel.Run) => boolean) =>
            pollWithTimeout(
              get.pipe(Effect.map((run) => (predicate(run) ? run : undefined))),
              "Evaluation production stage not reached",
              "40 seconds",
            ).pipe(Effect.tapError(() => host.log().pipe(Effect.tap((text) => Effect.sync(() => console.error(text))))))
          const exploring = gate()
          yield* llm.push(reply().tool("read", { path: "data.json" }).wait(exploring.promise))
          yield* host.command("research-issue", input.id, input)
          if (archive)
            yield* Effect.promise(async () =>
              (await read(archive)).append(example.packet.id, {
                kind: "issued",
                at: issuedAt,
                deadline: input.spec.budget.deadline,
                contractID: input.id,
              }),
            )
          if (process.env.S6B_FAIL_DEAD === "1") {
            yield* current.host.kill
            yield* Effect.fail(new Error("Injected dead-host provider failure for raw evidence retention"))
          }
          if (process.env.S6B_FAIL_EARLY === "1")
            yield* Effect.fail(new Error("Injected provider failure for partial ledger selfcheck"))
          yield* llm.wait(1)
          const run = yield* get
          const reviewing = gate()
          yield* llm.push(
            reply().tool("contract_request", { kind: "plan", payload: bindPlan(example.packet, run) }),
            reply().tool("read", { path: "evidence/materials.json" }).wait(reviewing.promise),
          )
          exploring.resolve()
          yield* llm.wait(3)
          const phase = { run: yield* fixture.researchRun(input.id), gate: reviewing, calls: 3 }
          expect(phase.run.stage).toBe("plan_review")
          const review = (run: ResearchModel.Run, entry: "plan" | "final", defective: boolean, artifact?: string) => ({
            version: 1,
            ...(entry === "plan" ? { scope: "within_task" } : {}),
            verdict: defective && process.env.S6B_RAW_ACCEPT !== "1" ? "changes_requested" : "accept",
            summary: "Deterministic response for evaluator selfcheck",
            findings: defective
              ? [
                  {
                    id: "target",
                    severity: "blocking",
                    path: example.oracle.target.path,
                    reason: `${example.oracle.target.mechanism}; ${example.oracle.target.consequence}`,
                    resolution: example.oracle.target.resolution,
                  },
                ]
              : [],
            claims: [
              {
                text: "Checked source evidence",
                evidence: [entry === "plan" ? run.plan!.hash : (artifact ?? run.verificationHash!)],
              },
            ],
          })
          const ending = gate()
          const recover = Effect.fnUntraced(function* () {
            if (archive)
              yield* Effect.promise(async () =>
                (await read(archive)).append(example.packet.id, {
                  kind: "injection",
                  at: Date.now(),
                  status: window(observations, example.oracle.fault!),
                  evidenceHash: await put(archive, { observations }),
                }),
              )
            fault.before = yield* fixture.researchRun(input.id)
            yield* Effect.promise(() => current.host.child.exited)
            yield* Effect.promise(() => cleanup(fault.processes))
            const calls = yield* llm.calls
            current.host = yield* fixture.startHost(true, { research: true, sandbox })
            const stopped = yield* wait((run) => run.stage === "unavailable")
            yield* pollWithTimeout(
              fixture.binding(input.id).pipe(Effect.map((binding) => (binding.dispatched ? undefined : true))),
              "Worker cleanup pending",
              "40 seconds",
            )
            expect(yield* llm.calls).toBe(calls)
            const oldID = example.oracle.fault === "provider" ? fault.before.plan!.jobID! : fault.before.verifierJobID!
            yield* host.command("job-cancel", oldID)
            yield* host.command("job-audit", oldID)
            const prior = (yield* fixture.operations(input.id)).filter((item) => item.source.jobID === oldID)
            expect(prior.some((item) => item.status === "unknown")).toBe(true)
            const snapshot = archive
              ? yield* Effect.promise(() =>
                  collect({
                    directory: archive,
                    storage: fixture.storage,
                    run: stopped,
                    command: (action, id, input) => Effect.runPromise(host.command(action, id, input)),
                  }),
                )
              : undefined
            phase.gate.resolve()
            phase.gate = gate()
            yield* llm.push(
              reply()
                .tool("read", {
                  path:
                    stopped.replan || example.oracle.fault === "test_process" ? "data.json" : "evidence/materials.json",
                })
                .wait(phase.gate.promise),
            )
            yield* host.command("research-recover", input.id, { retry: true })
            yield* llm.wait(calls + 1)
            phase.run = yield* get
            phase.calls = calls + 1
            if (stopped.replan) {
              const next = gate()
              yield* llm.push(
                reply().tool("contract_request", { kind: "plan", payload: bindPlan(example.packet, phase.run) }),
                reply().tool("read", { path: "evidence/materials.json" }).wait(next.promise),
              )
              phase.gate.resolve()
              yield* llm.wait(calls + 3)
              phase.run = yield* get
              phase.gate = next
              phase.calls = calls + 3
            }
            const newID = stopped.replan
              ? phase.run.plan!.jobID!
              : yield* pollWithTimeout(
                  Effect.gen(function* () {
                    const versions = (yield* host.command("research-history", input.id)) as {
                      version: number
                      data: ResearchModel.Run
                    }[]
                    const ids = recoveryJobs(
                      versions,
                      stopped.version,
                      example.oracle.fault === "provider" ? "plan" : "experiment",
                      oldID,
                    )
                    const jobs = yield* Effect.forEach(ids, (id) =>
                      host.command("job-get", id).pipe(Effect.map((job) => job as ProContractJob.Job)),
                    )
                    return jobs.find((job) => job.input.previousJobID === oldID)?.input.id
                  }),
                  "Recovered job lineage not found in durable history",
                  "40 seconds",
                )
            expect(newID).toBeDefined()
            expect(newID).not.toBe(oldID)
            expect(phase.run.input.spec.budget.deadline).toBe(input.spec.budget.deadline)
            if (!stopped.replan) {
              const job = (yield* host.command("job-get", newID)) as ProContractJob.Job
              expect(job.input.previousJobID).toBe(oldID)
            }
            if (archive)
              yield* Effect.promise(async () => {
                const ledger = await read(archive)
                const evidenceHash = await put(archive, {
                  observations,
                  snapshot,
                  stopped,
                  restored: phase.run,
                  oldID,
                  newID,
                })
                await ledger.append(example.packet.id, {
                  kind: "recovery",
                  at: Date.now(),
                  deadline: input.spec.budget.deadline,
                  oldJobID: oldID,
                  newJobID: newID,
                  safe: true,
                  replan: !!stopped.replan,
                  evidenceHash,
                })
              })
            return stopped.replan === true
          })
          if (example.oracle.fault === "provider") {
            yield* pollWithTimeout(
              Effect.sync(() => (fault.killed ? true : undefined)),
              "Gateway never observed the provider response",
              "10 seconds",
            )
            expect(fault.killed).toBe(true)
            expect(window(observations, "provider")).toBe("injected")
            yield* recover()
          }
          if (example.oracle.entry === "plan") {
            yield* llm.push(
              reply()
                .text(JSON.stringify(review(phase.run, "plan", example.oracle.instance.defective)))
                .stop(),
              ...(process.env.S6B_RAPID === "1" && example.oracle.instance.defective
                ? [
                    reply().tool("contract_request", { kind: "plan", payload: bindPlan(example.packet, phase.run) }),
                    reply().tool("read", { path: "evidence/materials.json" }).wait(ending.promise),
                  ]
                : [reply().tool("read", { path: "data.json" }).wait(ending.promise)]),
            )
            phase.gate.resolve()
            if (process.env.S6B_RAPID === "1" && example.oracle.instance.defective) {
              yield* llm.wait(6)
              expect((yield* get).plan?.jobID).not.toBe(phase.run.plan?.jobID)
            }
          } else {
            const execution = { gate: gate() }
            const injection =
              example.oracle.fault === "test_process"
                ? yield* Effect.forkChild(
                    pollWithTimeout(
                      Effect.promise(async () => {
                        const run = await Effect.runPromise(fixture.researchRun(input.id))
                        if (run.stage !== "verification" || run.purpose !== "experiment" || !run.verifierJobID)
                          return undefined
                        const child = await testProcess(fault.host!, "/usr/bin/node", "acceptance.mjs")
                        if (!child) return undefined
                        fault.attempted = true
                        const identity = active(
                          await Effect.runPromise(fixture.operations(input.id)),
                          run.verifierJobID,
                          "verification",
                        )
                        const parent = await processIdentity(child.parent)
                        fault.processes = parent ? [child, parent] : [child]
                        observations.push({ kind: "spawn", at: performance.now(), identity, process: child })
                        fault.killed = await killAtProcess(fault.host!, child, identity, observations)
                        return true
                      }),
                      "Actual Node test process never observed",
                      "40 seconds",
                    ),
                  )
                : undefined
            yield* llm.push(
              reply()
                .text(JSON.stringify(review(phase.run, "plan", false)))
                .stop(),
              ...Object.entries(example.packet.preparation).map(([file, content]) =>
                reply().tool("write", { path: file, content }),
              ),
              reply().tool("contract_request", { kind: "experiment", payload: {} }),
              ...(example.oracle.fault === "test_process"
                ? []
                : [reply().tool("read", { path: "data.json" }).wait(execution.gate.promise)]),
            )
            phase.gate.resolve()
            if (injection) {
              const { Fiber } = yield* Effect.promise(() => import("effect"))
              yield* Fiber.join(injection)
              expect(fault.killed).toBe(true)
              expect(window(observations, "test_process")).toBe("injected")
              const replanned = yield* recover()
              if (replanned) {
                yield* llm.push(
                  reply()
                    .text(JSON.stringify(review(phase.run, "plan", false)))
                    .stop(),
                  ...Object.entries(example.packet.preparation).map(([file, content]) =>
                    reply().tool("write", { path: file, content }),
                  ),
                  reply().tool("contract_request", { kind: "experiment", payload: {} }),
                  reply().tool("read", { path: "data.json" }).wait(execution.gate.promise),
                )
                phase.gate.resolve()
                yield* llm.wait(phase.calls + 5)
                phase.calls += 5
              } else execution.gate = phase.gate
            } else {
              yield* llm.wait(phase.calls + 5)
              phase.calls += 5
            }
            const experiment = yield* wait((run) => !!run.experiment)
            expect(experiment.plan?.approved).toBe(true)
            yield* llm.push(
              reply().tool("contract_report_ready", {
                summary: "Frozen task completed with actual experiment evidence",
                uncertainties: [],
              }),
              reply().tool("read", { path: "evidence/materials.json" }).wait(ending.promise),
            )
            execution.gate.resolve()
            yield* llm.wait(phase.calls + 2)
            const final = yield* get
            expect(final.stage).toBe("review")
            const verification = JSON.parse(
              String(yield* host.command("research-object", final.verificationHash!)),
            ) as ResearchModel.Verification
            yield* llm.push(
              reply()
                .text(
                  JSON.stringify(
                    review(
                      final,
                      "final",
                      example.oracle.instance.defective,
                      verification.evidence.find((item) => item.path === "artifacts/result.json")!.hash,
                    ),
                  ),
                )
                .usage({ input: 17, output: 11 })
                .stop(),
            )
            ending.resolve()
          }
          const entry = example.oracle.entry === "plan" ? "plan" : "final"
          const monitored = yield* Effect.promise(() =>
            monitor({
              port: { command: (action, id, input) => Effect.runPromise(host.command(action, id, input)) },
              contractID: input.id,
              entry: example.oracle.entry,
              deadline: input.spec.budget.deadline,
              archive: captureDirectory,
              storage: fixture.storage,
              observations: () => observations,
            }),
          )
          const finished = monitored.run
          const observed = monitored.observed
          const job = monitored.job!
          const raw = monitored.raw
          if (process.env.S6B_RAPID === "1" && example.oracle.entry === "plan")
            expect(observed.jobID).toBe(phase.run.plan?.jobID)
          const result = score({
            ...observed,
            entry,
            raw,
            defective: example.oracle.instance.defective,
            semanticConsistent: true,
            mechanicalBlock: false,
            gateReason: finished.stage,
            findings: [
              { id: "target", target: true, located: true, mechanism: true, consequence: true, supported: true },
            ],
          })
          expect(result.label).toBe(
            example.oracle.instance.defective
              ? process.env.S6B_RAW_ACCEPT === "1"
                ? "false_accept"
                : "detected"
              : "valid_accept",
          )
          expect(finished.input.spec.budget).toEqual({ deadline: issuedAt + 21_600_000 })
          expect(job.input.sessionID).not.toBe((yield* fixture.binding(input.id)).sessionID)
          if (example.oracle.entry === "research") {
            expect(finished.stage).toBe("ready")
            const report = JSON.parse(
              yield* Effect.promise(() => Bun.file(path.join(finished.workspace.directory, "report.json")).text()),
            )
            expect(report.conclusion).toBe(example.oracle.expected.conclusion)
            expect(report.effect).toBe(example.oracle.expected.effect)
          }
          const external =
            example.oracle.entry !== "plan"
              ? yield* Effect.promise(async () => {
                  const verification = JSON.parse(
                    String(await Effect.runPromise(host.command("research-object", finished.verificationHash!))),
                  ) as ResearchModel.Verification
                  const generated = verification.evidence.find((item) => item.path === "artifacts/result.json")!
                  const raw = String(await Effect.runPromise(host.command("research-object", generated.hash)))
                  // Outside both the host's writable storage and its network boundary.
                  const directory = path.join(archive ?? "/tmp", `candidate-score-${crypto.randomUUID()}`)
                  await mkdir(directory, { recursive: true })
                  const evaluated = await candidate({
                    launcher: await launcher(fixture.storage),
                    directory,
                    source: await Bun.file(path.join(finished.workspace.directory, "analysis.mjs")).text(),
                    inputs: example.oracle.inputs,
                    timeout: 5000,
                  })
                  const text = await Bun.file(path.join(finished.workspace.directory, "report.json")).text()
                  return {
                    score: objective(example.oracle, { report: text, raw, values: evaluated.values }),
                    evidenceHash: await put(captureDirectory, {
                      source: await Bun.file(path.join(finished.workspace.directory, "analysis.mjs")).text(),
                      inputs: example.oracle.inputs,
                      evaluated,
                      report: text,
                      raw,
                    }),
                  }
                })
              : undefined
          if (external)
            expect(
              Object.entries(external.score)
                .filter(([key]) => key !== "subjective")
                .every(([, value]) => value === true),
            ).toBe(!example.oracle.instance.defective)
          const scoredAt = Date.now()
          const attestation = { hash: undefined as string | undefined, at: undefined as number | undefined }
          if (example.oracle.entry === "research") {
            const receipt = (yield* host.command("root-attest", input.id, {
              contractID: input.id,
              expected: finished.published,
              evidenceHash: finished.bundleHash,
              operationID:
                "eval-attest-" + digest(JSON.stringify([finished.id, finished.published, finished.bundleHash])),
            })) as { decision: { type: string } }
            expect(receipt.decision.type).toBe("accepted")
            yield* wait((run) => run.stage === "accepted")
            attestation.at = Date.now()
            attestation.hash = yield* Effect.promise(() =>
              put(captureDirectory, {
                receipt,
                scoredAt,
                attestedAt: attestation.at,
                readyCapturedAt: monitored.capturedAt,
              }),
            )
          }
          ending.resolve()
          const operations = yield* fixture.operations(input.id)
          expect(operations.some((item) => item.kind === "provider" && item.source.jobID === observed.jobID)).toBe(true)
          expect(operations.filter((item) => item.kind === "verification").length).toBe(
            example.oracle.entry === "plan" ? 0 : example.oracle.fault === "test_process" ? 3 : 2,
          )
          if (archive)
            yield* Effect.promise(async () => {
              const ledger = await read(archive)
              const evidence = await collect({
                directory: archive,
                storage: fixture.storage,
                run: finished,
                command: (action, id, input) => Effect.runPromise(host.command(action, id, input)),
              })
              const archiveHash = await put(archive, {
                evidence: evidence.hash,
                transport: monitored.transportHash,
                history: monitored.history,
                receipts: [...monitored.receipts, attestation.hash].filter(Boolean),
                external: external?.evidenceHash,
              })
              await ledger.append(example.packet.id, {
                kind: "observation",
                at: Date.now(),
                hash: archiveHash,
                stage: finished.stage,
              })
              if (example.oracle.entry !== "research")
                await ledger.append(example.packet.id, {
                  kind: "probe",
                  at: Date.now(),
                  label: result.label,
                  exposed: result.label !== "not_exposed",
                  usable: result.structure && result.evidence,
                  mechanismFailure: result.mechanismFailure,
                  scoreHash: await put(archive, result),
                })
              if (example.oracle.entry === "research") {
                await ledger.append(example.packet.id, {
                  kind: "candidate",
                  at: Date.now(),
                  readyAt: monitored.history.find((item) => item.stage === "ready")!.at,
                  scoredAt,
                  attestedAt: attestation.at,
                  hash: finished.subjectHash!,
                  bundleValid: !!finished.bundleHash && !!finished.published,
                  verdict: "correct",
                  scoreHash: await put(archive, {
                    mode: "deterministic-fixture",
                    external,
                    humanJudgment: "not_a_model_quality_score",
                  }),
                })
                if (example.oracle.instance.family === "R1")
                  await ledger.append(example.packet.id, {
                    kind: "repair",
                    at: Date.now(),
                    source: "initial",
                    defectHash: digest(example.packet.files["analysis.mjs"]),
                    repaired: external?.score.boundaries === true,
                  })
              }
              for (const operation of operations)
                await ledger.append(example.packet.id, {
                  kind: "usage",
                  at: Date.now(),
                  value: {
                    stage: stage(operation, evidence.runs),
                    operationID: operation.id,
                    milliseconds: operation.endedAt === undefined ? null : operation.endedAt - operation.startedAt,
                    turns: operation.kind === "provider" ? 1 : 0,
                    actions: ["tool", "verification"].includes(operation.kind) ? 1 : 0,
                    wireRequests: observations.filter(
                      (event) => event.kind === "wire" && event.identity.operationID === operation.id,
                    ).length,
                    tokens: operation.usage.value?.totalTokens ?? null,
                    cost: null,
                    unknown: operation.usage.state === "unknown",
                  },
                })
              await ledger.append(example.packet.id, {
                kind: "accounting",
                at: Date.now(),
                archiveHash,
                operationIDs: operations.map((item) => item.id),
                unresolvedScoring: false,
              })
              await ledger.append(example.packet.id, {
                kind: "stopped",
                at: Date.now(),
                reason: "Deterministic target observation complete; cancellation or exact attestation recorded",
              })
            })
          expect(yield* llm.misses).toHaveLength(0)
        }),
      150_000,
    )
  }
})
