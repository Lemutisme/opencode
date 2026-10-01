export * as NativeAdvisoryStrength from "./native-advisory-strength"

import { DateTime, Effect, Result } from "effect"
import type { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { ModelV2 } from "@opencode-ai/core/model"
import { ProContractDelivery } from "@opencode-ai/core/pro-contract/delivery"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import type { NativeAdvisoryStore } from "./native-advisory-store"

const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

export const check = Effect.fn("NativeAdvisoryStrength.check")(function* (input: {
  readonly researcher: { readonly model: ModelV2.Ref; readonly location: Location.Ref }
  readonly reviewer: { readonly model: ModelV2.Ref; readonly location: Location.Ref }
  readonly explicit: boolean
  readonly reason?: string
}): Effect.fn.Return<NativeAdvisoryStore.Strength, ProContractDelivery.Denied, LocationServiceMap.Service> {
  const locations = yield* LocationServiceMap.Service
  const resolve = (selection: typeof input.researcher) =>
    Effect.gen(function* () {
      const models = yield* SessionRunnerModel.Service
      // A resolution-only description: no Session, input, turn or provider request is created.
      const model = yield* models.resolve(
        SessionV2.Info.make({
          id: SessionV2.ID.create(),
          projectID: ProjectV2.ID.global,
          title: "Native advisory configuration resolution",
          model: selection.model,
          location: selection.location,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        }),
      )
      const body = model.route.defaults.http?.body
      const reasoning = body?.reasoning
      const value =
        model.route.protocol === "openai-responses"
          ? reasoning && typeof reasoning === "object" && "effort" in reasoning
            ? reasoning.effort
            : undefined
          : model.route.protocol === "openai-compatible-chat" || model.route.protocol === "openai-chat"
            ? body?.reasoning_effort
            : undefined
      // Core resolves variant defaults and credential metadata before constructing this
      // route. Custom resolvers with further defaults cannot be certified from this body.
      const effort =
        typeof model.route.endpoint.baseURL === "string" &&
        !model.defaults &&
        typeof value === "string" &&
        efforts.includes(value)
          ? value
          : undefined
      return {
        provider: String(model.provider),
        model: String(model.id),
        effort,
        route: ProContractRecognition.fingerprint({
          protocol: model.route.protocol,
          baseURL: model.route.endpoint.baseURL,
        }),
      }
    }).pipe(Effect.provide(locations.get(selection.location)), Effect.result)
  const researcher = yield* resolve(input.researcher)
  const reviewer = yield* resolve(input.reviewer)
  const same =
    Result.isSuccess(researcher) && Result.isSuccess(reviewer)
      ? researcher.success.provider === reviewer.success.provider && researcher.success.model === reviewer.success.model
      : input.researcher.model.providerID === input.reviewer.model.providerID &&
        input.researcher.model.id === input.reviewer.model.id
  if (!same && (!input.explicit || !input.reason?.trim()))
    return yield* new ProContractDelivery.Denied({
      message: "A different reviewer model requires an explicit model and reason",
    })
  const resolved = {
    researcher: Result.isSuccess(researcher) ? researcher.success : undefined,
    reviewer: Result.isSuccess(reviewer) ? reviewer.success : undefined,
  }
  if (Result.isFailure(researcher) || Result.isFailure(reviewer))
    return {
      ...resolved,
      status: "unconfirmed",
      reason: "Strength unconfirmed: the effective Researcher or reviewer model could not be resolved",
    }
  if (!same)
    return {
      ...resolved,
      status: "unconfirmed",
      reason: `Strength unconfirmed across different models. Approved reason: ${input.reason}`,
    }
  if (!researcher.success.effort || !reviewer.success.effort || researcher.success.route !== reviewer.success.route)
    return {
      ...resolved,
      status: "unconfirmed",
      reason:
        "Strength unconfirmed: a supported effective effort or a common model route is unavailable; deployment overrides require separate verification",
    }
  if (efforts.indexOf(reviewer.success.effort) < efforts.indexOf(researcher.success.effort))
    return yield* new ProContractDelivery.Denied({
      message: "Reviewer effective reasoning effort is lower than the Researcher's",
    })
  return {
    ...resolved,
    status: "confirmed",
    reason:
      "Resolved SDK configuration uses the same model with reviewer effort no lower; any deployment gateway overrides must be independently verified",
  }
})
