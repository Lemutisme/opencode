import { expect } from "bun:test"
import { createServer } from "node:http"
import { lifecycleDevelopment } from "../lifecycle-scenarios"
import { lifecycleMaterials, lifecycleMeasures } from "../lifecycle-evaluate"
import { digest } from "../ledger"
import { corpus } from "../corpus"
import { runInstance } from "../instance"
import { prepareScoring, sealCandidate, revealFeedback, finalizeScoring } from "../evaluate"
import { launcher } from "../isolation"
import type { ResearchFeedback } from "../../../../sdk-next/src/research/review-feedback"

const explorer = `export function explore(data) {
  const contrast=(ids,t)=>ids.reduce((sum,id)=>{const i=data.observationIDs.indexOf(id); return sum+Number(data.b[i]>=t)-Number(data.a[i]>=t)},0)/ids.length
  const selected=data.split.validation
  const threshold=[...data.exploratoryThresholds].sort((a,b)=>contrast(selected,b)-contrast(selected,a)||a-b)[0]
  return {threshold,selectionIDs:data.split.validation,evaluationIDs:data.split.test,testContrast:contrast(data.split.test,threshold)}
}`

import type { Infrastructure } from "../infrastructure"
export const lifecycleCases = [
  "rebuttal",
  "repair",
  "fake-fixed",
  "remove-bad",
  "remove-good",
  "unavailable",
  "negative",
  "pending-intent",
  "stale-completion",
  "corrected-claim",
  "preexisting",
] as const

