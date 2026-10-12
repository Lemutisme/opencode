export * as ConfigProContract from "./pro-contract"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("Config.ProContract")({
  execution_policy: Schema.Union([Schema.Literal("r2-v5"), Schema.Literal(false)])
    .pipe(Schema.optional)
    .annotate({
      description:
        "Opt into the frozen R2 v5 behavior-matching strategy for future interactive Contracts. Omitted or false leaves execution policy unset; does not grant authority or approve Contract formation.",
    }),
}) {}
