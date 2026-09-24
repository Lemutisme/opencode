import { Schema, Option } from "effect"
import { reportReferencePaths, requiredReportReferences, type Oracle } from "./corpus"

const Report = Schema.Struct({
  effect: Schema.Number,
  conclusion: Schema.Literals(["positive", "negative", "indeterminate"]),
  causal: Schema.Boolean,
  controlPerformed: Schema.Boolean,
  randomizedControl: Schema.Boolean,
  limitations: Schema.NonEmptyString,
  evidence: Schema.NonEmptyArray(
    Schema.Struct({ path: Schema.Literals(reportReferencePaths), description: Schema.optional(Schema.NonEmptyString) }),
  ),
})

// Objective checks use retained raw observations and independently executed candidate output.
// Free-text method/limitations still require two blinded annotations before S6c correctness is final.
export function objective(oracle: Oracle, input: { report: string; raw: string; values?: readonly (number | null)[] }) {
  const report = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Report)))(input.report),
  )
  const raw = Option.getOrUndefined(
    Schema.decodeUnknownOption(
      Schema.UnknownFromJsonString.pipe(
        Schema.decodeTo(
          Schema.Struct({
            effect: Schema.Number,
            observations: Schema.Int,
            observationIDs: Schema.Array(Schema.String),
            primaryIDs: Schema.Array(Schema.String),
            split: Schema.Struct({
              train: Schema.Array(Schema.String),
              validation: Schema.Array(Schema.String),
              test: Schema.Array(Schema.String),
            }),
          }),
        ),
      ),
    )(input.raw),
  )
  return {
    structure: !!report && !!raw,
    boundaries: JSON.stringify(input.values) === JSON.stringify(oracle.outputs),
    numeric:
      !!report &&
      !!raw &&
      Math.abs(report.effect - oracle.expected.effect) <= 1e-12 &&
      Math.abs(raw.effect - oracle.expected.effect) <= 1e-12 &&
      raw.observations === oracle.population.observationIDs.length * 2,
    population:
      !!raw &&
      JSON.stringify(raw.observationIDs) === JSON.stringify(oracle.population.observationIDs) &&
      JSON.stringify(raw.primaryIDs) === JSON.stringify(oracle.population.primaryIDs) &&
      (["train", "validation", "test"] as const).every(
        (split) => JSON.stringify(raw.split[split]) === JSON.stringify(oracle.population.split[split]),
      ),
    conclusion: report?.conclusion === oracle.expected.conclusion,
    controls: report?.controlPerformed === oracle.expected.controlPerformed && report?.randomizedControl === false,
    causality: report?.causal === oracle.expected.causal,
    references:
      !!report && requiredReportReferences.every((file) => report.evidence.some((item) => item.path === file)),
    subjective: "requires_blind_annotations" as const,
  }
}
