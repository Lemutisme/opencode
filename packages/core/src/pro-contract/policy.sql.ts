import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { State } from "./policy"

export const ProContractPolicyTable = sqliteTable("pro_contract_policy", {
  scope: text().primaryKey(),
  data: text({ mode: "json" }).$type<State>().notNull(),
})
