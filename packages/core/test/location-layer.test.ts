import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Equal, Fiber, Hash, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { define } from "@opencode-ai/plugin/v2/effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Catalog } from "@opencode-ai/core/catalog"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolDefinitions } from "./lib/tool"
import { FSUtil } from "../src/fs-util"
import { Credential } from "../src/credential"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { ModelsDev } from "../src/models-dev"
import { Npm } from "../src/npm"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { Reference } from "../src/reference"
import { SessionTable } from "../src/session/sql"
import { ToolRegistry } from "../src/tool/registry"
import { ApplicationTools } from "../src/tool/application-tools"
import { settleTool, toolIdentity } from "./lib/tool"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ApplicationTools.node,
      Database.node,
      EventV2.node,
      ProContract.node,
      ProContractOpenCode.node,
      LocationServiceMap.node,
    ]),
  ),
)

describe("LocationServiceMap", () => {
  it.live("reuses cached services for constructed and decoded location refs", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.scoped(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const directory = AbsolutePath.make(dir.path)
            const constructed = Location.Ref.make({ directory })
            const decoded = Schema.decodeUnknownSync(Location.Ref)({ directory })

            expect(constructed).toEqual({ directory, workspaceID: undefined })
            expect(decoded).toEqual(constructed)
            expect(Equal.equals(constructed, decoded)).toBe(true)
            expect(Hash.hash(constructed)).toBe(Hash.hash(decoded))
            expect(yield* locations.contextEffect(constructed)).toBe(yield* locations.contextEffect(decoded))
          }),
        ),
      ),
    ),
  )

  it.live("isolates location state while sharing location policy with catalog", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([blocked, allowed]) =>
        Effect.gen(function* () {
          yield* (yield* ApplicationTools.Service).register({
            application_context: Tool.make({
              description: "Read application context",
              input: Schema.Struct({}),
              output: Schema.Struct({ ok: Schema.Boolean }),
              execute: () => Effect.succeed({ ok: true }),
            }),
          })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(blocked.path, "opencode.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "test" }] },
              }),
            ),
          )

          const update = (directory: string) =>
            Effect.gen(function* () {
              yield* Reference.Service
              const catalog = yield* Catalog.Service
              yield* catalog.transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))
              return {
                providers: yield* catalog.provider.all(),
                tools: yield* toolDefinitions(yield* ToolRegistry.Service),
              }
            }).pipe(
              Effect.scoped,
              Effect.provide(
                LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(directory) })),
              ),
            )

          const blockedState = yield* update(blocked.path)
          expect(blockedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(false)
          expect(blockedState.tools.map((tool) => tool.name).sort()).toEqual([
            "application_context",
            "apply_patch",
            "bash",
            "contract_propose",
            "contract_propose_revision",
            "contract_report_blocked",
            "contract_report_ready",
            "edit",
            "glob",
            "grep",
            "question",
            "read",
            "skill",
            "todowrite",
            "webfetch",
            "websearch",
            "write",
          ])
          const allowedState = yield* update(allowed.path)
          expect(allowedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(true)
          expect(allowedState.tools.map((tool) => tool.name).sort()).toEqual([
            "application_context",
            "apply_patch",
            "bash",
            "contract_propose",
            "contract_propose_revision",
            "contract_report_blocked",
            "contract_report_ready",
            "edit",
            "glob",
            "grep",
            "question",
            "read",
            "skill",
            "todowrite",
            "webfetch",
            "websearch",
            "write",
          ])
        }),
      ),
    ),
  )

  it.live("ratifies model-authored Contract proposals before issuance", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessionID = SessionV2.ID.make("ses_contract_proposal")
          const { db } = yield* Database.Service
          yield* db
            .insert(ProjectTable)
            .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(SessionTable)
            .values({
              id: sessionID,
              project_id: ProjectV2.ID.global,
              slug: sessionID,
              directory: location.directory,
              title: "Contract proposal",
              version: "test",
              model: { providerID: "test", id: "test" },
            })
            .run()
            .pipe(Effect.orDie)

          yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const permissions = yield* PermissionV2.Service
            const agents = yield* AgentV2.Service
            const contracts = yield* ProContract.Service
            const bindings = yield* ProContractOpenCode.Service
            yield* agents.transform((draft) =>
              draft.update(AgentV2.defaultID, (agent) => {
                agent.permissions.push({ action: "contract_issue", resource: "*", effect: "ask" })
              }),
            )
            const proposal = ProContract.defaultSpec("Continue after this Session", Date.now())
            expect((yield* registry.materialize()).definitions.map((item) => item.name)).toContain("contract_propose")
            const execution = yield* settleTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-contract-propose",
                name: "contract_propose",
                input: { spec: proposal },
              },
            }).pipe(Effect.forkChild)
            yield* Effect.yieldNow
            const pending = yield* permissions.list()
            expect(pending).toHaveLength(1)
            const approval = pending[0]
            if (!approval) yield* Effect.die("Contract proposal did not request permission")
            expect(approval).toMatchObject({ action: "contract_issue", resources: [ProContract.hashSpec(proposal)] })
            const contractID = ProContract.ID.make(String(approval.metadata?.contractID))
            expect(yield* contracts.get(contractID)).toBeUndefined()

            yield* permissions.reply({ requestID: approval.id, reply: "once" })
            const settled = yield* Fiber.join(execution)

            expect(settled.output?.structured).toMatchObject({ contractID })
            expect(yield* contracts.get(contractID)).toMatchObject({ id: contractID, spec: proposal })
            expect(yield* bindings.get(contractID)).toMatchObject({ contractID, model: { id: "test" } })

            const rejected = yield* settleTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-contract-reject",
                name: "contract_propose",
                input: { spec: { ...proposal, goal: "Rejected proposal" } },
              },
            }).pipe(Effect.forkChild)
            yield* Effect.yieldNow
            const rejection = (yield* permissions.list())[0]
            if (!rejection) yield* Effect.die("Contract proposal did not request permission")
            const rejectedID = ProContract.ID.make(String(rejection.metadata?.contractID))
            yield* permissions.reply({ requestID: rejection.id, reply: "reject", message: "Continue normally" })
            expect(yield* Fiber.join(rejected)).toMatchObject({ result: { type: "error", value: "Continue normally" } })
            expect(yield* contracts.get(rejectedID)).toBeUndefined()
          }).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      ),
    ),
  )

  it.live("rejects an unavailable selected model during location model resolution", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(dir.path, "opencode.json"),
              JSON.stringify({
                providers: {
                  unavailable: {
                    name: "Unavailable",
                    api: { type: "native", settings: {} },
                    models: { chat: { disabled: true } },
                  },
                },
              }),
            ),
          )
          const failure = yield* SessionRunnerModel.Service.use((models) =>
            models.resolve(
              SessionV2.Info.make({
                id: SessionV2.ID.make("ses_unavailable_model"),
                projectID: ProjectV2.ID.global,
                title: "test",
                model: {
                  id: ModelV2.ID.make("chat"),
                  providerID: ProviderV2.ID.make("unavailable"),
                },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
                location,
              }),
            ),
          ).pipe(Effect.provide(LocationServiceMap.Service.get(location)), Effect.flip)

          expect(failure).toMatchObject({
            _tag: "SessionRunnerModel.ModelUnavailableError",
            providerID: "unavailable",
            modelID: "chat",
          })
        }),
      ),
    ),
  )

  it.live("installs public plugins into a location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const plugins = yield* PluginV2.Service
          const reviewer = define({
            id: "reviewer",
            effect: (ctx) =>
              ctx.agent
                .transform((agent) => {
                  agent.update("reviewer", (item) => {
                    item.description = "Reviews code"
                    item.mode = "subagent"
                  })
                })
                .pipe(Effect.asVoid),
          })
          yield* plugins.add(PluginV2.ID.make(reviewer.id), reviewer.effect)

          expect(yield* (yield* AgentV2.Service).get(AgentV2.ID.make("reviewer"))).toMatchObject({
            description: "Reviews code",
            mode: "subagent",
          })
        }).pipe(
          Effect.scoped,
          Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
        ),
      ),
    ),
  )
})
