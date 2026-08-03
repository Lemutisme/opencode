import { describe, expect, test } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ProContractScheduler } from "@opencode-ai/core/pro-contract/scheduler"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionInputTable } from "@opencode-ai/core/session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { AgentV2 } from "@opencode-ai/core/agent"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationError, LocationServices } from "@opencode-ai/core/location-services"
import { ProjectV2 } from "@opencode-ai/core/project"
import { DateTime, Duration, Effect, Layer, LayerMap } from "effect"
import { eq } from "drizzle-orm"
import * as TestClock from "effect/testing/TestClock"
import { testEffect } from "./lib/effect"

const contractID = ProContract.ID.make("pct_test")
const executionModel = ModelV2.Ref.make({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test") })
const spec = ProContract.defaultSpec("Ship the verified change", 0)
const subjectHash = "subject-1"
const draft = {
  id: contractID,
  scope: "project-1",
  spec,
  issuer: "user-1",
  executor: "opencode",
  specHash: ProContract.hashSpec(spec),
} satisfies ProContract.Draft
const issue = { type: "issue", actor: draft.issuer, draft } as const

describe("ProContract kernel", () => {
  test("conserves an obligation until evidenced discharge", () => {
    const issued = ProContract.transition(ProContract.empty, issue)
    expect(issued.state.contracts[contractID]?.status).toBe("dormant")
    expect(ProContract.quiet(issued.state, draft.scope)).toBe(false)

    const activated = ProContract.transition(issued.state, {
      type: "activate",
      actor: "institution",
      contractID,
      revision: 1,
      time: 0,
    })
    const attestationID = ProContract.AttestationID.make("pca_test")
    const discharge = {
      type: "discharge",
      actor: draft.issuer,
      contractID,
      attestation: {
        id: attestationID,
        revision: 1,
        specHash: draft.specHash,
        subjectHash,
        evidenceHash: "evidence-1",
        verifierID: draft.issuer,
        class: "principal",
      },
    } as const
    expect(ProContract.transition(activated.state, discharge).decision).toEqual({
      type: "rejected",
      reason: "contract is not awaiting verification",
    })
    const handedOff = ProContract.transition(activated.state, {
      type: "report-ready",
      actor: "institution",
      contractID,
      revision: 1,
      summary: "candidate complete",
      uncertainties: [],
      subjectHash,
      time: 0,
    })
    expect(handedOff.state.contracts[contractID]).toMatchObject({ status: "verification", escalation: undefined })
    expect(ProContract.quiet(handedOff.state, draft.scope)).toBe(false)
    expect(
      ProContract.transition(handedOff.state, {
        ...discharge,
        attestation: {
          ...discharge.attestation,
          id: ProContract.AttestationID.make("pca_wrong_subject"),
          subjectHash: "different-subject",
        },
      }).decision,
    ).toEqual({ type: "rejected", reason: "attestation subject does not match" })
    const discharged = ProContract.transition(handedOff.state, discharge)

    expect(discharged.state.contracts[contractID]).toMatchObject({ status: "discharged", attestationID })
    expect(discharged.state.contracts[contractID]?.escalation).toBeUndefined()
    expect(ProContract.quiet(discharged.state, draft.scope)).toBe(true)
  })

  test("reconciles an exact issue retry without duplicating the duty", () => {
    const issued = ProContract.transition(ProContract.empty, issue)
    const retried = ProContract.transition(issued.state, issue)
    const changedSpec = { ...spec, brief: "A different handoff brief" }
    const changed = ProContract.transition(issued.state, {
      ...issue,
      draft: { ...draft, spec: changedSpec, specHash: ProContract.hashSpec(changedSpec) },
    })

    expect(retried.decision).toEqual({ type: "accepted" })
    expect(retried.state).toBe(issued.state)
    expect(ProContract.hashSpec(changedSpec)).not.toBe(draft.specHash)
    expect(changed.decision).toEqual({ type: "rejected", reason: "contract already exists" })
  })

  test("admits only backward revision-bound requirements", () => {
    const upstreamID = ProContract.ID.make("pct_upstream")
    const upstreamDraft = { ...draft, id: upstreamID, specHash: ProContract.hashSpec(spec) }
    const upstream = ProContract.transition(ProContract.empty, {
      type: "issue",
      actor: upstreamDraft.issuer,
      draft: upstreamDraft,
    })
    const childSpec = { ...spec, requires: [{ contractID: upstreamID, revision: 1 }] }
    const childDraft = { ...draft, spec: childSpec, specHash: ProContract.hashSpec(childSpec) }

    const admitted = ProContract.transition(upstream.state, {
      type: "issue",
      actor: childDraft.issuer,
      draft: childDraft,
    })
    expect(admitted.decision).toEqual({ type: "accepted" })
    expect(
      ProContract.transition(admitted.state, {
        type: "activate",
        actor: "institution",
        contractID,
        revision: 1,
        time: 0,
      }).decision,
    ).toEqual({ type: "rejected", reason: `required contract is not evidenced: ${upstreamID}` })
    expect(
      ProContract.transition(admitted.state, {
        type: "release",
        actor: upstreamDraft.issuer,
        contractID: upstreamID,
        reason: "replace upstream",
      }).decision,
    ).toEqual({ type: "rejected", reason: `contract is required by outstanding contract: ${contractID}` })
    const escalated = ProContract.transition(admitted.state, {
      type: "escalate",
      actor: "institution",
      contractID: upstreamID,
      revision: 1,
      reason: "retry upstream",
      time: 0,
    })
    expect(
      ProContract.transition(escalated.state, {
        type: "resume",
        actor: upstreamDraft.issuer,
        contractID: upstreamID,
      }).decision,
    ).toEqual({ type: "rejected", reason: `contract is required by outstanding contract: ${contractID}` })
    const upstreamRevision = { ...spec, goal: "Revise upstream" }
    const petitioned = ProContract.transition(admitted.state, {
      type: "petition-revision",
      actor: upstreamDraft.executor,
      contractID: upstreamID,
      spec: upstreamRevision,
      specHash: ProContract.hashSpec(upstreamRevision),
      reason: "replace upstream",
    })
    expect(
      ProContract.transition(petitioned.state, {
        type: "decide-revision",
        actor: upstreamDraft.issuer,
        contractID: upstreamID,
        accept: true,
      }).decision,
    ).toEqual({ type: "rejected", reason: `contract is required by outstanding contract: ${contractID}` })
    expect(
      ProContract.transition(ProContract.empty, { type: "issue", actor: childDraft.issuer, draft: childDraft })
        .decision,
    ).toEqual({ type: "rejected", reason: `required contract not found: ${upstreamID}` })

    const selfSpec = { ...spec, requires: [{ contractID, revision: 1 }] }
    const selfDraft = { ...draft, spec: selfSpec, specHash: ProContract.hashSpec(selfSpec) }
    expect(
      ProContract.transition(ProContract.empty, { type: "issue", actor: selfDraft.issuer, draft: selfDraft }).decision,
    ).toEqual({ type: "rejected", reason: "contract cannot require itself" })

    const released = ProContract.transition(upstream.state, {
      type: "release",
      actor: upstreamDraft.issuer,
      contractID: upstreamID,
      reason: "cancel upstream",
    })
    expect(
      ProContract.transition(released.state, { type: "issue", actor: childDraft.issuer, draft: childDraft }).decision,
    ).toEqual({ type: "rejected", reason: "required contract was released" })
  })

  test("rejects executor testimony and preserves authoritative state", () => {
    const activated = ProContract.transition(ProContract.transition(ProContract.empty, issue).state, {
      type: "activate",
      actor: "institution",
      contractID,
      revision: 1,
      time: 0,
    })
    const handedOff = ProContract.transition(activated.state, {
      type: "report-ready",
      actor: "institution",
      contractID,
      revision: 1,
      summary: "candidate complete",
      uncertainties: [],
      subjectHash,
      time: 0,
    })
    const command = {
      type: "discharge",
      actor: draft.executor,
      contractID,
      attestation: {
        id: ProContract.AttestationID.make("pca_forged"),
        revision: 1,
        specHash: draft.specHash,
        subjectHash,
        evidenceHash: "forged",
        verifierID: draft.executor,
        class: "principal",
      },
    } as const
    const result = ProContract.transition(handedOff.state, command)

    expect(result.decision).toEqual({ type: "rejected", reason: "principal evidence requires issuer attestation" })
    expect(result.state).toBe(handedOff.state)
    expect(result.event).toEqual({ command, decision: result.decision })
  })

  test("accepts revision only through issuer decision", () => {
    const issued = ProContract.transition(ProContract.empty, issue)
    const nextSpec = { ...spec, goal: "Ship the revised verified change" }
    const petitioned = ProContract.transition(issued.state, {
      type: "petition-revision",
      actor: draft.executor,
      contractID,
      spec: nextSpec,
      specHash: ProContract.hashSpec(nextSpec),
      reason: "goal changed",
    })
    expect(
      ProContract.transition(petitioned.state, {
        type: "activate",
        actor: "institution",
        contractID,
        revision: 1,
        time: 0,
      }).decision,
    ).toEqual({ type: "rejected", reason: "contract has a pending revision" })
    const revised = ProContract.transition(petitioned.state, {
      type: "decide-revision",
      actor: draft.issuer,
      contractID,
      accept: true,
    })

    expect(revised.state.contracts[contractID]).toMatchObject({
      revision: 2,
      status: "dormant",
      spec: { goal: nextSpec.goal },
    })
  })

  test("keeps dependency edges immutable across revisions", () => {
    const issued = ProContract.transition(ProContract.empty, issue)
    const nextSpec = { ...spec, requires: [{ contractID, revision: 1 }] }
    const petitioned = ProContract.transition(issued.state, {
      type: "petition-revision",
      actor: draft.executor,
      contractID,
      spec: nextSpec,
      specHash: ProContract.hashSpec(nextSpec),
      reason: "rewire the graph",
    })

    expect(petitioned.decision).toEqual({
      type: "rejected",
      reason: "contract dependencies cannot change during revision",
    })
    expect(petitioned.state).toBe(issued.state)
  })

  test("keeps escalation outstanding", () => {
    const issued = ProContract.transition(ProContract.empty, issue)
    const activated = ProContract.transition(issued.state, {
      type: "activate",
      actor: "institution",
      contractID,
      revision: 1,
      time: 0,
    })
    const escalated = ProContract.transition(activated.state, {
      type: "escalate",
      actor: "institution",
      contractID,
      revision: 1,
      reason: "capacity exhausted",
      time: 1,
    })
    expect(escalated.state.contracts[contractID]).toMatchObject({
      status: "escalated",
      escalation: { reason: "capacity exhausted", time: 1 },
    })
    expect(ProContract.quiet(escalated.state, draft.scope)).toBe(false)
    expect(
      ProContract.transition(escalated.state, {
        type: "report-ready",
        actor: "institution",
        contractID,
        revision: 1,
        summary: "candidate complete",
        uncertainties: [],
        subjectHash,
        time: 1,
      }).decision,
    ).toEqual({ type: "rejected", reason: "contract is not active" })
    const resumed = ProContract.transition(escalated.state, {
      type: "resume",
      actor: draft.issuer,
      contractID,
    })
    const reactivated = ProContract.transition(resumed.state, {
      type: "activate",
      actor: "institution",
      contractID,
      revision: 2,
      time: 2,
    })
    const handedOff = ProContract.transition(reactivated.state, {
      type: "report-ready",
      actor: "institution",
      contractID,
      revision: 2,
      summary: "candidate complete",
      uncertainties: [],
      subjectHash,
      time: 2,
    })
    const discharged = ProContract.transition(handedOff.state, {
      type: "discharge",
      actor: draft.issuer,
      contractID,
      attestation: {
        id: ProContract.AttestationID.make("pca_escalated"),
        revision: 2,
        specHash: draft.specHash,
        subjectHash,
        evidenceHash: "reviewed",
        verifierID: draft.issuer,
        class: "principal",
      },
    })
    expect(discharged.state.contracts[contractID]).toMatchObject({ status: "discharged", escalation: undefined })
    expect(resumed.state.contracts[contractID]).toMatchObject({ status: "dormant", escalation: undefined })

    const released = ProContract.transition(escalated.state, {
      type: "release",
      actor: draft.issuer,
      contractID,
      reason: "no longer needed",
    })
    expect(released.state.contracts[contractID]).toMatchObject({ status: "released", escalation: undefined })
  })

  test("carries blocked work into the next institutional attempt", () => {
    const issued = ProContract.transition(ProContract.empty, issue)
    const activated = ProContract.transition(issued.state, {
      type: "activate",
      actor: "institution",
      contractID,
      revision: 1,
      time: 0,
    })
    const blocked = ProContract.transition(activated.state, {
      type: "report-blocked",
      actor: "institution",
      contractID,
      revision: 1,
      reason: "waiting for external input",
      time: 1,
    })

    expect(blocked.state.contracts[contractID]?.blocked).toEqual({
      reason: "waiting for external input",
      time: 1,
    })
    const ready = ProContract.transition(blocked.state, {
      type: "report-ready",
      actor: "institution",
      contractID,
      revision: 1,
      summary: "input received",
      uncertainties: [],
      subjectHash,
      time: 2,
    })
    expect(ready.state.contracts[contractID]?.blocked).toBeUndefined()
  })

  test("turns challenged evidence into renewed duty without erasing history", () => {
    const issued = ProContract.transition(ProContract.empty, issue)
    const activated = ProContract.transition(issued.state, {
      type: "activate",
      actor: "institution",
      contractID,
      revision: 1,
      time: 0,
    })
    const handedOff = ProContract.transition(activated.state, {
      type: "report-ready",
      actor: "institution",
      contractID,
      revision: 1,
      summary: "candidate complete",
      uncertainties: [],
      subjectHash,
      time: 0,
    })
    const attestationID = ProContract.AttestationID.make("pca_challenged")
    const discharged = ProContract.transition(handedOff.state, {
      type: "discharge",
      actor: draft.issuer,
      contractID,
      attestation: {
        id: attestationID,
        revision: 1,
        specHash: draft.specHash,
        subjectHash,
        evidenceHash: "original-evidence",
        verifierID: draft.issuer,
        class: "principal",
      },
    })
    const challenge = {
      type: "challenge",
      actor: draft.issuer,
      contractID,
      challenge: {
        revision: 1,
        subjectHash,
        evidenceHash: "negative-witness",
        disclosure: "executor",
        summary: "Output diverges on an independent check",
        time: 1,
      },
    } as const
    expect(
      ProContract.transition(discharged.state, {
        ...challenge,
        challenge: { ...challenge.challenge, revision: 2 },
      }).decision,
    ).toEqual({ type: "rejected", reason: "challenge revision does not match" })
    expect(
      ProContract.transition(discharged.state, {
        ...challenge,
        challenge: { ...challenge.challenge, subjectHash: "different-subject" },
      }).decision,
    ).toEqual({ type: "rejected", reason: "challenge subject does not match" })
    const challenged = ProContract.transition(discharged.state, challenge)

    expect(challenged.state.attestations[attestationID]).toBe(discharged.state.attestations[attestationID])
    expect(challenged.state.contracts[contractID]).toMatchObject({
      status: "dormant",
      attestationID: undefined,
      challenge: { evidenceHash: "negative-witness", attestationID },
    })
    expect(ProContract.quiet(challenged.state, draft.scope)).toBe(false)

    const reactivated = ProContract.transition(challenged.state, {
      type: "activate",
      actor: "institution",
      contractID,
      revision: 1,
      time: 2,
    })
    const rehandedOff = ProContract.transition(reactivated.state, {
      type: "report-ready",
      actor: "institution",
      contractID,
      revision: 1,
      summary: "candidate repaired",
      uncertainties: [],
      subjectHash,
      time: 2,
    })
    const reaffirmed = ProContract.transition(rehandedOff.state, {
      type: "discharge",
      actor: draft.issuer,
      contractID,
      attestation: {
        id: ProContract.AttestationID.make("pca_reaffirmed"),
        revision: 1,
        specHash: draft.specHash,
        subjectHash,
        evidenceHash: "reaffirmed-evidence",
        verifierID: draft.issuer,
        class: "principal",
      },
    })
    expect(reaffirmed.state.contracts[contractID]).toMatchObject({
      status: "discharged",
      challenge: undefined,
      attestationID: "pca_reaffirmed",
    })
  })

  test("turns unsupported dependents into principal-owned remediation", () => {
    const upstreamID = ProContract.ID.make("pct_support_upstream")
    const childID = ProContract.ID.make("pct_support_child")
    const grandchildID = ProContract.ID.make("pct_support_grandchild")
    const waitingID = ProContract.ID.make("pct_support_waiting")
    const releasedID = ProContract.ID.make("pct_support_released")
    const upstreamAttestationID = ProContract.AttestationID.make("pca_support_upstream")
    const childAttestationID = ProContract.AttestationID.make("pca_support_child")
    const upstream = {
      ...draft,
      id: upstreamID,
      revision: 1,
      status: "discharged" as const,
      handoff: { summary: "upstream", uncertainties: [], subjectHash: "upstream-subject", time: 0 },
      attestationID: upstreamAttestationID,
    }
    const childSpec = { ...spec, requires: [{ contractID: upstreamID, revision: 1 }] }
    const child = {
      ...draft,
      id: childID,
      spec: childSpec,
      specHash: ProContract.hashSpec(childSpec),
      revision: 1,
      status: "discharged" as const,
      handoff: { summary: "child", uncertainties: [], subjectHash: "child-subject", time: 0 },
      attestationID: childAttestationID,
    }
    const grandchildSpec = { ...spec, requires: [{ contractID: childID, revision: 1 }] }
    const waitingSpec = { ...spec, requires: [{ contractID: upstreamID, revision: 1 }] }
    const state: ProContract.State = {
      contracts: {
        [upstreamID]: upstream,
        [childID]: child,
        [grandchildID]: {
          ...draft,
          id: grandchildID,
          spec: grandchildSpec,
          specHash: ProContract.hashSpec(grandchildSpec),
          revision: 1,
          status: "active",
        },
        [waitingID]: {
          ...draft,
          id: waitingID,
          spec: waitingSpec,
          specHash: ProContract.hashSpec(waitingSpec),
          revision: 1,
          status: "dormant",
        },
        [releasedID]: {
          ...draft,
          id: releasedID,
          spec: waitingSpec,
          specHash: ProContract.hashSpec(waitingSpec),
          revision: 1,
          status: "released",
        },
      },
      attestations: {
        [upstreamAttestationID]: {
          id: upstreamAttestationID,
          contractID: upstreamID,
          revision: 1,
          specHash: upstream.specHash,
          subjectHash: upstream.handoff.subjectHash,
          evidenceHash: "upstream-evidence",
          verifierID: draft.issuer,
          class: "principal",
        },
        [childAttestationID]: {
          id: childAttestationID,
          contractID: childID,
          revision: 1,
          specHash: child.specHash,
          subjectHash: child.handoff.subjectHash,
          evidenceHash: "child-evidence",
          verifierID: draft.issuer,
          class: "principal",
        },
      },
    }
    const challenged = ProContract.transition(state, {
      type: "challenge",
      actor: draft.issuer,
      contractID: upstreamID,
      challenge: {
        revision: 1,
        subjectHash: upstream.handoff.subjectHash,
        evidenceHash: "negative-witness",
        disclosure: "executor",
        summary: "Upstream support was withdrawn",
        time: 1,
      },
    })

    expect(challenged.decision).toEqual({ type: "accepted" })
    expect(challenged.state.attestations).toBe(state.attestations)
    expect(challenged.state.contracts[upstreamID]).toMatchObject({ status: "dormant", attestationID: undefined })
    expect(challenged.state.contracts[childID]).toMatchObject({
      status: "escalated",
      escalation: { reason: `Dependency support lost: ${upstreamID}`, time: 1 },
      attestationID: undefined,
      handoff: undefined,
    })
    expect(challenged.state.contracts[grandchildID]).toMatchObject({
      status: "escalated",
      escalation: { reason: `Dependency support lost: ${upstreamID}`, time: 1 },
    })
    expect(challenged.state.contracts[waitingID]?.status).toBe("dormant")
    expect(challenged.state.contracts[releasedID]?.status).toBe("released")
    expect(ProContract.quiet(challenged.state, draft.scope)).toBe(false)
  })

  test("keeps sealed verifier evidence away from automatic execution", () => {
    const activated = ProContract.transition(ProContract.transition(ProContract.empty, issue).state, {
      type: "activate",
      actor: "institution",
      contractID,
      revision: 1,
      time: 0,
    })
    const ready = ProContract.transition(activated.state, {
      type: "report-ready",
      actor: "institution",
      contractID,
      revision: 1,
      summary: "candidate complete",
      uncertainties: ["holdout result is sealed"],
      subjectHash,
      time: 1,
    })
    const challenged = ProContract.transition(ready.state, {
      type: "challenge",
      actor: draft.issuer,
      contractID,
      challenge: { revision: 1, subjectHash, evidenceHash: "sealed-witness", disclosure: "sealed", time: 2 },
    })
    const activation = ProContract.transition(challenged.state, {
      type: "activate",
      actor: "institution",
      contractID,
      revision: 1,
      time: 3,
    })

    expect(challenged.state.contracts[contractID]).toMatchObject({
      status: "escalated",
      escalation: { reason: "Verification challenged; evidence is sealed", time: 2 },
      challenge: { disclosure: "sealed", evidenceHash: "sealed-witness" },
    })
    expect(activation.decision).toEqual({ type: "rejected", reason: "contract is not dormant" })
  })
})

const it = testEffect(LayerNode.compile(ProContract.node))

describe("ProContract ledger", () => {
  it.effect("serializes accepted and rejected decisions in one hash chain", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const issued = yield* contracts.issue({ id: contractID, scope: draft.scope, spec, executor: "opencode" })
      yield* contracts.release({ contractID, reason: "no longer needed" })
      const rejected = yield* contracts.release({ contractID, reason: "release twice" })
      const history = yield* contracts.history({ contractID })

      expect(issued.frontier).toBe(0)
      expect(rejected).toMatchObject({ frontier: 2, decision: { type: "rejected" } })
      expect(history).toHaveLength(3)
      expect(history[1]?.previous_hash).toBe(history[0]?.hash)
      expect(history[2]?.previous_hash).toBe(history[1]?.hash)
      expect(yield* contracts.quiet(draft.scope)).toMatchObject({ quiet: true, frontier: 2 })
    }),
  )

  it.effect("accepts principal evidence atomically", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      yield* contracts.issue({ id: contractID, scope: draft.scope, spec, executor: "opencode" })
      yield* contracts.activate(contractID, 1, 0)
      yield* contracts.reportReady({
        contractID,
        revision: 1,
        summary: "candidate complete",
        uncertainties: [],
        subjectHash,
        time: 0,
      })
      const principal = yield* contracts.principalAttest({
        contractID,
        evidenceHash: "principal-evidence",
      })
      expect(principal.state.contracts[contractID]?.status).toBe("discharged")
      const attestationID = principal.state.contracts[contractID]?.attestationID
      expect(attestationID ? yield* contracts.getAttestation(attestationID) : undefined).toMatchObject({
        evidenceHash: "principal-evidence",
        subjectHash,
        verifierID: "local-owner",
      })
    }),
  )

  it.effect("reactivates executor-visible verification challenges", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      yield* contracts.issue({ id: contractID, scope: draft.scope, spec, executor: "opencode" })
      yield* contracts.activate(contractID, 1, 0)
      yield* contracts.reportReady({
        contractID,
        revision: 1,
        summary: "candidate complete",
        uncertainties: [],
        subjectHash,
        time: 1,
      })

      const challenged = yield* contracts.challenge({
        contractID,
        revision: 1,
        subjectHash,
        evidenceHash: "negative-witness",
        disclosure: "executor",
        summary: "Independent output mismatch",
        time: 2,
      })

      expect(challenged.decision).toEqual({ type: "accepted" })
      expect((yield* contracts.due(3)).map((contract) => contract.id)).toEqual([contractID])
      expect(yield* contracts.history({ contractID })).toHaveLength(4)
    }),
  )

  it.effect("persists challenged support and affected dependents atomically", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const upstreamID = ProContract.ID.make("pct_ledger_support_upstream")
      const childID = ProContract.ID.make("pct_ledger_support_child")
      yield* contracts.issue({ id: upstreamID, scope: "support", spec, executor: "upstream" })
      yield* contracts.activate(upstreamID, 1, 0)
      yield* contracts.reportReady({
        contractID: upstreamID,
        revision: 1,
        summary: "upstream complete",
        uncertainties: [],
        subjectHash: "upstream-subject",
        time: 0,
      })
      yield* contracts.principalAttest({ contractID: upstreamID, evidenceHash: "upstream-evidence" })
      const childSpec = { ...spec, requires: [{ contractID: upstreamID, revision: 1 }] }
      yield* contracts.issue({ id: childID, scope: "support", spec: childSpec, executor: "child" })
      yield* contracts.activate(childID, 1, 1)
      yield* contracts.reportReady({
        contractID: childID,
        revision: 1,
        summary: "child complete",
        uncertainties: [],
        subjectHash: "child-subject",
        time: 1,
      })
      const childDischarge = yield* contracts.principalAttest({
        contractID: childID,
        evidenceHash: "child-evidence",
      })
      const childAttestationID = childDischarge.state.contracts[childID]?.attestationID
      expect(yield* contracts.quiet("support")).toMatchObject({ quiet: true })

      const challenged = yield* contracts.challenge({
        contractID: upstreamID,
        revision: 1,
        subjectHash: "upstream-subject",
        evidenceHash: "negative-witness",
        disclosure: "executor",
        summary: "Upstream support was withdrawn",
        time: 2,
      })

      expect(challenged.decision).toEqual({ type: "accepted" })
      const challengedUpstream = yield* contracts.get(upstreamID)
      const challengedChild = yield* contracts.get(childID)
      expect(challengedUpstream).toMatchObject({ status: "dormant" })
      expect(challengedUpstream?.attestationID).toBeUndefined()
      expect(challengedChild).toMatchObject({
        status: "escalated",
        escalation: { reason: `Dependency support lost: ${upstreamID}`, time: 2 },
      })
      expect(challengedChild?.attestationID).toBeUndefined()
      expect(childAttestationID ? yield* contracts.getAttestation(childAttestationID) : undefined).toMatchObject({
        evidenceHash: "child-evidence",
      })
      expect(yield* contracts.quiet("support")).toMatchObject({
        quiet: false,
        outstanding: expect.arrayContaining([upstreamID, childID]),
      })
    }),
  )

  it.effect("rejects a specification with a false hash", () =>
    Effect.gen(function* () {
      const result = ProContract.transition(ProContract.empty, {
        ...issue,
        draft: { ...draft, specHash: "not-the-specification-hash" },
      })
      expect(result.decision).toEqual({ type: "rejected", reason: "specification hash does not match" })
    }),
  )

  it.effect("assigns one global frontier to concurrent contracts", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const receipts = yield* Effect.all(
        [
          contracts.issue({ id: ProContract.ID.make("pct_concurrent_1"), scope: "concurrent", spec, executor: "one" }),
          contracts.issue({ id: ProContract.ID.make("pct_concurrent_2"), scope: "concurrent", spec, executor: "two" }),
        ],
        { concurrency: "unbounded" },
      )
      expect(receipts.map((item) => item.frontier).toSorted((a, b) => a - b)).toEqual([0, 1])
      expect((yield* contracts.quiet("concurrent")).outstanding).toHaveLength(2)
    }),
  )

  it.effect("records a rejected issue without creating a contract", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const missing = ProContract.ID.make("pct_missing_requirement")
      const rejectedID = ProContract.ID.make("pct_rejected_requirement")
      const rejected = yield* contracts.issue({
        id: rejectedID,
        scope: "dependencies",
        spec: { ...spec, requires: [{ contractID: missing, revision: 1 }] },
        executor: "opencode",
      })

      expect(rejected.decision).toEqual({ type: "rejected", reason: `required contract not found: ${missing}` })
      expect(yield* contracts.get(rejectedID)).toBeUndefined()
      expect(yield* contracts.history({ contractID: rejectedID })).toMatchObject([
        { seq: 0, decision: { type: "rejected", reason: `required contract not found: ${missing}` } },
      ])
    }),
  )

  it.effect("makes a dependent contract due only after evidenced discharge", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const upstreamID = ProContract.ID.make("pct_due_upstream")
      const childID = ProContract.ID.make("pct_due_child")
      yield* contracts.issue({ id: upstreamID, scope: "dependencies", spec, executor: "upstream" })
      yield* contracts.issue({
        id: childID,
        scope: "dependencies",
        spec: { ...spec, requires: [{ contractID: upstreamID, revision: 1 }] },
        executor: "child",
      })

      expect((yield* contracts.due(0)).map((contract) => contract.id)).toEqual([upstreamID])
      yield* contracts.activate(upstreamID, 1, 0)
      yield* contracts.reportReady({
        contractID: upstreamID,
        revision: 1,
        summary: "upstream complete",
        uncertainties: [],
        subjectHash,
        time: 0,
      })
      yield* contracts.principalAttest({ contractID: upstreamID, evidenceHash: "upstream-evidence" })
      expect((yield* contracts.due(0)).map((contract) => contract.id)).toEqual([childID])
    }),
  )
})

