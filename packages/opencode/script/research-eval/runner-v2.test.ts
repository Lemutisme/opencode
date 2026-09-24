import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { development, expectedDiagnostic, interventions, measurement } from "./scenarios"
import { corpus, publish } from "./corpus"
import { diagnostic } from "./diagnostic"
import { launcher } from "./isolation"
import { issue } from "./driver"
import { bootstrap } from "./probe"
import { firstReviewAttempt, monitor } from "./controller"
import { feedbackMeasures } from "./feedback-evaluate"
import { feedbackReport } from "./feedback-report"
import { put } from "./archive"
import { runInstance } from "./instance"
import { digest } from "./ledger"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import type { Admission } from "./provider"

export const exploreSource = `export function explore(data) {
  const contrast = (ids,t) => ids.reduce((sum,id) => { const i=data.observationIDs.indexOf(id); return sum+Number(data.b[i]>=t)-Number(data.a[i]>=t) },0)/ids.length
  const selected = data.split.validation
  const threshold = [...data.exploratoryThresholds].sort((a,b)=>contrast(selected,b)-contrast(selected,a)||a-b)[0]
  return {threshold,selectionIDs:data.split.validation,evaluationIDs:data.split.test,testContrast:contrast(data.split.test,threshold)}
}`

test("v2 derives a distinct public evidence contract without changing the legacy corpus or truth", () => {
  const before = JSON.stringify(corpus("development"))
  const examples = development()
  expect(examples).toHaveLength(3)
  expect(JSON.stringify(corpus("development"))).toBe(before)
  for (const example of examples) {
    const original = corpus("development").find(
      (item) =>
        item.oracle.instance.family === example.oracle.instance.family &&
        item.oracle.instance.defective === example.oracle.instance.defective &&
        item.oracle.instance.repeat === 1,
    )!
    expect(example.packet.id).not.toBe(original.packet.id)
    expect(example.packet.plan).toEqual(original.packet.plan)
    expect(example.oracle.expected).toEqual(original.oracle.expected)
    expect(example.packet.preparation).toEqual({})
    expect(publish(example.packet)).not.toHaveProperty("plan")
    expect(publish(example.packet)).not.toHaveProperty("preparation")
  }
  expect(measurement.firstReview).toContain("earliest-created")
})

test("issue is explicit v2 advisory while absent evaluation retains v1", () => {
  const input = {
    directory: "/tmp/unused",
    contractID: "pct_eval_test",
    issuedAt: 100,
    worker: { providerID: "fixture", id: "worker" },
    reviewer: { providerID: "fixture", id: "reviewer" },
    executable: "/usr/bin/node",
    executableHash: digest("node"),
    timeout: 1000,
  } as Parameters<typeof issue>[1]
  expect(issue(publish(development()[0].packet), input).manifest.reviewPolicy).toEqual({ version: 1 })
  const v2 = issue(publish(development()[0].packet), { ...input, evaluation: "feedback-v2" })
  expect(v2.manifest.reviewPolicy).toEqual({ version: 2, plan: "advisory", delivery: "advisory" })
  expect(v2.spec.budget).toEqual({ deadline: 21_600_100 })
})

for (const protocol of ["/v1/chat/completions", "/v1/responses"])
  test(`bootstrap records the attempt before response and never repeats after reopen: ${protocol}`, async () => {
    const directory = await mkdtemp("/tmp/runner-bootstrap-")
    const input = { packet: development()[0].packet, file: directory + "/bootstrap.json", protocol }
    const run = {
      id: "pct_eval_seed",
      revision: 1,
      specHash: digest("spec"),
      manifestHash: digest("manifest"),
      stage: "exploration",
      context: { revision: 1, specHash: digest("spec"), version: 1, phaseID: "phase" },
    } as ResearchModel.Run
    const admission = {
      role: "worker",
      identity: { contractID: run.id, operationID: "op", sessionID: "session", jobID: "worker" },
      deadline: Date.now() + 1000,
    } as Admission
    const response = await bootstrap(input)(run, admission)
    const record = await Bun.file(input.file).json()
    expect(record.identity).toEqual(admission.identity)
    expect(record.context).toEqual(run.context)
    expect(record.status).toBe("attempted")
    expect(await response!.text()).toContain("contract_request")
    expect(await bootstrap(input)(run, admission)).toBeUndefined()
    expect(record.plan).not.toHaveProperty("preparation")
  })

