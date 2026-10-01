import { expect } from "bun:test"
import { Effect, Layer, LayerMap } from "effect"
import type { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { testEffect } from "../../core/test/lib/effect"
import { NativeAdvisoryStrength } from "../src/native-advisory-strength"

const it = testEffect(Layer.empty)
const ref = (variant?: string, id = "same-model") =>
  ModelV2.Ref.make({
    providerID: ProviderV2.ID.make("strength-test"),
    id: ModelV2.ID.make(id),
    ...(variant === undefined ? {} : { variant: ModelV2.VariantID.make(variant) }),
  })
const catalog = (input: { compatible?: boolean; default?: string; effort?: string; other?: boolean } = {}) =>
  ModelV2.Info.make({
    ...ref(),
    name: "Local configuration only",
    enabled: true,
    status: "active",
    api: {
      id: ModelV2.ID.make(input.other ? "other-upstream-model" : "same-upstream-model"),
      type: "aisdk",
      package: input.compatible ? "@ai-sdk/openai-compatible" : "@ai-sdk/openai",
      url: "http://127.0.0.1:1/v1",
    },
    request: {
      headers: {},
      body: input.effort
        ? input.compatible
          ? { reasoning_effort: input.effort }
          : { reasoning: { effort: input.effort } }
        : {},
      ...(input.default ? { variant: ModelV2.VariantID.make(input.default) } : {}),
    },
    variants: ["none", "minimal", "low", "medium", "high", "xhigh", "max"].map((effort) => ({
      id: ModelV2.VariantID.make(`preset-${effort}`),
      headers: {},
      body: input.compatible ? { reasoning_effort: effort } : { reasoning: { effort } },
    })),
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 4096, output: 512 },
    cost: [],
    time: { released: 0 },
  })

const assess = (input: {
  researcher?: ModelV2.Ref
  reviewer?: ModelV2.Ref
  catalog?: ModelV2.Info
  reviewerCatalog?: ModelV2.Info
  override?: string
  explicit?: boolean
  reason?: string
}) =>
  NativeAdvisoryStrength.check({
    researcher: {
      model: input.researcher ?? ref("preset-low"),
      location: { directory: AbsolutePath.make("/researcher") },
    },
    reviewer: { model: input.reviewer ?? ref("preset-high"), location: { directory: AbsolutePath.make("/reviewer") } },
    explicit: input.explicit ?? true,
    reason: input.reason,
  }).pipe(
    Effect.provideServiceEffect(
      LocationServiceMap.Service,
      LayerMap.make(
        (location: Location.Ref) =>
          // This configuration-only fixture supplies the real model resolver. Access to
          // any other Location service fails rather than starting an executor or provider.
          SessionRunnerModel.layerWith((session) =>
            SessionRunnerModel.resolve(
              session,
              location.directory === "/reviewer"
                ? (input.reviewerCatalog ?? input.catalog ?? catalog())
                : (input.catalog ?? catalog()),
              input.override && location.directory === "/reviewer"
                ? { type: "key", key: "fixture-only", metadata: { reasoning: { effort: input.override } } }
                : undefined,
            ),
          ) as ReturnType<LocationServiceMap.Service["Service"]["get"]>,
      ),
    ),
  )

for (const compatible of [false, true])
  it.effect(
    `compares actual ${compatible ? "compatible chat" : "Responses"} efforts, including intermediate ranks`,
    () =>
      Effect.gen(function* () {
        for (const [researcher, reviewer] of [
          ["none", "minimal"],
          ["low", "high"],
          ["high", "xhigh"],
          ["max", "max"],
        ]) {
          const result = yield* assess({
            catalog: catalog({ compatible }),
            researcher: ref(`preset-${researcher}`),
            reviewer: ref(`preset-${reviewer}`),
          })
          expect(result).toMatchObject({
            status: "confirmed",
            researcher: { effort: researcher },
            reviewer: { effort: reviewer },
          })
        }
        const error = yield* assess({
          catalog: catalog({ compatible }),
          researcher: ref("preset-high"),
          reviewer: ref("preset-low"),
        }).pipe(Effect.flip)
        expect(error.message).toContain("lower")
      }),
  )

for (const variant of [undefined, "default"])
  it.effect(`resolves ${variant ?? "omitted"} variants through the configured model default`, () =>
    Effect.gen(function* () {
      const result = yield* assess({
        catalog: catalog({ default: "preset-medium", effort: "low" }),
        researcher: ref(variant),
      })
      expect(result).toMatchObject({
        status: "confirmed",
        researcher: { effort: "medium" },
        reviewer: { effort: "high" },
      })
    }),
  )

it.effect("uses credential metadata after variant selection and never infers effort from variant names", () =>
  Effect.gen(function* () {
    const result = yield* assess({ researcher: ref("preset-high"), reviewer: ref("preset-low"), override: "xhigh" })
    expect(result).toMatchObject({ status: "confirmed", reviewer: { effort: "xhigh" } })
    const error = yield* assess({ researcher: ref("preset-high"), reviewer: ref("preset-max"), override: "low" }).pipe(
      Effect.flip,
    )
    expect(error.message).toContain("lower")
    expect(JSON.stringify(result)).not.toContain("fixture-only")
  }),
)

for (const input of [
  { researcher: ref(), catalog: catalog() },
  { researcher: ref(), catalog: catalog({ effort: "unspecified-upstream-setting" }) },
  { reviewer: ref("unavailable-variant") },
  { catalog: catalog(), reviewerCatalog: { ...catalog(), api: { ...catalog().api, url: "http://127.0.0.1:2/v1" } } },
])
  it.effect(
    `marks unresolved effective strength unconfirmed: ${JSON.stringify(input.researcher ?? input.reviewer ?? "route")}`,
    () =>
      Effect.gen(function* () {
        const result = yield* assess(input)
        expect(result.status).toBe("unconfirmed")
        expect(result.reason).toContain("unconfirmed")
      }),
  )

it.effect("requires explicit approval reasons across models, while resolving aliases before comparing", () =>
  Effect.gen(function* () {
    expect((yield* assess({ reviewerCatalog: catalog({ other: true }) }).pipe(Effect.flip)).message).toContain(
      "explicit model and reason",
    )
    const result = yield* assess({
      reviewerCatalog: catalog({ other: true }),
      reason: "Approved independent alternative",
    })
    expect(result).toMatchObject({
      status: "unconfirmed",
      reason: expect.stringContaining("Approved independent alternative"),
    })
    expect(
      (yield* assess({ reviewerCatalog: catalog({ other: true }), reason: "Approved", explicit: false }).pipe(
        Effect.flip,
      )).message,
    ).toContain("explicit")
    expect((yield* assess({ reviewer: ref("preset-high", "local-alias") })).status).toBe("confirmed")
  }),
)
