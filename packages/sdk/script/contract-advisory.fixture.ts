// Shared local fixtures; every model response is scripted and every database is isolated.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LanguageModel, LLMClient } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Model, Plugin } from "@opencode/plugin"
import { Global } from "@opencode/util/global"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import { PromiseSdk } from "../src/promise"
import { ContractDelivery } from "./contract-delivery"
import { ContractAdvisory } from "./contract-advisory"
import { contractProfile, drainDelivery } from "./contract-profile"
import { idleAdvisory, initialPrompt, waitForResearcher, workerConfig } from "./contract-worker"

export const config = {
  nodes: { submission: true, blocked: true, idle: true },
  reviewMs: 10_000,
  afterMs: 0,
}
export const continuation =
  "The Session stopped, but Contract delivery is still open. No completion was accepted. Inspect contract_delivery status, retain and resolve public behavioral counterexamples, then request handoff. If you cannot resolve an obligation, report blocked with the concrete reason. The original deadline is unchanged. Hidden grading results are unavailable."
export const probe = { title: "documented argument", args: ["x"] }

export async function fixture(
  input: {
    root?: string
    git?: boolean
    config?: typeof config | false
    timing?: Parameters<typeof ContractAdvisory.create>[1]
    deadlineMs?: number
    started?: number
    adapt?: (host: PromiseSdk.Interface) => PromiseSdk.Interface
    reviewer?: TestLLM.Responder
    researcher?: TestLLM.Responder
  } = {},
) {
  const root = input.root ?? (await fs.mkdtemp(path.join(os.tmpdir(), "contract-advisory-")))
  await fs.mkdir(root, { recursive: true })
  const directory = path.join(root, "candidate")
  const state = path.join(root, "state")
  await fs.mkdir(directory)
  await Bun.write(path.join(root, "reference"), '#!/bin/sh\necho "expected:$1"\n')
  await fs.chmod(path.join(root, "reference"), 0o755)
  await fs.copyFile(path.join(root, "reference"), path.join(directory, "source"))
  await Bun.write(path.join(directory, "compile.sh"), "cp source executable\nchmod +x executable\n")
  await Bun.write(path.join(directory, "validate.sh"), "exit 0\n")
  if (input.git) {
    const git = Bun.spawn(["git", "init", "-q", directory], { stdout: "pipe", stderr: "pipe" })
    if (await git.exited) throw new Error(await new Response(git.stderr).text())
  }
  const controller = new AbortController()
  const sessionID = `ses_advisory_${crypto.randomUUID()}`
  const deadline = Date.now() + (input.deadlineMs ?? 120_000)
  const standing = { active: true }
  const assertActive = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    controller.signal.throwIfAborted()
    if (Date.now() >= deadline) throw new Error("Original Contract deadline reached")
    if (!standing.active) throw new Error("Contract authority is absent, stale, or expired")
  }
  const delivery = await ContractDelivery.create({
    directory,
    state,
    reference: path.join(root, "reference"),
    deadline,
    signal: controller.signal,
    assertStanding: assertActive,
  })
  const selected = input.config === false ? undefined : (input.config ?? config)
  const advisory = selected
    ? ContractAdvisory.create(
        {
          config: selected,
          host: (): PromiseSdk.Interface => api,
          sessionID,
          directory,
          state,
          model: { providerID: "openai", id: "gpt-5.6-luna", variant: "max" },
          prompt: "Implement the documented program.\nPreserve this exact task text.",
          deadline,
          started: input.started ?? Date.now(),
          signal: controller.signal,
          assertActive,
          probes: delivery.probes,
        },
        input.timing ?? { marginMs: 0, minimumMs: 1, settlementMs: 1_000 },
      )
    : undefined
  const calls = new Map<string, { execute: Info["execute"]; call: ToolContext }>()
  const llm = await Effect.runPromise(TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer())))
  const requests: { sessionID: string; time: number; request: Parameters<TestLLM.Responder>[0] }[] = []
  let researcher = input.researcher
  let reviewer = input.reviewer
  const model = SessionRunnerModel.resolved(
    LanguageModel.make({ id: "gpt-5.6-luna", provider: "openai", route: OpenAIChat.route }),
    {
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variant: Model.VariantID.make("max"),
      cost: [],
      limit: { context: 272000, output: 128000 },
    },
  )
  await Effect.runPromise(
    llm.serve((request) => {
      const identity = request.http?.headers?.["X-Session-Id"] ?? ""
      requests.push({ sessionID: identity, time: Date.now(), request })
      if (identity.includes("_review_"))
        return (
          reviewer?.(request) ??
          (request.messages.some((message) => message.role === "tool")
            ? TestLLM.text("Check the empty argument case in source:2; its runtime behavior is unverified.", "advice")
            : TestLLM.tool("review-read", "read", { path: path.join(directory, "source") }))
        )
      if (identity !== sessionID) throw new Error(`Unexpected model request: ${identity}`)
      return researcher?.(request) ?? TestLLM.text("Researcher stopped.", "researcher")
    }),
  )
  const host = await PromiseSdk.create(
    {
      app: { name: "contract-advisory-test" },
      database: { path: path.join(state, "session.sqlite") },
      events: { persist: true },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
      config: {
        directory: path.join(state, "config"),
        project: false,
        content: workerConfig({ model: "gpt-5.6-luna", effort: "max" }),
      },
      plugins: [
        contractProfile(delivery, deadline, advisory),
        Plugin.define({
          id: "advisory-test-capture",
          async setup(context) {
            await context.tool.transform((editor) => {
              for (const tool of editor.list())
                editor.update(tool.id, (current) => {
                  const execute = current.execute
                  current.execute = (value, call) => {
                    calls.set(tool.name, { execute, call })
                    return execute(value, call)
                  }
                })
            })
          },
        }),
      ],
    },
    {
      overrides: [
        Global.node.replace(
          Global.layerWith({
            home: path.join(root, "home"),
            data: path.join(state, "data"),
            cache: path.join(state, "cache"),
            config: path.join(state, "config"),
            state: path.join(state, "global-state"),
            tmp: path.join(root, "tmp"),
            bin: path.join(state, "bin"),
            log: path.join(state, "log"),
            repos: path.join(state, "repos"),
          }),
        ),
        llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
        SessionRunnerModel.node.replace(
          Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) }),
        ),
      ],
    },
  )
  const api = input.adapt?.(host) ?? host
  await host.sessions.create({
    id: sessionID,
    title: "Contract advisory test",
    location: { directory },
    model: model.ref,
  })
  const interrupt = () => {
    void host.sessions.interrupt({ sessionID }).catch(() => undefined)
  }
  controller.signal.addEventListener("abort", interrupt, { once: true })
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()))
  const events = (id = sessionID) => Array.fromAsync(host.sessions.log({ sessionID: id }))
  const journal = async () =>
    (await Bun.file(path.join(state, "advisory.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
  const prompt = (
    text = initialPrompt({
      prompt: "Implement the documented program.\nPreserve this exact task text.",
      advisory: selected,
    }),
  ) => host.sessions.prompt({ sessionID, text })
  const wait = () => waitForResearcher(host, sessionID, advisory)
  return {
    root,
    directory,
    state,
    host,
    api,
    sessionID,
    delivery,
    advisory,
    llm,
    requests,
    calls,
    controller,
    standing,
    deadline,
    assertActive,
    events,
    journal,
    prompt,
    wait,
    serve: (researcherResponse: TestLLM.Responder, reviewerResponse = reviewer) => {
      researcher = researcherResponse
      reviewer = reviewerResponse
    },
    drain: () =>
      drainDelivery({
        wait,
        status: delivery.status,
        assertActive,
        prompt,
        beforePrompt: idleAdvisory({ host, sessionID, delivery, advisory, assertActive }),
      }),
    async [Symbol.asyncDispose]() {
      controller.abort()
      await advisory?.settle()
      clearTimeout(timer)
      controller.signal.removeEventListener("abort", interrupt)
      await host.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

export function script(...responses: TestLLM.Response[]): TestLLM.Responder {
  let index = 0
  return () => {
    if (!responses[index]) throw new Error(`Unexpected scripted request ${index}`)
    return responses[index++]
  }
}

export async function toolText(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const event = (await f.events()).find((event) => event.type === "session.tool.success" && event.data.id === id)
  return event?.type === "session.tool.success"
    ? event.data.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    : ""
}
