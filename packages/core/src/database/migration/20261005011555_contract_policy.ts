import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261005011555_contract_policy",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`pro_contract_policy\` (
          \`scope\` text PRIMARY KEY,
          \`data\` text NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
