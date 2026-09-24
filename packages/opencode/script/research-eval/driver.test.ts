import { expect, test } from "bun:test"
import { evidence, firstTarget, recoveryJobs, target } from "./driver"
import { digest } from "./ledger"
import { score } from "./score"
import type { ResearchModel } from "../../../sdk-next/src/research/model"

// Minimal durable versions exercise the evaluator's selector, without writing production approval state.
test("first target selection survives multiple plans between controller polls", () => {
  const first = {
    input: { manifest: { reviewPolicy: { version: 1 } } },
    version: 10,
    stage: "exploration",
    plan: { jobID: "first", hash: "plan-1", reportHash: "report-1", approved: false },
  } as ResearchModel.Run
  const second = {
    input: { manifest: { reviewPolicy: { version: 1 } } },
    version: 20,
    stage: "execution",
    plan: { jobID: "second", hash: "plan-2", reportHash: "report-2", approved: true },
  } as ResearchModel.Run
  expect(firstTarget([second, first], "plan")).toBe(first)
  expect(
    firstTarget([second, { ...first, plan: { ...first.plan!, reportHash: undefined }, stage: "plan_review" }], "plan"),
  ).toBe(second)
})

test("observed plan admission distinguishes v2 host admission from historical reviewer approval", () => {
  const run = {
    input: { manifest: { reviewPolicy: { version: 2, plan: "advisory", delivery: "advisory" } } },
    plan: { approved: false, admitted: true, reportHash: "outcome" },
  } as ResearchModel.Run
  expect(target(run, "plan").gate).toBe("open")
  expect(target({ ...run, plan: { ...run.plan!, approved: true, admitted: false } }, "plan").gate).toBe("closed")
  const historical = { ...run, input: { ...run.input, manifest: { ...run.input.manifest, reviewPolicy: undefined } } }
  expect(target(historical, "plan").gate).toBe("closed")
  expect(target({ ...historical, plan: { ...historical.plan!, approved: true, admitted: false } }, "plan").gate).toBe(
    "open",
  )
})

test("final evidence admits retained raw artifacts and rejects foreign or changed content", async () => {
  const raw = "retained result"
  const artifact = digest(raw)
  const verification = JSON.stringify({
    version: 1,
    jobID: "verify",
    inputHash: digest("input"),
    fingerprint: digest("fingerprint"),
    generation: 1,
    context: { revision: 1, specHash: "spec", version: 1, phaseID: "phase" },
    subjectHash: "candidate",
    manifestHash: digest("manifest"),
    verdict: "passed",
    reason: "Actual evidence",
    tests: [],
    replay: { policyHash: "policy", subjectHash: "candidate", evidenceHash: "result", passed: true, summary: "passed" },
    evidence: [{ path: "artifacts/result.json", hash: artifact, bytes: Buffer.byteLength(raw) }],
  })
  const run = {
    version: 1,
    stage: "ready",
    verificationHash: digest(verification),
    verifierJobID: "verify",
    subjectHash: "candidate",
    manifestHash: digest("manifest"),
  } as ResearchModel.Run
  const objects = new Map([
    [artifact, raw],
    [run.verificationHash!, verification],
  ])
  const allowed = await evidence(run, "final", async (hash) => objects.get(hash)!)
  expect(allowed).toContain(artifact)
  const input = {
    entry: "final" as const,
    defective: false,
    exposed: true,
    findings: [],
    semanticConsistent: true,
    gate: "open" as const,
    gateReason: "ready",
    mechanicalBlock: false,
    evidence: allowed,
  }
  const report = (reference: string) =>
    JSON.stringify({
      version: 1,
      verdict: "accept",
      summary: "Checked result",
      findings: [],
      claims: [{ text: "Numeric result", evidence: [reference] }],
    })
  expect(score({ ...input, raw: report(artifact) }).label).toBe("valid_accept")
  expect(score({ ...input, raw: report(digest("foreign")) }).label).toBe("unavailable")
  expect(evidence(run, "final", async (hash) => (hash === artifact ? "changed" : verification))).rejects.toThrow(
    "artifact identity",
  )
  expect(evidence({ ...run, subjectHash: "other" }, "final", async (hash) => objects.get(hash)!)).rejects.toThrow(
    "another candidate",
  )
})

test("recovery job selection retains a completed verifier after current state cleared it", () => {
  const versions = [
    { version: 25, data: { verifierJobID: "earlier" } },
    { version: 29, data: { verifierJobID: "old" } },
    { version: 32, data: { verifierJobID: "recovered" } },
    { version: 34, data: { verifierJobID: "recovered" } },
    { version: 35, data: { stage: "execution" } },
  ] as { version: number; data: ResearchModel.Run }[]
  expect(recoveryJobs(versions, 29, "experiment", "old")).toEqual(["recovered"])
})
