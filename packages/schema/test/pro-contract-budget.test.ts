import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ProContract } from "../src/pro-contract"

test("deadline-only budgets omit count ceilings without a finite sentinel", () => {
  const decode = Schema.decodeUnknownSync(ProContract.Budget)
  expect(decode({ deadline: 21_600_000 })).toEqual({ deadline: 21_600_000 })
  expect(Schema.encodeSync(ProContract.Budget)({ turns: undefined, actions: undefined, deadline: 21_600_000 })).toEqual(
    {
      deadline: 21_600_000,
    },
  )
  expect(decode({ turns: 3, deadline: 21_600_000 })).toEqual({ turns: 3, deadline: 21_600_000 })
  expect(decode({ actions: 4, deadline: 21_600_000 })).toEqual({ actions: 4, deadline: 21_600_000 })
  expect(decode({ turns: 3, actions: 4, deadline: 21_600_000 })).toEqual({
    turns: 3,
    actions: 4,
    deadline: 21_600_000,
  })
  expect(() => decode({})).toThrow()
  expect(() => decode({ turns: null, deadline: 21_600_000 })).toThrow()
  expect(() => decode({ turns: 0, deadline: 21_600_000 })).toThrow()
  expect(() => decode({ actions: -1, deadline: 21_600_000 })).toThrow()
  expect(() => decode({ actions: Infinity, deadline: 21_600_000 })).toThrow()
})

test("resolution can omit the cumulative attempt ceiling while retaining finite historical limits", () => {
  const decode = Schema.decodeUnknownSync(ProContract.Resolution)
  expect(decode({ retryDelay: 1 })).toEqual({ retryDelay: 1 })
  expect(Schema.encodeSync(ProContract.Resolution)({ maxAttempts: undefined, retryDelay: 1 })).toEqual({
    retryDelay: 1,
  })
  expect(decode({ maxAttempts: 3, retryDelay: 1 })).toEqual({ maxAttempts: 3, retryDelay: 1 })
  for (const maxAttempts of [0, -1, Infinity, null]) expect(() => decode({ maxAttempts, retryDelay: 1 })).toThrow()
})
