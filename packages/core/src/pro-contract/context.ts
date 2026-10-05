export * as ProContractContext from "./context"

import { Effect, Schema } from "effect"
import { SystemContext } from "../system-context"

const Mode = Schema.Literals(["admission", "execution"])

export function make(mode: typeof Mode.Type | undefined) {
  if (mode === undefined) return SystemContext.empty
  return SystemContext.make({
    key: SystemContext.Key.make("pro-contract/lifecycle"),
    codec: Mode,
    load: Effect.succeed(mode),
    baseline: guidance,
    update: (_previous, current) => guidance(current),
    removed: () =>
      "Automatic Contract admission guidance no longer applies to this agent. Existing Contract obligations and authority are unchanged.",
  })
}

function guidance(mode: typeof Mode.Type) {
  if (mode === "execution")
    return (
      "Contract execution: this Session is already bound to an issued Contract. Admission is complete. Execute the existing goal and stopping rule within its approved authority and shared budget. Later external evaluation does not require another proposal or a revision. Use configured public replay feedback to repair the candidate, not to rewrite the terms. A sealed external evaluator does not return repair feedback: report_ready is the final submission for this attempt. Do not defer a known unmet requirement expecting hidden-grader feedback. General tool/dependency installation is distinct from prohibited benchmark-answer retrieval. Petition revision only when the approved terms actually need to change. A passing public check is not settlement." +
      (process.env.OPENCODE_STRATEGY_PORTFOLIO === "1"
        ? " The execution-policy portfolio is enabled: declare task-grounded criteria with strategy_plan, use strategy_verify to obtain real observations and routing, and recover its durable state with strategy_status after compaction. Before report_ready, all declared public checks must pass on an unchanged candidate. Check-method revisions require a reason and cannot remove task requirements."
        : "")
    )
  return "Contract admission: this Session is not bound to an issued Contract. Before using effectful tools, call contract_propose when the request requires a future trigger, asynchronous or multi-Session work, durable follow-up, or later external evaluation. Keep the optimization goal separate from the exact evidence claim that may be settled. An implementation Contract that promises a build command or user-named output artifact must include finite replay checks and every user-named artifact path. Do not guess implementation-specific source paths; the build check covers its inputs. Use principal-only evidence only when no honest mechanical criterion exists. Preserve user-provided quality criteria, evaluation protocols, stopping rules, and assumptions in spec.brief. Do not invent generic exploration, edge-case, or validation requirements; execution policy is supplied separately. Proceed normally only when both work and validation finish in this Session; when unsure, propose."
}
