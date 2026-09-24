import { Schema } from "effect"
import { sealCandidate, finalizeScoring, revealFeedback } from "./evaluate"
import { sealTerminal } from "./terminal"
import { recognize } from "./recognize"
import { qualification } from "./qualification"

const Annotation = Schema.Struct({
  rater: Schema.NonEmptyString,
  candidateHash: Schema.NonEmptyString,
  rubricHash: Schema.NonEmptyString,
  items: Schema.Record(Schema.String, Schema.NullOr(Schema.Boolean)),
})
const Ratings = Schema.Struct({ first: Annotation, second: Annotation, resolution: Schema.optional(Annotation) })

if (import.meta.main) {
  const [command, directory, argument] = process.argv.slice(2)
  if (
    !directory ||
    !["seal-candidate", "seal-terminal", "score-reviewer", "reveal-feedback", "recognize", "report"].includes(
      command,
    ) ||
    (!["recognize", "reveal-feedback", "seal-terminal"].includes(command) && !argument)
  )
    throw new Error(
      "Usage: bun rating.ts seal-candidate|score-reviewer INSTANCE RATINGS.json | seal-terminal INSTANCE | reveal-feedback INSTANCE | recognize INSTANCE | report COHORT NEW_REPORT_DIRECTORY",
    )
  if (command === "report") console.log(JSON.stringify(await qualification(directory, argument), null, 2))
  else if (command === "seal-terminal") console.log(JSON.stringify(await sealTerminal(directory), null, 2))
  else if (command === "reveal-feedback") console.log(JSON.stringify(await revealFeedback(directory), null, 2))
  else if (command === "recognize")
    console.log(JSON.stringify(await recognize({ directory, bun: process.execPath, timeout: 30_000 }), null, 2))
  else {
    const ratings = Schema.decodeUnknownSync(Ratings, { onExcessProperty: "error" })(await Bun.file(argument).json())
    console.log(
      JSON.stringify(
        await (command === "seal-candidate" ? sealCandidate : finalizeScoring)({ directory, ...ratings }),
        null,
        2,
      ),
    )
  }
}
