import { test } from "bun:test"
import { lifecycleCases, lifecycleFixture } from "./test/lifecycle"

for (const scenario of lifecycleCases)
  test(`lifecycle local-fixture upstream continuation: ${scenario}`, () => lifecycleFixture(scenario), 100_000)
