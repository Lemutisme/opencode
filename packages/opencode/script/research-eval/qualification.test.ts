import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { corpus } from "./corpus"
import { digest } from "./ledger"
import { qualification } from "./qualification"
import { codeIdentity } from "./provenance"
import { put } from "./archive"

test("real report keeps all 66 unstarted instances and rejects changed execution rows", async () => {
  const directory = "/tmp/opencode-s6c-report-" + crypto.randomUUID()
  await mkdir(directory)
  const instances = corpus("qualification").map((item) => item.oracle.instance)
  const cohort = JSON.stringify({ mode: "qualification", instances, configuration: { runner: await codeIdentity() } })
  await Bun.write(directory + "/cohort.json", cohort)
  await Bun.write(directory + "/events.jsonl", "")
  const report = await qualification(directory, directory + "/unstarted")
  if ("evaluation" in report) throw new Error("Expected legacy report")
  expect(report.rows).toHaveLength(66)
  expect(report.metrics.delivered.denominator).toBe(18)
  expect(report.metrics.detected.denominator).toBe(24)
  expect(report.qualification).toBe("not_run")
  const row = { previous: digest(cohort), at: Date.now(), id: instances[0].id, status: "not_started" }
  await Bun.write(
    directory + "/events.jsonl",
    JSON.stringify({ ...row, hash: digest(JSON.stringify(row)), status: "forged" }) + "\n",
  )
  await expect(qualification(directory, directory + "/changed")).rejects.toThrow("event chain")
})

test("issued infrastructure failures retain wire and unknown usage instead of becoming not_run", async () => {
  const directory = "/tmp/opencode-s6c-failure-report-" + crypto.randomUUID()
  const instance = corpus("qualification")[0].oracle.instance
  const codeHash = await codeIdentity()
  const cohort = JSON.stringify({ mode: "qualification", instances: [instance], configuration: { runner: codeHash } })
  await Bun.write(directory + "/cohort.json", cohort)
  const identity = { contractID: "contract", sessionID: "session", jobID: "worker", operationID: "operation" }
  const retained = await put(directory + "/" + instance.id + "/archive", {
    mode: "model",
    codeHash,
    attempted: true,
    admitted: true,
    issuedAt: 1000,
    deadline: 21601000,
    agreement: { id: "contract" },
    records: [
      {
        boundary: "provider",
        role: "worker",
        origin: "https://fixture.invalid",
        event: { kind: "wire", at: 1100, identity, requestID: "request" },
      },
    ],
    partial: [
      {
        status: "fulfilled",
        value: [
          {
            id: "operation",
            kind: "provider",
            source: { contractID: "contract", sessionID: "session" },
            startedAt: 1000,
            status: "unknown",
            usage: { state: "unknown" },
          },
        ],
      },
      { status: "fulfilled", value: [] },
    ],
  })
  const evidence = await put(directory, {
    retained: { hash: retained },
    failure: "Recorded fixture infrastructure fault",
  })
  const row = { previous: digest(cohort), at: 1200, id: instance.id, status: "infrastructure_failure", evidence }
  await Bun.write(directory + "/events.jsonl", JSON.stringify({ ...row, hash: digest(JSON.stringify(row)) }) + "\n")
  const measured = await qualification(directory, directory + "/report")
  if ("evaluation" in measured) throw new Error("Expected legacy report")
  expect(measured.qualification).toBe("failed")
  expect(measured.rows[0].failure).toBe("infrastructure")
  expect(measured.rows[0].events.find((item) => item.kind === "usage")).toMatchObject({
    value: { wireRequests: 1, unknown: true, tokens: null },
  })
})

test("research gate failures and unresolved annotations remain visible to qualification", async () => {
  const directory = "/tmp/opencode-s6c-pending-report-" + crypto.randomUUID()
  const instance = corpus("qualification").find((item) => item.oracle.instance.family === "R3")!.oracle.instance
  const codeHash = await codeIdentity()
  const cohort = JSON.stringify({ mode: "qualification", instances: [instance], configuration: { runner: codeHash } })
  await Bun.write(directory + "/cohort.json", cohort)
  const resultHash = await put(directory, {
    mode: "model",
    codeHash,
    issuedAt: 1000,
    deadline: 21601000,
    monitored: {
      run: { id: "contract", stage: "ready", subjectHash: "subject", bundleHash: "bundle", published: {} },
      observed: { exposed: true },
    },
    usage: [],
  })
  const score = {
    resultHash,
    phaseOne: { verdict: "indeterminate" },
    reviewer: { verdict: "indeterminate" },
    measured: { label: "unavailable", mechanismFailure: true },
    verdict: "indeterminate",
  }
  const scoreHash = await put(directory + "/" + instance.id + "/archive", score)
  await Bun.write(directory + "/" + instance.id + "/score.json", JSON.stringify(score, null, 2) + "\n")
  await Bun.write(directory + "/" + instance.id + "/score-ref.json", JSON.stringify({ hash: scoreHash }))
  const row = { previous: digest(cohort), at: 1200, id: instance.id, status: "pending_scoring", evidence: resultHash }
  await Bun.write(directory + "/events.jsonl", JSON.stringify({ ...row, hash: digest(JSON.stringify(row)) }) + "\n")
  const measured = await qualification(directory, directory + "/report")
  if ("evaluation" in measured) throw new Error("Expected legacy report")
  expect(measured.qualification).toBe("pending")
  expect(measured.gates.invariants).toBe(false)
  expect(measured.gates.accounted).toBe(false)
  expect(measured.unresolvedScoring).toBe(true)
})
