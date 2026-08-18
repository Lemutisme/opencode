export * as ProContractKernel from "./kernel"

import { ProContract } from "@opencode-ai/schema/pro-contract"
import { Hash } from "../util/hash"

export type Draft = {
  readonly id: ProContract.ID
  readonly scope: string
  readonly spec: ProContract.Spec
  readonly issuer: string
  readonly executor: string
  readonly specHash: string
}

export type Contract = Draft & {
  readonly revision: number
  readonly status: ProContract.Status
  readonly escalation?: { readonly reason: string; readonly time: number }
  readonly blocked?: ProContract.Blocked
  readonly handoff?: ProContract.Handoff
  readonly challenge?: ProContract.Challenge
  readonly pendingRevision?: {
    readonly spec: ProContract.Spec
    readonly specHash: string
    readonly reason: string
  }
  readonly attestationID?: ProContract.AttestationID
}

export type State = {
  readonly contracts: Readonly<Record<string, Contract>>
  readonly attestations: Readonly<Record<string, ProContract.Attestation>>
}

export type Command =
  | { readonly type: "issue"; readonly actor: string; readonly draft: Draft }
  | {
      readonly type: "petition-revision"
      readonly actor: string
      readonly contractID: ProContract.ID
      readonly spec: ProContract.Spec
      readonly specHash: string
      readonly reason: string
    }
  | {
      readonly type: "decide-revision"
      readonly actor: string
      readonly contractID: ProContract.ID
      readonly accept: boolean
    }
  | {
      readonly type: "discharge"
      readonly actor: string
      readonly contractID: ProContract.ID
      readonly attestation: Omit<ProContract.Attestation, "contractID">
    }
  | {
      readonly type: "activate"
      readonly actor: "institution"
      readonly contractID: ProContract.ID
      readonly revision: number
      readonly time: number
    }
  | { readonly type: "resume"; readonly actor: string; readonly contractID: ProContract.ID }
  | {
      readonly type: "challenge"
      readonly actor: string
      readonly contractID: ProContract.ID
      readonly challenge: Omit<ProContract.Challenge, "attestationID">
    }
  | {
      readonly type: "report-ready"
      readonly actor: "institution"
      readonly contractID: ProContract.ID
      readonly revision: number
      readonly summary: string
      readonly uncertainties: ReadonlyArray<string>
      readonly subjectHash: string
      readonly replay?: ProContract.ReplayResult
      readonly time: number
    }
  | {
      readonly type: "report-blocked"
      readonly actor: "institution"
      readonly contractID: ProContract.ID
      readonly revision: number
      readonly reason: string
      readonly time: number
    }
  | {
      readonly type: "escalate"
      readonly actor: "institution"
      readonly contractID: ProContract.ID
      readonly revision: number
      readonly reason: string
      readonly time: number
    }
  | { readonly type: "release"; readonly actor: string; readonly contractID: ProContract.ID; readonly reason: string }

export type Decision = { readonly type: "accepted" } | { readonly type: "rejected"; readonly reason: string }

export type Result = {
  readonly state: State
  readonly decision: Decision
  readonly event: { readonly command: Command; readonly decision: Decision }
}

export const empty: State = { contracts: {}, attestations: {} }

const institutionCommands = new Set<Command["type"]>(["activate", "report-ready", "report-blocked", "escalate"])

export function hashSpec(spec: ProContract.Spec) {
  return Hash.sha256(JSON.stringify(ProContract.Spec.make(spec)))
}

export function hashReplay(policy: ProContract.ReplayPolicy) {
  return Hash.sha256(JSON.stringify(ProContract.ReplayPolicy.make(policy)))
}

