export * as ResearchCoordinator from "./coordinator"

import { Clock, Effect } from "effect"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { ResearchModel } from "./model"
import { ResearchStore } from "./store"

/** The host's phase lease fences admission as well as publication. I/O runs outside commit. */
export const make = Effect.gen(function* () {
  const state = yield* ResearchStore.Service
  const contracts = yield* ProContract.Service
  const guard = Effect.fnUntraced(function* (
    token: ResearchModel.Token,
    stage?: ResearchModel.Run["stage"],
    compute = true,
  ) {
    const run = yield* state.assert(token, stage)
    const contract = yield* contracts.get(run.id)
    if (
      !contract ||
      contract.specHash !== run.specHash ||
      contract.pendingRevision ||
      !ProContractRecognition.same(contract.recognition.context?.target, run.context) ||
      ["released", "discharged", "escalated"].includes(contract.status) ||
      (compute && (yield* Clock.currentTimeMillis) >= run.input.spec.budget.deadline)
    )
      return yield* new ResearchModel.Denied({ message: "Research phase, terms or original deadline changed" })
    return run
  })
  const commit = <A, E, R>(
    token: ResearchModel.Token,
    stage: ResearchModel.Run["stage"],
    effect: (run: ResearchModel.Run) => Effect.Effect<A, E, R>,
    compute = true,
  ) =>
    state.atomic(
      Effect.gen(function* () {
        return yield* effect(yield* guard(token, stage, compute))
      }),
    )
  return { guard, commit }
})
