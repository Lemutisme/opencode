import { describe, expect, test } from "bun:test"
import { acceptanceClaim, admission, hash, phase, verdict } from "./benchmark-contract"

function input() {
  const instruction = "Implement the documented calculator behavior and deliver result.txt."
  return {
    id: "pct_benchmark",
    scope: "benchmark-test",
    instruction,
    executionPolicy: "Repair failed public checks before submitting.",
    location: { directory: "/workspace" },
    model: { providerID: "openai", id: "gpt-5.6-luna", variant: "max" },
    budget: { deadline: Date.now() + 60_000 },
    manifest: {
      version: 1,
      instructionHash: hash(instruction),
      finalEvaluatorHash: hash("grader"),
      visibility: "public",
      provenance: "Issuer-owned public task fixture, not the hidden benchmark grader.",
      replay: {
        checks: [{ argv: ["python3", "-I", "-S", "-c", "assert 1+1==2"], timeout: 1000, exit: 0 }],
        protected: [],
        artifacts: ["result.txt"],
      },
    },
  }
}

function report() {
  return {
    subject: {
      contractID: "pct_benchmark",
      revision: 1,
      specHash: "spec-1",
      subjectHash: "candidate-1",
      evaluatorHash: hash("grader"),
    },
    current: {
      id: "pct_benchmark",
      revision: 1,
      specHash: "spec-1",
      status: "verification",
      handoff: { subjectHash: "candidate-1" },
      spec: { goal: "Task objective", evidence: { claim: acceptanceClaim("Task objective", hash("grader")) } },
    },
    generationSealed: true,
    sealHash: hash("host-owned solver-stop receipt"),
    evaluatorHash: hash("grader"),
    artifactsHash: hash("exact collected artifact manifest"),
    outcome: "passed",
    reportHash: hash("independent report"),
  }
}

