export * as ProContractDelivery from "./delivery"

import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import type { ProContract } from "../pro-contract"
import type { ProContractOpenCode } from "./open-code"
import type { SessionMessage } from "../session/message"

export class Denied extends Schema.TaggedErrorClass<Denied>()("ProContractDelivery.Denied", {
  message: Schema.String,
}) {}

export type Request = {
  readonly execution: ProContractOpenCode.Execution
  readonly call?: { readonly messageID: SessionMessage.ID; readonly callID: string }
  readonly summary: string
  readonly uncertainties: ReadonlyArray<string>
}

export type Node = {
  readonly execution: ProContractOpenCode.Execution
  readonly call: NonNullable<Request["call"]>
} & (
  | { readonly type: "submission"; readonly summary: string; readonly uncertainties: ReadonlyArray<string> }
  | { readonly type: "check"; readonly replay: ProContract.ReplayResult }
)

export type Handler = {
  readonly request: (input: Request) => Effect.Effect<void, Denied>
  readonly node?: (input: Node) => Effect.Effect<"intercept" | "continue", Denied | ProContractOpenCode.Unauthorized>
  readonly command?: (input: {
    readonly execution: ProContractOpenCode.Execution
    readonly call?: { readonly messageID: SessionMessage.ID; readonly callID: string }
    readonly kind: string
    readonly payload: unknown
  }) => Effect.Effect<unknown, Denied>
}

export interface Interface {
  readonly get: (profile: string) => Handler | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractDelivery") {}

// A non-native profile must install its own delivery boundary. Missing hosts cannot
// silently use synchronous native capture while their worker is still writing.
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.succeed(Service, { get: () => undefined }),
  deps: [],
})
