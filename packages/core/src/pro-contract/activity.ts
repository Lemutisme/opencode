export * as ProContractActivity from "./activity"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export interface Interface {
  readonly has: (contractID: string) => boolean
  readonly run: <A, E, R>(contractID: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractActivity") {}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.sync(Service, () => {
    const counts = new Map<string, number>()
    return Service.of({
      has: (id) => counts.has(id),
      run: (id, effect) =>
        Effect.acquireUseRelease(
          Effect.sync(() => counts.set(id, (counts.get(id) ?? 0) + 1)),
          () => effect,
          () =>
            Effect.sync(() => {
              const remaining = (counts.get(id) ?? 1) - 1
              if (remaining === 0) counts.delete(id)
              else counts.set(id, remaining)
            }),
        ),
    })
  }),
  deps: [],
})
