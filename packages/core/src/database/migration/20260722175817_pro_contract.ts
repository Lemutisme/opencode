import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260722175817_pro_contract",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`pro_contract_attestation\` (
          \`id\` text PRIMARY KEY,
          \`contract_id\` text NOT NULL,
          \`data\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pro_contract_event\` (
          \`seq\` integer PRIMARY KEY,
          \`contract_id\` text NOT NULL,
          \`command\` text NOT NULL,
          \`decision\` text NOT NULL,
          \`previous_hash\` text NOT NULL,
          \`hash\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pro_contract_ledger\` (
          \`id\` integer PRIMARY KEY,
          \`head_seq\` integer NOT NULL,
          \`head_hash\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pro_contract\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`status\` text NOT NULL,
          \`data\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pro_contract_opencode\` (
          \`contract_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`data\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`pro_contract_attestation_contract_idx\` ON \`pro_contract_attestation\` (\`contract_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`pro_contract_event_contract_seq_idx\` ON \`pro_contract_event\` (\`contract_id\`,\`seq\`);`,
      )
      yield* tx.run(`CREATE INDEX \`pro_contract_scope_status_idx\` ON \`pro_contract\` (\`scope\`,\`status\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`pro_contract_opencode_session_idx\` ON \`pro_contract_opencode\` (\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
