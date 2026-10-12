export * as ProContractExecutionPolicy from "./execution-policy"

import { ConfigProContract } from "../config/pro-contract"
import r2v5 from "./r2-v5.txt" with { type: "text" }

// These are the exact frozen solver-policy bytes, not Contract terms or a new
// benchmark result. Selection never changes authority, budgets, or settlement.
export const R2V5 = r2v5

export function select(policy: string | undefined, config?: ConfigProContract.Info) {
  return policy ?? (config?.execution_policy === "r2-v5" ? R2V5 : undefined)
}
