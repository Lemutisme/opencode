import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ConflictError } from "@opencode-ai/protocol/errors"
import { ProContractNotFoundError } from "@opencode-ai/protocol/groups/pro-contract"
import { Clock, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const ProContractHandler = HttpApiBuilder.group(Api, "server.proContract", (handlers) =>
  Effect.gen(function* () {
    const contracts = yield* ProContract.Service
    const bindings = yield* ProContractOpenCode.Service

    const requireContract = Effect.fnUntraced(function* (contractID: ProContract.ID) {
      const contract = yield* contracts.get(contractID)
      if (!contract)
        return yield* new ProContractNotFoundError({
          contractID,
          message: `Contract not found: ${contractID}`,
        })
      return contract
    })

    const receipt = (value: ProContract.Receipt) => {
      if (value.decision.type === "rejected") return Effect.fail(new ConflictError({ message: value.decision.reason }))
      return Effect.succeed({ frontier: value.frontier, hash: value.hash })
    }

    return handlers
      .handle(
        "proContract.issue",
        Effect.fn(function* (ctx) {
          const now = yield* Clock.currentTimeMillis
          const id = ctx.payload.id ?? ProContract.ID.create()
          const defaults = (yield* contracts.get(id))?.spec ?? ProContract.defaultSpec(ctx.payload.goal, now)
          if (
            ctx.payload.executionPolicy !== undefined &&
            ctx.payload.policy !== undefined &&
            ctx.payload.executionPolicy !== ctx.payload.policy
          )
            return yield* new ConflictError({ message: "execution policy aliases conflict", resource: id })
          const executionPolicy = ctx.payload.executionPolicy ?? ctx.payload.policy
          const spec = {
            trigger: ctx.payload.trigger ?? defaults.trigger,
            goal: ctx.payload.goal,
            brief: ctx.payload.brief ?? defaults.brief,
            requires: ctx.payload.requires ?? defaults.requires,
            authority: ctx.payload.authority ?? defaults.authority,
            budget: ctx.payload.budget ?? defaults.budget,
            evidence: ctx.payload.evidence ?? defaults.evidence,
            resolution: ctx.payload.resolution ?? defaults.resolution,
          }
          const issued = yield* bindings.issue({
            id,
            scope: ctx.payload.scope,
            spec,
            location: ctx.payload.location,
            model: ctx.payload.model,
            executionPolicy,
            now,
          })
          if (issued.decision.type === "rejected")
            return yield* new ConflictError({ message: issued.decision.reason, resource: ctx.payload.id })
          const contract = issued.contract
          if (!contract) return yield* Effect.die("Accepted contract was not loaded")
          const execution = issued.execution
          if (!execution) return yield* Effect.die("Accepted contract execution was not created")
          if (
            execution.location.directory !== ctx.payload.location.directory ||
            execution.location.workspaceID !== ctx.payload.location.workspaceID ||
            execution.model.providerID !== ctx.payload.model.providerID ||
            execution.model.id !== ctx.payload.model.id ||
            execution.model.variant !== ctx.payload.model.variant ||
            execution.executionPolicy !== executionPolicy
          )
            return yield* new ConflictError({ message: "contract execution binding does not match", resource: id })
          return {
            data: ProContract.info(contract),
            execution,
            receipt: { frontier: issued.frontier, hash: issued.hash },
          }
        }),
      )
      .handle(
        "proContract.list",
        Effect.fn(function* (ctx) {
          return { data: (yield* contracts.list(ctx.query.scope)).map(ProContract.info) }
        }),
      )
      .handle(
        "proContract.quiet",
        Effect.fn(function* (ctx) {
          return yield* contracts.quiet(ctx.query.scope)
        }),
      )
      .handle(
        "proContract.get",
        Effect.fn(function* (ctx) {
          return { data: ProContract.info(yield* requireContract(ctx.params.contractID)) }
        }),
      )
      .handle(
        "proContract.execution",
        Effect.fn(function* (ctx) {
          yield* requireContract(ctx.params.contractID)
          const execution = yield* bindings.get(ctx.params.contractID)
          if (!execution)
            return yield* new ProContractNotFoundError({
              contractID: ctx.params.contractID,
              message: `OpenCode execution not found: ${ctx.params.contractID}`,
            })
          return execution
        }),
      )
      .handle(
        "proContract.attest",
        Effect.fn(function* (ctx) {
          yield* requireContract(ctx.params.contractID)
          return yield* contracts
            .principalAttest({ contractID: ctx.params.contractID, ...ctx.payload })
            .pipe(Effect.flatMap(receipt))
        }),
      )
      .handle(
        "proContract.challenge",
        Effect.fn(function* (ctx) {
          yield* requireContract(ctx.params.contractID)
          return yield* contracts
            .challenge({
              contractID: ctx.params.contractID,
              revision: ctx.payload.revision,
              subjectHash: ctx.payload.subjectHash,
              evidenceHash: ctx.payload.evidenceHash,
              disclosure: ctx.payload.disclosure,
              summary: ctx.payload.summary,
              time: yield* Clock.currentTimeMillis,
            })
            .pipe(Effect.flatMap(receipt))
        }),
      )
      .handle(
        "proContract.decideRevision",
        Effect.fn(function* (ctx) {
          yield* requireContract(ctx.params.contractID)
          const decision = yield* contracts.decideRevision({
            contractID: ctx.params.contractID,
            accept: ctx.payload.accept,
          })
          return yield* receipt(decision)
        }),
      )
      .handle(
        "proContract.release",
        Effect.fn(function* (ctx) {
          yield* requireContract(ctx.params.contractID)
          return yield* contracts
            .release({ contractID: ctx.params.contractID, reason: ctx.payload.reason })
            .pipe(Effect.flatMap(receipt))
        }),
      )
      .handle(
        "proContract.resume",
        Effect.fn(function* (ctx) {
          yield* requireContract(ctx.params.contractID)
          return yield* contracts.resume(ctx.params.contractID).pipe(Effect.flatMap(receipt))
        }),
      )
  }),
)
