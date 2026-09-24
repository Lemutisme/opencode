import { expect, test } from "bun:test"
import { mkdtemp, unlink } from "node:fs/promises"
import { infrastructure } from "./infrastructure"
import { check, freezeDeployment, launch, identities } from "./launch"
import { lifecycleDevelopment } from "./lifecycle-scenarios"
import { lifecycleRevealGate } from "./lifecycle-blind"
import { sealTerminal, checkedTerminal } from "./terminal"
import { prepareScoring, sealCandidate, revealFeedback, finalizeScoring } from "./evaluate"
import { codeIdentity } from "./provenance"
import { digest } from "./ledger"
import { put } from "./archive"
import { issue } from "./driver"
import { publish } from "./corpus"
import { hostEvidence } from "./host-evidence"
import { journal } from "./host-journal"
import type { Infrastructure } from "./infrastructure"
import type { runInstance } from "./instance"

const policy = { version: 1 as const, startup: 30000, operation: 30000, cleanup: 30000 }

test("infrastructure freeze binds explicit deadlines and measurement; old policy cannot inherit terminal seals", async () => {
  expect(infrastructure(undefined, "repair-lifecycle-v1")).toBeUndefined()
  expect(() => infrastructure(policy, "feedback-v2")).toThrow()
  for (const changed of [
    { ...policy, operation: 0 },
    { ...policy, cleanup: 21_600_001 },
    { ...policy, requests: 3 },
  ])
    expect(() => infrastructure(changed, "repair-lifecycle-v1")).toThrow()
  const root = await mkdtemp("/tmp/research-infrastructure-freeze-")
  const model = {
    endpoint: "http://127.0.0.1:8317/v1/responses",
    model: "unused-offline-fixture",
    variant: "low",
    parameters: { reasoning_effort: "low" },
    seed: "unsupported",
    context: 100000,
    output: 4000,
    credentialEnv: null,
  }
  const deployment = await freezeDeployment(
    {
      version: 1,
      evaluation: "repair-lifecycle-v1",
      infrastructure: policy,
      feedbackGuidance: "closure:1",
      mode: "development-calibration",
      worker: model,
      reviewer: model,
      bun: process.execPath,
      node: "/usr/bin/node",
      timeouts: { provider: 900000, tool: 600000, verification: 10000, cleanup: 30000 },
    },
    root + "/freeze",
  )
  const checked = await check(deployment)
  expect(checked.frozen.infrastructure).toEqual(policy)
  expect(checked.frozen.feedbackGuidance).toBe("closure:1")
  await expect(check({ ...deployment, feedbackGuidance: undefined })).rejects.toThrow("guidance differs")
  const measurement = await Bun.file(deployment.objects + "/" + checked.frozen.scenarios).json()
  expect(measurement).toMatchObject({
    infrastructure: policy,
    finalQuality: "candidate-or-terminal:1",
    feedbackGuidance: "closure:1",
  })
  await expect(check({ ...deployment, infrastructure: undefined })).rejects.toThrow("policy differs")
  await expect(check({ ...deployment, infrastructure: { ...policy, cleanup: 30001 } })).rejects.toThrow(
    "policy differs",
  )
  const cancellation = new AbortController()
  cancellation.abort()
  const cohort = root + "/cohort"
  const launched = await launch(deployment, cohort, cancellation.signal)
  expect(launched.rows).toHaveLength(3)
  for (const row of launched.rows) {
    expect(row.status).toBe("not_started")
    expect(await sealTerminal(cohort + "/" + row.id)).toMatchObject({
      reason: "cancelled_before_start",
      coordinates: "not_created",
      candidateQuality: "not_scored",
    })
  }
  const result = {
    mode: "model",
    codeHash: checked.frozen.runner,
    infrastructure: policy,
    feedbackGuidance: "closure:1",
  } as Awaited<ReturnType<typeof runInstance>>
  await lifecycleRevealGate(cohort + "/" + launched.rows[0].id, result)
  await expect(
    lifecycleRevealGate(cohort + "/" + launched.rows[0].id, { ...result, infrastructure: undefined }),
  ).rejects.toThrow("policy changed")
}, 120000)

