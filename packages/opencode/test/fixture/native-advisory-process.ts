import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import type { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import type { NativeAdvisoryStore } from "../../../sdk-next/src/native-advisory-store"
import { guidance } from "../../../sdk-next/src/native-advisory"
import { contractProcess } from "./contract-process"
import { pollWithTimeout } from "../lib/effect"

export const nativeAdvisoryProcess = Effect.fnUntraced(function* (checkpoints = false, responses = false) {
  const fixture = yield* contractProcess
  yield* Effect.promise(async () => {
    await Bun.write(path.join(fixture.directory, "answer.txt"), "captured native material\n")
    if (responses) {
      const file = Bun.file(path.join(fixture.directory, "opencode.json"))
      await Bun.write(file, (await file.text()).replace("@ai-sdk/openai-compatible", "@ai-sdk/openai"))
    }
    await Bun.write(
      path.join(fixture.storage, "config/opencode/opencode.json"),
      await Bun.file(path.join(fixture.directory, "opencode.json")).text(),
    )
  })
  const host = yield* fixture.startHost(false, { nativeAdvisory: true, nativeCheckpoints: checkpoints })
  const requests = (id: string) =>
    host.command("native-requests", id).pipe(
      Effect.map(
        (value) =>
          value as ReadonlyArray<
            NativeAdvisoryStore.Request & {
              deliveryState: { admission: boolean; inbox: string }
            }
          >,
      ),
    )
  const ready = (id: string) =>
    pollWithTimeout(
      fixture
        .ledger(id)
        .pipe(
          Effect.map((events) =>
            events.find((event) => event.command.type === "report-ready" && event.decision.type === "accepted"),
          ),
        ),
      "Native task did not submit",
      "30 seconds",
    ).pipe(Effect.tapError(() => host.log().pipe(Effect.tap((log) => Effect.sync(() => console.error(log))))))
  const issue = Effect.fnUntraced(function* (
    id: string,
    options?: {
      ordinary?: boolean
      blockedRouting?: ProContractOpenCode.Binding["blockedRouting"]
      time?: Partial<NativeAdvisoryStore.Configuration["time"]>
      reviewerModel?: { providerID: string; id: string }
      materials?: ReadonlyArray<string>
      nodes?: NativeAdvisoryStore.Configuration["nodes"]
      defaultNodes?: boolean
      replay?: NativeAdvisoryStore.Registration["task"]["evidence"]["replay"]
    },
  ) {
    const deadline = Date.now() + 6 * 60 * 60 * 1000
    const input = {
      id,
      scope: "native-advisory-integration",
      now: Date.now(),
      location: { directory: fixture.directory },
      model: { providerID: "local", id: "researcher" },
      ...(options?.blockedRouting === undefined ? {} : { blockedRouting: options.blockedRouting }),
      spec: {
        trigger: { type: "immediate" },
        goal: "Inspect the native material",
        brief: `Read answer.txt and deliver the approved native task.\n\n${guidance}`,
        requires: [],
        authority: ["filesystem.read", "filesystem.write", "process.execute"],
        budget: { deadline },
        evidence: { type: "principal", ...(options?.replay ? { replay: options.replay } : {}) },
        resolution: { retryDelay: 10 },
      },
    }
    const issued = yield* host.command(
      options?.ordinary ? "issue" : "native-issue",
      id,
      options?.ordinary
        ? input
        : {
            issue: input,
            configuration: {
              reviewer: {
                model: options?.reviewerModel ?? input.model,
                ...(options?.reviewerModel
                  ? { reason: "Explicit alternative for the unavailable-reviewer fixture" }
                  : {}),
                agent: "build",
                instructions: "Read the captured answer.txt and return concrete independent advice as ordinary text.",
              },
              // Existing regressions exercise the voluntary-only policy explicitly.
              ...(options?.defaultNodes ? {} : { nodes: options?.nodes ?? { version: 1, submission: false } }),
              materials: options?.materials ?? ["answer.txt"],
              evidence: [],
              time: { operationMs: 30_000, reviewMs: 10_000, cleanupMs: 60_000, resumeMs: 10_000, ...options?.time },
            },
          },
    )
    expect(issued).toMatchObject({
      decision: { type: "accepted" },
      ...(options?.ordinary ? {} : { review: { available: true } }),
    })
    yield* host.command("root-info", id)
    return input
  })
  const archive = Effect.fnUntraced(function* (id: string, extra: unknown = {}, source = host): Effect.fn.Return<void> {
    if (!process.env.OPENCODE_NATIVE_ADVISORY_ARTIFACTS) return
    const result = {
      binding: yield* fixture.binding(id),
      requests: yield* source.command("native-requests", id),
      root: yield* source.command("root-info", id),
      operations: yield* fixture.operations(id),
      extra,
    }
    const log = yield* source.log()
    yield* Effect.promise(async () => {
      const output = path.join(process.env.OPENCODE_NATIVE_ADVISORY_ARTIFACTS!, `${id}-${Date.now()}`)
      await Bun.write(path.join(output, "result.json"), JSON.stringify(result, null, 2))
      await Bun.write(path.join(output, "host.log"), log)
    })
  })
  return { ...fixture, host, requests, ready, issue, archive }
})
