import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260918220926_contract_recognition",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`pro_contract_attempt\` (
          \`operation_id\` text NOT NULL,
          \`fingerprint\` text NOT NULL,
          \`contract_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`receipt\` text NOT NULL,
          CONSTRAINT \`pro_contract_attempt_pk\` PRIMARY KEY(\`operation_id\`, \`fingerprint\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pro_contract_context\` (
          \`contract_id\` text NOT NULL,
          \`version\` integer NOT NULL,
          \`data\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`pro_contract_context_pk\` PRIMARY KEY(\`contract_id\`, \`version\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pro_contract_operation\` (
          \`operation_id\` text PRIMARY KEY,
          \`fingerprint\` text NOT NULL
        );
      `)
      // Existing contracts predate profiles. Preserve their ledger and projection bytes;
      // recognition reads still verify this recovered handoff against the complete ledger.
      yield* tx.run(`
        INSERT INTO pro_contract_context (contract_id, version, data, time_created)
        SELECT c.id, 1, json_object(
          'target', json_patch(json_object(
            'revision', json_extract(c.data, '$.revision'),
            'specHash', json_extract(c.data, '$.specHash'),
            'version', 1, 'phaseID', 'migration:' || c.id
          ), CASE WHEN json_type(c.data, '$.handoff') = 'object' THEN json_object(
            'handoffID', (SELECT 'pch_' || e.hash FROM pro_contract_event e
              WHERE e.contract_id = c.id AND json_extract(e.command, '$.type') = 'report-ready'
                AND json_extract(e.decision, '$.type') = 'accepted'
                AND coalesce(json_extract(e.command, '$.replay.passed'), 1) = 1
              ORDER BY e.seq DESC LIMIT 1)
          ) ELSE '{}' END),
          'profile', 'native', 'referenceHash', 'none', 'admitted', json('true')
        ), c.time_created FROM pro_contract c;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
