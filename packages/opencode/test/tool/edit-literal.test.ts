import { describe, expect, test } from "bun:test"
import { replace } from "../../src/tool/edit"

describe("edit literal replacement", () => {
  for (const replaceAll of [false, true]) {
    for (const replacement of ["$$", "$&", "$`", "$'", "$1", "$<name>"]) {
      test(`preserves ${replacement} with replaceAll=${replaceAll}`, () => {
        expect(
          replace(
            replaceAll ? "prefix\nbefore\nmiddle\nbefore\nsuffix\n" : "prefix\nbefore\nsuffix\n",
            "before",
            replacement,
            replaceAll,
          ),
        ).toBe(
          replaceAll ? `prefix\n${replacement}\nmiddle\n${replacement}\nsuffix\n` : `prefix\n${replacement}\nsuffix\n`,
        )
      })
    }
  }
})
