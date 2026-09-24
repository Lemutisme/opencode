export * as ProContractOperationAudit from "./operation-audit"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { ProContractOperationUsageTable } from "./sql"

/** Call inside the transaction that proves this exact execution lease has expired. */
export const expire = (db: Database.Interface["db"], contractID: string, identity: string, now: number) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(ProContractOperationUsageTable)
      .where(eq(ProContractOperationUsageTable.contract_id, contractID))
      .all()
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      rows.filter((row) => row.data.source.identity === identity && row.data.status === "running"),
      (row) =>
        db
          .update(ProContractOperationUsageTable)
          .set({ data: { ...row.data, status: "unknown", endedAt: now } })
          .where(eq(ProContractOperationUsageTable.id, row.id))
          .run()
          .pipe(Effect.orDie),
    )
  })
