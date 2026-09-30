import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LanguageModel, LLMClient } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { PromiseSdk } from "../src/promise"
import { ContractDelivery } from "./contract-delivery"
import { contractProfile, drainDelivery } from "./contract-profile"

for (const precedingSteps of [0, 1002])
  test(`native closure after ${precedingSteps} preceding steps`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "contract-native-"))
    const directory = path.join(root, "candidate")
    await fs.mkdir(directory)
    await Bun.write(path.join(root, "reference"), '#!/bin/sh\necho "expected:$1"\n')
    await fs.chmod(path.join(root, "reference"), 0o755)
    await Bun.write(path.join(directory, "source"), '#!/bin/sh\necho "wrong:$1"\n')
    await Bun.write(path.join(directory, "compile.sh"), "cp source executable\nchmod +x executable\n")
    await Bun.write(path.join(directory, "validate.sh"), "exit 0\n")
    const controller = new AbortController()
    const deadline = Date.now() + 180_000
    const delivery = await ContractDelivery.create({
      directory,
      state: path.join(root, "evidence"),
      reference: path.join(root, "reference"),
      deadline,
      signal: controller.signal,
      assertStanding: async () => undefined,
    })
    const llm = await Effect.runPromise(TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer())))
    await Effect.runPromise(
      llm.push(
        ...Array.from({ length: precedingSteps }, (_, index) =>
          TestLLM.tool(`prior-${index}`, "contract_delivery", { action: "status" }),
        ),
        TestLLM.text("Finished, validation passed", "premature"),
        TestLLM.tool("observe", "contract_delivery", { action: "probe", probe: { title: "argument", args: ["x"] } }),
        TestLLM.tool("bad-handoff", "contract_delivery", { action: "handoff", summary: "self validator passes" }),
        TestLLM.tool("patch", "patch", {
          patchText: `*** Begin Patch\n*** Update File: ${directory}/source\n@@\n-echo "wrong:$1"\n+echo "expected:$1"\n*** End Patch`,
        }),
        TestLLM.tool("glob", "glob", { pattern: "source" }),
        TestLLM.tool("grep", "grep", { pattern: "expected", path: "source" }),
        TestLLM.tool("read", "read", { path: path.join(directory, "source") }),
        TestLLM.tool("shell", "shell", { command: "test -f source", workdir: directory }),
        TestLLM.tool("handoff", "contract_delivery", {
          action: "handoff",
          summary: "Retained argument behavior repaired; other behavior is unproven",
        }),
        TestLLM.text("Submitted for independent verification", "final"),
      ),
    )
    const model = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "gpt-5.6-luna", provider: "openai", route: OpenAIChat.route }),
      {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 8_192 },
      },
    )
    const host = await PromiseSdk.create(
      {
        app: { name: "contract-test" },
        database: { path: path.join(root, "session.sqlite") },
        events: { persist: true },
        models: { fetch: false },
        fs: { filewatcher: false, fff: false },
        config: {
          directory: path.join(root, "config"),
          project: false,
          content: JSON.stringify({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }),
        },
        plugins: [contractProfile(delivery, deadline)],
      },
      {
        overrides: [
          llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
          SessionRunnerModel.node.replace(
            Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) }),
          ),
        ],
      },
    )
    try {
      const session = await host.sessions.create({ title: "Contract qualification", location: { directory } })
      await host.sessions.prompt({
        sessionID: session.id,
        text: "Implement the documented program.\n" + ContractDelivery.instructions,
      })
      expect(
        await drainDelivery({
          wait: async () => {
            await host.sessions.wait({ sessionID: session.id })
            const events = await Array.fromAsync(host.sessions.log({ sessionID: session.id }))
            const failures = events.filter(
              (event) => event.type === "session.tool.failed" || event.type === "session.execution.failed",
            )
            if (failures.length) throw new Error(JSON.stringify(failures))
          },
          prompt: (text) => host.sessions.prompt({ sessionID: session.id, text }),
          status: delivery.status,
          assertActive: async () => {
            if (Date.now() >= deadline) throw new Error("fixture deadline")
          },
        }),
      ).toMatchObject({ state: "ready", probes: 1 })
      const events = await Array.fromAsync(host.sessions.log({ sessionID: session.id }))
      expect(events.filter((event) => event.type === "session.step.started")).toHaveLength(precedingSteps + 10)
      expect(events.filter((event) => event.type === "session.inbox.enqueued")).toHaveLength(2)
      expect(events.filter((event) => event.type === "session.execution.started")).toHaveLength(2)
      expect(events.filter((event) => event.type === "session.tool.failed")).toEqual([])
      const called = events.filter((event) => event.type === "session.tool.input.started")
      expect(new Set(called.map((event) => event.data.name))).toEqual(
        new Set(["contract_delivery", "patch", "glob", "grep", "read", "shell"]),
      )
      const journal = await Bun.file(path.join(root, "evidence/delivery.jsonl")).text()
      expect(journal).toContain('"matches":false')
      expect(journal).toContain('"matches":true')
    } finally {
      controller.abort()
      await host.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 200_000)
