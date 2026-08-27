import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260827174720_contract_formation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`pro_contract_formation\` (
          \`hash\` text PRIMARY KEY,
          \`root_contract_id\` text NOT NULL,
          \`data\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`pro_contract_formation_root_idx\` ON \`pro_contract_formation\` (\`root_contract_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
