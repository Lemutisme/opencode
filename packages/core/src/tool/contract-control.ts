export * as ContractControlTools from "./contract-control"

import { ToolFailure } from "@opencode-ai/llm"
import { Clock, Effect, Exit, Layer, Schema } from "effect"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ProContract } from "../pro-contract"
import { ProContractOpenCode } from "../pro-contract/open-code"
import { ProContractReplay } from "../pro-contract/replay"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { Snapshot } from "../snapshot"
import { Hash } from "../util/hash"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const config = yield* Config.Service
    const contracts = yield* ProContract.Service
    const bindings = yield* ProContractOpenCode.Service
    const replayVerifier = yield* ProContractReplay.Service
    const permissions = yield* PermissionV2.Service
    const sessions = yield* SessionStore.Service
    const snapshots = yield* Snapshot.Service

    yield* tools
      .register({
        contract_propose: Tool.make({
          description:
            "Propose a persistent Contract when the request requires a future trigger, asynchronous or multi-Session work, durable follow-up, or later external evaluation. Set spec.goal to the current optimization objective, spec.policy only to an exact policy offered to future Contracts, and evidence.claim to the exact proposition the evidence may settle. When delivery evidence does not settle the intended quality claim, include evaluation so that dependent evaluation is persisted before execution starts. A requirement may set policy: true only when its discharged source Contract defines the principal-ratified spec.policy. An implementation Contract that promises a build command or user-named output artifact must include finite replay checks and every user-named artifact path. Do not guess implementation-specific source paths; the build check covers its inputs. Preserve user-supplied quality criteria and stopping rules in the brief. Budgets and attempt limits are exact shared ceilings; budget.deadline is an absolute Unix timestamp in milliseconds. The exact draft requires principal approval before it is issued.",
          input: Schema.Struct({
            spec: ProContract.Spec,
            evaluation: ProContract.EvaluationPlan.pipe(Schema.optional),
          }),
          output: Schema.Struct({
            contractID: ProContract.ID,
            sessionID: SessionSchema.ID,
            evaluationContractID: ProContract.ID.pipe(Schema.optional),
            formationHash: Schema.NonEmptyString,
          }),
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Contract ${output.contractID} was approved and scheduled in Session ${output.sessionID}.${output.evaluationContractID ? ` Evaluation ${output.evaluationContractID} remains outstanding until independent evidence settles the quality claim.` : ""} Stop work in this Session; the dedicated Contract executor now owns the obligation.`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const session = yield* sessions.get(context.sessionID)
              if (!session) return yield* new ToolFailure({ message: "Session not found" })
              if (!session.model)
                return yield* new ToolFailure({ message: "Contract proposal requires a selected model" })
              const now = yield* Clock.currentTimeMillis
              const request = (yield* sessions.context(context.sessionID)).find((item) => item.type === "user")?.text
              const compiled = ProContractOpenCode.compileSpec({
                spec: input.spec,
                request,
                configuredPolicy: Config.latest(yield* config.entries(), "contract_policy"),
                evaluation: input.evaluation,
              })
              if (compiled.type === "rejected") return yield* new ToolFailure({ message: compiled.reason })
              const spec = compiled.spec
              const key = Hash.sha256(`${context.sessionID}:${context.assistantMessageID}:${context.toolCallID}`)
              const contractID = ProContract.ID.make(`pct_${key}`)
              const specHash = compiled.specHash
              const formationHash = ProContractOpenCode.formationHash({
                id: contractID,
                scope: session.projectID,
                spec,
                location: session.location,
                model: session.model,
                evaluation: input.evaluation,
              })
              yield* permissions.assert({
                id: PermissionV2.ID.create(`per_${key}`),
                action: "contract_issue",
                resources: [formationHash],
                metadata: {
                  contractID,
                  specHash,
                  formationHash,
                  goal: spec.goal,
                  details: [
                    spec.brief ? `Brief: ${spec.brief}` : undefined,
                    spec.policy ? `Future policy: ${spec.policy}` : undefined,
                    `Trigger: ${JSON.stringify(spec.trigger)}`,
                    `Authority: ${spec.authority.join(", ")}`,
                    `Budget: ${spec.budget.turns} turns, ${spec.budget.actions} actions, deadline ${spec.budget.deadline}`,
                    `Requires: ${spec.requires.map((item) => `${item.contractID}@${item.revision}${item.policy ? " (policy)" : ""}`).join(", ") || "none"}`,
                    `Settlement claim: ${ProContract.evidenceClaim(spec)}`,
                    `Evidence: ${spec.evidence.type}${spec.evidence.replay ? ` + replay (${spec.evidence.replay.checks.length} checks)` : ""}`,
                    input.evaluation
                      ? `Evaluation: ${input.evaluation.evaluatorHash}, deadline ${input.evaluation.deadline}`
                      : "Evaluation: none; delivery settlement is final for this scope",
                    `Formation: ${formationHash}`,
                    `Compiler manifest: ${compiled.manifestHash}`,
                    `Resolution: ${spec.resolution.maxAttempts} attempts, ${spec.resolution.retryDelay} ms retry delay`,
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
                evaluation: input.evaluation,
                now,
              })
              if (issued.decision.type === "rejected")
                return yield* new ToolFailure({ message: issued.decision.reason })
              if (!issued.execution) return yield* new ToolFailure({ message: "Contract execution was not created" })
              return {
                contractID,
                sessionID: issued.execution.sessionID,
                evaluationContractID: issued.evaluation?.id,
                formationHash: issued.formationHash,
              }
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
        contract_report_ready: Tool.make({
          description:
            "Petition independent verification when the issuer's stopping rule is met and the frozen evidence policy can adjudicate its settlement claim. The goal governs effort; the claim governs finality. State completed checks and unresolved assumptions that could materially affect the claim. Use contract_report_blocked or contract_propose_revision when evidence cannot settle it.",
          input: Schema.Struct({
            summary: Schema.NonEmptyString,
            uncertainties: Schema.Array(Schema.NonEmptyString),
          }),
          output: Schema.Struct({ recorded: Schema.Boolean }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const binding = yield* bindings.forSession(context.sessionID)
              if (!binding) return yield* new ToolFailure({ message: "No Contract is bound to this Session" })
              const contract = yield* contracts.get(binding.contractID)
              if (!contract) return yield* new ToolFailure({ message: "Contract not found" })
              const now = yield* Clock.currentTimeMillis
              const policy = contract.spec.evidence.replay
              const subjectHash = yield* snapshots.capture({ include: policy?.artifacts })
              if (!subjectHash) {
                const message = "Contract handoff snapshot is unavailable"
                const receipt = yield* contracts.escalate({
                  contractID: contract.id,
                  revision: contract.revision,
                  reason: message,
                  time: now,
                })
                if (receipt.decision.type === "rejected")
                  return yield* new ToolFailure({ message: receipt.decision.reason })
                return yield* new ToolFailure({ message })
              }
              const replay = policy
                ? yield* replayVerifier
                    .verify({
                      contractID: contract.id,
                      policy,
                      subjectHash,
                    })
                    .pipe(
                      Effect.catch((error) =>
                        Effect.gen(function* () {
                          const message = `Independent verification unavailable for ${subjectHash}: ${error.message}`
                          const receipt = yield* contracts.escalate({
                            contractID: contract.id,
                            revision: contract.revision,
                            reason: message,
                            time: now,
                          })
                          if (receipt.decision.type === "rejected")
                            return yield* new ToolFailure({ message: receipt.decision.reason })
                          return yield* new ToolFailure({ message })
                        }),
                      ),
                    )
                : undefined
              const receipt = yield* contracts.reportReady({
                contractID: binding.contractID,
                revision: binding.revision,
                summary: input.summary,
                uncertainties: input.uncertainties,
                subjectHash,
                replay,
                time: now,
              })
              if (receipt.decision.type === "rejected")
                return yield* new ToolFailure({ message: receipt.decision.reason })
              if (replay && !replay.passed) return yield* new ToolFailure({ message: replay.summary })
              return { recorded: true }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) }),
              ),
            ),
        }),
        contract_report_blocked: Tool.make({
          description:
            "Report that the active contract cannot proceed. This preserves the obligation and schedules retry or escalation.",
          input: Schema.Struct({ reason: Schema.NonEmptyString }),
          output: Schema.Struct({ recorded: Schema.Boolean }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const binding = yield* bindings.forSession(context.sessionID)
              if (!binding) return yield* new ToolFailure({ message: "No Contract is bound to this Session" })
              const receipt = yield* contracts.reportBlocked({
                contractID: binding.contractID,
                revision: binding.revision,
                reason: input.reason,
                time: yield* Clock.currentTimeMillis,
              })
              if (receipt.decision.type === "rejected")
                return yield* new ToolFailure({ message: receipt.decision.reason })
              yield* bindings.reschedule({
                contractID: binding.contractID,
                revision: binding.revision,
                promptID: binding.promptID,
                reason: input.reason,
                now: yield* Clock.currentTimeMillis,
                attempt: "new",
              })
              return { recorded: true }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) }),
              ),
            ),
        }),
        contract_propose_revision: Tool.make({
          description:
            "Petition the issuer to revise the active contract goal or handoff brief. The current obligation remains authoritative until accepted.",
          input: Schema.Struct({
            goal: Schema.NonEmptyString,
            brief: Schema.String.pipe(Schema.optional),
            reason: Schema.NonEmptyString,
          }),
          output: Schema.Struct({ recorded: Schema.Boolean }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const binding = yield* bindings.forSession(context.sessionID)
              if (!binding) return yield* new ToolFailure({ message: "No Contract is bound to this Session" })
              const contract = yield* contracts.get(binding.contractID)
              if (!contract) return yield* new ToolFailure({ message: "Contract not found" })
              const spec = { ...contract.spec, goal: input.goal, brief: input.brief ?? contract.spec.brief }
              const receipt = yield* contracts.petitionRevision({
                contractID: contract.id,
                spec,
                reason: input.reason,
              })
              if (receipt.decision.type === "rejected")
                return yield* new ToolFailure({ message: receipt.decision.reason })
              const approved = Exit.isSuccess(
                yield* Effect.exit(
                  permissions.assert({
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
                  }),
                ),
              )
              const decision = yield* contracts.decideRevision({ contractID: contract.id, accept: approved })
              if (decision.decision.type === "rejected")
                return yield* new ToolFailure({ message: decision.decision.reason })
              if (!approved)
                return yield* new ToolFailure({
                  message: "Revision rejected by the principal; the original Contract remains authoritative",
                })
              return { recorded: true }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/contract-control",
  layer,
  deps: [
    ToolRegistry.node,
    Config.node,
    PermissionV2.node,
    ProContract.node,
    ProContractOpenCode.node,
    ProContractReplay.node,
    SessionStore.node,
    Snapshot.node,
  ],
})
