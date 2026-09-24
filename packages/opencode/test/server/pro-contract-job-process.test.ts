import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { symlink } from "node:fs/promises"
import { NodeServices } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import type { Permission } from "@opencode-ai/schema/permission"
import type { ProContract } from "@opencode-ai/schema/pro-contract"
import { contractProcess } from "../fixture/contract-process"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import path from "node:path"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, NodeServices.layer, FetchHttpClient.layer))
type Host = Effect.Success<ReturnType<Effect.Success<typeof contractProcess>["startHost"]>>

const prepare = Effect.fnUntraced(function* (
  fixture: Effect.Success<typeof contractProcess>,
  host: Host,
  deadline = Date.now() + 120_000,
) {
  const contractID = `pct_job_${crypto.randomUUID()}`
  yield* host.command("issue", contractID, {
    id: contractID,
    scope: "job-e2e",
    driver: "test-process:1",
    now: Date.now(),
    location: { directory: fixture.directory },
    model: { providerID: "local", id: "researcher" },
    spec: {
      trigger: { type: "immediate" },
      goal: "Inspect the fixed candidate",
      brief: "Return independently observed evidence",
      requires: [],
      authority: ["filesystem.read", "filesystem.write", "process.execute"],
      budget: { deadline },
      evidence: { type: "principal", claim: "Independent evidence" },
      resolution: { maxAttempts: 1, retryDelay: 1 },
    },
  })
  const recognition = (yield* host.command("root-recognition", contractID)) as ProContract.Recognition
  const input = {
    id: crypto.randomUUID(),
    contractID,
    context: recognition.context!.target,
    driver: "test-process:1",
    kind: "review",
    inputHash: "a".repeat(64),
    sessionID: Session.ID.create(),
    promptID: SessionMessage.ID.create(),
    location: { directory: fixture.directory },
    model: { providerID: "local", id: "researcher" },
    agent: "build",
    prompt: { text: "Review candidate.txt independently" },
  }
  return { contractID, input, deadline }
})

const job = (host: Host, id: string) =>
  host.command("job-get", id).pipe(Effect.map((value) => value as ProContractJob.Job))
const operations = (host: Host, id: string) =>
  host.command("operations", id).pipe(Effect.map((value) => value as ProContractJob.Operation[]))
const settled = (host: Host, id: string) =>
  pollWithTimeout(
    job(host, id).pipe(
      Effect.map((job) =>
        ["completed", "failed", "interrupted", "cancelled", "unknown"].includes(job.status) ? job : undefined,
      ),
    ),
    "Job never settled",
    "20 seconds",
  )