test("earliest created review is retained even without an outcome and later successful review", async () => {
  const first = { version: 1, plan: { jobID: "first", hash: "first-plan" } } as ResearchModel.Run
  const later = { version: 5, plan: { jobID: "later", reportHash: "success" } } as ResearchModel.Run
  const calls: string[] = []
  const attempt = await firstReviewAttempt(
    [later, first],
    {
      command: async (action, id) => {
        calls.push(action + ":" + id)
        if (action === "job-get")
          return { input: { id, sessionID: "session" }, status: "failed", fingerprint: "fingerprint", generation: 1 }
        if (action === "session-context") return []
        throw new Error("Must not select later success")
      },
    },
    [],
  )
  expect(attempt?.plan.hash).toBe("first-plan")
  expect(attempt?.capture).toBe("absent")
  expect(attempt?.exposed).toBe(false)
  expect(attempt?.outcomeHash).toBeUndefined()
  expect(calls).not.toContain("research-object:success")
})

test("isolated interventions reject test selection, forged IDs, hardcoding and self-modifying carryover", async () => {
  const root = await mkdtemp("/tmp/runner-diagnostic-")
  const binary = await launcher(root + "/isolation")
  const data = JSON.parse(development().find((item) => item.oracle.instance.family === "P1")!.packet.files["data.json"])
  expect(new Set(interventions(data).map((item) => expectedDiagnostic(item).threshold)).size).toBeGreaterThan(1)
  const evidence = {
    exploratory: {
      status: "retained",
      rationale: "Independent validation selection",
      actual: expectedDiagnostic(data),
    },
  }
  const sources = [
    exploreSource,
    exploreSource.replace("const selected = data.split.validation", "const selected = data.split.test"),
    `export function explore() {return ${JSON.stringify(expectedDiagnostic(data))}}`,
    `import fs from 'node:fs'; fs.writeFileSync('candidate.mjs', ${JSON.stringify(exploreSource)}); export function explore(data) {return ${JSON.stringify(expectedDiagnostic(data))}}`,
  ]
  for (const [index, source] of sources.entries()) {
    const result = await diagnostic({
      launcher: binary,
      directory: root + "/run-" + index,
      source,
      data,
      report: JSON.stringify(evidence),
      raw: JSON.stringify(evidence),
      timeout: 3000,
    })
    expect(result.valid).toBe(index === 0)
    expect(result.runs.length).toBeGreaterThan(4)
  }
  const removed = JSON.stringify({ exploratory: { status: "removed", rationale: "No optional comparison claimed" } })
  expect(
    await diagnostic({
      launcher: binary,
      directory: root + "/removed",
      source: "throw 1",
      data,
      report: removed,
      raw: removed,
      timeout: 3000,
    }),
  ).toEqual({ status: "removed", valid: true, runs: [] })
}, 30_000)

