import { appendFileSync } from "node:fs"
import { Effect } from "effect"
import { ResearchIssuance } from "../../../../sdk-next/src/research/issuance"

await Effect.runPromise(
  ResearchIssuance.trace("pct_eval_interrupted", (event) =>
    appendFileSync(process.argv[2], JSON.stringify(event) + "\n", { flush: true }),
  )("snapshot_capture", Effect.never),
)
