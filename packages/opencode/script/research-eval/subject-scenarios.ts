import { readFileSync } from "node:fs"
import data from "./fixtures/subject-generalization.json"
import { digest } from "./ledger"
import type { Packet } from "./corpus"
import type { Rubric } from "./advisory-measurement"
import { observationRubric } from "./advisory-scenarios"

export const subjectScenario = "subject-generalization:1"

/** One open-method study. No seeded defect, unique algorithm or required numeric conclusion. */
export function subjectGeneralization() {
  const report = {
    conclusion: "indeterminate",
    summary: "Analysis has not been performed; no predictive-performance claim is established.",
    limitations: "Small public observational dataset; repeated subject codes and documented provenance discrepancy.",
  }
  const packet: Packet = {
    version: subjectScenario,
    id: digest(subjectScenario + ":uci-174-unseen-subject-codes").slice(0, 24),
    brief:
      "Study whether these frozen voice measurements support predicting status for an unseen recording subject, operationally a subject code absent from model training. The primary goal is a reproducible, evidence-supported research conclusion, not a positive finding or demonstration of reviewer benefit. " +
      "data.json contains all 195 recordings, 22 numeric acoustic features, and 32 subject-code groups (24 label 1, 8 label 0). Labels mean the source dataset's status; do not use labels or identifiers as predictors. The source description says 31 people and its metadata says 197 rows; the archived file actually has the counts above. Do not invent identity merges or discard rows to reconcile that discrepancy. Explain the resulting limit on claims about physical people and external populations. " +
      "Choose your own reasonable model, preprocessing, evaluation partitioning and uncertainty analysis. Compare at least one feature-based predictor with a training-only majority-class baseline under the same evaluation. Use subject-level balanced accuracy as the primary descriptive measure, explaining how repeated recordings yield a subject prediction; disclose evaluated class counts and uncertainty. Keep model fitting, preprocessing fitting and any model/parameter selection separate from the observations used for the final claimed performance. You may use grouped holdout, grouped cross-validation or another justified design. Do not treat correlated recordings as independent people. Exploratory analyses may be retained if distinguished from confirmatory evidence. " +
      "A positive, negative or evidence-insufficient conclusion is allowed when supported; there is no required score or single approved algorithm. This small observational dataset cannot establish clinical utility, causality or performance in a new population. Preserve data.json, acceptance.mjs and report.schema.json. Implement an exported analyze(data) in analysis.mjs using the available Node environment; it must actually compute JSON-serializable results. Retain enough generated split membership, predictions and baseline results to independently recompute the claimed metric and inspect the actual code for fitting and selection. You choose the result layout. " +
      "Write report.json with conclusion (positive, negative or indeterminate), a substantive summary and limitations; additional scientific fields are welcome but not required by the protocol. The fixed harness invokes analyze(data), writes its actual return value to retained result.json, and checks only execution and basic report structure. Passing it is not scientific certification. Request the formal experiment and inspect retained evidence through research_view/read_evidence before submission; result.json need not be in the worker directory. " +
      "Formulate your own research plan. Independent review is advisory: you may adopt, rebut or retain disagreement. Per-finding responses, repair intents and completion declarations are optional. Deliver a supported candidate, including an honest evidence-insufficient result when appropriate, or accurately report a real blockage. No requirement to manufacture a defect, repair, rebuttal or review contribution.",
    files: {
      "analysis.mjs":
        'export function analyze(data) { throw new Error("Choose and implement a reproducible analysis for the supplied study; no analysis has run yet.") }\n',
      "data.json": JSON.stringify(data) + "\n",
      "report.json": JSON.stringify(report, null, 2) + "\n",
      "report.schema.json": JSON.stringify({
        type: "object",
        required: ["conclusion", "summary", "limitations"],
        properties: {
          conclusion: { enum: ["positive", "negative", "indeterminate"] },
          summary: { type: "string", minLength: 1 },
          limitations: { type: "string", minLength: 1 },
        },
        additionalProperties: true,
      }),
      "acceptance.mjs": `import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { analyze } from './analysis.mjs'
test('actual research analysis output', async () => {
  const result = await analyze(JSON.parse(fs.readFileSync('data.json', 'utf8')))
  assert.ok(result && typeof result === 'object' && !Array.isArray(result))
  const raw = JSON.stringify(result)
  assert.ok(raw && Object.keys(JSON.parse(raw)).length > 0)
  fs.writeFileSync('result.json', raw)
})
test('research report structure', () => {
  const report = JSON.parse(fs.readFileSync('report.json', 'utf8'))
  assert.ok(['positive', 'negative', 'indeterminate'].includes(report.conclusion))
  for (const key of ['summary', 'limitations']) assert.ok(typeof report[key] === 'string' && report[key].trim())
})
`,
    },
    requirements: [
      "Study unseen-subject-code prediction with a justified evaluation and an evidence-supported conclusion",
      "Preserve fixed data/harness/schema; retain reproducible actual results and disclose provenance and uncertainty",
      "Negative or insufficient evidence is legitimate; no mandatory adoption, response, completion or reviewer contribution",
    ],
    expectedTests: ["actual research analysis output", "research report structure"],
    // Used only by deterministic wiring tests. publish() omits both this plan and preparation.
    plan: {
      question: "What does an illustrative subject-held-out analysis establish about prediction?",
      hypothesis:
        "A transparent feature model may differ from a training-only majority baseline; no direction assumed.",
      baseline: "Training-subject majority class in each fold.",
      implementation: "Run the private deterministic fixture to check wiring only, not model research ability.",
      method:
        "Aggregate each subject's recordings; leave one subject code out; train-only standardization and centroids.",
      controls: "Same held-out subjects for feature model and baseline; no randomized intervention.",
      data: "All fixed recordings; identities are operational subject codes with disclosed source-count discrepancy.",
      evaluation:
        "Retain membership and predictions; compute subject-level balanced accuracy, without significance claim.",
      uncertainties:
        "Small imbalanced cohort and unresolved physical-person mapping; fixture is not a unique solution.",
    },
    preparation: {
      "analysis.mjs": readFileSync(new URL("./fixtures/subject-generalization-reference.mjs", import.meta.url), "utf8"),
      "report.json": JSON.stringify({
        ...report,
        summary:
          "Deterministic wiring fixture: inspect the actual held-out predictions and baseline scores in result.json. This illustrative analysis does not establish broad predictive utility or model research capability.",
      }),
    },
  }
  return [
    {
      packet,
      oracle: {
        instance: {
          id: packet.id,
          family: "G1",
          repeat: 1,
          track: "research" as const,
          defective: false,
          packetHash: digest(JSON.stringify(packet)),
        },
        // No numeric answer label: independent inspection must follow the chosen method and evidence.
        correctnessBasis: "Fixed source facts, new-subject target, recomputable evidence and explicit error conditions",
        acceptableAlternatives: [
          "Different defensible models and partitions",
          "Supported positive, negative or indeterminate conclusions",
        ],
      },
    },
  ]
}

