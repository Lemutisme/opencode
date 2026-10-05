import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractObservation } from "@opencode-ai/core/pro-contract/observation"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ReferenceTools } from "@opencode-ai/core/tool/reference"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const live = process.platform === "win32" ? it.live.skip : it.live

describe("host-configured reference tools", () => {
  live("exposes and checks the reference without allowing candidate substitution or budget resets", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const candidate = AbsolutePath.make(path.join(tmp.path, "candidate"))
          const reference = AbsolutePath.make(path.join(tmp.path, "reference"))
          const executable = AbsolutePath.make(path.join(reference, "program"))
          const source = "#!/bin/sh\ncat\n"
          const contractID = ProContract.ID.make("pct_reference_tools")
          yield* Effect.promise(async () => {
            await fs.mkdir(candidate)
            await fs.mkdir(reference)
            await fs.writeFile(executable, source, { mode: 0o500 })
            await fs.writeFile(path.join(candidate, "program"), "wrong reference")
          })
          yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const agents = yield* AgentV2.Service
            const contracts = yield* ProContract.Service
            const bindings = yield* ProContractOpenCode.Service
            const database = yield* Database.Service
            const location = yield* Location.Service
            yield* agents.transform((draft) =>
              draft.update(AgentV2.defaultID, (agent) => {
                agent.permissions.push({ action: "reference_*", resource: "*", effect: "allow" })
              }),
            )
            const base = ProContract.defaultSpec("Probe the identified reference", Date.now())
            yield* contracts.issue({
              id: contractID,
              scope: "reference",
              executor: "opencode",
              spec: {
                ...base,
                authority: ["reference.run"],
                budget: { ...base.budget, actions: 5 },
              },
            })
            yield* bindings.create({
              contractID,
              revision: 1,
              location: { directory: candidate },
              model: ModelV2.Ref.make({ id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") }),
              nextActionAt: 0,
            })
            yield* contracts.activate(contractID, 1, Date.now())
            const binding = yield* bindings.claim(contractID, Date.now())
            if (!binding) return yield* Effect.die("Expected claimed Contract")
            yield* database.db
              .insert(ProjectTable)
              .values({ id: location.project.id, worktree: candidate, sandboxes: [] })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)
            yield* database.db
              .insert(SessionTable)
              .values({
                id: binding.sessionID,
                project_id: location.project.id,
                directory: candidate,
                slug: "reference",
                title: "reference",
                version: "test",
              })
              .run()
              .pipe(Effect.orDie)

            const catalog = (yield* registry.materialize()).definitions
            expect(catalog.map((item) => item.name)).toEqual(["reference_run", "reference_read"])
            expect(catalog[0]?.description).toContain(Hash.sha256(Buffer.from(source)))
            const invoke = (name: string, input: unknown, sessionID = binding.sessionID) =>
              settleTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: crypto.randomUUID(), name, input },
              })
            const result = yield* invoke("reference_run", {
              args: [],
              stdin: "observed\n",
              executable: path.join(candidate, "program"),
            })
            expect(result.result.type, JSON.stringify(result.result)).not.toBe("error")
            const record = Schema.decodeUnknownSync(ProContractObservation.Recorded)(result.output?.structured)
            expect(record.receipt).toMatchObject({
              execution: "completed",
              exit: 0,
              targetExecution: "unobserved",
              subject: { kind: "reference", identity: Hash.sha256(Buffer.from(source)) },
              stdout: { hash: Hash.sha256(Buffer.from("observed\n")), complete: true },
            })
            expect(result.output?.structured).toMatchObject({ preview: { stdout: "observed\n", truncated: false } })
            const read = yield* invoke("reference_read", {
              handle: record.handle,
              stream: "stdout",
              offset: 0,
              length: 64,
            })
            expect(read.output?.structured).toMatchObject({
              content: { data: Buffer.from("observed\n").toString("base64") },
            })
            expect(
              (yield* invoke("reference_run", { args: [], stdin: "" }, SessionSchema.ID.make("ses_unbound"))).result
                .type,
            ).toBe("error")

            yield* Effect.promise(async () => {
              await fs.chmod(executable, 0o700)
              await fs.writeFile(executable, "#!/bin/sh\nprintf forged\n")
            })
            const forged = yield* invoke("reference_run", { args: [], stdin: "" })
            expect(forged.result).toMatchObject({
              type: "error",
              value: expect.stringContaining("identity validation"),
            })
            yield* Effect.promise(() => fs.writeFile(executable, source))
            yield* Effect.promise(async () => {
              await fs.rm(executable)
              await fs.symlink(path.join(candidate, "program"), executable)
            })
            expect((yield* invoke("reference_run", { args: [], stdin: "" })).result).toMatchObject({
              type: "error",
              value: expect.stringContaining("separate directories"),
            })
            yield* invoke("reference_read", { handle: record.handle, stream: "stdout", offset: 0, length: 64 })
            expect(
              (yield* invoke("reference_read", { handle: record.handle, stream: "stdout", offset: 0, length: 64 }))
                .result,
            ).toMatchObject({ type: "error", value: "Contract action budget exhausted" })
            expect(yield* bindings.get(contractID)).toMatchObject({ actionsUsed: 5, attempts: 1 })
            expect((yield* contracts.get(contractID))?.handoff).toBeUndefined()
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(
                LayerNode.group([
                  ReferenceTools.nodeWith({
                    contractID,
                    executable,
                    directory: reference,
                    hash: Hash.sha256(Buffer.from(source)),
                    timeout: 1000,
                  }),
                  ToolRegistry.node,
                  ProContract.node,
                  ProContractOpenCode.node,
                  Database.node,
                  AgentV2.node,
                  Location.node,
                ]),
                [
                  [Location.node, Location.boundNode(Location.Ref.make({ directory: candidate }))],
                  [Global.node, Global.layerWith({ data: path.join(tmp.path, "data") })],
                ],
              ),
            ),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
