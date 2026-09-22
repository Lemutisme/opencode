import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { BuiltInTools } from "@opencode-ai/core/tool/builtins"
import { ReferenceTools } from "@opencode-ai/core/tool/reference"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("production reference registration", () => {
  it.live("the production built-in composition consumes the host binding only at its candidate Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const candidate = path.join(tmp.path, "candidate")
          const other = path.join(tmp.path, "other")
          yield* Effect.promise(() => Promise.all([mkdir(candidate), mkdir(other)]))
          const settings = JSON.stringify({
            contractID: "pct_reference_production",
            candidateDirectory: candidate,
            executable: "/host/reference",
            directory: "/host",
            hash: "a".repeat(64),
            timeout: 120_000,
            attestation: "/host/attestation.json",
          })
          for (const item of [
            { location: candidate, settings },
            { location: other, settings },
            { location: candidate, settings: undefined },
          ]) {
            const names = yield* Effect.scoped(
              Effect.gen(function* () {
                const registry = yield* ToolRegistry.Service
                return (yield* registry.materialize()).definitions.map((tool) => tool.name)
              }).pipe(
                Effect.provide(
                  AppNodeBuilder.build(LayerNode.group([BuiltInTools.node, ToolRegistry.node]), [
                    [
                      ReferenceTools.bindingNode,
                      makeGlobalNode({
                        service: ReferenceTools.HostBinding,
                        deps: [],
                        layer: ReferenceTools.bindingLayer(item.settings),
                      }),
                    ],
                    [Location.node, Location.boundNode({ directory: AbsolutePath.make(item.location) })],
                    [Global.node, Global.layerWith({ data: path.join(tmp.path, "data") })],
                  ]),
                ),
              ),
            )
            const expected = item.location === candidate && item.settings !== undefined
            expect(names.includes("reference_run")).toBe(expected)
            expect(names.includes("reference_contrast")).toBe(expected)
            expect(names.includes("reference_read")).toBe(expected)
            expect(names).toContain("bash")
          }
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  test.each(["", "{}", "not json", JSON.stringify({ executable: "relative" })])(
    "malformed host binding fails closed: %s",
    async (setting) => {
      await expect(
        Effect.runPromise(ReferenceTools.HostBinding.pipe(Effect.provide(ReferenceTools.bindingLayer(setting)))),
      ).rejects.toThrow("Invalid OPENCODE_REFERENCE_BINDING")
    },
  )
})
