export * as ProContractReason from "./reason"

import { Location } from "@opencode-ai/schema/location"
import { Model } from "@opencode-ai/schema/model"
import { Clock, Context, Effect, Exit, Layer, Schedule, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { ProContract } from "../pro-contract"
import { SessionV2 } from "../session"
import { SessionExecution } from "../session/execution"
import { SessionSchema } from "../session/schema"
import { ProContractOpenCode } from "./open-code"

export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("ProContractReason.Unavailable", {
  message: Schema.String,
}) {}

export const Observation = Schema.Struct({
  status: Schema.Literal("unverified"),
  contractID: ProContract.ID,
  sessionID: SessionSchema.ID,
  summary: Schema.NonEmptyString,
  subjectHash: Schema.optional(Schema.String),
  usage: Schema.Struct({ turns: Schema.Number, actions: Schema.Number, cost: Schema.Number }),
})
export type Observation = typeof Observation.Type

export interface Input {
  /** Stable identity derived by the host from the parent run and request, never from a fresh retry. */
  readonly id: ProContract.ID
  readonly scope: string
  readonly model: Model.Ref
  readonly authorization: ProContract.ExecutionAuthorization
  readonly prompt: string
  readonly deadline: number
  /** Host-owned private empty workspace; the candidate must not control this Location. */
  readonly location: Location.Ref
  readonly executionPolicy: string
}

export interface Interface {
  readonly run: (input: Input) => Effect.Effect<Observation, Unavailable>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractReason") {}

const retained = "Native reasoning observation (unverified):\n"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const contracts = yield* ProContract.Service
    const bindings = yield* ProContractOpenCode.Service
    const sessions = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service

    return Service.of({
      run: Effect.fn("ProContractReason.run")(function* (input) {
        const request = structuredClone(input)
        const now = yield* Clock.currentTimeMillis
        const spec = ProContract.Spec.make({
          trigger: { type: "immediate" },
          goal: "Produce an unverified reasoning observation, not an accepted research result",
          brief: request.prompt,
          requires: [],
          authority: [],
          budget: { deadline: request.deadline },
          evidence: { type: "principal", claim: "The observation was retained; its correctness is not attested" },
          // A transport failure requires a new explicit host decision, never a silently replayed request.
          resolution: { maxAttempts: 1, retryDelay: 0 },
        })
        const previous = yield* contracts.get(request.id)

        // The release event retains the exact observation, not a truth claim or a new acceptance primitive.
        // Historical reads need no still-live execution grant and cannot extend the original deadline.
        if (previous?.status === "released") {
          const binding = yield* bindings.get(request.id)
          if (
            previous.scope !== request.scope ||
            previous.specHash !== ProContract.hashSpec(spec) ||
            !binding ||
            !ProContractOpenCode.sameBinding(binding, { ...request, mode: "reason" })
          )
            return yield* new Unavailable({ message: "Native reasoning retry coordinates changed" })
          const record = (yield* contracts.history({ contractID: request.id })).findLast(
            (entry) =>
              entry.decision.type === "accepted" &&
              entry.command.type === "release" &&
              entry.command.reason.startsWith(retained),
          )
          if (!record || record.command.type !== "release")
            return yield* new Unavailable({ message: "Native reasoning was released without an observation" })
          const observation = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Observation))(
            record.command.reason.slice(retained.length),
          ).pipe(Effect.mapError(() => new Unavailable({ message: "Retained native observation is invalid" })))
          if (observation.contractID !== request.id || observation.sessionID !== binding.sessionID)
            return yield* new Unavailable({ message: "Retained native observation coordinates changed" })
          return observation
        }
        const receipt = yield* bindings.issue({ ...request, spec, mode: "reason", now })
        if (receipt.decision.type === "rejected") return yield* new Unavailable({ message: receipt.decision.reason })
        const admitted = receipt.execution
        if (!admitted || !receipt.contract)
          return yield* new Unavailable({ message: "Native reasoning execution was not admitted" })
        if (admitted.attempts > 0 || receipt.contract.status !== "dormant")
          return yield* new Unavailable({ message: "Native reasoning already started; automatic replay is forbidden" })
        if (now >= request.deadline) return yield* new Unavailable({ message: "Native reasoning deadline exhausted" })

        const activated = yield* contracts.activate(request.id, receipt.contract.revision, now)
        if (activated.decision.type === "rejected")
          return yield* new Unavailable({ message: activated.decision.reason })
        const claimed = yield* bindings.claim(request.id, now)
        if (!claimed) return yield* new Unavailable({ message: "Native reasoning execution could not be claimed" })

        return yield* Effect.gen(function* () {
          const session = yield* sessions.create({
            id: claimed.sessionID,
            location: request.location,
            model: request.model,
          })
          if (
            session.location.directory !== request.location.directory ||
            session.location.workspaceID !== request.location.workspaceID ||
            session.model?.id !== request.model.id ||
            session.model.providerID !== request.model.providerID ||
            (session.model.variant ?? "default") !== (request.model.variant ?? "default")
          )
            return yield* new Unavailable({ message: "Native reasoning Session coordinates changed" })
          yield* sessions.prompt({
            id: claimed.promptID,
            sessionID: claimed.sessionID,
            resume: false,
            delivery: "queue",
            prompt: {
              text: [
                "Return a text-only reasoning observation. It is not verified evidence, acceptance, or authorization.",
                `Frozen execution policy:\n${request.executionPolicy}`,
                `Request:\n${request.prompt}`,
              ].join("\n\n"),
            },
          })
          const maintain = Effect.gen(function* () {
            yield* bindings.heartbeat(new Set([claimed.sessionID]), yield* Clock.currentTimeMillis)
            if (
              !ProContractOpenCode.authorizationMatches(
                yield* contracts.get(request.authorization.contractID),
                request.authorization,
              )
            )
              return yield* new Unavailable({ message: "Native reasoning execution authorization withdrawn" })
          }).pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.andThen(Effect.never))
          const drained = yield* execution.resume(claimed.sessionID).pipe(Effect.exit, Effect.raceFirst(maintain))
          if (Exit.isFailure(drained))
            return yield* new Unavailable({ message: "Native reasoning execution did not complete" })

          const messages = (yield* sessions.messages({ sessionID: claimed.sessionID, order: "asc" })).filter(
            (message) => message.type === "assistant",
          )
          const contract = yield* contracts.get(request.id)
          const last = messages.at(-1)
          if (!last || last.error || (!contract?.handoff && last.finish !== "stop"))
            return yield* new Unavailable({ message: "Native reasoning did not finish an observation" })
          const summary =
            contract?.handoff?.summary ??
            last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
          if (!summary.trim()) return yield* new Unavailable({ message: "Native reasoning observation is empty" })
          const usage = yield* bindings.get(request.id)
          const observation = Observation.make({
            status: "unverified",
            contractID: request.id,
            sessionID: claimed.sessionID,
            summary,
            ...(contract?.handoff ? { subjectHash: contract.handoff.subjectHash } : {}),
            usage: {
              turns: usage?.turnsUsed ?? 0,
              actions: usage?.actionsUsed ?? 0,
              cost: messages.reduce((total, message) => total + (message.cost ?? 0), 0),
            },
          })
          const released = yield* contracts.release({
            contractID: request.id,
            reason: retained + JSON.stringify(observation),
          })
          if (released.decision.type === "rejected")
            return yield* new Unavailable({ message: released.decision.reason })
          return observation
        }).pipe(
          Effect.mapError((error) =>
            error instanceof Unavailable ? error : new Unavailable({ message: String(error) }),
          ),
          Effect.timeoutOrElse({
            duration: Math.max(0, request.deadline - (yield* Clock.currentTimeMillis)),
            orElse: () => Effect.fail(new Unavailable({ message: "Native reasoning deadline exhausted" })),
          }),
          Effect.onExit((exit) =>
            execution.interrupt(claimed.sessionID).pipe(
              Effect.andThen(
                Exit.isFailure(exit)
                  ? contracts.escalate({
                      contractID: request.id,
                      revision: claimed.revision,
                      reason: "Native reasoning failed or was cancelled; automatic replay is forbidden",
                      time: Date.now(),
                    })
                  : Effect.void,
              ),
            ),
          ),
        )
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [ProContract.node, ProContractOpenCode.node, SessionV2.node, SessionExecution.node],
})