async function fixture(
  first?: (directory: string, codeHash: string) => Promise<unknown>,
  selected: Infrastructure = policy,
) {
  const root = await mkdtemp("/tmp/research-terminal-unit-")
  const codeHash = await codeIdentity()
  const ids = lifecycleDevelopment().map((row) => row.packet.id)
  const cohort = JSON.stringify({
    mode: "development-calibration",
    configuration: {
      evaluation: "repair-lifecycle-v1",
      runner: codeHash,
      infrastructure: selected,
      order: ids,
    },
    instances: ids.map((id) => ({ id })),
  })
  await Bun.write(root + "/cohort.json", cohort)
  const chain = { previous: digest(cohort) }
  const rows = []
  for (const [index, id] of ids.entries()) {
    const value =
      index === 0 && first
        ? await first(root + "/" + id, codeHash)
        : {
            instance: id,
            codeHash,
            evaluation: "repair-lifecycle-v1",
            infrastructure: selected,
            attempted: false,
            reason: "prior_infrastructure_failure",
          }
    const row = {
      previous: chain.previous,
      at: Date.now(),
      id,
      status: index === 0 && first ? "pending_scoring" : "not_started",
      evidence: await put(root, value),
    }
    chain.previous = digest(JSON.stringify(row))
    rows.push({ ...row, hash: chain.previous })
  }
  await Bun.write(root + "/events.jsonl", rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
  return { root, codeHash, ids, rows, directory: root + "/" + ids[0] }
}

test("terminal refuses hidden archived candidates, late responses, identity and original-deadline changes", async () => {
  const value = await fixture()
  const archive = value.directory + "/archive"
  const candidate = {
    id: "pct_eval_" + value.ids[0],
    stage: "ready",
    subjectHash: "a".repeat(64),
    bundleHash: "b".repeat(64),
  }
  // Candidate-shaped model output is untrusted raw evidence, not a host observation.
  await put(archive, candidate)
  const request = { id: "request-one", action: "research-history", contractID: candidate.id }
  const journal = (run: typeof candidate) =>
    [
      { event: "command_start", ...request },
      { event: "wait_expired", ...request, execution: "unknown" },
      { event: "late_response", ...request, result: [{ data: run }] },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n"
  await Bun.write(value.directory + "/host/operations.jsonl", journal(candidate))
  await expect(sealTerminal(value.directory)).rejects.toThrow("candidate")
  await Bun.write(value.directory + "/host/operations.jsonl", journal({ ...candidate, id: "pct_eval_other" }))
  await expect(sealTerminal(value.directory)).rejects.toThrow("another instance")
  await unlink(value.directory + "/host/operations.jsonl")
  await sealTerminal(value.directory)
  const embedded = await fixture(async (_directory, codeHash) => ({
    instance: value.ids[0],
    codeHash,
    evaluation: "repair-lifecycle-v1",
    infrastructure: policy,
    cleanup: { result: { monitored: { run: candidate } } },
  }))
  await expect(sealTerminal(embedded.directory)).rejects.toThrow("candidate")
  await expect(checkedTerminal(value.directory, "f".repeat(64))).rejects.toThrow()
  await Bun.write(
    value.root + "/" + value.ids[1] + "/terminal-ref.json",
    await Bun.file(value.directory + "/terminal-ref.json").text(),
  )
  await expect(checkedTerminal(value.root + "/" + value.ids[1], value.codeHash)).rejects.toThrow()
  await Bun.write(
    value.directory + "/attempt.json",
    JSON.stringify({
      contractID: candidate.id,
      codeHash: value.codeHash,
      infrastructure: policy,
      issuedAt: 1,
      deadline: 2,
    }),
  )
  await expect(checkedTerminal(value.directory, value.codeHash)).rejects.toThrow("deadline")
  await unlink(value.directory + "/attempt.json")
  const original = await Bun.file(value.root + "/cohort.json").text()
  const changed = JSON.parse(original)
  changed.configuration.infrastructure.operation++
  await Bun.write(value.root + "/cohort.json", JSON.stringify(changed))
  await expect(checkedTerminal(value.directory, value.codeHash)).rejects.toThrow()
  await Bun.write(value.root + "/cohort.json", original)
  await Bun.write(
    value.root + "/events.jsonl",
    JSON.stringify({ ...value.rows[0], evidence: value.rows[1].evidence }) + "\n",
  )
  await expect(checkedTerminal(value.directory, value.codeHash)).rejects.toThrow()
}, 30000)

test("unconfirmed cleanup never queries a database or certifies durable absence", async () => {
  const root = await mkdtemp("/tmp/research-unknown-copy-")
  await Bun.write(root + "/host/cleanup.json", JSON.stringify({ complete: false, status: "unconfirmed" }))
  await Bun.write(root + "/host/opencode.db", "This is deliberately not SQLite")
  const audit = await hostEvidence({
    directory: root + "/archive",
    storage: root + "/host",
    contractID: "pct_eval_unknown",
  })
  expect(audit.state).toBe("unknown")
  expect(audit).not.toHaveProperty("runs")
  expect(audit).not.toHaveProperty("copy")
  expect(await Bun.file(root + "/host/opencode.db").text()).toBe("This is deliberately not SQLite")
})

test("not_submitted scoring fixture uses explicit absence, with no invented first-phase judgments", async () => {
  const example = lifecycleDevelopment()[0]
  const value = await fixture(async (directory, codeHash) => {
    const issuedAt = Date.now()
    const agreement = issue(publish(example.packet), {
      directory,
      contractID: "pct_eval_" + example.packet.id,
      issuedAt,
      worker: { providerID: "fixture", id: "worker" },
      reviewer: { providerID: "fixture", id: "reviewer" },
      executable: "/usr/bin/node",
      executableHash: digest("fixture"),
      timeout: 1000,
      evaluation: "repair-lifecycle-v1",
    } as Parameters<typeof issue>[1])
    // Hand-authored scoring fixture; not a claimed autonomous research execution.
    const run = {
      id: agreement.id,
      version: 1,
      stage: "cancelled",
      input: agreement,
      reason: "Stopped before candidate",
    }
    const result = {
      mode: "local-fixture",
      infrastructure: policy,
      codeHash,
      evaluation: "repair-lifecycle-v1",
      issuedAt,
      deadline: issuedAt + 21_600_000,
      observations: [],
      usage: [],
      monitored: {
        run,
        raw: "",
        history: [],
        observed: { exposed: false },
        evidence: { runs: [run], snapshots: [], objects: [] },
      },
    } as unknown as Awaited<ReturnType<typeof runInstance>>
    const scoring = await prepareScoring({
      directory,
      result,
      packet: example.packet,
      oracle: example.oracle,
      launcher: "unused",
      timeout: 1000,
    })
    expect(scoring.candidateAvailable).toBe(false)
    const rating = { candidateHash: scoring.candidateHash, rubricHash: scoring.rubricHash, rater: "one", items: {} }
    await expect(sealCandidate({ directory, first: rating, second: { ...rating, rater: "two" } })).rejects.toThrow(
      "terminal",
    )
    return result
  })
  for (const id of value.ids) await sealTerminal(value.root + "/" + id)
  const material = await revealFeedback(value.directory)
  expect<unknown>(material.material.measurement).toEqual(
    identities({}, lifecycleDevelopment(), { infrastructure: policy }, {}).scenarios,
  )
  const rating = {
    candidateHash: material.candidateHash,
    rubricHash: material.rubricHash,
    rater: "one",
    items: Object.fromEntries(Object.keys(material.rubric).map((key) => [key, null])),
  }
  const scored = await finalizeScoring({
    directory: value.directory,
    first: rating,
    second: { ...rating, rater: "two" },
  })
  expect(scored.verdict).toBe("indeterminate")
  expect(scored.phaseOne).toHaveProperty("absence")
  expect(scored.phaseOne).not.toHaveProperty("first")
  expect(scored.phaseOne).not.toHaveProperty("second")
  if (!("dimensions" in scored)) throw new Error("Expected lifecycle score")
  expect(scored.dimensions.feedback.status).toBe("not_observed")
  await checkedTerminal(value.directory, value.codeHash)
}, 30000)

test("CAS late candidates and corrupt references cannot become terminal absence", async () => {
  const value = await fixture(undefined, { ...policy, journal: "cas:1" })
  const file = value.directory + "/host/operations.jsonl"
  const writer = journal(file)
  const request = { connectionID: "one", id: "q", action: "research-history", contractID: "pct_eval_" + value.ids[0] }
  writer.append({ event: "command_start", ...request, payload: {} })
  writer.append({
    event: "late_response",
    ...request,
    result: [{ data: { id: request.contractID, stage: "ready", subjectHash: "candidate" } }],
  })
  await expect(sealTerminal(value.directory)).rejects.toThrow("candidate")
  const rows = (await Bun.file(file).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  await unlink(value.directory + "/host/operations.objects/" + rows[1].resultRef.chunks[0])
  await expect(sealTerminal(value.directory)).rejects.toThrow()
  expect(await Bun.file(value.directory + "/terminal-ref.json").exists()).toBe(false)
}, 20000)
