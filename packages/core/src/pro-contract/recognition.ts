export * as ProContractRecognition from "./recognition"

import { ProContract } from "@opencode-ai/schema/pro-contract"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Hash } from "../util/hash"
import { ProContractKernel } from "./kernel"
import type { ProContractEventTable } from "./sql"

export type View = ProContractKernel.Contract & { readonly recognition: ProContract.Recognition }
export type Validator = {
  readonly identity: string
  readonly validate: (input: {
    readonly contract: View
    readonly expected: ProContract.RecognitionTarget
    readonly evidenceHash: string
  }) => Effect.Effect<string | undefined>
}

// Registrations are immutable. A replacement must return a new identity and instance.
export interface Registry {
  readonly get: (profile: string) => Validator | undefined
}

export class Service extends Context.Service<Service, Registry>()("@opencode/ProContractRecognition") {}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.succeed(Service, { get: () => undefined }),
  deps: [],
})

export const Validators = Context.Reference<Registry | undefined>("@opencode/ProContract/Validators", {
  defaultValue: () => undefined,
})

export const native: Validator = {
  identity: "native:1",
  validate: (input) => Effect.succeed(input.evidenceHash ? undefined : "independent evidence hash is required"),
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

export function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b)
}

export function fingerprint(value: unknown) {
  return Hash.sha256(canonical(value))
}

// Replay only accepted events; rejected store guards need not exist in the pure reducer.
// Checking the entire chain prevents an older same-subject event masking a missing reset.
export function recover(
  events: ReadonlyArray<typeof ProContractEventTable.$inferSelect>,
  head: { readonly head_seq: number; readonly head_hash: string } | undefined,
  contracts: ReadonlyArray<ProContractKernel.Contract>,
) {
  const handoffs = new Map<string, string>()
  const petitions = new Map<string, number>()
  let state = ProContractKernel.empty
  let previous = "0".repeat(64)
  for (const [seq, event] of events.entries()) {
    if (
      event.seq !== seq ||
      event.previous_hash !== previous ||
      event.hash !== Hash.sha256(JSON.stringify([previous, seq, event.command, event.decision]))
    )
      return { handoffs, petitions, unavailable: "Contract history is incomplete or inconsistent" }
    previous = event.hash
    if (event.decision.type !== "accepted") continue
    const result = ProContractKernel.transition(state, event.command)
    if (result.decision.type !== "accepted")
      return { handoffs, petitions, unavailable: "Contract history cannot be replayed" }
    state = result.state
    Object.values(state.contracts).forEach((contract) => {
      if (!contract.handoff) handoffs.delete(contract.id)
      if (!contract.pendingRevision) petitions.delete(contract.id)
    })
    if (event.command.type === "report-ready" && state.contracts[event.contract_id]?.handoff)
      handoffs.set(event.contract_id, `pch_${event.hash}`)
    if (event.command.type === "petition-revision") petitions.set(event.contract_id, seq)
  }
  if ((head?.head_seq ?? -1) !== events.length - 1 || (head?.head_hash ?? "0".repeat(64)) !== previous)
    return { handoffs, petitions, unavailable: "Contract ledger head does not match history" }
  if (!same(state.contracts, Object.fromEntries(contracts.map((contract) => [contract.id, contract]))))
    return { handoffs, petitions, unavailable: "Contract projection does not match history" }
  return { handoffs, petitions, unavailable: undefined }
}

export function view(
  contract: ProContractKernel.Contract,
  context: ProContract.RecognitionContext | undefined,
  history: ReturnType<typeof recover>,
): View {
  const handoffID = history.handoffs.get(contract.id)
  const unavailable =
    history.unavailable ??
    (!context
      ? "Recognition context is missing"
      : context.target.revision !== contract.revision ||
          context.target.specHash !== contract.specHash ||
          context.target.handoffID !== handoffID
        ? "Recognition context does not match current phase"
        : undefined)
  return {
    ...contract,
    recognition: {
      context: unavailable ? undefined : context,
      handoff:
        !unavailable && contract.handoff && handoffID && context
          ? {
              revision: contract.revision,
              specHash: contract.specHash,
              subjectHash: contract.handoff.subjectHash,
              handoffID,
              contextHash: fingerprint({ contractID: contract.id, handoffID, context }),
            }
          : undefined,
      pending:
        !history.unavailable && contract.pendingRevision && history.petitions.has(contract.id)
          ? {
              revision: contract.revision,
              specHash: contract.pendingRevision.specHash,
              petition: history.petitions.get(contract.id)!,
            }
          : undefined,
      unavailable,
    },
  }
}

export function affected(state: ProContractKernel.State, id: ProContract.ID) {
  const ids = new Set<string>([id])
  const pending = [id]
  while (pending.length) {
    const dependency = pending.pop()
    Object.values(state.contracts)
      .filter(
        (item) => !ids.has(item.id) && item.spec.requires.some((requirement) => requirement.contractID === dependency),
      )
      .forEach((item) => {
        ids.add(item.id)
        pending.push(item.id)
      })
  }
  return ids
}

export function validSupport(
  views: ReadonlyArray<View>,
  support: NonNullable<ProContract.OperationReceipt["support"]>,
) {
  const byID = new Map(views.map((view) => [view.id, view]))
  const current = byID.get(support.contractID)
  if (!current || current.attestationID !== support.attestationID || !same(current.recognition.handoff, support.target))
    return false
  const visited = new Set<string>()
  const validity = new Map<string, boolean>()
  const valid = (contract: View): boolean => {
    const cached = validity.get(contract.id)
    if (cached !== undefined) return cached
    if (visited.has(contract.id)) return false
    if (
      contract.status !== "discharged" ||
      !contract.attestationID ||
      !contract.recognition.handoff ||
      !contract.recognition.context?.admitted
    )
      return false
    visited.add(contract.id)
    const result = contract.spec.requires.every((requirement) => {
      const dependency = byID.get(requirement.contractID)
      return dependency?.revision === requirement.revision && valid(dependency)
    })
    visited.delete(contract.id)
    validity.set(contract.id, result)
    return result
  }
  return valid(current)
}
