import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionObservationPack } from "@opencode-ai/core/session/observation-pack"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionObservationTools } from "@opencode-ai/core/tool/observation"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

function assistant(
  id: string,
  structured: Record<string, unknown> = { exit: 0, truncated: false },
  text = "first\n" + "中🙂\n".repeat(3000) + "last",
) {
  return Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id,
    type: "assistant",
    agent: "build",
    model: { id: "test", providerID: "test" },
    time: { created: 1, completed: 2 },
    finish: "tool-calls",
    content: [
      {
        type: "tool",
        id: `call-${id}`,
        name: "bash",
        time: { created: 1, completed: 2 },
        state: {
          status: "completed",
          input: { command: "probe" },
          structured,
          content: [
            { type: "text", text },
            { type: "text", text: "Command exited with code 0." },
          ],
        },
      },
    ],
  })
}

function placeholder(message: SessionMessage.Message) {
  if (message.type !== "assistant") throw new Error("Expected assistant")
  const tool = message.content[0]
  if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("Expected completed tool")
  const part = tool.state.content[0]
  if (part?.type !== "text") throw new Error("Expected text")
  return Schema.decodeUnknownSync(
    Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Schema.Struct({ recall: SessionObservationPack.ReadInput }))),
  )(part.text).recall
}

describe("Session observation packing", () => {
  test("ages from durable completed assistants, preserves originals, and is deterministic on resume", () => {
    const messages = [assistant("msg_first"), assistant("msg_second"), assistant("msg_third")]
    const original = JSON.stringify(messages)
    expect(SessionObservationPack.project(messages.slice(0, 2))).toEqual(messages.slice(0, 2))
    const projected = SessionObservationPack.project(messages)
    expect(projected.slice(1)).toEqual(messages.slice(1))
    expect(JSON.stringify(messages)).toBe(original)
    expect(SessionObservationPack.project(messages)).toEqual(projected)
    expect(JSON.stringify(projected[0]).length).toBeLessThan(4000)
    const tool = projected[0]?.type === "assistant" ? projected[0].content[0] : undefined
    if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("Expected completed tool")
    expect(tool.state.input).toEqual({ command: "probe" })
    expect(tool.state.structured).toEqual({ exit: 0, truncated: false })
    expect(tool.state.content[1]).toEqual({ type: "text", text: "Command exited with code 0." })
    expect(SessionObservationPack.read(messages[0]!, placeholder(projected[0]!))).toBeDefined()
    expect(
      SessionObservationPack.project([
        messages[0]!,
        { ...messages[1]!, time: { created: DateTime.makeUnsafe(1) } },
        messages[2]!,
      ]),
    ).toEqual([messages[0]!, { ...messages[1]!, time: { created: DateTime.makeUnsafe(1) } }, messages[2]!])
  })

  test("packs oversized structured-only results with an exact structured recall source", () => {
    const structuredOnly = (message: SessionMessage.Message) => {
      if (message.type !== "assistant") throw new Error("Expected assistant")
      const tool = message.content[0]
      if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("Expected completed tool")
      return {
        ...message,
        content: [{ ...tool, state: { ...tool.state, content: [] } }],
      }
    }
    const structured = { exit: 0, truncated: false, payload: "x".repeat(20_000) }
    const durable = structuredOnly(assistant("msg_structured", structured, ""))
    const projected = SessionObservationPack.project([durable, assistant("msg_structured_2"), assistant("msg_structured_3")])
    const input = placeholder(projected[0]!)
    const serialized = JSON.stringify(structured, null, 2)
    expect(input.source).toBe("structured")
    expect(input.block).toBe(0)

    const first = SessionObservationPack.read(durable, { ...input, length: 16_384 })
    if (!first) throw new Error("Missing structured observation page")
    const firstBytes = Buffer.from(first.data, first.encoding === "utf8" ? "utf8" : "base64")
    const second = SessionObservationPack.read(durable, {
      ...input,
      offset: first.nextOffset,
      length: 16_384,
    })
    if (!second) throw new Error("Missing structured observation tail")
    const secondBytes = Buffer.from(second.data, second.encoding === "utf8" ? "utf8" : "base64")
    expect(Buffer.concat([firstBytes, secondBytes]).equals(Buffer.from(serialized))).toBe(true)

    const small = structuredOnly(assistant("msg_structured_small", { exit: 0, truncated: false, payload: "short" }, ""))
    expect(
      SessionObservationPack.project([small, assistant("msg_structured_small_2"), assistant("msg_structured_small_3")])[0],
    ).toEqual(small)
  })

  test("recalls exact UTF-8 bytes including split characters, hidden failure lines and EOF", () => {
    const text = "🙂".repeat(3000) + "\ninner probe did not execute\n" + "中".repeat(3000)
    const message = assistant("msg_unicode", undefined, text)
    const input = placeholder(SessionObservationPack.project([message, assistant("msg_2"), assistant("msg_3")])[0]!)
    const pages = Array.from({ length: Math.ceil(Buffer.byteLength(text) / 997) }, (_, index) => {
      const page = SessionObservationPack.read(message, { ...input, offset: index * 997, length: 997 })
      if (!page) throw new Error("Missing page")
      expect(page.nextOffset).toBe(Math.min(Buffer.byteLength(text), index * 997 + 997))
      return Buffer.from(page.data, page.encoding === "utf8" ? "utf8" : "base64")
    })
    expect(Buffer.concat(pages).equals(Buffer.from(text))).toBe(true)
    expect(SessionObservationPack.read(message, { ...input, offset: Buffer.byteLength(text) })).toMatchObject({
      eof: true,
      data: "",
    })
    expect(SessionObservationPack.read(message, { ...input, hash: "0".repeat(64) })).toBeUndefined()
    expect(SessionObservationPack.read(message, { ...input, offset: -1 })).toBeUndefined()
    expect(SessionObservationPack.read(message, { ...input, length: 16385 })).toBeUndefined()
    expect(SessionObservationPack.read(message, { ...input, callID: "foreign-call" })).toBeUndefined()
    expect(SessionObservationPack.read(assistant("msg_unicode", undefined, text + "changed"), input)).toBeUndefined()
  })

  test("leaves failure, truncated, unknown, running, media and evidence outputs untouched", () => {
    const base = assistant("msg_protected")
    const tool = base.content[0]
    if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("Expected tool")
    const cases: SessionMessage.AssistantTool[] = [
      ...[{ exit: 1, truncated: false }, { exit: 0, truncated: true }, { timeout: true }, {}].map((structured) => ({
        ...tool,
        state: { ...tool.state, structured },
      })),
      ...[
        "contract_check",
        "contract_report_ready",
        "reference_run",
        "reference_read",
        SessionObservationPack.toolName,
      ].map((name) => ({ ...tool, name })),
      { ...tool, provider: { executed: true } },
      { ...tool, time: { ...tool.time, pruned: DateTime.makeUnsafe(3) } },
      { ...tool, state: { status: "running", input: {}, structured: {}, content: tool.state.content } },
      {
        ...tool,
        state: {
          status: "error",
          input: {},
          structured: {},
          error: { type: "unknown", message: "failed" },
          content: tool.state.content,
        },
      },
      {
        ...tool,
        state: {
          ...tool.state,
          content: [...tool.state.content, { type: "file", uri: "data:image/png;base64,eA==", mime: "image/png" }],
        },
      },
    ]
    cases.forEach((item) => {
      const messages = [{ ...base, content: [item] }, assistant("msg_2"), assistant("msg_3")]
      expect(SessionObservationPack.project(messages)).toEqual(messages)
    })
  })

  test("keeps escape-heavy recall bounded and does not expand text with oversized coordinates", () => {
    const message = assistant("msg_controls", undefined, "\u0000".repeat(16384))
    const input = placeholder(SessionObservationPack.project([message, assistant("msg_2"), assistant("msg_3")])[0]!)
    const page = SessionObservationPack.read(message, { ...input, length: 16384 })
    expect(page?.encoding).toBe("base64")
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(24 * 1024)
    expect(Buffer.from(page!.data, "base64").equals(Buffer.alloc(16384))).toBe(true)
    const oversized = { ...message, id: SessionMessage.ID.make("msg_" + "x".repeat(20000)) }
    expect(SessionObservationPack.project([oversized, assistant("msg_2"), assistant("msg_3")])[0]).toEqual(oversized)
  })

  test("vetoes explicit inner diagnostics despite exit zero and can still recall handles issued by earlier policies", () => {
    ;["Error:", "SyntaxError:", "FAILED", "FAIL:", "Failure:", "fatal:", "Panic in", "Traceback"].forEach((marker) => {
      const text = "start\n" + "x".repeat(12000) + `\n${marker} inner probe did not execute\n` + "end\n".repeat(200)
      const message = assistant("msg_inner", undefined, text)
      const messages = [message, assistant("msg_2"), assistant("msg_3")]
      expect(SessionObservationPack.project(messages)).toEqual(messages)
      expect(
        SessionObservationPack.read(message, {
          messageID: message.id,
          callID: "call-msg_inner",
          block: 0,
          hash: Hash.sha256(text),
          offset: 0,
          length: 16384,
        })?.data,
      ).toBe(text)
    })
  })
})