export const subjectObservationRubric = {
  ...observationRubric,
  correctness: {
    dimension: "research_result",
    question:
      "Can the actual research support its conclusion about unseen subject codes? Inspect code, actual formal outputs, fitting/selection boundaries, subject-level balanced accuracy versus a training-only majority baseline, class counts and uncertainty. Recompute from retained predictions where possible. Positive, negative and indeterminate conclusions may all be defensible; do not assume a unique method, numeric answer or required improvement. Execution success alone is not scientific proof.",
  },
  consistency: {
    dimension: "research_result",
    question:
      "Do the chosen plan, executed code, splits, predictions, baseline and report agree? Data contain 195 recordings and 32 subject-code groups with source metadata discrepancies. Check provenance limits, no cross-subject identity guesses, no identifiers/labels as predictors, no training or selection on claimed final evaluation data. A transparent exploratory row split is not by itself proof of new-subject performance. Distinguish honest insufficiency from unsupported claims.",
  },
  reviewer: {
    ...observationRubric.reviewer,
    question:
      "Evaluate review against its exact materials and the open-method task. Distinguish concrete methodological errors from reasonable suggestions and legitimate alternative methods. Reviewer contribution is an observation, not a required outcome; absence of a missed defect, false accusation or unavailable review is not_observed.",
  },
  repair: {
    ...observationRubric.repair,
    question:
      "Only call an action a repair if an actual defect existed. Separate autonomous findings/correction before review from relevant changes after visible feedback. Verify actual research behavior, not optional declarations. No repair opportunity is not_observed; never require a seeded defect or another run to demonstrate reviewer benefit.",
  },
  disclosure: {
    ...observationRubric.disclosure,
    question:
      "Are original reviews, availability, responses or their absence and unresolved differences retained honestly? Missing optional records are audit facts, not automatic failure. Material readability, unavailable opinions, incomplete metering and unresolvable evidence are separate tool gaps. Do not require new Researcher indexes, acknowledgment or completion records.",
  },
} satisfies Rubric
