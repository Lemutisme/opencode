import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { ResearchModel } from "../../../sdk-next/src/research/model"
import { InstanceScoring, type Freeze } from "./instance-scoring"
import {
  failureScope,
  isolatedSchedule,
  measurementVersion,
  revealVersion,
  type Judgment,
  type TerminalObservation,
} from "./advisory-measurement"

export function fixtureFreeze(): Freeze {
  return {
    version: measurementVersion,
    reveal: revealVersion,
    codeHash: "a".repeat(64),
    unavailable: "not_scored",
    rubric: {
      correct: { dimension: "research_result", question: "Does the candidate meet the frozen task?" },
      repair: {
        dimension: "feedback_handling",
        question: "Did actual code eliminate the defect and independently revalidate?",
      },
      removal: {
        dimension: "feedback_handling",
        question: "Was the optional diagnostic removed in accordance with the task?",
      },
      claim: { dimension: "audit_completeness", question: "Is the completion claim supported?" },
      reviewer: { dimension: "reviewer_judgment", question: "Was the independent review scientifically supported?" },
    },
    instances: ["good", "bad", "negative"].map((id) => {
      const context = (role: string, rater: string) => ({
        id: id + ":" + role,
        execution: id + ":session:" + role,
        rater,
      })
      return {
        id,
        contractID: task(id).id,
        agreementHash: ProContractRecognition.fingerprint(task(id)),
        files: ["result.json"],
        started: 1,
        deadline: 21_600_001,
        roles: {
          candidate: [context("candidate-a", "a"), context("candidate-b", "b")],
          candidateAdjudicator: context("candidate-judge", "judge"),
          feedback: [context("feedback-a", "a"), context("feedback-b", "b")],
          feedbackAdjudicator: context("feedback-judge", "judge"),
        },
      }
    }),
  }
}

export function annotate(grant: ReturnType<InstanceScoring["grant"]>, change?: Partial<Judgment["items"]>): Judgment {
  return {
    rater: grant.context.rater,
    context: grant.context.id,
    materialHash: grant.materialHash,
    rubricHash: grant.rubricHash,
    items: Object.fromEntries(
      Object.keys(grant.rubric).map((key) => [
        key,
        change?.[key] ?? {
          status: "scored",
          value: true,
          reason: "Deterministic fixture judgment of supplied evidence",
          evidence: [grant.materialHash],
        },
      ]),
    ),
  }
}

const prepare = (scoring: InstanceScoring, id: string) =>
  scoring.prepare(id, {
    source: {
      contractID: task(id).id,
      agreementHash: ProContractRecognition.fingerprint(task(id)),
      deadline: 21_600_001,
      files: ["result.json"],
      archiveHash: "c".repeat(64),
    },
    candidate: { instance: id, files: { "result.json": "42" }, task: "Return 42", verification: "42" },
    feedback: { opinions: ["P1: too narrow"], actual: { implemented: true, revalidated: true }, completion: undefined },
    audit: { completion: "absent", treatment: "not_provided" },
    infrastructure: { operation: "completed", accounting: { original: 1, supplemental: 2, unknown: true } },
  })
const seal = (
  scoring: InstanceScoring,
  id: string,
  phase: "candidate" | "feedback",
  change?: Partial<Judgment["items"]>,
) => {
  for (const suffix of ["a", "b"]) {
    const grant = scoring.grant(id, phase, `${id}:${phase}-${suffix}`)
    scoring.rate(grant.receipt, annotate(grant, change))
  }
  return scoring.seal(id, phase)
}
const agreement = Schema.decodeUnknownSync(ResearchModel.Input)({
  id: "pct_terminal",
  scope: "fixture",
  source: { directory: "/source" },
  model: { providerID: "test", id: "test" },
  spec: {
    trigger: { type: "immediate" },
    goal: "Task",
    brief: "Task",
    requires: [],
    authority: ["filesystem.read"],
    budget: { deadline: 21_600_001 },
    evidence: { type: "principal", claim: "claim" },
    resolution: { retryDelay: 1 },
  },
  manifest: {
    version: 1,
    reviewPolicy: { version: 3, plan: "advisory", delivery: "advisory" },
    requirements: ["result"],
    include: [],
    dependencies: [],
    verification: {
      adapter: "node-test-tap:1",
      executable: "/node",
      executableHash: "a".repeat(64),
      tests: ["test.cjs"],
      harness: [{ path: "test.cjs", hash: "b".repeat(64) }],
      expectedTests: ["result"],
      minimumTests: 1,
      maximumSkipped: 0,
      timeout: 1000,
    },
    artifacts: [],
    reviewer: { model: { providerID: "test", id: "test" }, agent: "build", instructions: "Review" },
  },
})
const task = (id: string) => Schema.decodeUnknownSync(ResearchModel.Input)({ ...agreement, id: "pct_" + id })
const terminal = (): TerminalObservation => ({
  agreement: task("negative"),
  reason: "Issuance failed before creating a run",
  inspection: {
    contractID: task("negative").id,
    at: 4,
    stopped: "confirmed",
    cleanup: "confirmed",
    exhaustive: true,
    runs: [],
    pendingOperations: [],
  },
})

