import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ResearchFeedback } from "../src/research/review-feedback"

const map: ResearchFeedback.References = {
  version: 2,
  contractID: ProContract.ID.create(),
  phase: "plan",
  round: 1,
  reviewVersion: 1,
  jobID: "review-job-1",
  context: { revision: 1, specHash: "s".repeat(64), version: 1, phaseID: "plan" },
  manifestHash: "a".repeat(64),
  materialsHash: "b".repeat(64),
  subjectHash: "background-snapshot",
  planHash: "c".repeat(64),
  entries: [
    { id: "plan", hash: "c".repeat(64) },
    { id: "materials", hash: "b".repeat(64) },
  ],
}
const review = {
  version: 2,
  verdict: "changes_requested",
  scope: "within_task",
  summary: "Report uncertainty for the selected estimate.",
  findings: [
    {
      id: "uncertainty",
      severity: "P1",
      path: "plan.evaluation",
      reason: "A confidence interval is missing.",
      resolution: "Report the held-out estimate and interval.",
      impact: "Affects the precision claim, not candidate permissions.",
      evidence: [{ jobID: map.jobID, id: "plan" }],
      escalation: "Principal should see the remaining measurement limitation.",
    },
  ],
  claims: [
    { text: "The proposed evaluation lacks precision reporting.", evidence: [{ jobID: map.jobID, id: "plan" }] },
  ],
} satisfies typeof ResearchFeedback.WireReview.Type

function outcome(value = ResearchFeedback.resolve(JSON.stringify(review), map)): ResearchFeedback.Outcome {
  return {
    ...value,
    version: 2,
    contractID: map.contractID,
    phase: map.phase,
    round: map.round,
    reviewVersion: map.reviewVersion,
    jobID: map.jobID,
    inputHash: "d".repeat(64),
    fingerprint: "e".repeat(64),
    generation: 1,
    jobStatus: "completed",
    context: map.context,
    manifestHash: map.manifestHash,
    materialsHash: map.materialsHash,
    subjectHash: map.subjectHash,
    planHash: map.planHash,
    referencesHash: ProContractRecognition.fingerprint(map),
    capture: "complete",
    rawHash: "f".repeat(64),
  }
}

describe("Job-scoped review evidence", () => {
  test("new prompt renders selectable objects without exposing a second citation syntax", () => {
    const rendered = ResearchFeedback.prompt({
      ...map,
      promptVersion: 2,
      entries: [
        { ...map.entries[0], label: "materials.plan: proposed execution plan" },
        { ...map.entries[1], label: "evidence/materials.json: original task" },
      ],
    })
    expect(rendered).toContain(JSON.stringify({ id: "plan", jobID: map.jobID }))
    expect(rendered).toContain(JSON.stringify([{ jobID: map.jobID, id: "plan" }]))
    for (const item of map.entries) expect(rendered).not.toContain(item.hash)
    expect(rendered).not.toContain("Allowed evidence references")
    expect(rendered).not.toContain("Review evidence map")
    expect(rendered).toContain(
      ProContractRecognition.canonical({
        material: "materials.plan: proposed execution plan",
        selector: { jobID: map.jobID, id: "plan" },
      }),
    )
    expect(ResearchFeedback.resolve(JSON.stringify(review), { ...map, promptVersion: 2 })).toEqual(
      ResearchFeedback.resolve(JSON.stringify(review), map),
    )
  })
  test("resolves structured references and retains finding severity, impact and escalation", () => {
    const result = ResearchFeedback.resolve(JSON.stringify(review), map)
    expect(result.availability).toBe("available")
    expect(result.review?.verdict).toBe("changes_requested")
    expect(result.review?.findings[0]).toEqual({ ...review.findings[0], evidence: [map.planHash!] })
    expect(result.review?.claims[0].evidence).toEqual([map.planHash!])
    expect(result.resolved).toEqual([
      { jobID: map.jobID, id: "plan", hash: map.planHash! },
      { jobID: map.jobID, id: "plan", hash: map.planHash! },
    ])
  })

  test.each([
    ["another job", { jobID: "previous-job", id: "plan" }],
    ["unknown ID", { jobID: map.jobID, id: "missing-plan" }],
    ["full hash in place of ID", { jobID: map.jobID, id: map.planHash }],
    ["bare old-format hash", map.planHash],
    ["abbreviated old-format hash", map.planHash!.slice(0, 12)],
    ["extra reference metadata", { jobID: map.jobID, id: "plan", candidate: "old" }],
  ])("rejects %s without guessing or repairing the citation", (_, reference) => {
    const result = ResearchFeedback.resolve(
      JSON.stringify({ ...review, claims: [{ text: "Claim", evidence: [reference] }] }),
      map,
    )
    expect(result.availability).toBe("unavailable")
    expect(result.review).toBeUndefined()
    expect(result.error).toBeTruthy()
  })

  test("a copied report cannot reuse the same short ID in a new job or candidate version", () => {
    const next = { ...map, jobID: "review-job-2", subjectHash: "new-snapshot", reviewVersion: 2 }
    const result = ResearchFeedback.resolve(JSON.stringify(review), next)
    expect(result.availability).toBe("unavailable")
    expect(result.error).toContain("another review job")
  })

  test("ambiguous maps and duplicate findings never resolve", () => {
    expect(
      ResearchFeedback.resolve(JSON.stringify(review), {
        ...map,
        entries: [...map.entries, { id: "plan", hash: "a".repeat(64) }],
      }).availability,
    ).toBe("unavailable")
    expect(
      ResearchFeedback.resolve(JSON.stringify({ ...review, findings: [...review.findings, ...review.findings] }), map)
        .availability,
    ).toBe("unavailable")
  })

  test.each(["not json", "```json\n{}\n```", JSON.stringify({ ...review, version: 1 }), "{}"])(
    "malformed output stays unavailable with no invented review: %s",
    (raw) => {
      const result = ResearchFeedback.resolve(raw, map)
      expect(result.availability).toBe("unavailable")
      expect(result.review).toBeUndefined()
      expect(result.resolved).toEqual([])
    },
  )

  test("a valid explicit unavailable report retains its actual findings", () => {
    const result = ResearchFeedback.resolve(JSON.stringify({ ...review, verdict: "unavailable" }), map)
    expect(result.availability).toBe("unavailable")
    expect(result.review?.verdict).toBe("unavailable")
    expect(result.review?.findings).toHaveLength(1)
  })

  test("P1 is an opinion field and does not automatically change a supported accept", () => {
    const result = ResearchFeedback.resolve(JSON.stringify({ ...review, verdict: "accept" }), map)
    expect(result.availability).toBe("available")
    expect(result.review?.verdict).toBe("accept")
    expect(result.review?.findings[0].severity).toBe("P1")
  })

  test("explicit blocking findings remain incompatible with an accept report", () => {
    const result = ResearchFeedback.resolve(
      JSON.stringify({ ...review, verdict: "accept", findings: [{ ...review.findings[0], severity: "blocking" }] }),
      map,
    )
    expect(result.availability).toBe("unavailable")
    expect(result.review).toBeUndefined()
  })

  test("the map schema rejects shortened hashes and the prompt preserves full identity", () => {
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(ResearchFeedback.References)({
          ...map,
          entries: [{ id: "plan", hash: map.planHash!.slice(0, 12) }],
        }),
      ),
    ).toBe(true)
    expect(ResearchFeedback.prompt(map)).toContain(ProContractRecognition.canonical(map))
  })
})