export async function lifecycleFixture(
  scenario: (typeof lifecycleCases)[number],
  options?: { directory: string; infrastructure: Infrastructure; capture: true; feedbackGuidance?: "closure:1" },
) {
  const bad = ["repair", "fake-fixed", "remove-bad", "pending-intent", "stale-completion", "corrected-claim"].includes(
    scenario,
  )
  const removed = scenario.startsWith("remove")
  const family = ["negative", "preexisting"].includes(scenario) ? "R3" : "P1"
  const example = lifecycleDevelopment().find(
    (item) => item.oracle.instance.family === family && item.oracle.instance.defective === bad,
  )!
  const original = corpus("development").find(
    (item) =>
      item.oracle.instance.family === family &&
      item.oracle.instance.defective === bad &&
      item.oracle.instance.repeat === 1,
  )!
  const good = corpus("development").find(
    (item) => item.oracle.instance.family === "P1" && !item.oracle.instance.defective,
  )!
  const protocol = ["repair", "unavailable"].includes(scenario) ? "responses" : "chat/completions"
  const calls = { worker: 0, reviewer: 0, urls: [] as string[] }
  const completionTargets = new Set<string>()
  const readTargets = new Set<string>()
  const state = {
    reworked: false,
    corrected: false,
    plan: family === "P1" ? 1 : 0,
    step: 0,
    read: false,
    error: undefined as unknown,
  }
  const responded = new Set<string>()
  const report = JSON.parse(original.packet.preparation["report.json"])
  if (family === "P1")
    report.exploratory = {
      status: removed ? "removed" : "retained",
      rationale: removed
        ? "Optional comparison removed and not performed"
        : "Select on validation, evaluate on held-out test",
    }
  const files = [
    [
      "analysis.mjs",
      original.packet.files["analysis.mjs"] +
        (family === "P1" && !removed
          ? scenario === "fake-fixed"
            ? explorer.replace("selected=data.split.validation", "selected=data.split.test")
            : explorer
          : ""),
    ],
    ["report.json", JSON.stringify(report)],
  ]
  const upstream = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        model: string
        input?: unknown
        messages?: unknown
      }
      calls.urls.push(incoming.url!)
      const prompt = strings(body.messages ?? body.input).join("\n")
      const delta = (() => {
        if (body.model === "fixture-reviewer") {
          calls.reviewer++
          const match = /Allowed evidence selectors \(immutable and local to this review job\): (.*)/.exec(prompt)
          if (!match) throw new Error("Missing v2 reviewer selectors")
          const selectors = (JSON.parse(match[1]) as { selector: { jobID: string; id: string } }[]).map(
            (item) => item.selector,
          )
          const planned = selectors.some((item) => item.id === "plan")
          const first = planned && calls.reviewer === 1
          if (scenario === "unavailable") return { content: "Malformed independent report retained verbatim" }
          return {
            content: JSON.stringify({
              version: 2,
              ...(planned ? { scope: "within_task" } : {}),
              verdict: first && (family === "P1" || scenario === "preexisting") ? "changes_requested" : "accept",
              summary: "Controlled local fixture opinion",
              findings:
                first && (family === "P1" || scenario === "preexisting")
                  ? [
                      {
                        id: "selection",
                        severity: "P1",
                        path: scenario === "preexisting" ? "analysis.mjs" : "plan.method",
                        reason:
                          scenario === "preexisting"
                            ? "analysis.mjs does not export analyze"
                            : bad
                              ? "The plan selects and evaluates on the same test observations"
                              : "Objection to exploratory selection",
                        resolution:
                          scenario === "preexisting"
                            ? "Add the analyze export"
                            : "Use independent validation selection and held-out test evaluation",
                      },
                    ]
                  : [],
              claims: [{ text: "Exact local fixture material", evidence: [selectors[0]] }],
            }),
          }
        }
        calls.worker++
        const feedback = [...prompt.matchAll(/Original independent outcome ([a-f0-9]{64}): (.*)/g)].at(-1)
        if (feedback && !responded.has(feedback[1])) {
          const outcome = JSON.parse(feedback[2]) as ResearchFeedback.Outcome
          const inventory = [
            ...prompt.matchAll(
              /(?:Retained response targets, prior append-only claims and current evidence inventory|Closeout state \(identity applicability is not semantic completion\)): (.*)/g,
            ),
          ].at(-1)
          if (outcome.phase === "delivery" && inventory && scenario !== "pending-intent") {
            const detail = JSON.parse(inventory[1], (key, value) =>
              key === "targets"
                ? value.map((item: { response?: object }) => (item.response ? { ...item, ...item.response } : item))
                : value,
            ) as {
              basis: { planHash: string; subjectHash: string; verificationHash: string }
              targets: { findingID: string; responseHash: string; disposition: string; previousHash?: string }[]
            }
            const target = detail.targets.find(
              (item) =>
                item.disposition === "repair_planned" && !completionTargets.has(item.responseHash + item.findingID),
            )
            if (target) {
              const key = target.responseHash + target.findingID
              if (!readTargets.has(key)) {
                readTargets.add(key)
                return tool("contract_request", {
                  kind: "read_review_evidence",
                  payload: { source: "verification", path: "artifacts/result.json", offset: 0, length: 16384 },
                })
              }
              completionTargets.add(key)
              return tool("contract_request", {
                kind: "review_completion",
                payload: {
                  ...detail.basis,
                  responseHash: target.responseHash,
                  findingID: target.findingID,
                  ...(target.previousHash ? { previousHash: target.previousHash } : {}),
                  disposition: removed ? "removed" : "fixed",
                  reason: "Claim actual handling based on retained formal output",
                  evidence: [detail.basis.verificationHash],
                },
              })
            }
          }
          if (outcome.phase === "delivery" && scenario === "corrected-claim" && !state.corrected && inventory) {
            const detail = JSON.parse(inventory[1], (key, value) =>
              key === "targets"
                ? value.map((item: { response?: object }) => (item.response ? { ...item, ...item.response } : item))
                : value,
            ) as {
              basis: object
              targets: { responseHash: string; findingID: string }[]
            }
            const previous = strings(body.messages ?? body.input)
              .filter((text) => text.startsWith('{"requested":true'))
              .map((text) => JSON.parse(text) as { result?: { completionHash?: string } })
              .findLast((item) => item.result?.completionHash)?.result?.completionHash
            if (!previous) throw new Error("Completion tool receipt missing")
            state.corrected = true
            return tool("contract_request", {
              kind: "review_completion",
              payload: {
                ...detail.basis,
                responseHash: detail.targets[0].responseHash,
                findingID: detail.targets[0].findingID,
                previousHash: previous,
                disposition: "unresolved",
                reason: "Correct earlier completion certainty; preserve remaining limitation",
                evidence: [(detail.basis as { verificationHash: string }).verificationHash],
              },
            })
          }

          if (outcome.phase === "delivery" && scenario === "stale-completion" && !state.reworked) {
            state.reworked = true
            state.step = 0
            files[1][1] = JSON.stringify({ ...report, lifecycleRevision: "second candidate" })
            responded.add(feedback[1])
            return tool("contract_request", {
              kind: "review_response",
              payload: {
                version: 2,
                planChange: "retain",
                outcomeHash: feedback[1],
                responses: [],
                summary: "Another in-scope report edit requires fresh evidence",
                action: "repair",
              },
            })
          }
          responded.add(feedback[1])
          return tool("contract_request", {
            kind: "review_response",
            payload: {
              version: 2,
              planChange:
                outcome.phase === "plan" && (bad || removed) && !!outcome.review?.findings.length ? "revise" : "retain",
              outcomeHash: feedback[1],
              responses: (outcome.review?.findings ?? []).map((finding) => ({
                findingID: finding.id,
                disposition: bad || removed || scenario === "preexisting" ? "repair_planned" : "rebutted",
                reason:
                  scenario === "preexisting"
                    ? "analysis.mjs does not export analyze"
                    : bad
                      ? "Repair selection to validation and verify actual output; retain original defect"
                      : "The proposed selection uses validation IDs and the evaluation uses disjoint held-out test IDs",
                evidence: [outcome.materialsHash],
              })),
              summary:
                outcome.availability === "unavailable"
                  ? "Reviewer unavailable; no approval claimed. Continue with independently checked evidence and retain this limitation."
                  : "Handle original findings within the task",
              action:
                outcome.phase === "delivery"
                  ? "submit"
                  : (bad || removed) && !!outcome.review?.findings.length
                    ? "repair"
                    : "continue",
            },
          })
        }
        const plan = [...prompt.matchAll(/version=(\d+); agreement=(\{.*?\});/g)].at(-1)
        if (plan && Number(plan[1]) > state.plan) {
          state.plan = Number(plan[1])
          return tool("contract_request", {
            kind: "plan",
            payload: {
              version: state.plan,
              agreement: JSON.parse(plan[2]),
              scope: "within_task",
              ...(family === "P1" ? good.packet.plan : example.packet.plan),
              ...(removed
                ? {
                    method: "Remove the optional exploratory diagnostic. Use the fixed all-pair primary result only.",
                  }
                : {}),
              protected: [],
            },
          })
        }
        const index = state.step++
        if (index < files.length) return tool("write", { path: files[index][0], content: files[index][1] })
        if (index === files.length) return tool("contract_request", { kind: "experiment", payload: {} })
        if (index === files.length + 1)
          return tool("contract_request", {
            kind: "read_experiment",
            payload: { path: "artifacts/result.json", offset: 0, length: 16384 },
          })
        state.read = strings(body.messages ?? body.input).some((text) => {
          if (!text.startsWith("{")) return false
          const parsed = JSON.parse(text) as { result?: { eof?: boolean; content?: string; returnedBytes?: number } }
          return (
            !!parsed.result?.eof &&
            !!parsed.result.returnedBytes &&
            JSON.parse(parsed.result.content!).observations === 8
          )
        })
        return tool("contract_report_ready", {
          summary: "Local fixture candidate with real formal execution evidence",
          uncertainties: scenario === "unavailable" ? ["Reviewer report unavailable"] : [],
        })
      })()
      outgoing.writeHead(200, { "content-type": "text/event-stream" })
      outgoing.end(stream(delta, protocol))
    } catch (error) {
      state.error = error
      outgoing.writeHead(500)
      outgoing.end("Fixture failure")
    }
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const route = {
    endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/${protocol}`,
    model: "fixture-worker",
    parameters: {},
    credential: null,
  }
  const directory = options?.directory ?? "/tmp/opencode-lifecycle-continuation-" + scenario + "-" + crypto.randomUUID()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 80_000)
  try {
    const result = await runInstance({
      mode: "local-fixture",
      evaluation: "repair-lifecycle-v1",
      infrastructure: options?.infrastructure,
      feedbackGuidance: options?.feedbackGuidance,
      directory,
      packet: example.packet,
      entry: family === "P1" ? "followup" : "research",
      routes: { worker: route, reviewer: { ...route, model: "fixture-reviewer" } },
      limits: { worker: { context: 100_000, output: 4000 }, reviewer: { context: 100_000, output: 4000 } },
      timeouts: { provider: 5000, verification: 10000, cleanup: 30000 },
      bun: process.execPath,
      node: "/usr/bin/node",
      signal: controller.signal,
    })
    console.log("Lifecycle local fixture evidence:", scenario, directory)
    expect(state.error).toBeUndefined()
    expect(result.monitored.run.stage).toBe("ready")
    expect(state.read).toBe(true)
    expect(result.monitored.receipts).toEqual([])
    expect(result.deadline).toBe(result.issuedAt + 21_600_000)
    expect(calls.worker).toBeGreaterThan(4)
    expect(calls.urls.every((url) => url === "/v1/" + protocol)).toBe(true)
    expect(result.qualification).toBe("not_run")
    expect(result.monitored.firstReview?.job.input.id).not.toBe(result.monitored.run.reviewJobID)
    if (family === "P1") {
      expect(result.bootstrap?.planHash).toBe(result.monitored.firstReview?.plan.hash)
      const scripted = result.usage.filter((row) => row.origin === "script:initial-plan-only")
      expect(scripted).toHaveLength(1)
      expect(scripted[0]).toMatchObject({ wireRequests: 0, tokens: null, unknown: true })
    }
    if (scenario === "unavailable")
      expect(result.monitored.firstReview).toMatchObject({
        availability: "unavailable",
        exposed: true,
        raw: "Malformed independent report retained verbatim",
      })
    if (options?.capture) return { result, example, directory }
    const scoring = await prepareScoring({
      directory,
      result,
      packet: example.packet,
      oracle: example.oracle,
      launcher: await launcher(directory + "/scorer"),
      timeout: 5000,
    })
    expect(scoring.objective?.diagnostic).toBe(family === "P1" ? scenario !== "fake-fixed" : undefined)
    const blind = await Bun.file(directory + "/blind/objects/" + scoring.candidateHash).text()
    expect(blind).not.toContain("Controlled local fixture opinion")
    expect(await Bun.file(directory + "/blind/reviewer.json").exists()).toBe(false)
    const first = {
      rater: "fixture-one",
      candidateHash: scoring.candidateHash,
      rubricHash: scoring.rubricHash,
      items: Object.fromEntries(Object.keys(example.oracle.rubric).map((key) => [key, true])),
    }
    const pending = await sealCandidate({ directory, first, second: { ...first, rater: "fixture-two" } })
    expect("pending" in pending && pending.pending).toBe(true)
    expect(await Bun.file(directory + "/blind/reviewer.json").exists()).toBe(false)
    const revealed = await revealFeedback(directory)
    expect(revealed.material.measurement.version).toBe("repair-lifecycle-measurement:1")
    expect(revealed.material.measurement.finalQuality).toBe("all-cohort-candidate-seals-before-feedback-reveal:1")
    expect(revealed.material.measurement).not.toHaveProperty("infrastructure")
    expect(revealed.material.lifecycle.plans.length).toBeGreaterThan(0)
    const rating = {
      rater: "fixture-one",
      candidateHash: revealed.candidateHash,
      rubricHash: revealed.rubricHash,
      items: Object.fromEntries(
        Object.keys(revealed.rubric).map((key) => [
          key,
          key.endsWith(".implemented") && scenario === "preexisting"
            ? false
            : key.startsWith("completion.")
              ? scenario !== "fake-fixed" && scenario !== "preexisting"
              : key.endsWith(".actualRemoved")
                ? removed
                : key === "spontaneousTargetCorrection"
                  ? false
                  : key.endsWith(".validDefect")
                    ? bad
                    : key.endsWith(".unsupportedObjection")
                      ? !bad
                      : key.endsWith(".removed")
                        ? removed
                        : true,
        ]),
      ),
    }
    const scored = await finalizeScoring({ directory, first: rating, second: { ...rating, rater: "fixture-two" } })
    expect("evaluation" in scored).toBe(true)
    if (!("evaluation" in scored)) throw new Error("Expected v2 score")
    expect(scored.verdict).toBe(scenario === "fake-fixed" ? "incorrect" : "correct")
    expect(scored.dimensions.firstReviewer.label).toBe(
      family === "R3" ? "not_scored" : scenario === "unavailable" ? "unavailable" : bad ? "detected" : "false_block",
    )
    expect(scored.dimensions.delivery.externallyRecognized).toBe(false)
    const dimensions = scored.dimensions as ReturnType<typeof lifecycleMeasures>
    const handled = dimensions.feedback.handling[0]
    if (scenario === "rebuttal") expect(handled.result).toBe("supported_rebuttal")
    if (scenario === "repair") {
      expect(handled.result).toBe("implemented_repair")
      expect(result.monitored.run.plan?.value.version).toBe(2)
      expect(result.monitored.run.plan?.hash).not.toBe(result.bootstrap?.planHash)
      expect(result.monitored.run.experiment?.planHash).toBe(result.monitored.run.plan?.hash)
    }
    if (scenario === "fake-fixed") expect(handled.result).toBe("unresolved")
    if (scenario === "remove-bad") expect(handled.result).toBe("remediation_by_removal")
    if (scenario === "remove-good") expect(handled.result).toBe("relinquished")
    if (scenario === "unavailable") {
      expect(handled.result).toBe("honest_continuation")
      expect(scored.dimensions.finalReviewer.availability).toBe("unavailable")
      expect(result.monitored.raw).toBe("Malformed independent report retained verbatim")
    }
    if (scenario === "corrected-claim") {
      expect(revealed.material.lifecycle.completions).toHaveLength(2)
      expect(revealed.material.lifecycle.completions.map((item) => item.superseded)).toEqual([true, false])
      expect(dimensions.feedback.completionClaims.map((item) => item.quality)).toEqual(["supported", "supported"])
      expect(dimensions.feedback.completionClaims[1].revalidated).toBe("not_applicable")
      expect(handled.result).toBe("unresolved")
    }
    if (scenario === "preexisting") {
      expect(scored.dimensions.feedback.handling[0].result).toBe("unresolved")
      expect(dimensions.feedback.completionClaims[0].quality).toBe("unsupported")
    }
    if (scenario === "pending-intent" || scenario === "stale-completion") {
      expect(handled.result).toBe("pending_intent")
      expect("actual" in handled && handled.actual?.implemented).toBe(true)
      expect("completionState" in handled && handled.completionState).toBe(
        scenario === "pending-intent" ? "absent" : "historical_only",
      )
    }
    if (scenario === "stale-completion") expect(revealed.material.lifecycle.completions[0].current).toBe(false)
    if (scenario === "repair") {
      const object = async (hash: string, raw?: boolean) => {
        const bytes = await Bun.file(directory + "/archive/objects/" + hash).text()
        expect(digest(bytes)).toBe(hash)
        return raw ? bytes : JSON.parse(bytes)
      }
      const changed = {
        ...result,
        monitored: { ...result.monitored, run: { ...result.monitored.run, completionHashes: [] } },
      }
      await expect(lifecycleMaterials(changed, example.oracle, object, directory)).rejects.toThrow()
      for (const evaluation of ["feedback-v2", undefined] as const)
        await expect(
          prepareScoring({
            directory,
            result: { ...result, evaluation },
            packet: example.packet,
            oracle: example.oracle,
            launcher: "unused",
            timeout: 1,
          }),
        ).rejects.toThrow("explicit evaluation")
      const claimHash = result.monitored.run.completionHashes![0]
      const record = (await object(claimHash)) as { basisHash: string; request: { previousHash?: string } }
      for (const change of [
        { contractID: "pct_foreign" },
        { basisHash: "b".repeat(64) },
        { request: { ...record.request, previousHash: "c".repeat(64) } },
      ])
        await expect(
          lifecycleMaterials(
            result,
            example.oracle,
            async (hash, raw) =>
              hash === claimHash && !raw ? { ...((await object(hash)) as object), ...change } : object(hash, raw),
            directory,
          ),
        ).rejects.toThrow()
      await expect(
        lifecycleMaterials(
          result,
          example.oracle,
          async (hash, raw) => (hash === record.basisHash && raw ? "corrupt" : object(hash, raw)),
          directory,
        ),
      ).rejects.toThrow("object changed")
      const rerated = { ...rating, items: { ...rating.items } }
      const claim = revealed.material.lifecycle.completions[0]
      rerated.items["completion." + claim.hash + ".supported"] = false
      const measured = lifecycleMeasures({
        result,
        oracle: example.oracle,
        material: revealed,
        ratings: { first: rerated, second: { ...rerated, rater: "fixture-two" } },
        diagnostic: scoring.diagnostic,
        verdict: "correct",
      })
      expect(measured.feedback.handling[0].result).toBe("unresolved")
      expect("actual" in measured.feedback.handling[0] && measured.feedback.handling[0].actual?.implemented).toBe(true)
    }
    if (scenario === "negative") expect(scored.dimensions.feedback.coverage.valid_defect).toBe("not_observed")
  } finally {
    clearTimeout(timer)
    controller.abort()
    upstream.closeAllConnections()
    upstream.close()
  }
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === "object") return Object.values(value).flatMap(strings)
  return []
}

function tool(name: string, value: unknown) {
  return {
    tool_calls: [{ id: "fixture_" + crypto.randomUUID(), function: { name, arguments: JSON.stringify(value) } }],
  }
}

function stream(
  delta: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] },
  protocol: string,
) {
  const call = delta.tool_calls?.[0]
  if (protocol !== "responses")
    return (
      "data: " +
      JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: call
              ? { role: "assistant", tool_calls: [{ ...call, index: 0, type: "function" }] }
              : { role: "assistant", content: delta.content },
            finish_reason: call ? "tool_calls" : "stop",
          },
        ],
      }) +
      "\n\ndata: [DONE]\n\n"
    )
  const item = call ? { type: "function_call", id: "fc_" + call.id, call_id: call.id, ...call.function } : undefined
  return [
    ...(item
      ? [
          { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
          { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
          { type: "response.output_item.done", output_index: 0, item },
        ]
      : [{ type: "response.output_text.delta", item_id: "msg_fixture", delta: delta.content }]),
    {
      type: "response.completed",
      response: { id: "resp_fixture", usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } },
    },
  ]
    .map((event) => "data: " + JSON.stringify(event) + "\n\n")
    .join("")
}
