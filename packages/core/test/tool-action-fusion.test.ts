import { describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer, Schedule, Schema, Scope } from "effect"
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
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ActionFusionTool } from "@opencode-ai/core/tool/action-fusion"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const withContract = <A, E, R>(
  options: { actions?: number; enabled?: string; authority?: string[]; deny?: string },
  body: (input: {
    directory: string
    registry: ToolRegistry.Interface
    bindings: ProContractOpenCode.Interface
    contracts: ProContract.Interface
    binding: ProContractOpenCode.Binding
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const agents = yield* AgentV2.Service
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const database = yield* Database.Service
        const location = yield* Location.Service
        yield* agents.transform((draft) =>
          draft.update(AgentV2.defaultID, (agent) => {
            agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
            if (options.deny) agent.permissions.push({ action: options.deny, resource: "*", effect: "deny" })
          }),
        )
        const id = ProContract.ID.make("pct_fusion_test")
        const base = ProContract.defaultSpec("Modify and check a candidate", Date.now())
        yield* contracts.issue({
          id,
          scope: "fusion",
          executor: "opencode",
          spec: {
            ...base,
            authority: options.authority ?? ["filesystem.read", "filesystem.write", "process.execute"],
            budget: { ...base.budget, actions: options.actions ?? 10 },
          },
        })
        yield* bindings.create({
          contractID: id,
          revision: 1,
          location: { directory: AbsolutePath.make(tmp.path) },
          model: ModelV2.Ref.make({ id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") }),
          nextActionAt: 0,
        })
        yield* contracts.activate(id, 1, Date.now())
        const binding = yield* bindings.claim(id, Date.now())
        if (!binding) return yield* Effect.die("Expected claimed Contract")
        yield* database.db
          .insert(ProjectTable)
          .values({ id: location.project.id, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* database.db
          .insert(SessionTable)
          .values({
            id: binding.sessionID,
            project_id: location.project.id,
            directory: tmp.path,
            slug: "fusion",
            title: "fusion",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        return yield* body({ directory: tmp.path, registry, bindings, contracts, binding })
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              ActionFusionTool.configuredNode,
              ToolRegistry.node,
              ProContract.node,
              ProContractOpenCode.node,
              Database.node,
              AgentV2.node,
              Location.node,
            ]),
            [
              [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }))],
              [Global.node, Global.layerWith({ data: path.join(tmp.path, "data") })],
              [ActionFusionTool.policyNode, ActionFusionTool.policyLayer(options.enabled ?? "1")],
            ],
          ),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const invoke = (
  registry: ToolRegistry.Interface,
  binding: ProContractOpenCode.Binding,
  input: unknown,
  id = "fusion",
) =>
  settleTool(registry, {
    sessionID: binding.sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id, name: ActionFusionTool.name, input },
  })

describe("Action Fusion", () => {
  it.live(
    "preserves interruption and terminates the running command",
    () =>
      withContract({}, (ctx) =>
        Effect.gen(function* () {
          const fiber = yield* invoke(ctx.registry, ctx.binding, {
            mutation: { tool: "write", input: { path: "kept", content: "candidate" } },
            run: { command: "echo $$ > command.pid; touch started; sleep 10; touch late", timeout: 20000 },
          }).pipe(Effect.forkChild)
          const started = yield* Effect.promise(() => Bun.file(path.join(ctx.directory, "started")).exists()).pipe(
            Effect.repeat({ while: (value) => !value, times: 200, schedule: Schedule.spaced("10 millis") }),
          )
          expect(started).toBe(true)
          const pid = Number(yield* Effect.promise(() => Bun.file(path.join(ctx.directory, "command.pid")).text()))
          yield* Fiber.interrupt(fiber)
          const outcome = yield* Fiber.await(fiber)
          expect(Exit.isFailure(outcome) && Cause.hasInterrupts(outcome.cause)).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(path.join(ctx.directory, "kept")).text())).toBe("candidate")
          expect(yield* Effect.promise(() => Bun.file(path.join(ctx.directory, "late")).exists())).toBe(false)
          if (process.platform === "linux")
            expect(yield* Effect.promise(() => Bun.file(`/proc/${pid}/stat`).exists())).toBe(false)
          expect((yield* ctx.bindings.get(ctx.binding.contractID))?.actionsUsed).toBe(2)
        }),
      ),
    10000,
  )

  it.live("ties subaction accounting to the canonical tool rather than its name", () =>
    withContract({}, (ctx) =>
      Effect.gen(function* () {
        yield* ctx.registry.register({
          [ActionFusionTool.name]: Tool.make({
            description: "Ordinary replacement",
            input: Schema.Unknown,
            output: Schema.String,
            execute: () => Effect.succeed("ordinary action"),
          }),
        })
        yield* invoke(ctx.registry, ctx.binding, {})
        expect((yield* ctx.bindings.get(ctx.binding.contractID))?.actionsUsed).toBe(1)
      }),
    ),
  )

  for (const tool of ["write", "edit", "apply_patch"] as const) {
    it.live(`runs ${tool} then real Bash with exactly two actions and no handoff`, () =>
      withContract({}, (ctx) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(ctx.directory, "value"), "before"))
          const input =
            tool === "write"
              ? { path: "value", content: "after" }
              : tool === "edit"
                ? { path: "value", oldString: "before", newString: "after" }
                : { patchText: "*** Begin Patch\n*** Update File: value\n@@\n-before\n+after\n*** End Patch" }
          const result = yield* invoke(ctx.registry, ctx.binding, {
            mutation: { tool, input },
            run: { command: 'test "$(cat value)" = after && printf checked' },
          })
          const output = Schema.decodeUnknownSync(ActionFusionTool.Output)(result.output?.structured)
          expect(output).toMatchObject({
            mutation: { status: "completed" },
            run: { status: "completed" },
            settled: false,
          })
          expect(JSON.stringify(output.run.result)).toContain("checked")
          expect(yield* ctx.bindings.get(ctx.binding.contractID)).toMatchObject({
            actionsUsed: 2,
            turnsUsed: 0,
            attempts: 1,
          })
          expect((yield* ctx.contracts.get(ctx.binding.contractID))?.handoff).toBeUndefined()
        }),
      ),
    )
  }

  it.live("skips Bash after a rejected patch", () =>
    withContract({}, (ctx) =>
      Effect.gen(function* () {
        const result = yield* invoke(ctx.registry, ctx.binding, {
          mutation: { tool: "apply_patch", input: { patchText: "not a patch" } },
          run: { command: "touch should-not-exist" },
        })
        expect(result.output?.structured).toMatchObject({ mutation: { status: "failed" }, run: { status: "skipped" } })
        expect(yield* Effect.promise(() => Bun.file(path.join(ctx.directory, "should-not-exist")).exists())).toBe(false)
        expect((yield* ctx.bindings.get(ctx.binding.contractID))?.actionsUsed).toBe(1)
      }),
    ),
  )

  it.live("checks the complete multi-file patch in one command", () =>
    withContract({}, (ctx) =>
      Effect.gen(function* () {
        const result = yield* invoke(ctx.registry, ctx.binding, {
          mutation: {
            tool: "apply_patch",
            input: {
              patchText: "*** Begin Patch\n*** Add File: one\n+first\n*** Add File: two\n+second\n*** End Patch",
            },
          },
          run: { command: 'test "$(cat one)" = first && test "$(cat two)" = second' },
        })
        expect(result.output?.structured).toMatchObject({
          mutation: { status: "completed", structured: { applied: [{ resource: "one" }, { resource: "two" }] } },
          run: { status: "completed" },
        })
        expect((yield* ctx.bindings.get(ctx.binding.contractID))?.actionsUsed).toBe(2)
      }),
    ),
  )

  it.live("preserves a partially applied patch and skips its command", () =>
    withContract({}, (ctx) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(ctx.directory, "exists"), "original"))
        const result = yield* invoke(ctx.registry, ctx.binding, {
          mutation: {
            tool: "apply_patch",
            input: {
              patchText:
                "*** Begin Patch\n*** Add File: first\n+retained\n*** Add File: exists\n+replacement\n*** End Patch",
            },
          },
          run: { command: "touch forbidden" },
        })
        expect(result.output?.structured).toMatchObject({ mutation: { status: "failed" }, run: { status: "skipped" } })
        expect(JSON.stringify(result.output?.structured)).toContain("partially applied")
        expect(yield* Effect.promise(() => Bun.file(path.join(ctx.directory, "first")).text())).toBe("retained\n")
        expect(yield* Effect.promise(() => Bun.file(path.join(ctx.directory, "exists")).text())).toBe("original")
        expect(yield* Effect.promise(() => Bun.file(path.join(ctx.directory, "forbidden")).exists())).toBe(false)
      }),
    ),
  )

  it.live("retains a successful mutation when the command exits nonzero", () =>
    withContract({}, (ctx) =>
      Effect.gen(function* () {
        const result = yield* invoke(ctx.registry, ctx.binding, {
          mutation: { tool: "write", input: { path: "kept", content: "candidate" } },
          run: { command: "printf 'failed assertion'; exit 7" },
        })
        expect(result.output?.structured).toMatchObject({
          mutation: { status: "completed" },
          run: { status: "failed", structured: { exit: 7 } },
        })
        expect(yield* Effect.promise(() => Bun.file(path.join(ctx.directory, "kept")).text())).toBe("candidate")
        expect((yield* ctx.bindings.get(ctx.binding.contractID))?.actionsUsed).toBe(2)
      }),
    ),
  )

  it.live("keeps timeout distinct from a passing command", () =>
    withContract({}, (ctx) =>
      Effect.gen(function* () {
        const result = yield* invoke(ctx.registry, ctx.binding, {
          mutation: { tool: "write", input: { path: "kept", content: "candidate" } },
          run: { command: "sleep 10", timeout: 30 },
        })
        expect(result.output?.structured).toMatchObject({
          mutation: { status: "completed" },
          run: { status: "failed", structured: { timeout: true } },
        })
      }),
    ),
  )

  it.live(
    "allows Bash to run beyond the mutation tool's one-minute limit",
    () =>
      withContract({}, (ctx) =>
        Effect.gen(function* () {
          const result = yield* invoke(ctx.registry, ctx.binding, {
            mutation: { tool: "write", input: { path: "kept", content: "candidate" } },
            run: { command: "sleep 61; printf completed", timeout: 65000 },
          })
          expect(result.output?.structured).toMatchObject({
            mutation: { status: "completed" },
            run: { status: "completed", structured: { exit: 0 } },
          })
          expect((yield* ctx.bindings.get(ctx.binding.contractID))?.actionsUsed).toBe(2)
        }),
      ),
    80000,
  )

  it.live("does not execute a second action when only one remains", () =>
    withContract({ actions: 1 }, (ctx) =>
      Effect.gen(function* () {
        const result = yield* invoke(ctx.registry, ctx.binding, {
          mutation: { tool: "write", input: { path: "kept", content: "candidate" } },
          run: { command: "touch forbidden" },
        })
        expect(result.output?.structured).toMatchObject({
          mutation: { status: "completed" },
          run: { status: "failed" },
        })
        expect(JSON.stringify(result.output?.structured)).toContain("action budget exhausted")
        expect(yield* Effect.promise(() => Bun.file(path.join(ctx.directory, "forbidden")).exists())).toBe(false)
        expect((yield* ctx.bindings.get(ctx.binding.contractID))?.actionsUsed).toBe(1)
      }),
    ),
  )

  for (const options of [{ deny: "bash" }, { deny: "edit" }, { authority: ["filesystem.write"] }]) {
    it.live(`rejects missing permission or delegation before mutation: ${JSON.stringify(options)}`, () =>
      withContract(options, (ctx) =>
        Effect.gen(function* () {
          const result = yield* invoke(ctx.registry, ctx.binding, {
            mutation: { tool: "write", input: { path: "forbidden", content: "bad" } },
            run: { command: "true" },
          })
          expect(result.result.type).toBe("error")
          expect(yield* Effect.promise(() => Bun.file(path.join(ctx.directory, "forbidden")).exists())).toBe(false)
          expect((yield* ctx.bindings.get(ctx.binding.contractID))?.actionsUsed).toBe(0)
        }),
      ),
    )
  }

  it.live("keeps the default catalog unchanged when disabled", () =>
    withContract({ enabled: "0" }, (ctx) =>
      Effect.gen(function* () {
        const catalog = yield* ctx.registry.materialize()
        expect(catalog.definitions.some((tool) => tool.name === ActionFusionTool.name)).toBe(false)
      }),
    ),
  )

  it.live("captures Bash identity before mutation and rejects replacement", () =>
    withContract({}, (ctx) =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        yield* ctx.registry.register({
          write: Tool.make({
            description: "Change tool placement while the first stage executes",
            input: Schema.Struct({ path: Schema.String, content: Schema.String }),
            output: Schema.String,
            execute: () =>
              ctx.registry
                .register({
                  bash: Tool.make({
                    description: "replacement",
                    input: Schema.Struct({ command: Schema.String }),
                    output: Schema.String,
                    execute: () => Effect.die("replacement must never execute"),
                  }),
                })
                .pipe(Effect.provideService(Scope.Scope, scope), Effect.as("mutation completed"), Effect.orDie),
          }),
        })
        const result = yield* invoke(ctx.registry, ctx.binding, {
          mutation: { tool: "write", input: { path: "unused", content: "unused" } },
          run: { command: "true" },
        })
        expect(result.output?.structured).toMatchObject({
          mutation: { status: "completed" },
          run: { status: "failed" },
        })
        expect(JSON.stringify(result.output?.structured)).toContain("Stale tool call: bash")
      }),
    ),
  )
})