const wakeCalls: SessionV2.ID[] = []
const activeSessions = new Set<SessionV2.ID>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set(activeSessions)),
    resume: () => Effect.void,
    interrupt: () => Effect.void,
    wake: (sessionID) => Effect.sync(() => wakeCalls.push(sessionID)),
  }),
)
const schedulerIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, ProContract.node, ProContractOpenCode.node, SessionV2.node, ProContractScheduler.node]),
    [[SessionExecution.node, execution]],
  ),
)

let schedulerCycles = 0
const schedulerLiveIt = testEffect(
  AppNodeBuilder.build(ProContractScheduler.liveNode, [
    [
      ProContractScheduler.node,
      Layer.succeed(
        ProContractScheduler.Service,
        ProContractScheduler.Service.of({
          runOnce: () =>
            Effect.suspend(() => {
              schedulerCycles++
              return schedulerCycles === 1 ? Effect.die("first cycle failed") : Effect.void
            }),
        }),
      ),
    ],
  ]),
)

const terminalSession = Layer.mock(SessionStore.Service, {
  get: (id) =>
    Effect.succeed(
      SessionV2.Info.make({
        id,
        projectID: ProjectV2.ID.global,
        agent: AgentV2.ID.make("build"),
        model: executionModel,
        title: "Terminal provider error",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      }),
    ),
  context: () =>
    Effect.succeed([
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_terminal_provider_error"),
        type: "assistant",
        agent: AgentV2.ID.make("build"),
        model: executionModel,
        time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(0) },
        content: [],
        finish: "error",
        error: { type: "unknown", message: "Expired key" },
      }),
    ]),
})
const terminalLocations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () =>
      Layer.succeed(
        SessionRunner.Service,
        SessionRunner.Service.of({ run: () => Effect.void }),
      ) as unknown as Layer.Layer<LocationServices, LocationError>,
  ),
)
const terminalExecutionIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, ProContract.node, ProContractOpenCode.node, SessionExecutionLocal.node]),
    [
      [SessionStore.node, terminalSession],
      [LocationServiceMap.node, terminalLocations],
    ],
  ),
)

