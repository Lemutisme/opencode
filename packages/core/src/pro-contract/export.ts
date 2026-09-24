export * as ProContractExport from "./export"

import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { AppNodeBuilder } from "../effect/app-node-builder"
import { Global } from "../global"
import { Location } from "../location"
import { ProContract } from "../pro-contract"
import { AbsolutePath } from "../schema"
import { Snapshot } from "../snapshot"
import { ProContractOpenCode } from "./open-code"

export class Error extends Schema.TaggedErrorClass<Error>()("ProContractExport.Error", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly materialize: (input: {
    readonly contractID: ProContract.ID
    readonly directory: AbsolutePath
  }) => Effect.Effect<
    {
      readonly contractID: ProContract.ID
      readonly subjectHash: string
      readonly directory: AbsolutePath
      readonly target: ProContract.RecognitionTarget
    },
    Error | Snapshot.Error
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractExport") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const contracts = yield* ProContract.Service
    const bindings = yield* ProContractOpenCode.Service
    const global = yield* Global.Service

    return Service.of({
      materialize: Effect.fn("ProContractExport.materialize")(function* (input) {
        const contract = yield* contracts.get(input.contractID)
        if (!contract) return yield* new Error({ message: `Contract not found: ${input.contractID}` })
        const handoff = contract.handoff
        if (!handoff) return yield* new Error({ message: `Contract has no current handoff: ${input.contractID}` })
        const target = contract.recognition.handoff
        if (!target)
          return yield* new Error({ message: contract.recognition.unavailable ?? "Handoff identity unavailable" })
        const binding = yield* bindings.get(input.contractID)
        if (!binding) return yield* new Error({ message: `OpenCode execution not found: ${input.contractID}` })
        yield* Snapshot.Service.use((snapshots) =>
          snapshots.materialize({ snapshot: Snapshot.ID.make(handoff.subjectHash), directory: input.directory }),
        ).pipe(
          Effect.provide(
            AppNodeBuilder.build(Snapshot.node, [
              [Location.node, Location.boundNode(binding.location)],
              [Global.node, Layer.succeed(Global.Service, global)],
            ]).pipe(Layer.fresh),
          ),
        )
        return { contractID: input.contractID, subjectHash: handoff.subjectHash, directory: input.directory, target }
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [ProContract.node, ProContractOpenCode.node, Global.node],
})
