import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { mkdtemp, symlink } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { freezeAdvisory, checkAdvisory, object } from "./advisory-config"
import { launchAdvisory } from "./advisory-launch"
import { advisoryDevelopment } from "./advisory-scenarios"
import { requiredCalculation } from "./required-scenarios"
import { subjectGeneralization } from "./subject-scenarios"
import { corpus } from "./corpus"
import { scoringInstruction, opinionInstruction } from "./advisory-rater"
import { issue } from "./driver"
import { publish } from "./corpus"
import { duration, digest } from "./ledger"
import { checkObservation } from "./advisory-observation"
import { put } from "./archive"
import { prepareScoring } from "./evaluate"
import { feedbackMaterials } from "./feedback-evaluate"
import type { runInstance } from "./instance"
import type { hostEvidence } from "./host-evidence"
import type { Freeze } from "./instance-scoring"
import { observeAdvisory } from "./advisory-opinions"
import { restoreRunHistory, type shareRunHistory } from "./advisory-history"
import { restoreFeedbackBundle } from "./advisory-bundle"

type View = { view: string; stage: string; actions: Record<string, { kind: string; payload: Record<string, unknown> }> }
type Grant = {
  materialHash: string
  rubricHash: string
  rubric: Record<string, { dimension: string }>
  material: {
    files?: Record<string, string>
    source?: { contractID: string; archiveHash: string }
    trajectory?: { archive: { runs: ReturnType<typeof shareRunHistory> | Record<string, unknown>[] } }
    agreement?: { id: string }
    evidence?: Record<string, unknown>
    bundle?: {
      feedback: { outcome: { availability: string }; unaddressed: string[] }[]
      records: unknown[]
      treatment: { status: string }
    }
  }
  prior?: unknown[]
}

