import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { ProContract } from "@opencode-ai/schema/pro-contract"
import { Timestamps } from "../database/schema.sql"
import type { Command, Contract, Decision } from "./kernel"
import type { Binding } from "./open-code"
import type { Job, Operation } from "./job"

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

export const ProContractContextTable = sqliteTable(
  "pro_contract_context",
  {
    contract_id: text().notNull(),
    version: integer().notNull(),
    data: text({ mode: "json" }).$type<ProContract.RecognitionContext>().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [primaryKey({ columns: [table.contract_id, table.version] })],
)

export const ProContractOperationTable = sqliteTable("pro_contract_operation", {
  operation_id: text().primaryKey(),
  fingerprint: text().notNull(),
})

// Conflicting uses of a global operation ID retain their own immutable rejection receipt.
export const ProContractAttemptTable = sqliteTable(
  "pro_contract_attempt",
  {
    operation_id: text().notNull(),
    fingerprint: text().notNull(),
    contract_id: text().notNull(),
    kind: text().notNull(),
    receipt: text({ mode: "json" }).$type<Omit<ProContract.OperationReceipt, "replayed">>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.operation_id, table.fingerprint] })],
)

export const ProContractJobTable = sqliteTable(
  "pro_contract_job",
  {
    id: text().primaryKey(),
    contract_id: text().notNull(),
    session_id: text().notNull(),
    data: text({ mode: "json" }).$type<Job>().notNull(),
  },
  (table) => [
    index("pro_contract_job_contract_idx").on(table.contract_id),
    uniqueIndex("pro_contract_job_session_idx").on(table.session_id),
  ],
)

// This marker survives unavailable job data and completed/cancelled executions.
export const ProContractJobSessionTable = sqliteTable("pro_contract_job_session", {
  session_id: text().primaryKey(),
  job_id: text().notNull(),
})

export const ProContractOperationUsageTable = sqliteTable(
  "pro_contract_operation_usage",
  {
    id: text().primaryKey(),
    contract_id: text().notNull(),
    session_id: text().notNull(),
    job_id: text(),
    data: text({ mode: "json" }).$type<Operation>().notNull(),
  },
  (table) => [
    index("pro_contract_operation_usage_contract_idx").on(table.contract_id),
    index("pro_contract_operation_usage_job_idx").on(table.job_id),
  ],
)
