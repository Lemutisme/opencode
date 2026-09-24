import { expect } from "bun:test"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { Hash } from "@opencode-ai/core/util/hash"
import type { NativeAdvisoryStore } from "../../../sdk-next/src/native-advisory-store"
import { guidance } from "../../../sdk-next/src/native-advisory"
import { tasks } from "../../script/pro-contract-feedback-tasks"
import { contractProcess } from "../fixture/contract-process"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, NodeServices.layer, FetchHttpClient.layer))

for (const mode of ["disabled", "enabled", "corrupt-archive"] as const)
  it.live(
    `native review ${mode}: runs the reference shell/Python task and submits its executable`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* contractProcess
        const llm = yield* TestLLMServer
        const review = mode !== "disabled"
        const task = tasks.find((task) => task.id === "ready-control")!
        yield* Effect.promise(() =>
          Promise.all(
            task.files.map(async (file) => {
              await Bun.write(path.join(fixture.directory, file.path), file.content)
              if (file.executable) await chmod(path.join(fixture.directory, file.path), 0o755)
            }),
          ),
        )
        yield* Effect.promise(async () => {
          await Bun.write(
            path.join(fixture.storage, "config/opencode/opencode.json"),
            await Bun.file(path.join(fixture.directory, "opencode.json")).text(),
          )
        })
        const host = yield* fixture.startHost(false, {
          nativeAdvisory: review,
          nativeCheckpoints: mode === "corrupt-archive",
        })
        if (mode === "corrupt-archive") yield* host.command("checkpoint-arm", "collected")
        const id = `pct_native_reference_${mode}`
        const deadline = Date.now() + 6 * 60 * 60 * 1000
        yield* llm.push(
          reply().tool("bash", {
            command:
              "./compile.sh && python3 validate.py && printf 'native validation succeeded\\n' > validation-output.txt",
            timeout: 10_000,
          }),
          ...(review
            ? [
                reply().tool("contract_request", { kind: "review", payload: {} }),
                reply().tool("read", { path: "materials.json" }),
                reply().tool("read", { path: "candidate/linepack.py" }),
                reply().tool("read", { path: "candidate/validation-output.txt" }),
                reply()
                  .text(
                    "I read linepack.py: dict.fromkeys preserves first occurrence and key=str.casefold sorts values. validation-output.txt says native validation succeeded. Consider adding a casefold tie example; this advice is optional.",
                  )
                  .stop(),
                // No response or completion action: the restored native worker exercises process authority.
                reply().tool("bash", { command: "./compile.sh && python3 validate.py", timeout: 10_000 }),
              ]
            : []),
          reply().tool("contract_check", {}),
          reply().tool("contract_report_ready", { summary: "Reference executable verified", uncertainties: [] }),
        )
        const input = {
          id,
          scope: "native-advisory-reference",
          now: Date.now(),
          location: { directory: fixture.directory },
          model: { providerID: "local", id: "researcher" },
          spec: {
            trigger: { type: "immediate" },
            goal: "Deliver the reference Python CLI",
            brief: review ? `${task.brief}\n\n${guidance}` : task.brief,
            requires: [],
            authority: ["filesystem.read", "filesystem.write", "process.execute"],
            budget: { deadline },
            evidence: {
              type: "principal",
              replay: {
                checks: task.replay.checks,
                protected: task.replay.protectedFiles.map((name) => ({
                  path: name,
                  hash: Hash.sha256(task.files.find((file) => file.path === name)!.content),
                })),
                artifacts: task.replay.artifacts,
              },
            },
            resolution: { retryDelay: 10 },
          },
        }
        const issued = yield* host.command(
          review ? "native-issue" : "issue",
          id,
          review
            ? {
                issue: input,
                configuration: {
                  reviewer: {
                    model: { providerID: "local", id: "researcher" },
                    agent: "build",
                    instructions: "Inspect the CLI and captured validation output; offer independent optional advice.",
                  },
                  materials: ["linepack.py", "validation-output.txt", "executable"],
                  evidence: [],
                  time: { operationMs: 30_000, reviewMs: 10_000, cleanupMs: 60_000, resumeMs: 10_000 },
                },
              }
            : input,
        )
        expect(issued).toMatchObject({
          decision: { type: "accepted" },
          ...(review ? { review: { available: true } } : {}),
        })
        // Initialize the embedded HTTP graph, including its native scheduler.
        yield* host.command("root-info", id)
        const archived =
          mode === "corrupt-archive"
            ? yield* Effect.gen(function* () {
                yield* pollWithTimeout(
                  host
                    .command("checkpoint-status", "collected")
                    .pipe(Effect.map((reached) => (reached ? true : undefined))),
                  "Review archive was not collected",
                  "20 seconds",
                )
                const request = ((yield* host.command("native-requests", id)) as NativeAdvisoryStore.Request[])[0]
                const original = (yield* host.command("native-object", request.outcome!.archiveHash!)) as string
                yield* Effect.promise(async () => {
                  const file = path.join(
                    fixture.storage,
                    "data/opencode/pro-contract/blobs",
                    request.outcome!.archiveHash!,
                  )
                  await chmod(file, 0o600)
                  await Bun.write(file, "corrupt independent review archive")
                })
                expect(yield* host.command("native-attachment", id)).toMatchObject([
                  { availability: expect.stringContaining("corrupt") },
                ])
                yield* host.command("checkpoint-release", "collected")
                return original
              })
            : undefined
        yield* pollWithTimeout(
          fixture
            .ledger(id)
            .pipe(
              Effect.map((events) =>
                events.find((event) => event.command.type === "report-ready" && event.decision.type === "accepted"),
              ),
            ),
          "Native reference task did not submit",
          "30 seconds",
        ).pipe(Effect.tapError(() => host.log().pipe(Effect.tap((log) => Effect.sync(() => console.error(log))))))
        const binding = yield* fixture.binding(id)
        const root = yield* host.command("root-info", id)
        const requests = review
          ? ((yield* host.command("native-requests", id)) as ReadonlyArray<
              NativeAdvisoryStore.Request & { deliveryState: { admission: boolean; inbox: string } }
            >)
          : []
        const archive =
          archived ??
          (requests[0]?.outcome?.archiveHash
            ? ((yield* host.command("native-object", requests[0].outcome.archiveHash)) as string)
            : undefined)
        if (process.env.OPENCODE_NATIVE_ADVISORY_ARTIFACTS) {
          const output = path.join(process.env.OPENCODE_NATIVE_ADVISORY_ARTIFACTS, `${id}-${Date.now()}`)
          const hits = yield* llm.hits
          const context = yield* host.command("session-context", id, { sessionID: binding.sessionID })
          const operations = yield* fixture.operations(id)
          const log = yield* host.log()
          yield* Effect.promise(async () => {
            await Bun.write(
              path.join(output, "result.json"),
              JSON.stringify({ root, binding, requests, context, hits, operations }, null, 2),
            )
            await Bun.write(path.join(output, "host.log"), log)
            if (archive) await Bun.write(path.join(output, "review-archive.json"), archive)
          })
        }
        expect(binding).toMatchObject({
          attempts: 1,
          generation: review ? 2 : 1,
          turnsUsed: review ? 5 : 3,
          actionsUsed: review ? 4 : 3,
        })
        expect(root).toMatchObject({
          status: "verification",
          spec: { budget: { deadline } },
          handoff: { replay: { passed: true } },
        })
        expect(yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "executable")).text())).toBe(
          task.files.find((file) => file.path === "linepack.py")!.content,
        )
        expect(
          yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "validation-output.txt")).text()),
        ).toBe("native validation succeeded\n")
        expect(yield* llm.calls).toBe(review ? 9 : 3)
        if (review) {
          expect(requests).toHaveLength(1)
          const request = requests[0]
          expect(request).toMatchObject({
            phase: "resumed",
            outcome: { status: "complete", jobStatus: "completed" },
            deliveryState: { admission: true, inbox: "promoted" },
          })
          expect(request.execution.sessionID).toBe(binding.sessionID)
          expect(request.job!.sessionID).not.toBe(binding.sessionID)
          expect(request.prequery).toEqual(request.actual)
          expect(binding.admission?.capabilities).toBeUndefined()
          expect(archive).toContain("dict.fromkeys")
          expect(archive).toContain("native validation succeeded")
          expect(archive).toContain('"status":"completed"')
          const received = JSON.stringify((yield* llm.hits).at(-1)!.body)
          if (mode === "corrupt-archive") {
            expect(request.archiveFault).toContain("corrupt")
            expect(received).not.toContain("Consider adding a casefold tie example")
            expect(received).toContain("corrupt")
          }
          if (mode === "enabled") {
            expect(received).toContain("Independent advisory opinion")
            expect(received).toContain("Consider adding a casefold tie example")
          }
          const attachments = yield* host.command("native-attachment", id)
          expect(attachments).toMatchObject([
            {
              availability: mode === "corrupt-archive" ? expect.stringContaining("corrupt") : "complete",
              handoff: { sameSubject: true },
            },
          ])
        }
      }),
    60_000,
  )
