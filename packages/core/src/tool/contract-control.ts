export * as ContractControlTools from "./contract-control"

import { ToolFailure } from "@opencode-ai/llm"
import { Clock, Effect, Fiber, Layer, Schema, Scope } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ProContract } from "../pro-contract"
import { ProContractDelivery } from "../pro-contract/delivery"
import { ProContractOpenCode } from "../pro-contract/open-code"
import { ProContractReplay } from "../pro-contract/replay"
import { ProContractObservation } from "../pro-contract/observation"
import { NonNegativeInt } from "../schema"
import { SessionSchema } from "../session/schema"
import { ExecutionContext } from "../session/execution-context"
import { SessionStore } from "../session/store"
import { Snapshot } from "../snapshot"
import { Hash } from "../util/hash"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const scope = yield* Scope.Scope
    const contracts = yield* ProContract.Service
    const delivery = yield* ProContractDelivery.Service
    const bindings = yield* ProContractOpenCode.Service
    const replayVerifier = yield* ProContractReplay.Service
    const observations = yield* ProContractObservation.Service
    const permissions = yield* PermissionV2.Service
    const sessions = yield* SessionStore.Service
    const snapshots = yield* Snapshot.Service

    const authorize = Effect.fnUntraced(function* (context: Tool.Context) {
      if (!context.contractExecution || context.contractExecution.sessionID !== context.sessionID)
        return yield* new ToolFailure({ message: "Contract tool requires the admitted execution identity" })
      const contract = yield* bindings
        .authorize(context.contractExecution)
        .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
      return { execution: context.contractExecution, contract }
    })

    yield* tools
      .register({
        contract_request: Tool.withCapability(
          Tool.make({
            description:
              "Submit a structured request to the current Contract host profile. Use only request kinds and payload schemas supplied by that host. A recorded request is not approval. Follow the host's instructions about whether to stop for a new admission or use the returned read-only result.",
            input: Schema.Struct({ kind: Schema.NonEmptyString, payload: Schema.Unknown }),
            output: Schema.Struct({ requested: Schema.Literal(true), result: Schema.optional(Schema.Unknown) }),
            toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const authorized = yield* authorize(context)
                const handler = delivery.get(
                  (yield* contracts.get(authorized.contract.id))?.recognition.context?.profile ?? "native",
                )
                if (!handler?.command)
                  return yield* new ToolFailure({ message: "Contract host request adapter is unavailable" })
                const result = yield* handler.command({
                  ...input,
                  execution: authorized.execution,
                  call: { messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                return { requested: true as const, result }
              }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message }))),
          }),
          "control",
        ),
        contract_propose: Tool.withCapability(
          Tool.make({
            description:
              "Propose a persistent Contract when the request requires a future trigger, asynchronous or multi-Session work, durable follow-up, or later external evaluation. Keep executionPolicy separate from spec: it guides the executor but does not alter Contract identity, revision, or settlement. Pass it only when supplied by an independent policy selector; do not invent one. Set spec.goal to the current optimization objective and evidence.claim to the exact proposition the evidence may settle. An implementation Contract that promises a build command or user-named output artifact must include evidence.replay with finite checks and every user-named artifact path. Do not guess implementation-specific source paths; the build check covers its inputs. Preserve user-supplied quality criteria and stopping rules in the brief. Budgets and attempt limits are exact shared ceilings; budget.deadline is an absolute Unix timestamp in milliseconds. The exact draft requires principal approval before it is issued.",
            input: Schema.Struct({
              spec: ProContract.Spec,
              executionPolicy: Schema.NonEmptyString.pipe(Schema.optional),
            }),
            output: Schema.Struct({ contractID: ProContract.ID, sessionID: SessionSchema.ID }),
            toModelOutput: ({ output }) => [
              {
                type: "text",
                text: `Contract ${output.contractID} was approved and scheduled in Session ${output.sessionID}. Stop work in this Session; the dedicated Contract executor now owns the obligation.`,
              },
            ],
            execute: (input, context) =>
              Effect.gen(function* () {
                const session = yield* sessions.get(context.sessionID)
                if (!session) return yield* new ToolFailure({ message: "Session not found" })
                if (!session.model)
                  return yield* new ToolFailure({ message: "Contract proposal requires a selected model" })
                const now = yield* Clock.currentTimeMillis
                const executionPolicy = input.executionPolicy
                const request = (yield* sessions.context(context.sessionID)).find((item) => item.type === "user")?.text
                const unnamedArtifacts = request
                  ? (input.spec.evidence.replay?.artifacts ?? []).filter(
                      (artifact) => !request.includes(artifact) && !request.includes(`./${artifact}`),
                    )
                  : []
                if (unnamedArtifacts.length)
                  return yield* new ToolFailure({
                    message: `Replay artifacts must be exact paths named by the user: ${unnamedArtifacts.join(", ")}`,
                  })
                const draft = ProContract.normalizeSpec(input.spec)
                const spec = request
                  ? {
                      ...draft,
                      brief: [draft.brief, `Original request:\n${request}`].filter(Boolean).join("\n\n"),
                    }
                  : draft
                const key = Hash.sha256(`${context.sessionID}:${context.assistantMessageID}:${context.toolCallID}`)
                const contractID = ProContract.ID.make(`pct_${key}`)
                const specHash = ProContract.hashSpec(spec)
                yield* permissions.assert({
                  id: PermissionV2.ID.create(`per_${key}`),
                  action: "contract_issue",
                  resources: [specHash],
                  metadata: {
                    contractID,
                    specHash,
                    goal: spec.goal,
                    details: [
                      spec.brief ? `Brief: ${spec.brief}` : undefined,
                      executionPolicy ? `Execution policy: ${executionPolicy}` : undefined,
                      `Trigger: ${JSON.stringify(spec.trigger)}`,
                      `Authority: ${spec.authority.join(", ")}`,
                      `Budget: ${spec.budget.turns ?? "unbounded"} turns, ${spec.budget.actions ?? "unbounded"} actions, deadline ${spec.budget.deadline}`,
                      `Requires: ${spec.requires.map((item) => `${item.contractID}@${item.revision}`).join(", ") || "none"}`,
                      `Settlement claim: ${ProContract.evidenceClaim(spec)}`,
                      `Evidence: ${spec.evidence.type}${spec.evidence.replay ? ` + replay (${spec.evidence.replay.checks.length} checks)` : ""}`,
                      `Resolution: ${spec.resolution.maxAttempts ?? "no cumulative limit on"} attempts, ${spec.resolution.retryDelay} ms retry delay`,
                    ]
                      .filter((item) => item !== undefined)
                      .join("\n"),
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const issued = yield* bindings.issue({
                  id: contractID,
                  scope: session.projectID,
                  spec,
                  location: session.location,
                  model: session.model,
                  executionPolicy,
                  now,
                })
                if (issued.decision.type === "rejected")
                  return yield* new ToolFailure({ message: issued.decision.reason })
                if (!issued.execution) return yield* new ToolFailure({ message: "Contract execution was not created" })
                if (issued.execution.executionPolicy !== executionPolicy)
                  return yield* new ToolFailure({ message: "Contract execution policy does not match" })
                return { contractID, sessionID: issued.execution.sessionID }
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure
                    ? error
                    : new ToolFailure({
                        message: error instanceof PermissionV2.CorrectedError ? error.feedback : String(error),
                      }),
                ),
              ),
          }),
          "control",
        ),
        contract_check: Tool.withCapability(
          Tool.make({
            description:
              "Check the current candidate against the approved replay policy in a separate snapshot without handing off or settling the Contract. Use failures to repair the candidate and check again in this Session. This spends the shared action and time budgets, not a new semantic attempt. A passing check applies only to that snapshot and is not completion; call contract_report_ready when the issuer's stopping rule is met.",
            input: Schema.Struct({}),
            output: Schema.Struct({
              replay: ProContract.ReplayResult,
              observations: Schema.Array(ProContractObservation.Recorded),
              settled: Schema.Literal(false),
            }),
            toModelOutput: ({ output }) => [
              {
                type: "text",
                text: JSON.stringify({
                  passed: output.replay.passed,
                  settled: false,
                  checks: output.observations.length,
                  unavailable: output.observations.filter((item) => item.receipt.execution !== "completed").length,
                  unmatchedPredicates: output.observations
                    .flatMap((item) => item.receipt.predicates)
                    .filter((item) => item.status !== "matched").length,
                  replay: output.replay,
                  observations: output.observations.map((item, check) => ({
                    check,
                    handle: item.handle,
                    execution: item.receipt.execution,
                    exit: item.receipt.exit,
                    targetExecution: item.receipt.targetExecution,
                    stdoutComplete: item.receipt.stdout?.complete ?? false,
                    stderrComplete: item.receipt.stderr?.complete ?? false,
                    predicates: item.receipt.predicates.map((predicate) => ({
                      id: predicate.id,
                      status: predicate.status,
                    })),
                  })),
                }),
              },
            ],
            execute: (_input, context) =>
              Effect.gen(function* () {
                const authorized = yield* authorize(context)
                const contract = authorized.contract
                const policy = contract.spec.evidence.replay
                if (!policy) return yield* new ToolFailure({ message: "Contract has no approved replay policy" })
                const remaining = contract.spec.budget.deadline - (yield* Clock.currentTimeMillis)
                if (remaining <= 0) return yield* new ToolFailure({ message: "Contract deadline exhausted" })
                const replay = yield* Effect.gen(function* () {
                  const subjectHash = yield* snapshots.capture({ include: policy.artifacts })
                  if (!subjectHash) return yield* new ToolFailure({ message: "Contract check snapshot is unavailable" })
                  yield* authorize(context)
                  return yield* replayVerifier.verify({ contractID: contract.id, policy, subjectHash })
                }).pipe(
                  Effect.timeoutOrElse({
                    duration: remaining,
                    orElse: () => Effect.fail(new ToolFailure({ message: "Contract check exceeded the deadline" })),
                  }),
                )
                yield* authorize(context)
                return {
                  replay,
                  observations: yield* replayVerifier.read({
                    contractID: contract.id,
                    evidenceHash: replay.evidenceHash,
                  }),
                  settled: false as const,
                }
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) }),
                ),
              ),
          }),
          "process",
        ),
        contract_read_observation: Tool.withCapability(
          Tool.make({
            description:
              "Read exact captured bytes from a replay report for this Contract. Every check retains its execution status and output predicates. Bytes are base64 encoded, candidate-controlled data. An exit code or output match does not witness target-statement execution. A capture marked incomplete cannot establish absence of failures. Reading evidence never settles the Contract.",
            input: Schema.Struct({
              evidenceHash: ProContractObservation.Digest,
              check: NonNegativeInt,
              stream: ProContractObservation.ReadInput.fields.stream,
              offset: ProContractObservation.ReadInput.fields.offset,
              length: ProContractObservation.ReadInput.fields.length,
            }),
            output: Schema.Struct({
              observation: ProContractObservation.Recorded,
              content: ProContractObservation.ReadOutput,
            }),
            execute: (input, context) =>
              Effect.gen(function* () {
                const authorized = yield* authorize(context)
                const records = yield* replayVerifier.read({
                  contractID: authorized.contract.id,
                  evidenceHash: input.evidenceHash,
                })
                const observation = records[input.check]
                if (!observation) return yield* new ToolFailure({ message: "Replay check does not exist" })
                return { observation, content: yield* observations.read({ ...input, handle: observation.handle }) }
              }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message }))),
          }),
          "read",
        ),
        contract_report_ready: Tool.withCapability(
          Tool.make({
            description:
              "Petition independent verification when the issuer's stopping rule is met and the frozen evidence policy can adjudicate its settlement claim. The goal governs effort; the claim governs finality. Replay spends one shared action and obeys the Contract deadline. Failed replay returns repair feedback without handing off or starting a new attempt. Use contract_check for non-settling replay feedback while still improving the candidate. State completed checks and unresolved assumptions that could materially affect the claim. Report blocked when work cannot proceed; petition revision only when approved terms actually need to change.",
            input: Schema.Struct({
              summary: Schema.NonEmptyString,
              uncertainties: Schema.Array(Schema.NonEmptyString),
            }),
            output: Schema.Struct({ recorded: Schema.Boolean, requested: Schema.optional(Schema.Literal(true)) }),
            execute: (input, context) =>
              Effect.gen(function* () {
                const authorized = yield* authorize(context)
                const contract = authorized.contract
                const profile = (yield* contracts.get(contract.id))?.recognition.context?.profile
                if (!profile) return yield* new ToolFailure({ message: "Contract recognition profile is unavailable" })
                if (profile !== "native") {
                  const handler = delivery.get(profile)
                  if (!handler) return yield* new ToolFailure({ message: "Contract delivery adapter is unavailable" })
                  yield* handler.request({
                    execution: authorized.execution,
                    ...input,
                    call: { messageID: context.assistantMessageID, callID: context.toolCallID },
                  })
                  return { recorded: false, requested: true as const }
                }
                const now = yield* Clock.currentTimeMillis
                const policy = contract.spec.evidence.replay
                if (policy && !(yield* bindings.reserveAction(context.sessionID, now, authorized.execution)))
                  return yield* new ToolFailure({ message: "Contract action budget exhausted" })
                const subjectHash = yield* snapshots.capture({ include: policy?.artifacts })
                if (!subjectHash) {
                  const message = "Contract handoff snapshot is unavailable"
                  const receipt = yield* bindings.control(
                    authorized.execution,
                    contracts.escalate({
                      contractID: contract.id,
                      revision: contract.revision,
                      reason: message,
                      time: now,
                    }),
                  )
                  if (receipt.decision.type === "rejected")
                    return yield* new ToolFailure({ message: receipt.decision.reason })
                  return yield* new ToolFailure({ message })
                }
                yield* authorize(context)
                const replay = policy
                  ? yield* replayVerifier
                      .verify({
                        contractID: contract.id,
                        policy,
                        subjectHash,
                      })
                      .pipe(
                        Effect.timeoutOrElse({
                          duration: Math.max(0, contract.spec.budget.deadline - (yield* Clock.currentTimeMillis)),
                          orElse: () =>
                            Effect.fail(
                              new ProContractReplay.Unavailable({ message: "Contract replay deadline exhausted" }),
                            ),
                        }),
                        Effect.catch((error) =>
                          Effect.gen(function* () {
                            const message = `Independent verification unavailable for ${subjectHash}: ${error.message}`
                            const receipt = yield* bindings.control(
                              authorized.execution,
                              contracts.escalate({
                                contractID: contract.id,
                                revision: contract.revision,
                                reason: message,
                                time: yield* Clock.currentTimeMillis,
                              }),
                            )
                            if (receipt.decision.type === "rejected")
                              return yield* new ToolFailure({ message: receipt.decision.reason })
                            return yield* new ToolFailure({ message })
                          }),
                        ),
                      )
                  : undefined
                if (replay && !replay.passed) {
                  yield* authorize(context)
                  return yield* new ToolFailure({
                    message: `${replay.summary}\nReplay evidence: ${replay.evidenceHash}; subject: ${replay.subjectHash}. No handoff was recorded. Repair the candidate within the existing Contract and remaining budget, then check or report ready again.`,
                  })
                }
                const receipt = yield* bindings.control(
                  authorized.execution,
                  contracts.reportReady({
                    contractID: authorized.execution.contractID,
                    revision: authorized.execution.revision,
                    summary: input.summary,
                    uncertainties: input.uncertainties,
                    subjectHash,
                    replay,
                    time: yield* Clock.currentTimeMillis,
                  }),
                )
                if (receipt.decision.type === "rejected")
                  return yield* new ToolFailure({ message: receipt.decision.reason })
                return { recorded: true }
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) }),
                ),
              ),
          }),
          "control",
        ),
        contract_report_blocked: Tool.withCapability(
          Tool.make({
            description:
              "Report that the active contract cannot proceed. This preserves the obligation and schedules retry or escalation.",
            input: Schema.Struct({ reason: Schema.NonEmptyString }),
            output: Schema.Struct({ recorded: Schema.Boolean }),
            execute: (input, context) =>
              Effect.gen(function* () {
                const authorized = yield* authorize(context)
                const receipt = yield* bindings.reportBlocked(authorized.execution, input.reason)
                if (receipt.decision.type === "rejected")
                  return yield* new ToolFailure({ message: receipt.decision.reason })
                return { recorded: true }
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) }),
                ),
              ),
          }),
          "control",
        ),
        contract_propose_revision: Tool.withCapability(
          Tool.make({
            description:
              "Petition the issuer only for a necessary change to the active Contract goal or handoff brief. Explain the concrete change and why the existing terms prevent the required work. Do not petition merely to record already-issued terms, plan implementation, or acknowledge later external evaluation. The current obligation remains authoritative until accepted; a pending decision can pause execution.",
            input: Schema.Struct({
              goal: Schema.NonEmptyString,
              brief: Schema.String.pipe(Schema.optional),
              reason: Schema.NonEmptyString,
            }),
            output: Schema.Struct({ recorded: Schema.Boolean }),
            execute: (input, context) =>
              Effect.gen(function* () {
                const authorized = yield* authorize(context)
                const contract = authorized.contract
                const spec = { ...contract.spec, goal: input.goal, brief: input.brief ?? contract.spec.brief }
                const receipt = yield* bindings.control(
                  authorized.execution,
                  contracts.petitionRevision({
                    contractID: contract.id,
                    spec,
                    reason: input.reason,
                  }),
                )
                if (receipt.decision.type === "rejected")
                  return yield* new ToolFailure({ message: receipt.decision.reason })
                // This continuation belongs to the issuer's exact petition, not to the revoked worker.
                // Its scope can outlive a worker drain; it has no provider, tool, or filesystem capability.
                const issuer = yield* Effect.gen(function* () {
                  const approved = yield* permissions
                    .assert({
                      action: "contract_revision",
                      resources: [ProContract.hashSpec(spec)],
                      metadata: { contractID: contract.id, goal: input.goal, reason: input.reason },
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: {
                        type: "tool",
                        messageID: context.assistantMessageID,
                        callID: context.toolCallID,
                      },
                    })
                    .pipe(
                      Effect.as(true),
                      Effect.catchTag("PermissionV2.BlockedError", () => Effect.succeed(false)),
                      Effect.catchTag("PermissionV2.CorrectedError", () => Effect.succeed(false)),
                      Effect.catchDefect((error) =>
                        error instanceof PermissionV2.DeclinedError ? Effect.succeed(false) : Effect.die(error),
                      ),
                    )
                  // The issuer response completes this petition, even after its executor lease has expired.
                  const decision = yield* contracts.decideRevision({
                    contractID: contract.id,
                    operationID: `revision:${contract.id}:${receipt.hash}`,
                    accept: approved,
                    expected: {
                      revision: contract.revision,
                      specHash: ProContract.hashSpec(ProContract.normalizeSpec(spec)),
                      petition: receipt.frontier,
                    },
                  })
                  if (decision.decision.type === "rejected")
                    return yield* new ToolFailure({ message: decision.decision.reason })
                  if (!approved)
                    return yield* new ToolFailure({
                      message: "Revision rejected by the principal; the original Contract remains authoritative",
                    })
                  return { recorded: true }
                }).pipe(
                  Effect.provideService(ExecutionContext.Current, undefined),
                  Effect.raceFirst(
                    Effect.gen(function* () {
                      while (true) {
                        const remaining = contract.spec.budget.deadline - (yield* Clock.currentTimeMillis)
                        const current = yield* contracts.get(contract.id)
                        if (
                          remaining <= 0 ||
                          !current ||
                          ["released", "discharged", "escalated"].includes(current.status)
                        )
                          return yield* Effect.interrupt
                        yield* Effect.sleep(Math.min(remaining, 1000))
                      }
                    }),
                  ),
                  Effect.forkIn(scope),
                )
                return yield* Fiber.join(issuer)
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) }),
                ),
              ),
          }),
          "control",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/contract-control",
  layer,
  deps: [
    ToolRegistry.node,
    PermissionV2.node,
    ProContract.node,
    ProContractDelivery.node,
    ProContractOpenCode.node,
    ProContractReplay.node,
    ProContractObservation.node,
    SessionStore.node,
    Snapshot.node,
  ],
})