describe("Researcher feedback accounting", () => {
  test("source archives preserve provider errors and round-trip decoded message timestamps", () => {
    const message = Schema.decodeUnknownSync(SessionMessage.Message)({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "test" },
      time: { created: 1789926164660, completed: 1789926164700 },
      content: [
        {
          type: "reasoning",
          id: "reasoning-1",
          text: "Partial review before the provider failed.",
          time: { created: 1789926164670, completed: 1789926164690 },
        },
      ],
      error: { type: "unknown", message: "Provider returned an error before final output" },
    })
    const archived = ResearchFeedback.encodeSource(message)
    expect(archived.time.created).toBe(1789926164660)
    const restored = Schema.decodeUnknownSync(SessionMessage.Message)(JSON.parse(JSON.stringify(archived)))
    expect(ProContractRecognition.same(restored, message)).toBe(true)
    expect(restored.type === "assistant" ? restored.error : undefined).toEqual({
      type: "unknown",
      message: "Provider returned an error before final output",
    })
    expect(ProContractRecognition.fingerprint(ResearchFeedback.encodeSource(restored))).toBe(
      ProContractRecognition.fingerprint(archived),
    )
  })

  test("an unavailable reviewer environment has no invented instruction identity", () => {
    const decode = Schema.decodeUnknownOption(ResearchFeedback.Environment, { onExcessProperty: "error" })
    const missing = { unavailable: "Approved reviewer agent is unavailable" }
    expect(Option.getOrUndefined(decode(missing))).toEqual(missing)
    expect(Option.isNone(decode({ ...missing, instructionsHash: "a".repeat(64) }))).toBe(true)
    expect(
      Option.isNone(
        decode({
          ...missing,
          configurationHash: "a".repeat(64),
          agentHash: "b".repeat(64),
          instructionsHash: "c".repeat(64),
        }),
      ),
    ).toBe(true)
    expect(Option.isNone(decode({ unavailable: "" }))).toBe(true)
  })

  test.each(["fixed", "rebutted", "unresolved"] as const)(
    "accepts an explicit %s response with its reason",
    (disposition) => {
      const report = outcome()
      expect(
        ResearchFeedback.validateResponse(report, {
          outcomeHash: ProContractRecognition.fingerprint(report),
          responses: [{ findingID: "uncertainty", disposition, reason: "The interval is now included in evaluation." }],
          summary: "All review findings considered; remaining uncertainty is stated.",
          action: "continue",
        }),
      ).toBeUndefined()
      expect(report.review?.verdict).toBe("changes_requested")
    },
  )

  test("missing, duplicate, foreign and stale finding responses fail", () => {
    const report = outcome()
    const response = {
      outcomeHash: ProContractRecognition.fingerprint(report),
      responses: [{ findingID: "uncertainty", disposition: "unresolved" as const, reason: "Requires more data." }],
      summary: "The limitation remains explicit.",
      action: "continue" as const,
    }
    for (const changed of [
      { ...response, responses: [] },
      { ...response, responses: [...response.responses, ...response.responses] },
      { ...response, responses: [{ ...response.responses[0], findingID: "another-report" }] },
      { ...response, outcomeHash: "a".repeat(64) },
      { ...response, summary: " " },
      { ...response, responses: [{ ...response.responses[0], reason: "\n" }] },
      { ...response, action: "submit" as const },
    ])
      expect(ResearchFeedback.validateResponse(report, changed)).toBeTruthy()
  })

  test("unavailable feedback requires an explicit summary and never becomes a valid review", () => {
    const report = outcome(ResearchFeedback.resolve("malformed", map))
    expect(
      ResearchFeedback.validateResponse(report, {
        outcomeHash: ProContractRecognition.fingerprint(report),
        responses: [],
        summary: "Reviewer output was malformed; the missing independent opinion remains an unresolved limitation.",
        action: "continue",
      }),
    ).toBeUndefined()
    expect(report.availability).toBe("unavailable")
    expect(report.review).toBeUndefined()
  })
})
