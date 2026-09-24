export * as ProContractDriver from "./driver"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import type { ProContract } from "../pro-contract"
import type { ProContractOpenCode } from "./open-code"

export type View = {
  readonly binding: ProContractOpenCode.Binding
  readonly contract: ProContract.Contract
  readonly now: number
}

export type Outcome = {
  readonly type:
    | "completed"
    | "retryable-error"
    | "terminal-error"
    | "invalid-session"
    | "interrupted"
    | "dispatch-failed"
    | "blocked"
  readonly reason: string
}

export type Decision =
  | { readonly type: "wait" }
  | { readonly type: "retry"; readonly attempt: "same" | "new" }
  | { readonly type: "escalate" }

// These are finite, synchronous policy decisions. Host I/O belongs outside the
// store transaction and must return through the admission CAS boundary.
export type Driver = {
  readonly identity: string
  readonly activate: (view: View) => boolean
  readonly claim: (view: View) => boolean
  readonly heartbeat: (view: View) => boolean
  readonly outcome: (view: View & { readonly outcome: Outcome }) => Decision
}

export const native: Driver = Object.freeze({
  identity: "native:1",
  activate: () => true,
  claim: () => true,
  heartbeat: () => true,
  outcome: ({ outcome }) =>
    outcome.type === "terminal-error"
      ? { type: "escalate" }
      : {
          type: "retry",
          attempt: ["completed", "invalid-session", "blocked"].includes(outcome.type) ? "new" : "same",
        },
})

export interface Interface {
  readonly get: (identity: string) => Driver | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractDriver") {}

export function make(registrations: ReadonlyArray<Driver> = []): Interface {
  const entries = new Map([[native.identity, native]])
  registrations.forEach((driver) => {
    if (
      !driver.identity ||
      entries.has(driver.identity) ||
      [driver.activate, driver.claim, driver.heartbeat, driver.outcome].some((method) => typeof method !== "function")
    )
      throw new Error("Contract driver registration requires a unique identity and complete lifecycle methods")
    entries.set(driver.identity, Object.freeze({ ...driver }))
  })
  return Object.freeze({ get: (identity: string) => entries.get(identity) })
}

export const node = makeGlobalNode({ service: Service, layer: Layer.succeed(Service, make()), deps: [] })