describe("Controlled job production execution", () => {
  it.live(
    "uses an independent reviewer Session and refuses public identity and tool bypasses",
    () =>
      Effect.gen(function* () {
        const fixture = yield* contractProcess
        const llm = yield* TestLLMServer
        yield* Effect.promise(() => Bun.write(path.join(fixture.directory, "candidate.txt"), "review evidence"))
        const host = yield* fixture.startHost(true)
        const prepared = yield* prepare(fixture, host)
        const worker = yield* fixture.binding(prepared.contractID)
        yield* host.command("job-create", prepared.input.id, prepared.input)
        const rejected = yield* host
          .command("session-create", "", { id: prepared.input.sessionID, location: prepared.input.location })
          .pipe(Effect.exit)
        expect(rejected._tag).toBe("Failure")
        yield* host.command("session-create", "", {
          id: prepared.input.sessionID,
          location: prepared.input.location,
          model: prepared.input.model,
          agent: prepared.input.agent,
        })
        const prompt = {
          id: prepared.input.promptID,
          sessionID: prepared.input.sessionID,
          prompt: prepared.input.prompt,
          resume: false,
        }
        expect((yield* host.command("session-prompt", "", prompt).pipe(Effect.exit))._tag).toBe("Failure")
        yield* llm.push(
          reply().tool("read", { path: "candidate.txt" }).usage({ input: 11, output: 3 }),
          reply().tool("write", { path: "intrusion.txt", content: "forbidden" }),
          reply().tool("bash", { command: "touch forbidden-shell" }),
          reply().text("Independent review complete").usage({ input: 17, output: 5 }),
        )
        yield* host.command("job-start", prepared.input.id)
        const finished = yield* settled(host, prepared.input.id)
        expect(finished.status).toBe("completed")
        expect(yield* llm.calls).toBe(4)
        expect(yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "intrusion.txt")).exists())).toBe(
          false,
        )
        expect(yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "forbidden-shell")).exists())).toBe(
          false,
        )
        const history = (yield* host.command("session-context", "", {
          sessionID: prepared.input.sessionID,
        })) as SessionMessage.Message[]
        expect(JSON.stringify(history)).toContain("review evidence")
        expect(history.filter((message) => message.type === "user")).toHaveLength(1)
        const usage = yield* operations(host, prepared.contractID)
        expect(usage.filter((operation) => operation.kind === "provider")).toHaveLength(4)
        expect(usage.some((operation) => operation.kind === "tool" && operation.detail === "read")).toBe(true)
        expect(
          usage.every(
            (operation) =>
              operation.source.jobID === prepared.input.id && operation.source.sessionID === prepared.input.sessionID,
          ),
        ).toBe(true)
        expect((yield* fixture.binding(prepared.contractID)).sessionID).toBe(worker.sessionID)
        for (const action of ["session-agent", "session-model", "session-revert"])
          expect(
            (yield* host
              .command(action, "", {
                sessionID: prepared.input.sessionID,
                agent: "build",
                model: prepared.input.model,
                messageID: prepared.input.promptID,
              })
              .pipe(Effect.exit))._tag,
          ).toBe("Failure")
        expect((yield* host.command("session-prompt", "", prompt).pipe(Effect.exit))._tag).toBe("Failure")
      }),
    40_000,
  )

  it.live(
    "persists provider usage before permission settlement and cancels a pending reviewer",
    () =>
      Effect.gen(function* () {
        const fixture = yield* contractProcess
        const llm = yield* TestLLMServer
        yield* Effect.promise(async () => {
          const config = await Bun.file(path.join(fixture.directory, "opencode.json")).json()
          await Bun.write(
            path.join(fixture.directory, "opencode.json"),
            JSON.stringify({ ...config, permissions: [{ action: "read", resource: "*", effect: "ask" }] }),
          )
          await Bun.write(path.join(fixture.directory, "candidate.txt"), "pending read")
        })
        const host = yield* fixture.startHost(true)
        const prepared = yield* prepare(fixture, host)
        yield* host.command("job-create", prepared.input.id, prepared.input)
        yield* llm.push(reply().tool("read", { path: "candidate.txt" }).usage({ input: 23, output: 7 }))
        yield* host.command("job-start", prepared.input.id)
        yield* awaitWithTimeout(llm.wait(1), "Reviewer never requested its provider", "20 seconds")
        const pending = yield* pollWithTimeout(
          host
            .command("permission-list", "", { sessionID: prepared.input.sessionID })
            .pipe(Effect.map((value) => (value as Permission.Request[])[0])),
          "Reviewer never requested permission",
          "10 seconds",
        )
        const observed = yield* pollWithTimeout(
          operations(host, prepared.contractID).pipe(
            Effect.map((rows) => rows.find((row) => row.kind === "provider" && row.usage.state === "reported")),
          ),
          "Usage was not stored before tool completion",
          "10 seconds",
        )
        expect(observed.usageEvents.length).toBeGreaterThan(0)
        expect((yield* job(host, prepared.input.id)).status).toBe("open")
        expect(yield* host.command("open", prepared.contractID)).toMatchObject({ conflict: expect.any(String) })
        yield* host.command("job-cancel", prepared.input.id)
        expect((yield* job(host, prepared.input.id)).status).toBe("cancelled")
        yield* host
          .command("permission-reply", "", {
            sessionID: prepared.input.sessionID,
            requestID: pending.id,
            reply: "once",
          })
          .pipe(Effect.exit)
        expect(yield* llm.calls).toBe(1)
        expect(
          (yield* operations(host, prepared.contractID)).some(
            (row) => row.kind === "tool" && row.status === "interrupted",
          ),
        ).toBe(true)
        yield* host.kill
        const restarted = yield* fixture.startHost(true)
        expect((yield* restarted.command("job-recover-sync", prepared.input.id).pipe(Effect.exit))._tag).toBe("Failure")
        expect((yield* job(restarted, prepared.input.id)).status).toBe("cancelled")
        expect(yield* llm.calls).toBe(1)
      }),
    45_000,
  )

  it.live(
    "remote cancellation retains the stopped owner's live lease until that owner cleans up",
    () =>
      Effect.gen(function* () {
        const fixture = yield* contractProcess
        const llm = yield* TestLLMServer
        const first = yield* fixture.startHost(true)
        const second = yield* fixture.startHost(true)
        const prepared = yield* prepare(fixture, first)
        yield* first.command("job-create", prepared.input.id, prepared.input)
        const withheld = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => withheld.resolve()))
        yield* llm.push(reply().text("Partial response").wait(withheld.promise))
        yield* first.command("job-start", prepared.input.id)
        yield* awaitWithTimeout(llm.wait(1), "Provider did not start", "20 seconds")
        yield* Effect.acquireUseRelease(
          Effect.sync(() => first.child.kill("SIGSTOP")),
          () =>
            Effect.gen(function* () {
              const cancelling = yield* second.command("job-cancel", prepared.input.id).pipe(Effect.forkChild)
              const cancelled = yield* pollWithTimeout(
                job(second, prepared.input.id).pipe(
                  Effect.map((value) => (value.status === "cancelled" ? value : undefined)),
                ),
                "Remote cancellation was not persisted",
                "5 seconds",
              )
              expect(cancelled.owner).toBe(first.owner)
              expect(cancelled.leaseExpiresAt!).toBeGreaterThan(Date.now())
              expect(yield* second.command("open", prepared.contractID)).toMatchObject({ conflict: expect.any(String) })
              expect((yield* operations(second, prepared.contractID))[0].status).toBe("running")
              yield* Effect.sync(() => first.child.kill("SIGCONT"))
              yield* Fiber.join(cancelling)
              expect((yield* job(second, prepared.input.id)).status).toBe("cancelled")
              expect((yield* job(second, prepared.input.id)).owner).toBeUndefined()
              expect(yield* operations(second, prepared.contractID)).toMatchObject([{ status: "interrupted" }])
              expect(yield* llm.calls).toBe(1)
            }),
          () =>
            Effect.sync(() => {
              if (first.child.exitCode === null) first.child.kill("SIGCONT")
            }),
        )
      }),
    40_000,
  )

  for (const tool of ["write", "bash", "mutate_run"] as const) {
    it.live(
      `revocation while ${tool} awaits permission prevents its pending side effect`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* contractProcess
          const llm = yield* TestLLMServer
          yield* Effect.promise(async () => {
            const config = await Bun.file(path.join(fixture.directory, "opencode.json")).json()
            await Bun.write(
              path.join(fixture.directory, "opencode.json"),
              JSON.stringify({
                ...config,
                permissions: [
                  { action: "edit", resource: "*", effect: tool === "mutate_run" ? "allow" : "ask" },
                  { action: "bash", resource: "*", effect: "ask" },
                  { action: "mutate_run", resource: "*", effect: "allow" },
                ],
              }),
            )
          })
          const host = yield* fixture.startHost(true, { actionFusion: tool === "mutate_run" })
          const prepared = yield* prepare(fixture, host)
          yield* llm.push(
            reply().tool(
              tool,
              tool === "write"
                ? { path: "forbidden.txt", content: "late write" }
                : tool === "bash"
                  ? { command: "touch forbidden.txt" }
                  : {
                      mutation: { tool: "write", input: { path: "first-stage.txt", content: "retained first stage" } },
                      run: { command: "touch forbidden.txt" },
                    },
            ),
          )
          yield* host.command("open", prepared.contractID)
          yield* awaitWithTimeout(llm.wait(1), "Worker provider did not start", "20 seconds")
          const binding = yield* fixture.binding(prepared.contractID)
          const pending = yield* pollWithTimeout(
            host
              .command("permission-list", "", { sessionID: binding.sessionID })
              .pipe(Effect.map((value) => (value as Permission.Request[])[0])),
            "Worker did not reach permission wait",
            "20 seconds",
          )
          if (tool === "mutate_run")
            expect(yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "first-stage.txt")).text())).toBe(
              "retained first stage",
            )
          yield* host.command("close", prepared.contractID)
          yield* host
            .command("permission-reply", "", { sessionID: binding.sessionID, requestID: pending.id, reply: "once" })
            .pipe(Effect.exit)
          yield* pollWithTimeout(
            fixture.binding(prepared.contractID).pipe(Effect.map((value) => (!value.dispatched ? value : undefined))),
            "Revoked worker never stopped",
            "10 seconds",
          )
          expect(yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "forbidden.txt")).exists())).toBe(
            false,
          )
          expect(yield* llm.calls).toBe(1)
          const history = yield* operations(host, prepared.contractID)
          expect(history.some((row) => row.kind === "tool" && row.status === "interrupted")).toBe(true)
          if (tool === "mutate_run")
            expect(history.filter((row) => row.kind === "tool").map((row) => row.detail)).toEqual(["write", "bash"])
        }),
      40_000,
    )
  }

  it.live(
    "reviewer read, glob and grep cannot leave the Location through symlinks or external approval",
    () =>
      Effect.gen(function* () {
        const fixture = yield* contractProcess
        const llm = yield* TestLLMServer
        yield* Effect.promise(async () => {
          await Bun.write(path.join(fixture.storage, "private.txt"), "private reviewer escape sentinel")
          await symlink(fixture.storage, path.join(fixture.directory, "escape"))
          const config = await Bun.file(path.join(fixture.directory, "opencode.json")).json()
          await Bun.write(
            path.join(fixture.directory, "opencode.json"),
            JSON.stringify({ ...config, permissions: [{ action: "*", resource: "*", effect: "allow" }] }),
          )
        })
        const host = yield* fixture.startHost(true)
        for (const tool of ["read", "glob", "grep", "external"] as const) {
          const prepared = yield* prepare(fixture, host)
          yield* host.command("job-create", prepared.input.id, prepared.input)
          yield* llm.push(
            reply().tool(
              tool === "external" ? "read" : tool,
              tool === "read"
                ? { path: "escape/private.txt" }
                : tool === "external"
                  ? { path: path.join(fixture.storage, "private.txt") }
                  : { path: "escape", pattern: tool === "glob" ? "*.txt" : "sentinel" },
            ),
          )
          yield* host.command("job-start", prepared.input.id)
          yield* settled(host, prepared.input.id)
          const history = (yield* host.command("session-context", "", {
            sessionID: prepared.input.sessionID,
          })) as SessionMessage.Message[]
          expect(JSON.stringify(history)).not.toContain("private reviewer escape sentinel")
          expect(
            history
              .flatMap((message) => (message.type === "assistant" ? message.content : []))
              .filter((part) => part.type === "tool"),
          ).toMatchObject([{ name: tool === "external" ? "read" : tool, state: { status: "error" } }])
        }
      }),
    45_000,
  )

  it.live(
    "recovers only a queued zero-operation job after SIGKILL and preserves its original deadline",
    () =>
      Effect.gen(function* () {
        const fixture = yield* contractProcess
        const llm = yield* TestLLMServer
        const first = yield* fixture.startHost(true)
        const prepared = yield* prepare(fixture, first)
        yield* first.command("job-create", prepared.input.id, prepared.input)
        yield* first.command("job-queue", prepared.input.id)
        const queued = yield* job(first, prepared.input.id)
        expect(yield* operations(first, prepared.contractID)).toHaveLength(0)
        expect(yield* llm.calls).toBe(0)
        yield* first.kill
        const missing = yield* fixture.startHost(false)
        expect(
          (yield* missing
            .command("session-prompt", "", {
              id: prepared.input.promptID,
              sessionID: prepared.input.sessionID,
              prompt: prepared.input.prompt,
            })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure")
        yield* missing.kill
        const restarted = yield* fixture.startHost(true)
        expect((yield* restarted.command("job-recover-sync", prepared.input.id).pipe(Effect.exit))._tag).toBe("Failure")
        yield* pollWithTimeout(
          Effect.sync(() => (Date.now() > queued.leaseExpiresAt! ? true : undefined)),
          "Original lease never expired",
          "35 seconds",
        )
        yield* llm.push(reply().text("Recovered exactly once"))
        yield* restarted.command("job-recover", prepared.input.id)
        const recovered = yield* settled(restarted, prepared.input.id)
        expect(recovered.status).toBe("completed")
        expect(recovered.generation).toBe(queued.generation + 1)
        expect(recovered.deadline).toBe(prepared.deadline)
        expect(recovered.input.sessionID).toBe(queued.input.sessionID)
        const context = (yield* restarted.command("session-context", "", {
          sessionID: queued.input.sessionID,
        })) as SessionMessage.Message[]
        expect(context.filter((message) => message.type === "user").map((message) => message.id)).toEqual([
          queued.input.promptID,
        ])
        expect(yield* llm.calls).toBe(1)
      }),
    65_000,
  )

  it.live(
    "does not replay provider work after SIGKILL and retains unknown accounting",
    () =>
      Effect.gen(function* () {
        const fixture = yield* contractProcess
        const llm = yield* TestLLMServer
        const first = yield* fixture.startHost(true)
        const prepared = yield* prepare(fixture, first)
        yield* first.command("job-create", prepared.input.id, prepared.input)
        const withheld = Promise.withResolvers<void>()
        yield* llm.push(reply().text("Partial exploration").wait(withheld.promise))
        yield* first.command("job-start", prepared.input.id)
        yield* awaitWithTimeout(llm.wait(1), "Job provider never started", "20 seconds")
        const before = yield* job(first, prepared.input.id)
        const prior = yield* operations(first, prepared.contractID)
        expect(prior).toHaveLength(1)
        expect(prior[0]).toMatchObject({ kind: "provider", status: "running", usage: { state: "unknown" } })
        yield* first.kill
        const restarted = yield* fixture.startHost(true)
        expect(yield* llm.calls).toBe(1)
        yield* pollWithTimeout(
          Effect.sync(() => (Date.now() > before.leaseExpiresAt! ? true : undefined)),
          "Original lease never expired",
          "35 seconds",
        )
        expect(yield* restarted.command("job-recover-sync", prepared.input.id)).toMatchObject({
          job: { status: "unknown", deadline: prepared.deadline },
        })
        expect(yield* operations(restarted, prepared.contractID)).toMatchObject([
          { id: prior[0].id, status: "unknown", usage: { state: "unknown" } },
        ])
        expect(
          (yield* restarted
            .command("session-prompt", "", {
              sessionID: prepared.input.sessionID,
              id: prepared.input.promptID,
              prompt: prepared.input.prompt,
            })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure")
        expect(yield* llm.calls).toBe(1)
        yield* Effect.sync(() => withheld.resolve())
      }),
    65_000,
  )

  it.live(
    "runs a frozen verifier under root verification and retains interrupted process evidence",
    () =>
      Effect.gen(function* () {
        const fixture = yield* contractProcess
        const llm = yield* TestLLMServer
        const host = yield* fixture.startHost(true)
        const prepared = yield* prepare(fixture, host)
        yield* llm.push(reply().tool("contract_report_ready", { summary: "Candidate frozen", uncertainties: [] }))
        yield* host.command("open", prepared.contractID)
        const root = yield* pollWithTimeout(
          host
            .command("root-info", prepared.contractID)
            .pipe(
              Effect.map((value) =>
                (value as ProContract.Info).status === "verification" ? (value as ProContract.Info) : undefined,
              ),
            ),
          "Worker never froze its candidate",
          "20 seconds",
        )
        yield* pollWithTimeout(
          fixture.binding(prepared.contractID).pipe(Effect.map((binding) => (!binding.dispatched ? true : undefined))),
          "Worker cleanup never ended",
          "20 seconds",
        )
        const recognition = (yield* host.command("root-recognition", prepared.contractID)) as ProContract.Recognition
        const verifier = {
          ...prepared.input,
          id: crypto.randomUUID(),
          sessionID: Session.ID.create(),
          promptID: SessionMessage.ID.create(),
          context: recognition.context!.target,
          kind: "verify",
          verification: {
            subjectHash: root.handoff!.subjectHash,
            policy: {
              checks: [
                {
                  argv: [process.execPath, "-e", "process.stdout.write('frozen verifier result')"],
                  timeout: 10_000,
                  exit: 0,
                },
              ],
              protected: [],
              artifacts: [],
            },
          },
        }
        yield* host.command("job-create", verifier.id, verifier)
        yield* host.command("job-verify", verifier.id)
        const complete = yield* settled(host, verifier.id)
        expect(complete).toMatchObject({
          status: "completed",
          result: { passed: true, subjectHash: verifier.verification.subjectHash },
        })
        expect(
          (yield* operations(host, prepared.contractID)).filter((row) => row.source.jobID === verifier.id),
        ).toMatchObject([{ kind: "verification", status: "completed" }])
        expect(yield* host.command("root-info", prepared.contractID)).toMatchObject({ status: "verification" })
        expect(yield* llm.calls).toBe(1)

        const signal = path.join(fixture.storage, "verifier-started")
        const interrupted = {
          ...verifier,
          id: crypto.randomUUID(),
          sessionID: Session.ID.create(),
          promptID: SessionMessage.ID.create(),
          verification: {
            ...verifier.verification,
            policy: {
              checks: [
                {
                  argv: [
                    process.execPath,
                    "-e",
                    `require('fs').writeFileSync(${JSON.stringify(signal)}, String(process.pid)); process.stdout.write('partial verifier evidence'); setInterval(() => {}, 1000)`,
                  ],
                  timeout: 60_000,
                  exit: 0,
                },
              ],
              protected: [],
              artifacts: [],
            },
          },
        }
        yield* host.command("job-create", interrupted.id, interrupted)
        yield* host.command("job-verify", interrupted.id)
        yield* pollWithTimeout(
          Effect.promise(async () => ((await Bun.file(signal).exists()) ? true : undefined)),
          "Verifier process never started",
          "20 seconds",
        )
        yield* host.command("job-cancel", interrupted.id)
        expect(yield* job(host, interrupted.id)).toMatchObject({ status: "cancelled" })
        expect((yield* job(host, interrupted.id)).result).toBeUndefined()
        expect(
          (yield* operations(host, prepared.contractID)).filter((row) => row.source.jobID === interrupted.id),
        ).toMatchObject([{ kind: "verification", status: "interrupted" }])
        expect(JSON.stringify(yield* fixture.reports)).toContain("partial verifier evidence")
        expect(JSON.stringify(yield* fixture.reports)).toContain('"reason":"interrupted"')
        expect(yield* host.command("root-info", prepared.contractID)).toMatchObject({ status: "verification" })
      }),
    45_000,
  )

  it.live(
    "the original deadline stops a real verifier and forbids a late passed result",
    () =>
      Effect.gen(function* () {
        const fixture = yield* contractProcess
        const llm = yield* TestLLMServer
        const host = yield* fixture.startHost(true)
        const prepared = yield* prepare(fixture, host, Date.now() + 8000)
        yield* llm.push(
          reply().tool("contract_report_ready", { summary: "Frozen for deadline test", uncertainties: [] }),
        )
        yield* host.command("open", prepared.contractID)
        const root = yield* pollWithTimeout(
          host
            .command("root-info", prepared.contractID)
            .pipe(
              Effect.map((value) =>
                (value as ProContract.Info).status === "verification" ? (value as ProContract.Info) : undefined,
              ),
            ),
          "Worker never froze candidate",
          "5 seconds",
        )
        yield* pollWithTimeout(
          fixture.binding(prepared.contractID).pipe(Effect.map((value) => (!value.dispatched ? true : undefined))),
          "Worker did not stop",
          "5 seconds",
        )
        const recognition = (yield* host.command("root-recognition", prepared.contractID)) as ProContract.Recognition
        const signal = path.join(fixture.storage, "deadline-process")
        const input = {
          ...prepared.input,
          kind: "verify",
          context: recognition.context!.target,
          verification: {
            subjectHash: root.handoff!.subjectHash,
            policy: {
              checks: [
                {
                  argv: [
                    process.execPath,
                    "-e",
                    `require('fs').writeFileSync(${JSON.stringify(signal)}, String(process.pid)); process.stdout.write('deadline partial evidence'); setInterval(() => {}, 1000)`,
                  ],
                  timeout: 60_000,
                  exit: 0,
                },
              ],
              protected: [],
              artifacts: [],
            },
          },
        }
        yield* host.command("job-create", input.id, input)
        yield* host.command("job-verify", input.id)
        yield* pollWithTimeout(
          Effect.promise(async () => ((await Bun.file(signal).exists()) ? true : undefined)),
          "Verifier did not start before deadline",
          "5 seconds",
        )
        const pid = yield* Effect.promise(async () => Number(await Bun.file(signal).text()))
        const result = yield* settled(host, input.id)
        expect(result.deadline).toBe(prepared.deadline)
        expect(result.status).not.toBe("completed")
        expect(result.result).toBeUndefined()
        expect(Date.now()).toBeLessThan(prepared.deadline + 5000)
        expect(() => process.kill(pid, 0)).toThrow()
        const history = (yield* operations(host, prepared.contractID)).filter((row) => row.source.jobID === input.id)
        expect(history).toHaveLength(1)
        expect(history[0].endedAt).toBeDefined()
        expect(JSON.stringify(yield* fixture.reports)).toContain("deadline partial evidence")
        expect(yield* llm.calls).toBe(1)
      }),
    25_000,
  )
})
