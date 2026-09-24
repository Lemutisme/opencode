import { OpenCode } from "@opencode-ai/client/effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ProContractDelivery } from "@opencode-ai/core/pro-contract/delivery"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { ProContractDriver } from "@opencode-ai/core/pro-contract/driver"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { ExecutionPermit } from "@opencode-ai/core/session/execution-permit"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { ProContractActivity } from "@opencode-ai/core/pro-contract/activity"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { make } from "./contract-jobs"
import { createEmbeddedRoutes, createRoutes } from "@opencode-ai/server/routes"
import { Context, Effect, Layer, Scope } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"

export type Options = {
  readonly contractDrivers?: ReadonlyArray<ProContractDriver.Driver>
  readonly research?: boolean
  /** Explicitly enable authenticated principal endpoints for this trusted embedded host. */
  readonly principalPassword?: string
}

export const create = Effect.fn("OpenCode.create")(function* (options: Options = {}) {
  const researchModule = options.research ? (yield* Effect.promise(() => import("./research"))).Research : undefined
  const scope = yield* Scope.Scope
  const memoMap = yield* Layer.makeMemoMap
  const base: LayerNode.Replacements = [
    [SessionExecution.node, SessionExecutionLocal.node],
    [
      ProContractDriver.node,
      Layer.succeed(
        ProContractDriver.Service,
        ProContractDriver.make([
          ...(options.contractDrivers ?? []),
          ...(researchModule ? [researchModule.driver, researchModule.plannedDriver] : []),
        ]),
      ),
    ],
    ...(researchModule
      ? ([
          [ProContractDelivery.node, researchModule.deliveryNode],
          [ProContractRecognition.node, researchModule.validatorNode],
        ] as const)
      : []),
  ]
  // Host jobs and HTTP handlers must share the same Location permissions and runner instances.
  const replacements: LayerNode.Replacements = [...base, [LocationServiceMap.node, buildLocationServiceMap(base)]]
  const context = yield* Layer.buildWithMemoMap(
    AppNodeBuilder.build(
      LayerNode.group([
        ApplicationTools.node,
        PermissionSaved.node,
        ProContractOpenCode.node,
        ProContractJob.node,
        ExecutionPermit.node,
        SessionV2.node,
        ProContractActivity.node,
        LocationServiceMap.node,
        ...(researchModule ? [researchModule.node] : []),
      ]),
      replacements,
    ),
    memoMap,
    scope,
  )
  const tools = Context.get(context, ApplicationTools.Service)
  const permissions = Context.get(context, PermissionSaved.Service)
  const bindings = Context.get(context, ProContractOpenCode.Service)
  const contractJobs = yield* make.pipe(Effect.provideContext(context))
  const research = researchModule ? yield* researchModule.make.pipe(Effect.provideContext(context)) : undefined
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        (options.principalPassword
          ? createRoutes(options.principalPassword, replacements)
          : createEmbeddedRoutes(replacements)
        ).pipe(
          HttpRouter.provideRequest(Layer.succeed(PermissionSaved.Service, permissions)),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true, memoMap },
      ),
    ),
    (web) => Effect.promise(web.dispose),
  )
  const fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (options.principalPassword)
        request.headers.set("authorization", `Basic ${btoa(`opencode:${options.principalPassword}`)}`)
      return web.handler(request)
    },
    {
      preconnect: () => undefined,
    },
  ) satisfies typeof globalThis.fetch
  const client = yield* OpenCode.make({ baseUrl: "http://opencode.local" }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  )
  return {
    ...client,
    tools: { register: tools.register },
    contractJobs,
    research,
    contractExecution: {
      owner: bindings.owner,
      issue: bindings.issue,
      get: bindings.get,
      setAdmission: bindings.setAdmission,
    },
  }
})

export type Interface = Effect.Success<ReturnType<typeof create>>

export class Service extends Context.Service<Service, Interface>()("@opencode-ai/sdk-next/OpenCode") {}

export const layer = Layer.effect(Service, create())