test("feedback opportunities are per finding and repair quality is independent of final quality", () => {
  const rubric = Object.fromEntries(
    ["validDefect", "unsupportedObjection", "responseSupported", "implemented", "revalidated", "removed", "target"].map(
      (key) => ["outcome.finding." + key, key],
    ),
  )
  const material = {
    candidateHash: digest("materials"),
    rubricHash: digest(JSON.stringify(rubric)),
    rubric,
    material: {
      seed: { matched: false, truth: null },
      records: [
        {
          outcomeHash: "outcome",
          phase: "plan",
          outcome: { availability: "available", review: { findings: [{ id: "finding" }] } },
          response: { responses: [{ findingID: "finding", disposition: "rebutted" }] },
        },
      ],
    },
  } as unknown as Parameters<typeof feedbackMeasures>[0]["material"]
  const result = {
    mode: "local-fixture",
    monitored: { run: { stage: "ready" }, observed: { exposed: false } },
  } as Parameters<typeof feedbackMeasures>[0]["result"]
  const rate = (valid: boolean | null, unsupported: boolean | null) => {
    const first = {
      rater: "one",
      candidateHash: material.candidateHash,
      rubricHash: material.rubricHash,
      items: Object.fromEntries(
        Object.keys(rubric).map((key) => [
          key,
          key.endsWith(".validDefect")
            ? valid
            : key.endsWith(".unsupportedObjection")
              ? unsupported
              : key.endsWith(".removed")
                ? false
                : true,
        ]),
      ),
    }
    return feedbackMeasures({
      result,
      oracle: development()[0].oracle,
      material,
      ratings: { first, second: { ...first, rater: "two" } },
      verdict: "incorrect",
      diagnostic: { status: "retained", valid: true, runs: [] },
    })
  }
  expect(rate(false, false).feedback.handling[0]).toMatchObject({
    opportunity: "ordinary_feedback",
    result: "acknowledged",
  })
  expect(rate(false, false).feedback.coverage.unsupported_objection).toBe("not_observed")
  expect(rate(false, true).feedback.handling[0].result).toBe("supported_rebuttal")
  expect(rate(true, false).feedback.handling[0].result).toBe("implemented_repair")
  expect(rate(true, false).delivery.quality).toBe("incorrect")
  const firstUnrelated = {
    rater: "one",
    candidateHash: material.candidateHash,
    rubricHash: material.rubricHash,
    items: Object.fromEntries(
      Object.keys(rubric).map((key) => [key, !key.endsWith(".unsupportedObjection") && !key.endsWith(".removed")]),
    ),
  }
  const unrelated = feedbackMeasures({
    result,
    oracle: development().find((row) => row.oracle.instance.family === "P1")!.oracle,
    material,
    ratings: { first: firstUnrelated, second: { ...firstUnrelated, rater: "two" } },
    verdict: "incorrect",
    diagnostic: { status: "removed", valid: true, runs: [] },
  })
  expect(unrelated.feedback.handling[0].result).toBe("implemented_repair")

  expect(rate(null, null).feedback.handling[0].result).toBe("not_scored")
  expect(() => rate(true, true)).toThrow("both")
  const partial = { ...result, monitored: { ...result.monitored, firstReview: { exposed: true } } } as typeof result
  const empty = {
    ...material,
    rubric: {},
    rubricHash: digest("{}"),
    material: { ...material.material, seed: { ...material.material.seed, truth: false }, records: [] },
  }
  const first = { rater: "one", candidateHash: empty.candidateHash, rubricHash: empty.rubricHash, items: {} }
  expect(
    feedbackMeasures({
      result: partial,
      oracle: development()[0].oracle,
      material: empty,
      ratings: { first, second: { ...first, rater: "two" } },
      verdict: "indeterminate",
    }).firstReviewer,
  ).toMatchObject({ label: "unavailable", availability: "unavailable" })
})

test("v2 deadline stop preserves a no-bundle instance and never asks Principal to challenge", async () => {
  const directory = await mkdtemp("/tmp/v2-deadline-")
  const deadline = Date.now() - 1
  const run = {
    id: "pct_eval_deadline",
    version: 1,
    stage: "exploration",
    input: {
      spec: { budget: { deadline } },
      manifest: { reviewPolicy: { version: 2, plan: "advisory", delivery: "advisory" } },
    },
  } as ResearchModel.Run
  const actions: string[] = []
  const result = await monitor({
    contractID: run.id,
    entry: "followup",
    evaluation: "feedback-v2",
    deadline,
    archive: directory,
    observations: () => [],
    port: {
      command: async (action) => {
        actions.push(action)
        if (action === "research-get") return run
        if (action === "research-history") return [{ version: 1, data: run }]
        if (action === "operations") return []
        if (action === "research-cancel") return undefined
        throw new Error("Unexpected operation " + action)
      },
    },
  })
  expect(result.timedOut).toBe(true)
  expect(result.run.input.spec.budget.deadline).toBe(deadline)
  expect(result.run.bundleHash).toBeUndefined()
  expect(result.evidence.runs).toHaveLength(1)
  expect(actions).toContain("research-cancel")
  expect(actions).not.toContain("root-challenge")
})