describe("benchmark Contract boundary", () => {
  test("does not downgrade the task claim to candidate readiness", () => {
    const value = input()
    const result = admission(value)
    expect(result.evidence.claim).toContain(value.instruction)
    expect(result.evidence.claim).toContain(value.manifest.finalEvaluatorHash)
    expect(result.evidence.claim).not.toContain("ready for independent benchmark evaluation")
    expect(JSON.stringify(result.evidence.replay)).toBe(JSON.stringify(value.manifest.replay))
    expect(result.resolution.maxAttempts).toBe(1)
    expect(result.budget).toEqual(value.budget)
    expect(result.budget).not.toHaveProperty("turns")
    expect(result.budget).not.toHaveProperty("actions")
  })

  test("keeps strategy outside immutable task terms", () => {
    const value = input()
    const first = admission(value)
    const second = admission({ ...value, executionPolicy: "Use another solver strategy." })
    expect({ ...first, executionPolicy: undefined }).toEqual({ ...second, executionPolicy: undefined })
    expect(first.brief).not.toContain(value.executionPolicy)
  })

  test("fails closed without public executable checks", () => {
    const value = input()
    expect(() => admission({ ...value, manifest: undefined })).toThrow()
    expect(() =>
      admission({
        ...value,
        manifest: { ...value.manifest, replay: { checks: [], protected: [], artifacts: ["result.txt"] } },
      }),
    ).toThrow("executable public check")
    expect(() =>
      admission({
        ...value,
        manifest: {
          ...value.manifest,
          replay: { ...value.manifest.replay, checks: [{ argv: [], timeout: 1000, exit: 0 }] },
        },
      }),
    ).toThrow("command is empty")
  })

  test("admits explicitly sealed external evaluation without inventing public checks", () => {
    const value = input()
    const result = admission({
      ...value,
      manifest: {
        version: 2,
        instructionHash: value.manifest.instructionHash,
        finalEvaluatorHash: value.manifest.finalEvaluatorHash,
        visibility: "sealed",
        mode: "external-only",
        provenance: "Pinned official task and separate final verifier.",
      },
    })
    expect(result.evidence).not.toHaveProperty("replay")
    expect(result.evidence.claim).toBe(acceptanceClaim(value.instruction, value.manifest.finalEvaluatorHash))
    expect(result.budget).toEqual(value.budget)
    expect(result.resolution.maxAttempts).toBe(1)
  })

  test("does not admit sealed final tests as in-attempt feedback", () => {
    const value = input()
    expect(() =>
      admission({
        ...value,
        manifest: {
          ...value.manifest,
          version: 2,
          visibility: "sealed",
          mode: "external-only",
        },
      }),
    ).toThrow()
    expect(() =>
      admission({
        ...value,
        manifest: {
          ...value.manifest,
          version: 2,
          replay: undefined,
          visibility: "public",
          mode: "external-only",
        },
      }),
    ).toThrow()
  })

  test("rejects hidden or wrong-task feedback plans", () => {
    const value = input()
    expect(() => admission({ ...value, manifest: { ...value.manifest, visibility: "sealed" } })).toThrow()
    expect(() => admission({ ...value, manifest: { ...value.manifest, instructionHash: hash("other task") } })).toThrow(
      "does not match",
    )
  })

  test("does not extend expired or invalid budgets", () => {
    const value = input()
    expect(() => admission({ ...value, budget: { deadline: Date.now() - 1 } })).toThrow("expired")
    expect(() => admission({ ...value, budget: { deadline: Infinity } })).toThrow()
    expect(() => admission({ ...value, budget: { ...value.budget, turns: 0 } })).toThrow()
  })

  test("verification is not completion", () => {
    expect(phase("active")).toBe("continue")
    expect(phase("verification")).toBe("evaluate")
    expect(phase("discharged")).toBe("complete")
    expect(phase("escalated")).toBe("blocked")
    expect(() => phase("done")).toThrow()
  })

  test("only an independent passing report requests attestation", () => {
    expect(verdict(report()).action).toBe("attest")
    expect(() => verdict({ ...report(), generationSealed: false })).toThrow()
    expect(() => verdict({ ...report(), outcome: "unknown" })).toThrow()
  })

  test("cannot replace the frozen evaluator or weaken the acceptance claim", () => {
    const value = report()
    expect(() => verdict({ ...value, evaluatorHash: hash("easier grader") })).toThrow("frozen task-acceptance")
    expect(() =>
      verdict({
        ...value,
        current: { ...value.current, spec: { ...value.current.spec, evidence: { claim: "Candidate is ready" } } },
      }),
    ).toThrow("frozen task-acceptance")
  })

  test("a negative final report is sealed, never an automatic repair oracle", () => {
    const result = verdict({ ...report(), outcome: "failed" })
    expect(result.action).toBe("challenge")
    if (result.action !== "challenge") throw new Error("Expected challenge")
    expect(result.body.disclosure).toBe("sealed")
    expect(result.body).not.toHaveProperty("summary")
  })

  test("unavailable grading neither discharges nor invents a model failure", () => {
    const result = verdict({ ...report(), outcome: "unavailable" })
    expect(result.action).toBe("pending")
    expect(result).not.toHaveProperty("path")
  })

  test.each(["contractID", "revision", "specHash", "subjectHash"] as const)("rejects stale %s", (key) => {
    const value = report()
    expect(() => verdict({ ...value, subject: { ...value.subject, [key]: key === "revision" ? 2 : "other" } })).toThrow(
      "stale or different",
    )
  })

  test("binds evidence to evaluator, exact artifacts, outcome and report", () => {
    const value = report()
    const original = verdict(value).evidenceHash
    for (const key of ["sealHash", "artifactsHash", "reportHash"] as const)
      expect(verdict({ ...value, [key]: hash("changed") }).evidenceHash).not.toBe(original)
    expect(verdict({ ...value, outcome: "failed" }).evidenceHash).not.toBe(original)
  })
})