async function fixture(
  mode: "complete" | "issuance-failure" | "scorer-failure" | "cancel-worker" | "cancel-scorer" | "stop-with-capture",
  observation = false,
  scenario?: "required-calculation:1" | "subject-generalization:1",
) {
  const directory = await mkdtemp("/tmp/research-advisory-batch-")
  const examples =
    scenario === "subject-generalization:1"
      ? subjectGeneralization()
      : scenario
        ? requiredCalculation()
        : advisoryDevelopment()
  const controller = new AbortController()
  const state = { error: undefined as unknown, firstCandidate: "", workerCalls: 0, currentFamily: "" }
  const steps = new Map<string, number>()
  const ratings: { model: string; grant: Grant; raw: Record<string, unknown> }[] = []
  const upstream = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        model: string
        stream: boolean
        messages?: { role: string; content: string }[]
        input?: unknown
        instructions?: string
      }
      if (body.model.startsWith("rater-")) {
        expect(body.stream).toBe(false)
        expect(body.instructions ?? body.messages?.[0].content).toBe(
          observation ? opinionInstruction : scoringInstruction,
        )
        expect(body).not.toHaveProperty("previous_response_id")
        expect(body).not.toHaveProperty("conversation")
        const grant = JSON.parse(body.messages?.at(-1)?.content ?? strings(body.input).at(-1)!) as Grant
        ratings.push({ model: body.model, grant, raw: body })
        const candidate = Object.values(grant.rubric).every((rule) => rule.dimension === "research_result")
        if (candidate) {
          expect(grant.material.files).toBeDefined()
          expect(grant.material.bundle).toBeUndefined()
          expect(grant.material).not.toHaveProperty("trajectory")
          if (body.model !== "rater-C") expect(grant.prior).toBeUndefined()
          if (body.model === "rater-C") expect(grant.prior).toHaveLength(2)
          state.firstCandidate ||= grant.materialHash
        } else if (grant.material.bundle) {
          if (observation) {
            const restored = restoreFeedbackBundle({
              ...grant.material,
              bundle: grant.material.bundle,
              evidence: grant.material.evidence!,
            })
            expect(Object.values(grant.material.evidence!).some((value) => typeof value !== "string")).toBe(true)
            for (const [hash, value] of Object.entries(restored.evidence)) expect(digest(value)).toBe(hash)
          } else expect(Object.values(grant.material.evidence!).every((value) => typeof value === "string")).toBe(true)
          const candidateCalls = ratings.filter((item) => item.grant.material.files)
          expect(candidateCalls.some((item) => item.model === "rater-A")).toBe(true)
          expect(candidateCalls.some((item) => item.model === "rater-B")).toBe(true)
          expect(
            grant.material.bundle.records.filter((item) => (item as { kind?: string }).kind === "response"),
          ).toHaveLength(0)
          const runs = grant.material.trajectory!.archive.runs
          expect(Array.isArray(runs)).toBe(!observation)
          if (!Array.isArray(runs)) {
            const original = await object<{ runs: Record<string, unknown>[] }>(
              path.join(directory, "batch", grant.material.source!.contractID.slice("pct_eval_".length), "archive"),
              grant.material.source!.archiveHash,
            )
            expect(JSON.stringify(restoreRunHistory(runs))).toBe(JSON.stringify(original.runs))
          }
        }
        if (observation && !candidate) {
          const contractID = grant.material.source?.contractID ?? grant.material.agreement?.id
          const instance = examples.find((item) => contractID === "pct_eval_" + item.packet.id)
          expect(instance).toBeDefined()
          const opinions = path.join(directory, "batch", instance!.packet.id, "opinions")
          const record = await object<{ records: { execution: string }[]; terminal?: unknown }>(
            opinions,
            (await Bun.file(path.join(opinions, "candidate-record.json")).json()).hash,
          )
          expect(record.records.length === 2 || !!record.terminal).toBe(true)
          for (const item of record.records)
            expect(await Bun.file(path.join(opinions, item.execution, "result.json")).exists()).toBe(true)
        }
        if (mode === "cancel-scorer") {
          controller.abort()
          return outgoing.destroy()
        }
        if (
          mode === "scorer-failure" &&
          candidate &&
          state.firstCandidate === grant.materialHash &&
          body.model === "rater-B"
        ) {
          outgoing.writeHead(200, { "content-type": "application/json" })
          outgoing.end(
            observation
              ? '{"output":[{"type":"message","content":[{"type":"output_text","text":""}]}],"usage":{"input_tokens":12,"output_tokens":8,"total_tokens":20}}'
              : '{"choices":[{"message":{"content":"malformed rating"}}]}',
          )
          return
        }
        const items = Object.fromEntries(
          Object.keys(grant.rubric).map((key) => [
            key,
            candidate
              ? {
                  status: "scored",
                  value: body.model !== "rater-B",
                  reason: "Deterministic wiring fixture judgment; not a model capability claim",
                  evidence: [grant.materialHash],
                }
              : {
                  status: "not_observed",
                  value: null,
                  reason: "Fixture does not measure autonomous feedback handling",
                  evidence: [],
                },
          ]),
        )
        const text = observation
          ? candidate
            ? "Fixture independent opinion: inspect analysis.mjs and report.json with verification.artifacts. No scientific capability claim; concrete references need no copied hash."
            : "Fixture trajectory opinion: repair not_observed; separate audit absence from correctness. No model capability claim."
          : JSON.stringify({ items })
        outgoing.writeHead(200, { "content-type": "application/json" })
        outgoing.end(
          JSON.stringify(
            incoming.url === "/v1/responses"
              ? {
                  output: [{ type: "message", content: [{ type: "output_text", text }] }],
                  usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
                }
              : {
                  choices: [{ message: { content: text } }],
                  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
                },
          ),
        )
        return
      }
      const text = strings(body.messages ?? body.input).join("\n")
      const example =
        examples.find((item) => text.includes("pct_eval_" + item.packet.id)) ??
        (scenario ? examples.find((item) => text.includes("/" + item.packet.id + "/")) : undefined) ??
        examples
          .filter((item) => text.includes(item.packet.brief))
          .toSorted((a, b) => b.packet.brief.length - a.packet.brief.length)[0]
      if (body.model === "fixture-worker")
        await Bun.write(
          path.join(directory, "last-fixture-request.json"),
          JSON.stringify({ example: example?.packet.id, body }),
        )
      const delta = (() => {
        if (body.model === "fixture-reviewer") {
          const match = /Allowed evidence selectors \(immutable and local to this review job\): (.*)/.exec(text)
          if (!match) throw new Error("Missing host reviewer selector map")
          const selectors = (JSON.parse(match[1]) as { selector: { jobID: string; id: string } }[]).map(
            (item) => item.selector,
          )
          if (state.currentFamily === "R3") return { content: "Original unavailable reviewer output" }
          return {
            content: JSON.stringify({
              version: 2,
              ...(selectors.some((item) => item.id === "plan") ? { scope: "within_task" } : {}),
              verdict: "changes_requested",
              summary: "Fixture independent opinion",
              findings: [
                {
                  id: "F1",
                  severity: "P1",
                  path: "plan.method",
                  reason: "Fixture opinion retained without compulsory response",
                  resolution: "Consider the limitation",
                },
              ],
              claims: [{ text: "Exact material", evidence: [selectors[0]] }],
            }),
          }
        }
        state.workerCalls++
        if (mode === "cancel-worker") {
          controller.abort()
          return { content: "Explicit external cancellation" }
        }
        if (!example) throw new Error("Worker prompt does not identify its frozen task")
        state.currentFamily = example.oracle.instance.family
        const step = steps.get(example.packet.id) ?? 0
        steps.set(example.packet.id, step + 1)
        const results = strings(body.messages ?? body.input)
          .filter((value) => value.startsWith('{"requested":'))
          .map((value) => JSON.parse(value) as { result?: View })
        const view = results.findLast((item) => item.result?.view)?.result
        if ([0, 2, 6, 8].includes(step)) return tool({ kind: "research_view", payload: {} })
        if (!view) throw new Error("Expected actual host view result")
        const original = scenario
          ? example
          : corpus("development").find(
              (item) =>
                item.oracle.instance.family === example.oracle.instance.family &&
                item.oracle.instance.defective === example.oracle.instance.defective &&
                item.oracle.instance.repeat === 1,
            )!
        if (step === 1)
          return tool({
            kind: "plan",
            payload: {
              ...view.actions.plan.payload,
              ...example.packet.plan,
              ...(scenario
                ? {}
                : {
                    implementation: "Implement primary analysis; omit optional diagnostic",
                    method: "All primary pairs; optional diagnostic removed",
                    evaluation: "Formal primary evaluation; no optional diagnostic",
                  }),
            },
          })
        if (step === 3) return write("analysis.mjs", original.packet.preparation["analysis.mjs"])
        if (step === 4)
          return write(
            "report.json",
            JSON.stringify({
              ...JSON.parse(original.packet.preparation["report.json"]),
              ...(example.oracle.instance.family === "P1"
                ? { exploratory: { status: "removed", rationale: "Optional diagnostic not performed" } }
                : {}),
            }),
          )
        if (step === 5) return tool(view.actions.experiment)
        if (step === 7) return tool(view.actions.prepare_candidate)
        if (step === 9 && mode === "stop-with-capture" && example.packet.id === examples[0].packet.id)
          return call("contract_report_blocked", {
            reason: "Fixture explicit blockage after capture, without candidate submission",
          })
        if (step === 9) return tool(view.actions.submit_candidate)
        return { content: "Fixture completed." }
      })()
      outgoing.writeHead(200, { "content-type": "text/event-stream" })
      outgoing.end(
        "data: " +
          JSON.stringify({
            id: crypto.randomUUID(),
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", ...delta },
                finish_reason: "tool_calls" in delta ? "tool_calls" : "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      )
    } catch (error) {
      state.error = error
      controller.abort()
      outgoing.writeHead(500)
      outgoing.end(String(error))
    }
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/`
  const model = (name: string) => ({
    endpoint: endpoint + (name === "rater-B" ? "responses" : "chat/completions"),
    model: name,
    variant: "low",
    parameters: { reasoning_effort: "low" },
    seed: "unsupported" as const,
    context: 100000,
    output: 4000,
    credentialEnv: null,
  })
  const setup = {
    version: observation ? "advisory-observation:1" : "advisory-batch:1",
    mode: "local-fixture",
    evaluation: "advisory-v3",
    ...(scenario ? { scenario } : {}),
    worker: model("fixture-worker"),
    reviewer: model("fixture-reviewer"),
    raters: {
      first: { id: "A", model: model("rater-A") },
      second: { id: "B", model: model("rater-B") },
      adjudicator: { id: "C", model: model("rater-C") },
    },
    infrastructure: { version: 1, startup: 30000, operation: 30000, cleanup: 30000, journal: "cas:1" },
    timeouts: { provider: 10000, verification: 10000, cleanup: 30000, scoring: 10000, extraction: 10000 },
    bun: process.execPath,
    node: "/usr/bin/node",
    ...(mode === "issuance-failure" ? { fixtureFaults: { [examples[0].packet.id]: "before_issue" } } : {}),
  }
  const timer = setTimeout(() => controller.abort(new Error("Fixture watchdog")), 180000)
  try {
    const deployment = await freezeAdvisory(setup, path.join(directory, "freeze"))
    const checked = await checkAdvisory(deployment)
    expect(checked.frozen.budget).toEqual({ milliseconds: duration })
    expect(checked.frozen.examples.map((item) => item.packet.version)).toEqual(
      Array(examples.length).fill(scenario ?? "advisory-development:1"),
    )
    const report = await launchAdvisory(deployment, path.join(directory, "batch"), controller.signal)
    console.log("Advisory actual-entry fixture:", mode, directory)
    expect(state.error).toBeUndefined()
    return { directory, report, ratings, state, deployment }
  } finally {
    clearTimeout(timer)
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
}

function tool(value: { kind: string; payload: Record<string, unknown> }) {
  return call("contract_request", value)
}

test("open-method subject study uses the actual entry with four independent opinion contexts and no numeric oracle", async () => {
  const value = await fixture("complete", true, "subject-generalization:1")
  expect(value.report.denominator).toBe(1)
  expect(value.report.rows[0].status).toBe("completed")
  expect(value.report.rows[0].measurement.researchResult.candidate).toBe("present")
  expect(value.report.rows[0].measurement).toMatchObject({ formalScoring: "not_run" })
  expect(value.ratings).toHaveLength(4)
  expect(value.ratings.every((row) => row.model !== "rater-C")).toBe(true)
  const checked = await checkAdvisory(value.deployment)
  expect(checked.frozen.examples[0].oracle).not.toHaveProperty("expected")
  expect(checked.frozen.rubric.correctness.question).toContain("indeterminate")
  expect(checked.frozen.rubric.reviewer.question).toContain("not a required outcome")
  expect(value.report).toMatchObject({ qualification: "not_run", externalRecognition: "not_run" })
  await expect(
    freezeAdvisory(
      { ...checked.config, version: "advisory-batch:1" },
      path.join(value.directory, "forbidden-study-scoring"),
    ),
  ).rejects.toThrow("not historical formal scoring")
}, 240000)

test("required-calculation observation uses the actual entry and keeps unavailable opinions separate", async () => {
  const value = await fixture("scorer-failure", true, "required-calculation:1")
  expect(value.report.denominator).toBe(2)
  expect(value.report.rows.every((row) => row.status === "completed")).toBe(true)
  expect(value.ratings).toHaveLength(8)
  expect(value.ratings.every((row) => row.model !== "rater-C")).toBe(true)
  for (const row of value.report.rows) {
    expect(row.measurement.researchResult.candidate).toBe("present")
    expect(row.measurement).toMatchObject({ formalScoring: "not_run" })
  }
  const checked = await checkAdvisory(value.deployment)
  expect(checked.frozen.rubric.repair.question).toContain("autonomous correction")
  expect(checked.frozen.rubric.reviewer.question).toContain("reasonable suggestions")
  await expect(
    freezeAdvisory(
      { ...checked.config, version: "advisory-batch:1" },
      path.join(value.directory, "forbidden-formal-freeze"),
    ),
  ).rejects.toThrow("not historical formal scoring")
}, 240000)
function write(file: string, content: string) {
  return call("write", { path: file, content })
}
function call(name: string, args: unknown) {
  return {
    tool_calls: [
      {
        index: 0,
        id: "call_" + crypto.randomUUID(),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  }
}
function strings(value: unknown): string[] {
  return typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : []
}

test("actual v3 batch entry isolates issuance failure, archives two zero-response candidates and independently scores/reveals them", async () => {
  const value = await fixture("issuance-failure")
  expect(value.report.denominator).toBe(3)
  expect(value.report.rows[0].status).toBe("infrastructure_failure")
  for (const row of value.report.rows.slice(1)) {
    expect(row.status).toBe("completed")
    expect(row.measurement.researchResult.candidate).toBe("present")
    expect(row.measurement.candidateSeal).toBeDefined()
    expect(row.measurement.feedbackSeal).toBeDefined()
    const directory = path.join(value.directory, "batch", row.id)
    const bound = await Bun.file(path.join(directory, "measurement-freeze.json")).json()
    expect(bound.freeze.instances[0].deadline - bound.freeze.instances[0].started).toBe(duration)
    const db = new Database(path.join(directory, "measurement.sqlite"), { readonly: true })
    expect(db.query("SELECT * FROM judgment").all()).toHaveLength(5)
    expect(db.query("SELECT * FROM seal").all()).toHaveLength(2)
    db.close()
    const result = (await Bun.file(path.join(directory, "result.json")).json()).result
    expect(result.monitored.run.input.manifest.reviewPolicy.version).toBe(3)
    expect(result.bootstrap).toBeUndefined()
    expect(result.monitored.run.stage).toBe("ready")
    const example = advisoryDevelopment().find((item) => item.packet.id === row.id)!
    const actual = result as Awaited<ReturnType<typeof runInstance>>
    await expect(
      prepareScoring({
        directory,
        result: actual,
        packet: example.packet,
        oracle: example.oracle,
        launcher: "unused",
        timeout: 10000,
      }),
    ).rejects.toThrow("dedicated")
    await expect(
      feedbackMaterials(actual, example.oracle, async () => {
        throw new Error("Must reject before reading legacy material")
      }),
    ).rejects.toThrow("dedicated")
    expect(row.ratings.every((item) => item.result.usageKnown)).toBe(true)
  }
  const feedback = value.ratings.filter((item) => item.grant.material.bundle)
  expect(feedback).toHaveLength(4)
  // Reopen the actual stopped observer, then test identity and integrity rejection without changing the research result.
  const failed = path.join(value.directory, "batch", value.report.rows[0].id)
  const checked = await checkAdvisory(value.deployment)
  const check = () => checkObservation({ directory: failed, checked, packet: advisoryDevelopment()[0].packet })
  expect((await check()).confirmed).toBe(true)
  const reference = await Bun.file(path.join(failed, "failure.json")).text()
  const archive = path.join(failed, "archive")
  const original = await object<Record<string, unknown>>(archive, JSON.parse(reference).hash)
  const audit = await object<Awaited<ReturnType<typeof hostEvidence>>>(archive, String(original.auditHash))
  const wrong = await put(archive, { ...audit, contractID: "pct_eval_another" })
  await Bun.write(
    path.join(failed, "failure.json"),
    JSON.stringify({ hash: await put(archive, { ...original, auditHash: wrong }) }),
  )
  await expect(check()).rejects.toThrow("another instance")
  await Bun.write(path.join(failed, "failure.json"), reference)
  if (!("sources" in audit) || !audit.sources.length) throw new Error("Expected actual post-stop database evidence")
  const blob = path.join(archive, "objects", audit.sources[0].hash)
  const bytes = new Uint8Array(await Bun.file(blob).arrayBuffer())
  await Bun.write(blob, "corrupt post-stop database")
  await expect(check()).rejects.toThrow("missing or corrupt")
  await Bun.write(blob, bytes)
  const attemptPath = path.join(failed, "attempt.json")
  const attempt = await Bun.file(attemptPath).text()
  await Bun.write(attemptPath, JSON.stringify({ ...JSON.parse(attempt), deadline: JSON.parse(attempt).deadline + 1 }))
  await expect(check()).rejects.toThrow("original deadline")
  await Bun.write(attemptPath, attempt)
  expect((await check()).confirmed).toBe(true)

  expect(feedback.every((item) => item.grant.material.bundle!.treatment.status === "not_provided")).toBe(true)
  expect(
    feedback.some((item) =>
      item.grant.material.bundle!.feedback.some((entry) => entry.outcome.availability === "unavailable"),
    ),
  ).toBe(true)
  expect(
    feedback.some((item) => item.grant.material.bundle!.feedback.some((entry) => entry.unaddressed.includes("F1"))),
  ).toBe(true)
}, 240000)

test("actual entry retains unavailable candidate rater without blocking another instance's feedback seal", async () => {
  const value = await fixture("scorer-failure")
  expect(value.report.rows[0].measurement.researchResult.candidate).toBe("present")
  expect(value.report.rows[0].measurement.candidateSeal).toBeUndefined()
  expect(value.report.rows[0].measurement.feedbackSeal).toBeUndefined()
  expect(value.report.rows.slice(1).every((row) => !!row.measurement.feedbackSeal)).toBe(true)
  expect(value.ratings.filter((item) => item.grant.materialHash === value.state.firstCandidate)).toHaveLength(2)
}, 240000)

for (const mode of ["cancel-worker", "cancel-scorer"] as const)
  test(
    "actual entry " + mode + " closes execution and leaves remaining instances unstarted",
    async () => {
      const value = await fixture(mode)
      expect(value.report.rows.slice(1).map((row) => row.status)).toEqual(["not_started", "not_started"])
      expect(value.ratings).toHaveLength(mode === "cancel-worker" ? 0 : 1)
      expect(value.report.rows.every((row) => !row.measurement.feedbackSeal)).toBe(true)
      const directory = path.join(value.directory, "batch", value.report.rows[0].id)
      const reference = await Bun.file(path.join(directory, "result.json"))
        .json()
        .catch(() => undefined)
      const failure = reference ? undefined : await Bun.file(path.join(directory, "failure.json")).json()
      const result =
        reference?.result ?? (await object<{ auditHash: string }>(path.join(directory, "archive"), failure.hash))
      const audit = await object<{ cleanup: { complete: boolean; status: string } }>(
        path.join(directory, "archive"),
        result.auditHash,
      )
      expect(audit.cleanup).toMatchObject({ complete: true, status: "confirmed" })
    },
    240000,
  )

test("v3 issuance is explicit; old protocols do not silently inherit new scenarios", () => {
  const packet = publish(advisoryDevelopment()[0].packet)
  const input = {
    directory: "/unused",
    contractID: "pct_example",
    issuedAt: Date.now(),
    worker: { providerID: "test", id: "worker" },
    reviewer: { providerID: "test", id: "reviewer" },
    executable: "/usr/bin/node",
    executableHash: digest("fixture"),
    timeout: 1000,
  } as Parameters<typeof issue>[1]
  expect(() => issue(packet, input)).toThrow()
  expect(() => issue(packet, { ...input, evaluation: "repair-lifecycle-v1" })).toThrow()
  const agreement = issue(packet, { ...input, evaluation: "advisory-v3" })
  expect(agreement.manifest.reviewPolicy).toEqual({ version: 3, plan: "advisory", delivery: "advisory" })
  expect(agreement.manifest.feedbackProtocol).toBeUndefined()
  expect(agreement.manifest.requirements.some((item) => item.includes("every independent finding"))).toBe(false)
})

for (const mode of ["scorer-failure", "stop-with-capture", "issuance-failure", "cancel-scorer"] as const)
  test(
    "limited observation actual entry preserves independent prose and isolation: " + mode,
    async () => {
      const value = await fixture(mode, true)
      const report = await Bun.file(path.join(value.directory, "batch/report.json")).json()
      expect(report.version).toBe("advisory-observation:1")
      expect(report.measurement).toBe("candidate-opinion:1")
      expect(report.reveal).toBe("candidate-attempts-before-feedback:1")
      expect(report.denominator).toBe(3)
      expect(report.qualification).toBe("not_run")
      expect(value.ratings.some((row) => row.model === "rater-C")).toBe(false)
      if (mode === "cancel-scorer") {
        expect(value.ratings).toHaveLength(1)
        expect(report.rows.slice(1).map((row: { status: string }) => row.status)).toEqual([
          "not_started",
          "not_started",
        ])
        expect(report.rows[0].measurement.feedbackHandling.reviews).toHaveLength(0)
        return
      }
      for (const row of report.rows) {
        expect(row.measurement.formalScoring).toBe("not_run")
        expect(row.measurement.candidateSeal).toBeUndefined()
        expect(row.measurement.feedbackHandling.reviews).toHaveLength(2)
        expect(
          row.measurement.feedbackHandling.reviews.every(
            (item: { result: { opinion?: string } }) => !!item.result.opinion,
          ),
        ).toBe(true)
        expect(row.measurement.infrastructure.accounting.completeness).toBe("unknown")
      }
      const first = report.rows[0].measurement
      if (mode === "scorer-failure") {
        expect(first.researchResult.candidate).toBe("present")
        expect(first.researchResult.reviews).toHaveLength(2)
        expect(first.researchResult.reviews[0].result.opinion).toContain("analysis.mjs")
        expect(first.researchResult.reviews[1].result.opinion).toBeUndefined()
        expect(first.researchResult.reviews[1].result.usageKnown).toBe(true)
        // Use a valid, fully intact archive from another real fixture instance; reject identity substitution.
        const original = path.join(value.directory, "batch", report.rows[0].id)
        const foreign = path.join(value.directory, "batch", report.rows[1].id)
        const originalResult = (await Bun.file(path.join(original, "result.json")).json()).result as Awaited<
          ReturnType<typeof runInstance>
        >
        const foreignResult = (await Bun.file(path.join(foreign, "result.json")).json()).result as Awaited<
          ReturnType<typeof runInstance>
        >
        const probe = await mkdtemp("/tmp/research-opinion-identity-")
        await symlink(path.join(foreign, "archive"), path.join(probe, "archive"))
        const checked = await checkAdvisory(value.deployment)
        const cohort = await object<{ registry: Freeze["instances"] }>(
          path.join(value.directory, "batch"),
          (await Bun.file(path.join(value.directory, "batch/cohort.json")).json()).hash,
        )
        const rejected = await observeAdvisory({
          directory: probe,
          checked,
          registered: cohort.registry[0],
          result: {
            ...originalResult,
            monitored: { ...originalResult.monitored, evidence: foreignResult.monitored.evidence },
          },
          inspection: await checkObservation({
            directory: original,
            checked,
            packet: advisoryDevelopment()[0].packet,
            result: originalResult,
          }),
          infrastructure: first.infrastructure,
          evidence: report.rows[0].evidence,
          signal: AbortSignal.abort(),
        })
        expect(rejected.gaps).toContain(
          "Error: Submitted archive differs from the observed instance, agreement or candidate",
        )
        expect(rejected.researchResult.candidate).toBe("present")
        expect(rejected.researchResult.reviews).toHaveLength(0)
      } else {
        expect(first.researchResult.candidate).toBe("absent")
        expect(first.researchResult.reviews).toHaveLength(0)
        if (mode === "stop-with-capture") {
          const result = (await Bun.file(path.join(value.directory, "batch", report.rows[0].id, "result.json")).json())
            .result
          expect(result.monitored.run.subjectHash).toBeDefined()
          expect(result.monitored.run.submissionHash).toBeUndefined()
          expect(result.monitored.run.reason).toContain("Fixture explicit blockage")
        }
      }
      for (const row of report.rows.slice(1)) expect(row.measurement.researchResult.reviews).toHaveLength(2)
      expect(value.ratings.every((row) => row.grant.prior === undefined)).toBe(true)
    },
    240000,
  )
