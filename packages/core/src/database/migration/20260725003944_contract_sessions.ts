import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260725003944_contract_sessions",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`pro_contract_opencode_session\` (
          \`session_id\` text PRIMARY KEY,
          \`contract_id\` text NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`pro_contract_opencode_session_contract_idx\` ON \`pro_contract_opencode_session\` (\`contract_id\`);`,
      )
      yield* tx.run(
        `INSERT INTO \`pro_contract_opencode_session\` (\`session_id\`, \`contract_id\`) SELECT \`session_id\`, \`contract_id\` FROM \`pro_contract_opencode\`;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