export function transition(state: State, command: Command): Result {
  const reject = (reason: string): Result => {
    const decision = { type: "rejected" as const, reason }
    return { state, decision, event: { command, decision } }
  }
  const accept = (next: State): Result => {
    const decision = { type: "accepted" as const }
    return { state: next, decision, event: { command, decision } }
  }

  if (command.type === "issue") {
    if (command.actor !== command.draft.issuer) return reject("only the issuer may issue the contract")
    if (command.draft.issuer === command.draft.executor) return reject("issuer and executor must be distinct")
    if (command.draft.specHash !== hashSpec(command.draft.spec)) return reject("specification hash does not match")
    const replay = command.draft.spec.evidence.replay
    if (replay && replay.checks.length === 0 && replay.protected.length === 0 && replay.artifacts.length === 0)
      return reject("replay policy is empty")
    if (replay?.checks.some((check) => check.argv.length === 0)) return reject("replay check command is empty")
    if (command.draft.spec.requires.filter((requirement) => requirement.policy).length > 1)
      return reject("contract may require only one execution policy")
    const existing = state.contracts[command.draft.id]
    if (existing) {
      if (
        existing.scope === command.draft.scope &&
        existing.specHash === command.draft.specHash &&
        existing.issuer === command.draft.issuer &&
        existing.executor === command.draft.executor
      )
        return accept(state)
      return reject("contract already exists")
    }
    for (const requirement of command.draft.spec.requires) {
      if (requirement.contractID === command.draft.id) return reject("contract cannot require itself")
      const dependency = state.contracts[requirement.contractID]
      if (!dependency) return reject(`required contract not found: ${requirement.contractID}`)
      if (dependency.issuer !== command.draft.issuer) return reject("required contract issuer does not match")
      if (dependency.revision !== requirement.revision) return reject("required contract revision does not match")
      if (dependency.status === "released") return reject("required contract was released")
      if (requirement.policy && !dependency.spec.policy) return reject("required contract defines no execution policy")
      if (requirement.policy && (dependency.status !== "discharged" || !dependency.attestationID))
        return reject("execution policy is not evidenced")
    }
    return accept({
      ...state,
      contracts: {
        ...state.contracts,
        [command.draft.id]: { ...command.draft, revision: 1, status: "dormant" },
      },
    })
  }

  const contract = state.contracts[command.contractID]
  if (!contract) return reject("contract not found")
  if (institutionCommands.has(command.type) && command.actor !== "institution")
    return reject("institution command requires institution actor")

  if (command.type === "challenge") {
    if (command.actor !== contract.issuer) return reject("only the issuer may challenge verification")
    if (contract.pendingRevision) return reject("verification cannot be challenged while a revision is pending")
    if (contract.status !== "discharged" && contract.status !== "verification")
      return reject("contract is not awaiting adjudication")
    if (command.challenge.revision !== contract.revision) return reject("challenge revision does not match")
    if (!contract.handoff || command.challenge.subjectHash !== contract.handoff.subjectHash)
      return reject("challenge subject does not match")
    if (command.challenge.disclosure === "executor" && !command.challenge.summary)
      return reject("executor-visible challenge requires a summary")
    if (command.challenge.disclosure === "sealed" && command.challenge.summary)
      return reject("sealed challenge cannot include a summary")
    const affected = new Set([contract.id])
    const pending = [contract.id]
    while (pending.length > 0) {
      const dependencyID = pending.pop()
      if (!dependencyID) continue
      Object.values(state.contracts)
        .filter(
          (item) =>
            !affected.has(item.id) && item.spec.requires.some((requirement) => requirement.contractID === dependencyID),
        )
        .forEach((item) => {
          affected.add(item.id)
          pending.push(item.id)
        })
    }
    return accept({
      ...state,
      contracts: Object.fromEntries(
        Object.entries(state.contracts).map(([id, item]) => {
          if (item.id === contract.id)
            return [
              id,
              {
                ...contract,
                status: command.challenge.disclosure === "sealed" ? "escalated" : "dormant",
                escalation:
                  command.challenge.disclosure === "sealed"
                    ? { reason: "Verification challenged; evidence is sealed", time: command.challenge.time }
                    : undefined,
                challenge: { ...command.challenge, attestationID: contract.attestationID },
                blocked: undefined,
                handoff: undefined,
                attestationID: undefined,
              },
            ]
          if (!affected.has(item.id) || item.status === "dormant" || item.status === "released") return [id, item]
          return [
            id,
            {
              ...item,
              status: "escalated",
              escalation: { reason: `Dependency support lost: ${contract.id}`, time: command.challenge.time },
              blocked: undefined,
              handoff: undefined,
              attestationID: undefined,
            },
          ]
        }),
      ),
    })
  }

  if (contract.status === "discharged" || contract.status === "released") return reject("contract is already settled")
  const dependent = Object.values(state.contracts).find(
    (item) =>
      item.status !== "discharged" &&
      item.status !== "released" &&
      item.spec.requires.some((requirement) => requirement.contractID === contract.id),
  )

  if (command.type === "report-ready") {
    if (contract.status !== "active") return reject("contract is not active")
    if (command.revision !== contract.revision) return reject("contract revision does not match")
    if (contract.pendingRevision) return reject("handoff is blocked while a revision petition is pending")
    const replay = contract.spec.evidence.replay
    if (replay && !command.replay) return reject("replay evidence is required")
    if (!replay && command.replay) return reject("replay evidence is not configured")
    if (replay && command.replay) {
      if (command.replay.policyHash !== hashReplay(replay)) return reject("replay policy does not match")
      if (command.replay.subjectHash !== command.subjectHash) return reject("replay subject does not match")
    }
    const challenge = command.replay && !command.replay.passed ? command.replay : undefined
    if (challenge)
      return accept({
        ...state,
        contracts: {
          ...state.contracts,
          [contract.id]: {
            ...contract,
            status: "dormant",
            escalation: undefined,
            blocked: undefined,
            handoff: undefined,
            challenge: {
              revision: contract.revision,
              subjectHash: command.subjectHash,
              evidenceHash: challenge.evidenceHash,
              disclosure: "executor",
              summary: challenge.summary,
              time: command.time,
            },
            attestationID: undefined,
          },
        },
      })
    return accept({
      ...state,
      contracts: {
        ...state.contracts,
        [contract.id]: {
          ...contract,
          status: "verification",
          escalation: undefined,
          blocked: undefined,
          challenge: undefined,
          handoff: {
            summary: command.summary,
            uncertainties: command.uncertainties,
            subjectHash: command.subjectHash,
            replay: command.replay,
            time: command.time,
          },
        },
      },
    })
  }

  if (command.type === "report-blocked") {
    if (contract.status !== "active") return reject("contract is not active")
    if (command.revision !== contract.revision) return reject("contract revision does not match")
    if (contract.pendingRevision) return reject("blocked work cannot be reported while a revision is pending")
    return accept({
      ...state,
      contracts: {
        ...state.contracts,
        [contract.id]: { ...contract, blocked: { reason: command.reason, time: command.time } },
      },
    })
  }

  if (command.type === "petition-revision") {
    if (command.actor !== contract.executor) return reject("only the executor may petition for revision")
    if (contract.pendingRevision) return reject("a revision petition is already pending")
    if (command.specHash === contract.specHash) return reject("the proposed revision is unchanged")
    if (command.specHash !== hashSpec(command.spec)) return reject("specification hash does not match")
    if (JSON.stringify(command.spec.requires) !== JSON.stringify(contract.spec.requires))
      return reject("contract dependencies cannot change during revision")
    return accept({
      ...state,
      contracts: {
        ...state.contracts,
        [contract.id]: {
          ...contract,
          pendingRevision: { spec: command.spec, specHash: command.specHash, reason: command.reason },
        },
      },
    })
  }

  if (command.type === "decide-revision") {
    if (command.actor !== contract.issuer) return reject("only the issuer may decide a revision")
    if (!contract.pendingRevision) return reject("no revision petition is pending")
    if (command.accept && dependent) return reject(`contract is required by outstanding contract: ${dependent.id}`)
    return accept({
      ...state,
      contracts: {
        ...state.contracts,
        [contract.id]: command.accept
          ? {
              ...contract,
              spec: contract.pendingRevision.spec,
              specHash: contract.pendingRevision.specHash,
              revision: contract.revision + 1,
              status: "dormant",
              escalation: undefined,
              blocked: undefined,
              handoff: undefined,
              pendingRevision: undefined,
              attestationID: undefined,
            }
          : { ...contract, pendingRevision: undefined },
      },
    })
  }

  if (command.type === "release") {
    if (command.actor !== contract.issuer) return reject("only the issuer may release the contract")
    if (dependent) return reject(`contract is required by outstanding contract: ${dependent.id}`)
    return accept({
      ...state,
      contracts: {
        ...state.contracts,
        [contract.id]: {
          ...contract,
          status: "released",
          escalation: undefined,
          blocked: undefined,
          handoff: undefined,
          challenge: undefined,
          pendingRevision: undefined,
        },
      },
    })
  }

  if (command.type === "activate") {
    if (contract.status !== "dormant") return reject("contract is not dormant")
    if (command.revision !== contract.revision) return reject("contract revision does not match")
    if (contract.pendingRevision) return reject("contract has a pending revision")
    if (command.time >= contract.spec.budget.deadline) return reject("contract deadline has passed")
    if (contract.spec.trigger.type === "time" && contract.spec.trigger.at > command.time)
      return reject("contract trigger is not ready")
    for (const requirement of contract.spec.requires) {
      const dependency = state.contracts[requirement.contractID]
      if (
        !dependency ||
        dependency.revision !== requirement.revision ||
        dependency.status !== "discharged" ||
        !dependency.attestationID
      )
        return reject(`required contract is not evidenced: ${requirement.contractID}`)
    }
    return accept({
      ...state,
      contracts: { ...state.contracts, [contract.id]: { ...contract, status: "active", escalation: undefined } },
    })
  }

  if (command.type === "resume") {
    if (command.actor !== contract.issuer) return reject("only the issuer may resume the contract")
    if (contract.status !== "escalated") return reject("contract is not escalated")
    if (contract.pendingRevision) return reject("contract has a pending revision")
    return accept({
      ...state,
      contracts: {
        ...state.contracts,
        [contract.id]: {
          ...contract,
          status: "dormant",
          escalation: undefined,
          blocked: contract.blocked ?? contract.escalation,
          handoff: undefined,
        },
      },
    })
  }

  if (command.type === "escalate") {
    if (command.revision !== contract.revision) return reject("contract revision does not match")
    return accept({
      ...state,
      contracts: {
        ...state.contracts,
        [contract.id]: {
          ...contract,
          status: "escalated",
          escalation: { reason: command.reason, time: command.time },
        },
      },
    })
  }

  if (command.type === "discharge") {
    if (contract.status !== "verification") return reject("contract is not awaiting verification")
    if (!contract.handoff) return reject("contract has not been handed off for verification")
    if (contract.pendingRevision) return reject("discharge is blocked while a revision petition is pending")
    if (state.attestations[command.attestation.id]) return reject("attestation already exists")
    if (command.attestation.revision !== contract.revision) return reject("attestation revision does not match")
    if (command.attestation.specHash !== contract.specHash) return reject("attestation specification does not match")
    if (command.attestation.subjectHash !== contract.handoff.subjectHash)
      return reject("attestation subject does not match")
    const replay = contract.spec.evidence.replay
    if (
      replay &&
      (!contract.handoff.replay?.passed ||
        contract.handoff.replay.policyHash !== hashReplay(replay) ||
        contract.handoff.replay.subjectHash !== contract.handoff.subjectHash)
    )
      return reject("replay evidence does not support discharge")
    if (replay && command.attestation.evidenceHash === contract.handoff.replay?.evidenceHash)
      return reject("principal evidence must be independent of replay")
    if (command.actor !== contract.issuer || command.attestation.verifierID !== contract.issuer)
      return reject("principal evidence requires issuer attestation")
    return accept({
      ...state,
      contracts: {
        ...state.contracts,
        [contract.id]: {
          ...contract,
          status: "discharged",
          escalation: undefined,
          blocked: undefined,
          pendingRevision: undefined,
          challenge: undefined,
          attestationID: command.attestation.id,
        },
      },
      attestations: {
        ...state.attestations,
        [command.attestation.id]: { ...command.attestation, contractID: contract.id },
      },
    })
  }

  return reject("unsupported command")
}

export function quiet(state: State, scope: string) {
  return Object.values(state.contracts).every(
    (contract) => contract.scope !== scope || contract.status === "discharged" || contract.status === "released",
  )
}
