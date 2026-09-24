import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919001200_contract_jobs",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`pro_contract_job_session\` (
          \`session_id\` text PRIMARY KEY,
          \`job_id\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pro_contract_job\` (
          \`id\` text PRIMARY KEY,
          \`contract_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`data\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pro_contract_operation_usage\` (
          \`id\` text PRIMARY KEY,
          \`contract_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`job_id\` text,
          \`data\` text NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`pro_contract_job_contract_idx\` ON \`pro_contract_job\` (\`contract_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`pro_contract_job_session_idx\` ON \`pro_contract_job\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`pro_contract_operation_usage_contract_idx\` ON \`pro_contract_operation_usage\` (\`contract_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`pro_contract_operation_usage_job_idx\` ON \`pro_contract_operation_usage\` (\`job_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
