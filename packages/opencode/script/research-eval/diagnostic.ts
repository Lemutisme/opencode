import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Option, Schema } from "effect"
import { execute } from "./isolation"
import { expectedDiagnostic, interventions, type DiagnosticData } from "./scenarios"

const Result = Schema.Struct({
  threshold: Schema.Finite,
  selectionIDs: Schema.Array(Schema.String),
  evaluationIDs: Schema.Array(Schema.String),
  testContrast: Schema.Finite,
})
const Evidence = Schema.Struct({
  exploratory: Schema.Struct({
    status: Schema.Literals(["retained", "removed"]),
    rationale: Schema.NonEmptyString,
    actual: Schema.optional(Result),
  }),
})

/** Execute untrusted code with inputs only, never the scorer or expected outputs. */
export async function diagnostic(input: {
  launcher: string
  directory: string
  source: string
  report: string
  raw: string
  data: DiagnosticData
  timeout: number
}) {
  const decode = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Evidence)))
  const report = Option.getOrUndefined(decode(input.report))?.exploratory
  const raw = Option.getOrUndefined(decode(input.raw))?.exploratory
  if (!report || !raw || report.status !== raw.status || report.rationale !== raw.rationale)
    return { status: "invalid" as const, valid: false, runs: [] }
  if (report.status === "removed") return { status: "removed" as const, valid: raw.actual === undefined, runs: [] }
  await mkdir(input.directory, { mode: 0o700 })
  const inputs = interventions(input.data)
  const expected = inputs.map(expectedDiagnostic)
  if (new Set(expected.slice(1).map((row) => row.threshold)).size < 2)
    throw new Error("Frozen interventions do not distinguish validation selection")
  const runs = []
  for (const [index, data] of inputs.entries()) {
    const directory = path.join(input.directory, String(index))
    await mkdir(directory, { mode: 0o700 })
    await Bun.write(path.join(directory, "candidate.mjs"), input.source)
    await Bun.write(
      path.join(directory, "run.mjs"),
      `import {explore} from './candidate.mjs'; let text=''; for await(const part of process.stdin) text+=part; console.log(JSON.stringify(await explore(JSON.parse(text))));`,
    )
    const output = await execute({
      ...input,
      directory,
      argv: ["/usr/bin/node", "run.mjs"],
      stdin: JSON.stringify(data),
    })
    const value =
      !output.exit && !output.timedOut && !output.truncated
        ? Option.getOrUndefined(
            Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Result)))(
              output.stdout.trim(),
            ),
          )
        : undefined
    runs.push({ data, output, value, correct: !!value && same(value, expectedDiagnostic(data)) })
  }
  return {
    status: "retained" as const,
    valid: runs.every((run) => run.correct) && !!raw.actual && same(raw.actual, expected[0]),
    runs,
  }
}

function same(actual: typeof Result.Type, expected: ReturnType<typeof expectedDiagnostic>) {
  return (
    actual.threshold === expected.threshold &&
    Math.abs(actual.testContrast - expected.testContrast) < 1e-12 &&
    JSON.stringify(actual.selectionIDs) === JSON.stringify(expected.selectionIDs) &&
    JSON.stringify(actual.evaluationIDs) === JSON.stringify(expected.evaluationIDs)
  )
}