describe("New per-instance measurement; historical batch gate is unchanged", () => {
  test("two complete candidates reveal without waiting for a third broken terminal seal", () => {
    const scoring = new InstanceScoring(":memory:", fixtureFreeze())
    try {
      for (const id of ["good", "bad"]) {
        prepare(scoring, id)
        seal(scoring, id, "candidate")
      }
      expect(() =>
        scoring.terminal(
          "negative",
          { ...terminal(), inspection: { ...terminal().inspection, cleanup: "unknown" } },
          {},
          {},
        ),
      ).toThrow("confirmed")
      scoring.gap("negative", "Cleanup cannot be confirmed", { operation: "unknown" })
      for (const id of ["good", "bad"])
        seal(scoring, id, "feedback", {
          claim: { status: "not_observed", value: null, reason: "No completion claim was written", evidence: [] },
          removal: { status: "not_applicable", value: null, reason: "The implementation was repaired", evidence: [] },
        })
      const report = scoring.report()
      expect(report.denominator).toBe(3)
      expect(report.status).toBe("partial")
      expect(report.rows[0].feedbackHandling.researcher.repair.value).toBe(true)
      expect(report.rows[0].auditCompleteness.facts).toEqual({ completion: "absent", treatment: "not_provided" })
      expect(report.rows[0].auditCompleteness.judgments.claim.status).toBe("not_observed")
      expect(report.rows[2].researchResult.candidate).toBe("unknown")
      expect(report.rows[2].feedbackHandling.researcher.repair.status).toBe("not_scored")
    } finally {
      scoring.close()
    }
  })
  test("confirmed pre-run absence keeps the denominator but creates no invented quality score", () => {
    const scoring = new InstanceScoring(":memory:", fixtureFreeze())
    try {
      scoring.terminal("negative", terminal(), { noOpinion: true }, { phase: "preparation", usage: "unknown" })
      expect(() => scoring.terminal("good", terminal(), {}, {})).toThrow("another agreement")
      expect(() => scoring.grant("negative", "candidate", "negative:candidate-a")).toThrow("real candidate")
      seal(
        scoring,
        "negative",
        "feedback",
        Object.fromEntries(
          ["repair", "removal", "claim", "reviewer"].map((key) => [
            key,
            { status: "not_observed", value: null, reason: "Worker and reviewer did not execute", evidence: [] },
          ]),
        ) as Judgment["items"],
      )
      const row = scoring.report().rows[2]
      expect(row.researchResult.candidate).toBe("absent")
      expect(row.researchResult.items.correct.status).toBe("not_scored")
      expect(row.candidateSeal).toBeUndefined()
      expect(row.feedbackSeal).toBeTruthy()
    } finally {
      scoring.close()
    }
  })
  test("partial double rating and unresolved disagreement cannot open the target feedback", () => {
    const scoring = new InstanceScoring(":memory:", fixtureFreeze())
    try {
      prepare(scoring, "bad")
      const a = scoring.grant("bad", "candidate", "bad:candidate-a")
      scoring.rate(a.receipt, annotate(a))
      expect(() => scoring.seal("bad", "candidate")).toThrow("unavailable")
      expect(() => scoring.grant("bad", "feedback", "bad:feedback-a")).toThrow("own complete")
      const b = scoring.grant("bad", "candidate", "bad:candidate-b")
      scoring.rate(
        b.receipt,
        annotate(b, {
          correct: { status: "scored", value: false, reason: "A contrary judgment", evidence: [b.materialHash] },
        }),
      )
      expect(() => scoring.seal("bad", "candidate")).toThrow("unavailable")
      const judge = scoring.grant("bad", "candidate", "bad:candidate-judge")
      expect(judge.prior).toHaveLength(2)
      scoring.rate(judge.receipt, annotate(judge))
      scoring.seal("bad", "candidate")
      expect(scoring.grant("bad", "feedback", "bad:feedback-a").material).toBeTruthy()
      expect(() =>
        scoring.rate(
          a.receipt,
          annotate(a, {
            correct: { status: "not_scored", value: null, reason: "Change sealed opinion", evidence: [] },
          }),
        ),
      ).toThrow("already sealed")
    } finally {
      scoring.close()
    }
  })
  test("wrong receipt, candidate, rubric and context aliases are rejected", () => {
    const frozen = fixtureFreeze()
    const scoring = new InstanceScoring(":memory:", frozen)
    try {
      prepare(scoring, "good")
      const a = scoring.grant("good", "candidate", "good:candidate-a")
      expect(() => scoring.rate("unknown", annotate(a))).toThrow("receipt")
      expect(() => scoring.rate(a.receipt, { ...annotate(a), materialHash: "b".repeat(64) })).toThrow("identity")
      expect(() => scoring.rate(a.receipt, { ...annotate(a), rubricHash: "b".repeat(64) })).toThrow("identity")
      expect(() =>
        scoring.rate(
          a.receipt,
          annotate(a, { correct: { status: "scored", value: true, reason: "Empty reference", evidence: [""] } }),
        ),
      ).toThrow("evidence")
      expect(() => scoring.grant("good", "candidate", "good:feedback-a")).toThrow("assigned")
      expect(() => scoring.grant("bad", "candidate", "good:candidate-a")).toThrow("assigned")
      frozen.instances[1].roles.candidate[0].execution = frozen.instances[0].roles.feedback[0].execution
      expect(() => new InstanceScoring(":memory:", frozen)).toThrow("aliases")
      const noQuality = fixtureFreeze()
      delete noQuality.rubric.correct
      expect(() => new InstanceScoring(":memory:", noQuality)).toThrow("each measurement dimension")
    } finally {
      scoring.close()
    }
  })
  test("corrupt one candidate does not prevent another candidate's own reveal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "advisory-score-"))
    const file = path.join(dir, "score.sqlite")
    const scoring = new InstanceScoring(file, fixtureFreeze())
    try {
      prepare(scoring, "good")
      prepare(scoring, "bad")
      const grant = scoring.grant("bad", "candidate", "bad:candidate-a")
      seal(scoring, "good", "candidate")
      const db = new Database(file)
      db.query("UPDATE object SET value='{}' WHERE hash=?").run(grant.materialHash)
      db.close()
      expect(() => scoring.grant("bad", "candidate", "bad:candidate-b")).toThrow("corrupt")
      expect(scoring.grant("good", "feedback", "good:feedback-a").receipt).toBeTruthy()
      expect(scoring.report().rows[0].candidateSeal).toBeTruthy()
      expect(scoring.report().rows[1].researchResult.candidate).toBe("unknown")
    } finally {
      scoring.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
  test("unsupported completion remains separate from actual repair and removal", () => {
    const scoring = new InstanceScoring(":memory:", fixtureFreeze())
    try {
      prepare(scoring, "bad")
      seal(scoring, "bad", "candidate")
      const grant = scoring.grant("bad", "feedback", "bad:feedback-a")
      const change: Judgment["items"] = {
        claim: { status: "scored", value: false, reason: "Claim lacks support", evidence: [grant.materialHash] },
        repair: { status: "scored", value: false, reason: "Code still leaks", evidence: [grant.materialHash] },
      }
      seal(scoring, "bad", "feedback", change)
      const row = scoring.report().rows[1]
      expect(row.feedbackHandling.researcher.repair.value).toBe(false)
      expect(row.auditCompleteness.judgments.claim.value).toBe(false)
    } finally {
      scoring.close()
    }
  })
})

test("one scheduled attempt per instance, local cleanup isolation, no timeout-based safety inference", async () => {
  const calls: string[] = []
  const instances = fixtureFreeze().instances
  const local = {
    phase: "issuance",
    operation: "stopped",
    cleanup: "confirmed",
    isolation: "instance",
    integrity: "intact",
    evidence: ["host stop receipt"],
  } as const
  const result = await isolatedSchedule({
    instances,
    now: () => 2,
    attempt: async (item) => {
      calls.push(item.id)
      return item.id === "good"
        ? { status: "failed", failure: { ...local, evidence: [...local.evidence] } }
        : { status: "completed", evidence: [item.id] }
    },
  })
  expect(calls).toEqual(["good", "bad", "negative"])
  expect(result.rows.map((row) => row.deadline)).toEqual(instances.map((item) => item.deadline))
  const blocked = await isolatedSchedule({
    instances,
    now: () => 2,
    attempt: async () => ({
      status: "failed",
      failure: { ...local, operation: "running", evidence: [...local.evidence] },
    }),
  })
  expect(blocked.rows[1].result).toEqual({ status: "not_started", reason: "shared_safety_unknown" })
  expect(failureScope({ ...local, cleanup: "unknown", evidence: [...local.evidence] }).scope).toBe("shared")
  expect(failureScope({ ...local, integrity: "broken", evidence: [...local.evidence] }).scope).toBe("shared")
  let attempts = 0
  await expect(
    isolatedSchedule({
      instances: [instances[0], instances[0]],
      now: () => 2,
      attempt: async () => {
        attempts += 1
        return { status: "completed", evidence: [] }
      },
    }),
  ).rejects.toThrow("unique")
  expect(attempts).toBe(0)
})