test("v2 failed instance reports retain real usage and reject damaged failure/transport objects", async () => {
  const directory = await mkdtemp("/tmp/v2-failure-report-")
  const instance = development()[0].oracle.instance
  const archive = directory + "/" + instance.id + "/archive"
  const records = [
    {
      boundary: "provider",
      role: "worker",
      origin: "http://127.0.0.1",
      event: {
        kind: "wire",
        at: 1100,
        identity: {
          contractID: "pct_eval_" + instance.id,
          sessionID: "session",
          jobID: "worker",
          operationID: "operation",
        },
        requestID: "request",
      },
    },
  ]
  const transportHash = await put(archive, records.map((record) => JSON.stringify(record)).join("\n") + "\n")
  const retained = await put(archive, {
    codeHash: "runtime",
    evaluation: "feedback-v2",
    mode: "local-fixture",
    attempted: true,
    admitted: true,
    issuedAt: 1000,
    deadline: 21_601_000,
    agreement: { id: "pct_eval_" + instance.id, spec: { budget: { deadline: 21_601_000 } } },
    records,
    transportHash,
    partial: [
      {
        status: "fulfilled",
        value: [
          {
            id: "operation",
            kind: "provider",
            source: { sessionID: "session", contractID: "pct_eval_" + instance.id },
            startedAt: 1000,
            usage: { state: "unknown" },
          },
        ],
      },
      { status: "fulfilled", value: [] },
    ],
  })
  const evidence = await put(directory, { retained: { hash: retained }, failure: "Fixture infrastructure failure" })
  const input = {
    directory,
    output: directory + "/report",
    codeHash: "runtime",
    instances: [instance],
    rows: [{ id: instance.id, status: "infrastructure_failure", evidence }],
    executionTip: "tip",
  }
  const report = await feedbackReport(input)
  expect(report.denominator).toBe(1)
  expect(report.rows[0]).toMatchObject({
    accountingIncomplete: true,
    admission: "admitted",
    usage: [{ wireRequests: 1, tokens: null, unknown: true, cost: null }],
  })
  await Bun.write(archive + "/objects/" + transportHash, "changed")
  await expect(feedbackReport({ ...input, output: directory + "/changed-transport" })).rejects.toThrow(
    "transport changed",
  )
  await Bun.write(archive + "/objects/" + retained, "changed")
  await expect(feedbackReport({ ...input, output: directory + "/changed-failure" })).rejects.toThrow("failure changed")
})

test("direct v2 execution rejects legacy packets before admitting a task", async () => {
  const input = {
    evaluation: "feedback-v2",
    entry: "research",
    packet: corpus("development").find((item) => item.oracle.instance.family === "R3")!.packet,
  } as Parameters<typeof runInstance>[0]
  await expect(runInstance(input)).rejects.toThrow("matching derived development scenario")
})

test("closure failures before retained instance evidence keep their denominator and explicit guidance", async () => {
  const directory = await mkdtemp("/tmp/research-closure-early-failure-")
  const instance = corpus("development")[0].oracle.instance
  const evidence = await put(directory, {
    instance: instance.id,
    failure: "Storage initialization failed before attempt",
    feedbackGuidance: "closure:1",
  })
  const input = {
    directory,
    output: directory + "/report",
    codeHash: "frozen-runtime",
    evaluation: "repair-lifecycle-v1" as const,
    feedbackGuidance: "closure:1" as const,
    instances: [instance],
    rows: [{ id: instance.id, status: "infrastructure_failure", evidence }],
    executionTip: "tip",
  }
  const report = await feedbackReport(input)
  expect(report.denominator).toBe(1)
  expect(report.feedbackGuidance).toBe("closure:1")
  expect(report.rows[0]).toMatchObject({ scoring: "not_scored", accountingIncomplete: true, admission: "unknown" })
  await expect(feedbackReport({ ...input, feedbackGuidance: undefined, output: directory + "/wrong" })).rejects.toThrow(
    "guidance",
  )
})