describe("OpenCode Contract binding", () => {
  terminalExecutionIt.effect("escalates a durable provider error without retrying", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const execution = yield* SessionExecution.Service
      const issued = yield* contracts.issue({ id: contractID, scope: draft.scope, spec, executor: "opencode" })
      yield* bindings.create({
        contractID,
        revision: issued.contract!.revision,
        location: { directory: AbsolutePath.make("/project") },
        model: executionModel,
        nextActionAt: 0,
      })
      yield* contracts.activate(contractID, 1, 0)
      const attempt = yield* bindings.claim(contractID, 0)

      yield* execution.resume(attempt!.sessionID)

      expect(yield* contracts.get(contractID)).toMatchObject({
        status: "escalated",
        escalation: { reason: "OpenCode provider returned a terminal error", time: 0 },
      })
      expect(yield* bindings.get(contractID)).toMatchObject({ attempts: 1, turnsUsed: 0, actionsUsed: 0 })
    }),
  )

  schedulerLiveIt.effect("keeps the live scheduler running after a failed cycle", () =>
    Effect.gen(function* () {
      schedulerCycles = 0
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.seconds(3))
      yield* Effect.yieldNow
      expect(schedulerCycles).toBeGreaterThanOrEqual(4)
    }),
  )

  schedulerIt.effect("dispatches a due contract through its separate binding", () =>
    Effect.gen(function* () {
      wakeCalls.length = 0
      activeSessions.clear()
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const scheduler = yield* ProContractScheduler.Service
      const sessions = yield* SessionV2.Service
      const binding = yield* bindings.create({
        contractID,
        revision: 1,
        location: { directory: AbsolutePath.make("/project") },
        model: executionModel,
        nextActionAt: 0,
      })
      yield* contracts.issue({ id: contractID, scope: draft.scope, spec, executor: "opencode" })

      yield* scheduler.runOnce()

      expect(yield* contracts.get(contractID)).toMatchObject({ status: "active" })
      expect(yield* bindings.get(contractID)).toMatchObject({ dispatched: true })
      expect(yield* sessions.get(binding.sessionID)).toMatchObject({ model: executionModel })
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ prompt: SessionInputTable.prompt })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, binding.sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        prompt: {
          text: "Reconcile the active contract against the existing candidate state. Inspect and reuse valid files, artifacts, and completed checks before new exploration, then advance within the delegated authority.",
        },
      })
      expect(wakeCalls).toEqual([binding.sessionID])
    }),
  )

  schedulerIt.effect("reuses one semantic attempt for transport retries", () =>
    Effect.gen(function* () {
      wakeCalls.length = 0
      activeSessions.clear()
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const scheduler = yield* ProContractScheduler.Service
      const limited = { ...spec, resolution: { ...spec.resolution, maxAttempts: 1 } }
      const retryAt = 1 + limited.resolution.retryDelay
      const issued = yield* contracts.issue({ id: contractID, scope: draft.scope, spec: limited, executor: "opencode" })
      yield* bindings.create({
        contractID,
        revision: issued.contract!.revision,
        location: { directory: AbsolutePath.make("/project") },
        model: executionModel,
        nextActionAt: 0,
      })
      yield* scheduler.runOnce()
      const first = yield* bindings.get(contractID)
      yield* bindings.reschedule({
        contractID,
        revision: 1,
        promptID: first!.promptID,
        reason: "provider unavailable",
        now: 1,
        attempt: "same",
      })
      yield* TestClock.setTime(retryAt)
      yield* scheduler.runOnce()
      const second = yield* bindings.get(contractID)

      expect(second).toMatchObject({
        sessionID: first?.sessionID,
        attempts: 1,
      })
      expect(second?.promptID).not.toBe(first?.promptID)
      expect(wakeCalls).toEqual([first!.sessionID, first!.sessionID])
    }),
  )

  schedulerIt.effect("starts verification challenges in a fresh fenced Session", () =>
    Effect.gen(function* () {
      wakeCalls.length = 0
      activeSessions.clear()
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const scheduler = yield* ProContractScheduler.Service
      const sessions = yield* SessionV2.Service
      const issued = yield* contracts.issue({ id: contractID, scope: draft.scope, spec, executor: "opencode" })
      yield* bindings.create({
        contractID,
        revision: issued.contract!.revision,
        location: { directory: AbsolutePath.make("/project") },
        model: executionModel,
        nextActionAt: 0,
      })
      yield* scheduler.runOnce()
      const first = yield* bindings.get(contractID)
      yield* contracts.reportReady({
        contractID,
        revision: 1,
        summary: "candidate complete",
        uncertainties: [],
        subjectHash,
        time: 1,
      })
      yield* contracts.challenge({
        contractID,
        revision: 1,
        subjectHash,
        evidenceHash: "negative-witness",
        disclosure: "executor",
        summary: "Independent output mismatch",
        time: 2,
      })
      yield* scheduler.runOnce()
      const second = yield* bindings.get(contractID)

      expect(second?.sessionID).not.toBe(first?.sessionID)
      expect(second?.promptID).not.toBe(first?.promptID)
      expect(second).toMatchObject({ revision: 1, attempts: 2 })
      expect(yield* sessions.get(first!.sessionID)).toMatchObject({ id: first?.sessionID })
      expect(yield* sessions.get(second!.sessionID)).toMatchObject({ id: second?.sessionID })
      expect(wakeCalls).toEqual([first!.sessionID, second!.sessionID])
      expect(yield* bindings.forSession(first!.sessionID)).toMatchObject({
        sessionID: first?.sessionID,
        dispatched: false,
      })
      expect(yield* bindings.reserveAction(first!.sessionID, 2)).toBe(false)
    }),
  )

  schedulerIt.effect("escalates a due OpenCode contract with no execution binding", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const scheduler = yield* ProContractScheduler.Service
      yield* contracts.issue({ id: contractID, scope: draft.scope, spec, executor: "opencode" })

      yield* scheduler.runOnce()

      expect(yield* contracts.get(contractID)).toMatchObject({
        status: "escalated",
        escalation: { reason: "OpenCode execution binding is missing", time: 0 },
      })
    }),
  )

  schedulerIt.effect("escalates a dormant contract whose dependency wait passed its deadline", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const scheduler = yield* ProContractScheduler.Service
      const upstreamID = ProContract.ID.make("pct_waiting_upstream")
      yield* contracts.issue({ id: upstreamID, scope: draft.scope, spec, executor: "upstream" })
      yield* contracts.issue({
        id: contractID,
        scope: draft.scope,
        spec: {
          ...spec,
          requires: [{ contractID: upstreamID, revision: 1 }],
          budget: { ...spec.budget, deadline: 10 },
        },
        executor: "opencode",
      })
      yield* TestClock.setTime(11)

      yield* scheduler.runOnce()

      expect(yield* contracts.get(contractID)).toMatchObject({
        status: "escalated",
        escalation: { reason: "OpenCode deadline exhausted while waiting", time: 11 },
      })
      yield* scheduler.runOnce()
      expect(yield* contracts.history({ contractID })).toHaveLength(2)
    }),
  )

  schedulerIt.effect("enforces turn and action budgets atomically", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const limited = { ...spec, budget: { turns: 1, actions: 1, deadline: 100 } }
      const issued = yield* contracts.issue({ id: contractID, scope: draft.scope, spec: limited, executor: "opencode" })
      const binding = yield* bindings.create({
        contractID,
        revision: issued.contract!.revision,
        location: { directory: AbsolutePath.make("/project") },
        model: executionModel,
        nextActionAt: 0,
      })
      yield* contracts.activate(contractID, 1, 1)
      const claimed = yield* bindings.claim(contractID, 1)
      expect(claimed).toBeDefined()

      expect(yield* bindings.reserveAction(binding.sessionID, 1)).toBe(true)
      expect(yield* bindings.reserveTurn(binding.sessionID, 1)).toBe(true)
      expect(yield* bindings.reserveAction(binding.sessionID, 1)).toBe(false)
      expect(yield* bindings.reserveTurn(binding.sessionID, 1)).toBe(false)
    }),
  )

  schedulerIt.effect("pauses one attempt while the principal decides a revision", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const issued = yield* contracts.issue({ id: contractID, scope: draft.scope, spec, executor: "opencode" })
      const binding = yield* bindings.create({
        contractID,
        revision: issued.contract!.revision,
        location: { directory: AbsolutePath.make("/project") },
        model: executionModel,
        nextActionAt: 0,
      })
      yield* contracts.activate(contractID, 1, 0)
      const attempt = yield* bindings.claim(contractID, 0)
      yield* contracts.petitionRevision({
        contractID,
        spec: { ...spec, goal: "Revise the verified change" },
        reason: "The original acceptance condition is ambiguous",
      })

      yield* bindings.heartbeat(new Set([binding.sessionID]), 1)
      expect(yield* bindings.get(contractID)).toMatchObject({ leaseExpiresAt: 30_000 })
      expect(yield* bindings.due(30_000)).toEqual([])
      expect(yield* bindings.claim(contractID, 30_000)).toBeUndefined()
      expect(yield* bindings.reserveTurn(binding.sessionID, 1)).toBe(false)
      expect(yield* bindings.reserveAction(binding.sessionID, 1)).toBe(false)

      yield* bindings.reschedule({
        contractID,
        revision: 1,
        promptID: attempt!.promptID,
        reason: "OpenCode execution ended without settlement",
        now: 1,
        attempt: "new",
      })
      const paused = yield* bindings.get(contractID)
      expect(paused).toMatchObject({ sessionID: attempt!.sessionID, attempts: 1, dispatched: false, nextActionAt: 1 })
      expect(paused?.promptID).not.toBe(attempt?.promptID)

      yield* contracts.decideRevision({ contractID, accept: false })
      const resumed = yield* bindings.claim(contractID, 1)
      expect(resumed).toMatchObject({ sessionID: attempt!.sessionID, attempts: 1, promptID: paused?.promptID })
    }),
  )

  schedulerIt.effect("escalates after bounded retry exhaustion without becoming quiet", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const limited = { ...spec, resolution: { maxAttempts: 1, retryDelay: 1 } }
      const issued = yield* contracts.issue({ id: contractID, scope: draft.scope, spec: limited, executor: "opencode" })
      yield* bindings.create({
        contractID,
        revision: issued.contract!.revision,
        location: { directory: AbsolutePath.make("/project") },
        model: executionModel,
        nextActionAt: 0,
      })
      yield* contracts.activate(contractID, 1, 0)
      const claimed = yield* bindings.claim(contractID, 0)
      expect(claimed).toBeDefined()
      yield* bindings.reschedule({
        contractID,
        revision: 1,
        promptID: claimed!.promptID,
        reason: "blocked",
        now: 1,
        attempt: "new",
      })

      expect(yield* contracts.get(contractID)).toMatchObject({
        status: "escalated",
        escalation: { reason: "blocked", time: 1 },
      })
      expect(yield* contracts.quiet(draft.scope)).toMatchObject({ quiet: false, outstanding: [contractID] })
    }),
  )

  schedulerIt.effect("preserves a verification handoff when execution ends", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const issued = yield* contracts.issue({ id: contractID, scope: draft.scope, spec, executor: "opencode" })
      yield* bindings.create({
        contractID,
        revision: issued.contract!.revision,
        location: { directory: AbsolutePath.make("/project") },
        model: executionModel,
        nextActionAt: 0,
      })
      yield* contracts.activate(contractID, 1, 0)
      const attempt = yield* bindings.claim(contractID, 0)
      yield* contracts.reportReady({
        contractID,
        revision: 1,
        summary: "reviewed",
        uncertainties: [],
        subjectHash,
        time: 1,
      })
      yield* bindings.reschedule({
        contractID,
        revision: 1,
        promptID: attempt!.promptID,
        reason: "OpenCode execution ended without settlement",
        now: 2,
        attempt: "new",
      })

      expect(yield* contracts.get(contractID)).toMatchObject({
        status: "verification",
        handoff: { summary: "reviewed", uncertainties: [], subjectHash },
      })
    }),
  )

  schedulerIt.effect("fences completion from an expired attempt", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const issued = yield* contracts.issue({ id: contractID, scope: draft.scope, spec, executor: "opencode" })
      yield* bindings.create({
        contractID,
        revision: issued.contract!.revision,
        location: { directory: AbsolutePath.make("/project") },
        model: executionModel,
        nextActionAt: 0,
      })
      yield* contracts.activate(contractID, 1, 0)
      const first = yield* bindings.claim(contractID, 0)
      yield* bindings.reserveTurn(first!.sessionID, 1)
      const second = yield* bindings.claim(contractID, 30_000)
      expect(second?.promptID).not.toBe(first?.promptID)
      expect(second?.sessionID).not.toBe(first?.sessionID)

      yield* bindings.reschedule({
        contractID,
        revision: first!.revision,
        promptID: first!.promptID,
        reason: "stale completion",
        now: 30_001,
        attempt: "new",
      })
      expect(yield* bindings.get(contractID)).toMatchObject({
        promptID: second?.promptID,
        dispatched: true,
        attempts: 2,
      })
    }),
  )

  schedulerIt.effect("reclaims a zero-work lease without consuming an attempt", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const limited = { ...spec, resolution: { ...spec.resolution, maxAttempts: 1 } }
      const issued = yield* contracts.issue({ id: contractID, scope: draft.scope, spec: limited, executor: "opencode" })
      yield* bindings.create({
        contractID,
        revision: issued.contract!.revision,
        location: { directory: AbsolutePath.make("/project") },
        model: executionModel,
        nextActionAt: 0,
      })
      yield* contracts.activate(contractID, 1, 0)
      const first = yield* bindings.claim(contractID, 0)
      const reclaimed = yield* bindings.claim(contractID, 30_000)

      expect(reclaimed).toMatchObject({ sessionID: first?.sessionID, promptID: first?.promptID, attempts: 1 })
    }),
  )

  schedulerIt.effect("heartbeat protects a live attempt and blocked work waits for retry", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const issued = yield* contracts.issue({ id: contractID, scope: draft.scope, spec, executor: "opencode" })
      const binding = yield* bindings.create({
        contractID,
        revision: issued.contract!.revision,
        location: { directory: AbsolutePath.make("/project") },
        model: executionModel,
        nextActionAt: 0,
      })
      yield* contracts.activate(contractID, 1, 0)
      const attempt = yield* bindings.claim(contractID, 0)
      yield* bindings.heartbeat(new Set([binding.sessionID]), 29_000)
      expect(yield* bindings.claim(contractID, 30_000)).toBeUndefined()

      yield* contracts.reportBlocked({
        contractID,
        revision: attempt!.revision,
        reason: "wait for input",
        time: 30_000,
      })
      yield* bindings.reschedule({
        contractID,
        revision: attempt!.revision,
        promptID: attempt!.promptID,
        reason: "wait for input",
        now: 30_000,
        attempt: "new",
      })
      expect(yield* bindings.get(contractID)).toMatchObject({
        dispatched: false,
        attempts: 1,
        nextActionAt: 90_000,
      })
      expect(yield* contracts.get(contractID)).toMatchObject({
        blocked: { reason: "wait for input", time: 30_000 },
      })
      expect((yield* contracts.history({ contractID })).at(-1)?.command).toMatchObject({
        type: "report-blocked",
        reason: "wait for input",
      })
      expect(yield* bindings.reserveTurn(binding.sessionID, 30_000)).toBe(false)
      const next = yield* bindings.claim(contractID, 90_000)
      expect(next?.sessionID).not.toBe(binding.sessionID)
      expect(next).toMatchObject({ attempts: 2 })
    }),
  )

  schedulerIt.effect("escalates a live attempt when its contract deadline expires", () =>
    Effect.gen(function* () {
      activeSessions.clear()
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const scheduler = yield* ProContractScheduler.Service
      const limited = { ...spec, budget: { ...spec.budget, deadline: 10 } }
      const issued = yield* contracts.issue({ id: contractID, scope: draft.scope, spec: limited, executor: "opencode" })
      const binding = yield* bindings.create({
        contractID,
        revision: issued.contract!.revision,
        location: { directory: AbsolutePath.make("/project") },
        model: executionModel,
        nextActionAt: 0,
      })
      yield* contracts.activate(contractID, 1, 0)
      yield* bindings.claim(contractID, 0)
      activeSessions.add(binding.sessionID)
      yield* TestClock.setTime(11)

      yield* scheduler.runOnce()

      expect(yield* contracts.get(contractID)).toMatchObject({
        escalation: { reason: "OpenCode deadline exhausted", time: 11 },
      })
    }),
  )

  schedulerIt.effect("escalates an expired final attempt", () =>
    Effect.gen(function* () {
      activeSessions.clear()
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const scheduler = yield* ProContractScheduler.Service
      const limited = { ...spec, resolution: { maxAttempts: 1, retryDelay: 0 } }
      const issued = yield* contracts.issue({ id: contractID, scope: draft.scope, spec: limited, executor: "opencode" })
      yield* bindings.create({
        contractID,
        revision: issued.contract!.revision,
        location: { directory: AbsolutePath.make("/project") },
        model: executionModel,
        nextActionAt: 0,
      })
      yield* contracts.activate(contractID, 1, 0)
      const attempt = yield* bindings.claim(contractID, 0)
      yield* bindings.reserveTurn(attempt!.sessionID, 1)
      yield* TestClock.setTime(30_001)

      yield* scheduler.runOnce()

      expect(yield* contracts.get(contractID)).toMatchObject({
        escalation: { reason: "OpenCode attempt budget exhausted", time: 30_001 },
      })
    }),
  )

  schedulerIt.effect("resume preserves consumed budgets and fences the old revision", () =>
    Effect.gen(function* () {
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const limited = { ...spec, budget: { turns: 1, actions: 1, deadline: 100 } }
      const issued = yield* contracts.issue({ id: contractID, scope: draft.scope, spec: limited, executor: "opencode" })
      const binding = yield* bindings.create({
        contractID,
        revision: issued.contract!.revision,
        location: { directory: AbsolutePath.make("/project") },
        model: executionModel,
        nextActionAt: 0,
      })
      yield* contracts.activate(contractID, 1, 0)
      const first = yield* bindings.claim(contractID, 0)
      yield* bindings.reserveTurn(binding.sessionID, 1)
      yield* bindings.reserveAction(binding.sessionID, 1)
      yield* contracts.escalate({ contractID, revision: 1, reason: "manual review", time: 1 })
      yield* contracts.resume(contractID)
      yield* contracts.activate(contractID, 2, 2)
      const second = yield* bindings.claim(contractID, 2)

      expect(second).toMatchObject({ revision: 2, turnsUsed: 1, actionsUsed: 1 })
      expect(second?.promptID).not.toBe(first?.promptID)
      expect(second?.sessionID).not.toBe(first?.sessionID)
      expect(yield* bindings.reserveTurn(binding.sessionID, 2)).toBe(false)
    }),
  )
})
