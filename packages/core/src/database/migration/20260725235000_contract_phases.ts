import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260725235000_contract_phases",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        UPDATE pro_contract
        SET status = 'escalated', data = json_set(data, '$.status', 'escalated')
        WHERE json_type(data, '$.escalation') = 'object';
      `)
      yield* tx.run(`
        UPDATE pro_contract
        SET status = 'verification',
          data = json_remove(json_set(data, '$.status', 'verification'), '$.escalation')
        WHERE json_extract(data, '$.escalation.reason') = 'Ready for verification'
          AND json_type(data, '$.handoff') = 'object';
      `)
    })
  },
} satisfies DatabaseMigration.Migration
