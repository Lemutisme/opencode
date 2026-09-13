import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ProContractContext } from "@opencode-ai/core/pro-contract/context"
import { SystemContext } from "@opencode-ai/core/system-context"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("ProContract lifecycle context", () => {
  it.effect("keeps admission instructions out of already-bound execution", () =>
    Effect.gen(function* () {
      const admitted = yield* SystemContext.initialize(ProContractContext.make("admission"))
      const executing = yield* SystemContext.initialize(ProContractContext.make("execution"))
      expect(admitted.baseline).toContain("call contract_propose")
      expect(admitted.baseline).toContain("later external evaluation")
      expect(executing.baseline).toContain("Admission is complete")
      expect(executing.baseline).toContain("does not require another proposal or a revision")
      expect(executing.baseline).not.toContain("call contract_propose")
      expect(executing.baseline).not.toContain("when unsure, propose")
      expect(executing.snapshot["pro-contract/lifecycle"]).toMatchObject({ value: "execution" })
    }),
  )

  it.effect("records lifecycle changes without repeating unchanged guidance", () =>
    Effect.gen(function* () {
      const admitted = yield* SystemContext.initialize(ProContractContext.make("admission"))
      expect(yield* SystemContext.reconcile(ProContractContext.make("admission"), admitted.snapshot)).toEqual({
        _tag: "Unchanged",
      })
      const updated = yield* SystemContext.reconcile(ProContractContext.make("execution"), admitted.snapshot)
      expect(updated).toMatchObject({ _tag: "Updated", text: expect.stringContaining("Admission is complete") })
      expect(yield* SystemContext.reconcile(ProContractContext.make(undefined), admitted.snapshot)).toMatchObject({
        _tag: "Updated",
        text: expect.stringContaining("Existing Contract obligations and authority are unchanged"),
      })
      const empty = yield* SystemContext.initialize(ProContractContext.make(undefined))
      expect(empty).toEqual({ baseline: "", snapshot: {} })
    }),
  )
})