const it = testEffect(Layer.empty)
it.live("recalls durable text after compaction, rejects foreign Sessions and spends the shared Contract budget", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const location = yield* Location.Service
        const registry = yield* ToolRegistry.Service
        const agents = yield* AgentV2.Service
        const store = yield* SessionStore.Service
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const contractID = ProContract.ID.make("pct_observation_budget")
        const spec = ProContract.defaultSpec("Recall prior observations", Date.now())
        yield* contracts.issue({
          id: contractID,
          scope: "observations",
          executor: "opencode",
          spec: { ...spec, budget: { ...spec.budget, actions: 3 } },
        })
        const binding = yield* bindings.create({
          contractID,
          revision: 1,
          location: { directory: AbsolutePath.make(tmp.path) },
          model: ModelV2.Ref.make({ id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") }),
          nextActionAt: 0,
        })
        yield* contracts.activate(contractID, 1, Date.now())
        yield* bindings.claim(contractID, Date.now())
        const id = binding.sessionID
        const message = assistant("msg_durable")
        const recall = placeholder(
          SessionObservationPack.project([message, assistant("msg_2"), assistant("msg_3")])[0]!,
        )
        yield* agents.transform((draft) =>
          draft.update(AgentV2.defaultID, (agent) => {
            agent.permissions.push({ action: SessionObservationPack.toolName, resource: "*", effect: "allow" })
          }),
        )
        yield* db
          .insert(ProjectTable)
          .values({ id: location.project.id, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id,
            project_id: location.project.id,
            directory: tmp.path,
            title: "observations",
            slug: "observations",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionMessageTable)
          .values({
            session_id: id,
            seq: 1,
            id: message.id,
            type: "assistant",
            data: Schema.encodeSync(SessionMessage.Assistant)(message),
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionMessageTable)
          .values({
            session_id: id,
            seq: 2,
            id: SessionMessage.ID.make("msg_compacted"),
            type: "compaction",
            data: Schema.encodeSync(SessionMessage.Compaction)({
              id: SessionMessage.ID.make("msg_compacted"),
              type: "compaction",
              time: { created: DateTime.makeUnsafe(3) },
              reason: "auto",
              summary: "Older results have stable recall coordinates",
              recent: "",
            }),
          })
          .run()
          .pipe(Effect.orDie)
        expect((yield* store.context(id)).map((entry) => entry.type)).toEqual(["compaction"])
        const invoke = (sessionID: SessionSchema.ID, input = recall) =>
          settleTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: crypto.randomUUID(), name: SessionObservationPack.toolName, input },
          })
        const result = yield* invoke(id)
        expect(result.output?.structured).toMatchObject({ hash: recall.hash, offset: 0, nextOffset: 4096 })
        expect((yield* invoke(SessionSchema.ID.make("ses_foreign"))).result.type).toBe("error")
        expect((yield* invoke(id, { ...recall, hash: Hash.sha256("wrong") })).result.type).toBe("error")
        expect((yield* store.message(message.id))?.message).toEqual(message)
        expect((yield* invoke(id)).result.type).not.toBe("error")
        expect((yield* invoke(id)).result).toEqual({ type: "error", value: "Contract action budget exhausted" })
        expect(yield* bindings.get(contractID)).toMatchObject({ actionsUsed: 3, turnsUsed: 0, attempts: 1 })
        expect((yield* contracts.get(contractID))?.handoff).toBeUndefined()
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              SessionObservationTools.node,
              ToolRegistry.node,
              AgentV2.node,
              Database.node,
              Location.node,
              SessionStore.node,
              ProContract.node,
              ProContractOpenCode.node,
            ]),
            [
              [Global.node, Global.layerWith({ data: tmp.path })],
              [Location.node, Location.boundNode({ directory: AbsolutePath.make(tmp.path) })],
            ],
          ),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)
