import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { ProContract } from "@opencode-ai/schema/pro-contract"
import { Timestamps } from "../database/schema.sql"
import type { Command, Contract, Decision } from "./kernel"
import type { Binding } from "./open-code"

export const ProContractTable = sqliteTable(
  "pro_contract",
  {
    id: text().primaryKey(),
    scope: text().notNull(),
    status: text().$type<Contract["status"]>().notNull(),
    data: text({ mode: "json" }).$type<Contract>().notNull(),
    ...Timestamps,
  },
  (table) => [index("pro_contract_scope_status_idx").on(table.scope, table.status)],
)

export const ProContractOpenCodeTable = sqliteTable(
  "pro_contract_opencode",
  {
    contract_id: text().primaryKey(),
    session_id: text().notNull(),
    data: text({ mode: "json" }).$type<Binding>().notNull(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("pro_contract_opencode_session_idx").on(table.session_id)],
)

export const ProContractOpenCodeSessionTable = sqliteTable(
  "pro_contract_opencode_session",
  {
    session_id: text().primaryKey(),
    contract_id: text().notNull(),
  },
  (table) => [index("pro_contract_opencode_session_contract_idx").on(table.contract_id)],
)

export const ProContractAttestationTable = sqliteTable(
  "pro_contract_attestation",
  {
    id: text().primaryKey(),
    contract_id: text().notNull(),
    data: text({ mode: "json" }).$type<ProContract.Attestation>().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [index("pro_contract_attestation_contract_idx").on(table.contract_id)],
)

export const ProContractEventTable = sqliteTable(
  "pro_contract_event",
  {
    seq: integer().primaryKey(),
    contract_id: text().notNull(),
    command: text({ mode: "json" }).$type<Command>().notNull(),
    decision: text({ mode: "json" }).$type<Decision>().notNull(),
    previous_hash: text().notNull(),
    hash: text().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [index("pro_contract_event_contract_seq_idx").on(table.contract_id, table.seq)],
)

export const ProContractLedgerTable = sqliteTable("pro_contract_ledger", {
  id: integer().primaryKey(),
  head_seq: integer().notNull(),
  head_hash: text().notNull(),
})
