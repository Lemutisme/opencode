import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import { RelativePath } from "@opencode-ai/schema/schema"
import path from "node:path"
import { contractProcess } from "../fixture/contract-process"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, NodeServices.layer))
const leaseTest = process.platform === "win32" ? it.live.skip : it.live
const ready = () => reply().tool("contract_report_ready", { summary: "Verified answer.ts", uncertainties: [] })

describe("S1 production process E2E", () => {
  it.live(
    "writes a candidate, replays a snapshot, requires attestation, and persists across SIGKILL",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const fixture = yield* contractProcess
        const server = yield* fixture.start()
        const id = "pct_process_success"
        yield* llm.push(reply().tool("write", { path: "answer.ts", content: "export const answer = 42\n" }), ready())
        yield* server.issue(id, {
          type: "principal",
          replay: {
            checks: [
              {
                argv: [
                  process.execPath,
                  "-e",
                  'const { answer } = await import("./answer.ts"); if (answer !== 42) process.exit(1)',
                ],
                timeout: 10_000,
                exit: 0,
              },
            ],
            protected: [],
            artifacts: [RelativePath.make("answer.ts")],
          },
        })
        const contract = yield* server.status(id, "verification")
        expect(contract.handoff?.replay?.passed).toBe(true)
        expect(contract.attestationID).toBeUndefined()
        expect(yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "answer.ts")).text())).toContain("42")
        const binding = yield* fixture.binding(id)
        expect(binding).toMatchObject({ generation: 1, attempts: 1, turnsUsed: 2, actionsUsed: 2 })
        expect(yield* server.execution(id)).toMatchObject({
          sessionID: binding.sessionID,
          turnsUsed: 2,
          actionsUsed: 2,
        })
        yield* awaitWithTimeout(llm.wait(2), "Provider requests missing")
        expect((yield* llm.hits).every((hit) => hit.url.pathname === "/v1/chat/completions")).toBe(true)
        const refusal = yield* server
          .request(`/api/contract/${id}/attestation`, {
            operationID: "replay-refusal",
            expected: contract.recognition!.handoff!,
            evidenceHash: contract.handoff!.replay!.evidenceHash,
          })
          .pipe(Effect.flip)
        expect(String(refusal)).toContain("principal evidence must be independent of replay")
        // The harness acts as the external issuer; its exact-file check is separate from replay.
        const actual = yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "answer.ts")).text())
        expect(actual).toBe("export const answer = 42\n")
        yield* server.request(`/api/contract/${id}/attestation`, {
          operationID: "independent-attestation",
          expected: contract.recognition!.handoff!,
          evidenceHash: new Bun.CryptoHasher("sha256").update(`issuer exact-file check: ${actual}`).digest("hex"),
        })
        const discharged = yield* server.status(id, "discharged")
        const ledger = yield* fixture.ledger(id)
        expect(
          ledger.filter((event) => event.command.type === "report-ready" && event.decision.type === "accepted"),
        ).toHaveLength(1)
        expect((yield* server.settled(binding.sessionID, 2)).map((tool) => tool.state.status)).toEqual([
          "completed",
          "completed",
        ])
        const transcript = yield* server.context(binding.sessionID)
        yield* server.kill
        const restarted = yield* fixture.start()
        expect(yield* restarted.get(id)).toEqual(discharged)
        expect(yield* fixture.ledger(id)).toEqual(ledger)
        expect(yield* restarted.context(binding.sessionID)).toEqual(transcript)
        expect(yield* llm.calls).toBe(2)
      }),
    60_000,
  )

  leaseTest(
    "rejects delayed ready, blocked, and revision calls after a real lease takeover",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const fixture = yield* contractProcess
        const original = yield* fixture.start()
        const id = "pct_process_takeover"
        const delayed = Promise.withResolvers<void>()
        const current = Promise.withResolvers<void>()
        // One OpenAI-compatible response containing three distinct control calls.
        yield* llm.push(
          raw({
            wait: delayed.promise,
            tail: [
              {
                id: "chatcmpl-stale",
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        ["contract_report_ready", { summary: "stale", uncertainties: [] }],
                        ["contract_report_blocked", { reason: "stale" }],
                        ["contract_propose_revision", { goal: "stale", reason: "stale" }],
                      ].map(([name, input], index) => ({
                        index,
                        id: `stale_${index}`,
                        type: "function",
                        function: { name, arguments: JSON.stringify(input) },
                      })),
                    },
                  },
                ],
              },
              {
                id: "chatcmpl-stale",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              },
            ],
          }),
          ready().wait(current.promise),
        )
        yield* original.issue(id)
        yield* awaitWithTimeout(llm.wait(1), "Original provider never started", "20 seconds")
        const before = yield* fixture.binding(id)
        yield* Effect.sync(() => original.child.kill("SIGSTOP"))
        const replacement = yield* fixture.start()
        const after = yield* pollWithTimeout(
          fixture
            .binding(id)
            .pipe(Effect.map((binding) => (binding.sessionID !== before.sessionID ? binding : undefined))),
          "Production scheduler did not reclaim the expired lease",
          "45 seconds",
        )
        expect(after.generation).toBe(before.generation! + 1)
        expect(after.leaseOwner).not.toBe(before.leaseOwner)
        expect(after.attempts).toBe(before.attempts)
        yield* awaitWithTimeout(llm.wait(2), "Replacement provider never started", "20 seconds")
        yield* Effect.sync(() => {
          original.child.kill("SIGCONT")
          delayed.resolve()
        })
        // S3b interrupts the stale provider itself; its delayed tool calls need not enter history.
        yield* original.idle(before.sessionID)
        const tools = (yield* original.context(before.sessionID)).flatMap((message) =>
          message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
        )
        expect(tools.every((tool) => tool.state.status !== "completed")).toBe(true)
        const oldOperations = (yield* fixture.operations(id)).filter(
          (operation) => operation.source.sessionID === before.sessionID,
        )
        expect(oldOperations.some((operation) => operation.kind === "provider")).toBe(true)
        expect(oldOperations.every((operation) => operation.status !== "running")).toBe(true)
        expect(yield* replacement.get(id)).toMatchObject({ status: "active", revision: 1 })
        expect((yield* replacement.get(id)).handoff).toBeUndefined()
        expect((yield* replacement.get(id)).pendingRevision).toBeUndefined()
        expect((yield* fixture.binding(id)).actionsUsed).toBe(0)
        expect(
          (yield* fixture.ledger(id)).filter((event) =>
            ["report-ready", "report-blocked", "petition-revision"].includes(event.command.type),
          ),
        ).toHaveLength(0)
        yield* Effect.sync(() => current.resolve())
        yield* replacement.status(id, "verification")
        expect((yield* replacement.settled(after.sessionID, 1))[0].state.status).toBe("completed")
        expect(yield* llm.calls).toBe(2)
      }),
    90_000,
  )

  for (const outcome of ["success", "failure", "unavailable", "timeout", "interrupted"] as const) {
    it.live(
      `fences a ${outcome} replay when authorization is revoked over HTTP`,
      () =>
        Effect.gen(function* () {
          const llm = yield* TestLLMServer
          const fixture = yield* contractProcess
          const server = yield* fixture.start()
          const id = `pct_process_replay_${outcome}`
          const started = path.join(fixture.storage, "replay-started")
          const release = path.join(fixture.storage, "replay-release")
          const interruptible = path.join(fixture.storage, "replay-interruptible")
          const unrun = path.join(fixture.storage, "replay-unrun")
          // Publish readiness only after installing the release watcher. The marker is outside
          // the candidate snapshot and serves only as the test's synchronization channel.
          const script = `const fs = require('fs'); setTimeout(() => process.exit(124), 20000); const watcher = fs.watch(${JSON.stringify(fixture.storage)}, (_, name) => { if (name === 'replay-release') { watcher.close(); process.exit(${outcome === "failure" ? 1 : 0}) } }); fs.writeFileSync(${JSON.stringify(started)}, process.cwd());`
          yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(release, "cleanup")))
          yield* llm.push(ready())
          yield* server.issue(id, {
            type: "principal",
            replay: {
              checks: [
                { argv: [process.execPath, "-e", script], timeout: 15_000, exit: 0 },
                ...(outcome === "unavailable"
                  ? [{ argv: [path.join(fixture.storage, "missing-program")], timeout: 1_000, exit: 0 }]
                  : []),
                ...(outcome === "timeout"
                  ? [
                      {
                        argv: [process.execPath, "-e", "await new Promise((resolve) => setTimeout(resolve, 5000))"],
                        timeout: 1_000,
                        exit: 0,
                      },
                    ]
                  : []),
                ...(outcome === "interrupted"
                  ? [
                      {
                        argv: [
                          process.execPath,
                          "-e",
                          `setInterval(() => {}, 1000); process.stdout.write('x'.repeat(2 * 1024 * 1024), () => require('fs').writeFileSync(${JSON.stringify(interruptible)}, 'ready'));`,
                        ],
                        timeout: 15_000,
                        exit: 0,
                      },
                      {
                        argv: [
                          process.execPath,
                          "-e",
                          `require('fs').writeFileSync(${JSON.stringify(unrun)}, 'should not run')`,
                        ],
                        timeout: 1_000,
                        exit: 0,
                      },
                    ]
                  : []),
              ],
              protected: [],
              artifacts: [],
            },
          })
          yield* pollWithTimeout(
            Effect.promise(async () => ((await Bun.file(started).exists()) ? true : undefined)),
            "Replay command never started",
            "20 seconds",
          )
          expect(yield* Effect.promise(() => Bun.file(started).text())).not.toBe(fixture.directory)
          const binding = yield* fixture.binding(id)
          expect(binding.actionsUsed).toBe(1)
          if (outcome === "interrupted") {
            yield* Effect.promise(() => Bun.write(release, "go"))
            yield* pollWithTimeout(
              Effect.promise(async () => ((await Bun.file(interruptible).exists()) ? true : undefined)),
              "Second replay command never became interruptible",
            )
          }
          yield* server.request(`/api/contract/${id}/release`, { reason: "Revoke while replay is running" })
          yield* Effect.promise(() => Bun.write(release, "go"))
          yield* server.idle(binding.sessionID)
          const tools = (yield* server.context(binding.sessionID)).flatMap((message) =>
            message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
          )
          expect(tools).toHaveLength(1)
          expect(tools[0].state.status).toBe("error")
          yield* pollWithTimeout(
            fixture.binding(id).pipe(Effect.map((current) => (!current.dispatched ? true : undefined))),
            "Revoked replay did not finish cleanup",
          )
          const contract = yield* server.get(id)
          expect(contract.status).toBe("released")
          expect(contract.handoff).toBeUndefined()
          expect(contract.escalation).toBeUndefined()
          expect((yield* fixture.binding(id)).actionsUsed).toBe(1)
          const operations = yield* fixture.operations(id)
          expect(operations.some((operation) => operation.kind === "verification")).toBe(true)
          expect(operations.every((operation) => operation.status !== "running")).toBe(true)
          const ledger = yield* fixture.ledger(id)
          expect(
            ledger.filter(
              (event) =>
                ["report-ready", "escalate"].includes(event.command.type) && event.decision.type === "accepted",
            ),
          ).toHaveLength(0)
          const reports = yield* fixture.reports
          expect(reports).toHaveLength(1)
          const interrupted = Schema.is(
            Schema.Struct({ incomplete: Schema.Struct({ reason: Schema.Literal("interrupted") }) }),
          )(reports[0])
          // Cancellation can stop before a control command, including after report publication.
          // Any command that reaches the ledger after revocation must still be rejected.
          expect(
            ledger
              .slice(ledger.findIndex((event) => event.command.type === "release") + 1)
              .filter((event) => ["report-ready", "escalate"].includes(event.command.type))
              .every((event) => event.decision.type === "rejected"),
          ).toBe(true)
          if (interrupted)
            expect(reports[0]).toMatchObject({
              contractID: id,
              passed: false,
              incomplete: {
                reason: "interrupted",
                expectedChecks:
                  outcome === "interrupted" ? 3 : outcome === "unavailable" || outcome === "timeout" ? 2 : 1,
              },
            })
          if (outcome === "interrupted") {
            expect(interrupted).toBe(true)
            expect(reports[0]).toMatchObject({
              checks: [
                { observation: { receipt: { execution: "completed", exit: 0 } } },
                {
                  observation: {
                    receipt: {
                      execution: "unavailable",
                      error: "Replay check interrupted; captured output may be incomplete",
                      stdout: { bytes: 1024 * 1024, complete: false },
                    },
                  },
                },
              ],
            })
            expect(yield* Effect.promise(() => Bun.file(unrun).exists())).toBe(false)
          }
          if (!interrupted)
            expect(reports[0]).toMatchObject({
              version: 2,
              contractID: id,
              passed: outcome === "success",
              checks: [
                { observation: { receipt: { execution: "completed", exit: outcome === "failure" ? 1 : 0 } } },
                ...(outcome === "unavailable" || outcome === "timeout"
                  ? [{ observation: { receipt: { execution: outcome === "timeout" ? "timed-out" : "unavailable" } } }]
                  : []),
              ],
            })
          yield* server.kill
          const restarted = yield* fixture.start()
          expect(yield* restarted.get(id)).toEqual(contract)
          expect(yield* fixture.ledger(id)).toEqual(ledger)
          expect((yield* fixture.binding(id)).actionsUsed).toBe(1)
          expect(yield* fixture.reports).toEqual(reports)
        }),
      60_000,
    )
  }

  for (const replyToOld of ["once", "reject"] as const) {
    leaseTest(
      `rejects an old ${replyToOld} permission reply against a same-content replacement petition`,
      () =>
        Effect.gen(function* () {
          const llm = yield* TestLLMServer
          const fixture = yield* contractProcess
          const original = yield* fixture.start()
          const id = `pct_process_aba_${replyToOld}`
          yield* llm.push(
            reply().tool("contract_propose_revision", { goal: "Amended goal", reason: "First petition" }),
            reply().tool("contract_propose_revision", { goal: "Amended goal", reason: "Replacement petition" }),
          )
          yield* original.issue(id)
          yield* awaitWithTimeout(llm.wait(1), "Original provider never started", "20 seconds")
          const before = yield* fixture.binding(id)
          const oldPermission = yield* original.permission(before.sessionID)
          const oldPetition = (yield* original.get(id)).pendingRevision!
          yield* Effect.sync(() => original.child.kill("SIGSTOP"))
          const replacement = yield* fixture.start()
          yield* replacement.request(`/api/contract/${id}/revision/decision`, {
            operationID: "replace-petition",
            expected: (yield* replacement.get(id)).recognition!.pending!,
            accept: false,
          })
          const after = yield* pollWithTimeout(
            fixture
              .binding(id)
              .pipe(Effect.map((binding) => (binding.sessionID !== before.sessionID ? binding : undefined))),
            "Replacement Session never claimed the expired lease",
            "45 seconds",
          )
          yield* awaitWithTimeout(llm.wait(2), "Replacement provider never started", "20 seconds")
          const newPermission = yield* replacement.permission(after.sessionID)
          const pending = yield* replacement.get(id)
          expect(pending.revision).toBe(1)
          expect(pending.pendingRevision?.specHash).toBe(oldPetition.specHash)
          expect(pending.pendingRevision?.reason).toBe("Replacement petition")
          yield* Effect.sync(() => original.child.kill("SIGCONT"))
          yield* original.request(`/api/session/${before.sessionID}/permission/${oldPermission.id}/reply`, {
            reply: replyToOld,
          })
          // The worker was interrupted when it petitioned; the issuer continuation owns the CAS receipt.
          yield* original.idle(before.sessionID)
          const ledger = yield* pollWithTimeout(
            fixture
              .ledger(id)
              .pipe(
                Effect.map((events) =>
                  events.at(-1)?.command.type === "decide-revision" && events.at(-1)?.decision.type === "rejected"
                    ? events
                    : undefined,
                ),
              ),
            "Old issuer reply never produced its rejected receipt",
            "10 seconds",
          )
          expect(yield* replacement.get(id)).toEqual(pending)
          expect((yield* replacement.permissions(after.sessionID)).map((request) => request.id)).toContain(
            newPermission.id,
          )
          expect(
            ledger.filter((event) => event.command.type === "petition-revision" && event.decision.type === "accepted"),
          ).toHaveLength(2)
          expect(ledger.at(-1)).toMatchObject({
            command: { type: "decide-revision", accept: replyToOld === "once" },
            decision: { type: "rejected" },
          })
          yield* replacement.request(`/api/contract/${id}/release`, { reason: "End race test" })
        }),
      90_000,
    )
  }

  it.live(
    "retains a pending revision through SIGKILL and resumes only after an explicit decision",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const fixture = yield* contractProcess
        const server = yield* fixture.start()
        const id = "pct_process_pending"
        yield* llm.push(
          reply().tool("contract_propose_revision", { goal: "Approved after restart", reason: "Need new scope" }),
          ready(),
          ready(),
        )
        yield* server.issue(id)
        yield* awaitWithTimeout(llm.wait(1), "Provider never started", "20 seconds")
        yield* server.permission((yield* server.execution(id)).sessionID)
        // Pending revision suppresses heartbeats; capture the durable lease only after that boundary.
        const before = yield* fixture.binding(id)
        const pending = yield* server.get(id)
        const ledger = yield* fixture.ledger(id)
        yield* server.kill
        const restarted = yield* fixture.start()
        expect(yield* restarted.get(id)).toEqual(pending)
        expect(yield* fixture.ledger(id)).toEqual(ledger)
        expect(yield* restarted.permissions(before.sessionID)).toEqual([])
        expect(yield* llm.calls).toBe(1)
        // A second scheduled Contract witnesses a live scheduler cycle after the dead
        // owner's lease expires. The original pending petition must still prevent retry.
        const probe = "pct_process_scheduler_probe"
        yield* restarted.issue(probe, undefined, { type: "time", at: before.leaseExpiresAt! + 1 })
        yield* pollWithTimeout(
          restarted.get(probe).pipe(Effect.map((contract) => (contract.status === "verification" ? true : undefined))),
          "Scheduler did not run beyond the original lease deadline",
          "45 seconds",
        )
        expect(yield* restarted.get(id)).toEqual(pending)
        expect(yield* fixture.ledger(id)).toEqual(ledger)
        const retired = yield* fixture.binding(id)
        expect(retired).toMatchObject({
          contractID: before.contractID,
          sessionID: before.sessionID,
          revision: before.revision,
          generation: before.generation,
          attempts: before.attempts,
          turnsUsed: before.turnsUsed,
          actionsUsed: before.actionsUsed,
          admission: before.admission,
          dispatched: false,
        })
        expect(retired.leaseOwner).toBeUndefined()
        expect(retired.leaseExpiresAt).toBeUndefined()
        expect(yield* llm.calls).toBe(2)
        yield* restarted.request(`/api/contract/${id}/revision/decision`, {
          operationID: "resume-petition",
          expected: (yield* restarted.get(id)).recognition!.pending!,
          accept: true,
        })
        const verified = yield* restarted.status(id, "verification")
        expect(verified).toMatchObject({ revision: 2, spec: { goal: "Approved after restart" } })
        expect(verified.pendingRevision).toBeUndefined()
        const after = yield* fixture.binding(id)
        expect(after.sessionID).not.toBe(before.sessionID)
        expect(after.generation).toBe(before.generation! + 1)
        expect(after.turnsUsed).toBe(2)
        expect((yield* fixture.ledger(id)).slice(0, ledger.length)).toEqual(ledger)
        expect(yield* llm.calls).toBe(3)
      }),
    90_000,
  )
})
