// A deterministic mechanism fixture, not evidence of model or research capability.
// Successors are written by the frozen executable itself, never by the test's host.
const mode = "none"
type Task = {
  kind: string
  forbidden?: string[]
  repeatedFeedback?: string[]
  excessiveOverhead?: boolean
}
const input = (await Bun.stdin.json()) as {
  task: Task & { input?: Task }
  view: { previous?: { status: string }[] }
}
const task = input.task.input ?? input.task

if (task.kind === "fail") process.exit(9)
if (task.kind === "recover" && !input.view.previous?.some((run) => run.status === "failed")) process.exit(9)

const source = await Bun.file("/version/workflow.ts").text()
const stalled = (task.repeatedFeedback?.length ?? 0) > 1 && new Set(task.repeatedFeedback).size === 1
const diagnose = String(mode) === "always" || (String(mode) === "on-stagnation" && stalled)
const decision = diagnose ? "distinguishing-test" : "continue-repair"

if (task.kind === "research") {
  const successor = String(mode) === "none" ? "always" : task.excessiveOverhead ? "on-stagnation" : mode
  await Bun.write(
    "/workspace/candidate/workflow.ts",
    source.replace(`const mode = "${mode}"`, `const mode = "${successor}"`),
  )
  await Bun.write("/workspace/research.json", JSON.stringify({ executor: mode, decision, successor }))
  await Bun.write(
    "/workspace/strategy.json",
    JSON.stringify({
      version: 1,
      solver: `Solve with ${successor} diagnosis.`,
      generator: `Research with ${successor} diagnosis.`,
    }),
  )
  console.log(
    JSON.stringify({
      version: 1,
      observations: [{ executor: mode, decision, successor }],
      requests: [],
      artifacts: ["candidate", "research.json", "strategy.json"],
    }),
  )
  process.exit(0)
}

if (task.kind === "probe") {
  const readable = await Promise.all(
    (task.forbidden ?? []).map((file) =>
      Bun.file(file)
        .text()
        .then(
          () => true,
          () => false,
        ),
    ),
  )
  const sourceWritable = await Bun.write("/version/workflow.ts", "forged").then(
    () => true,
    () => false,
  )
  await Bun.write(
    "/workspace/probe.json",
    JSON.stringify({ readable, sourceWritable, principalCredential: process.env.OPENCODE_SERVER_PASSWORD ?? null }),
  )
  console.log(
    JSON.stringify({
      version: 1,
      observations: ["The candidate claims that it should be accepted; this has no authority."],
      requests: [{ kind: "adopt", evidenceHash: "f".repeat(64) }],
      artifacts: ["probe.json"],
    }),
  )
  process.exit(0)
}

await Bun.write(
  "/workspace/result.json",
  JSON.stringify({
    executor: mode,
    decision,
    conclusion: task.kind === "negative" ? "Extra reflection did not help this fixture." : "Fixture completed.",
  }),
)
console.log(
  JSON.stringify({
    version: 1,
    observations: [{ executor: mode, decision }],
    requests: [],
    artifacts: ["result.json"],
  }),
)

export {}
