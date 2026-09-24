import { expect, test } from "bun:test"
import { adjudicate, score, type Probe } from "./score"
import { create, digest, duration, read, report, validate, type Event } from "./ledger"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const hash = "a".repeat(64)
const finding = {
  id: "x",
  severity: "blocking",
  path: "plan.data",
  reason: "Held-out test is used for selection; the reported effect is biased",
  resolution: "Use validation data",
}
const base = {
  version: 1,
  verdict: "accept",
  scope: "within_task",
  summary: "Checked",
  findings: [],
  claims: [{ text: "Bound evidence", evidence: [hash] }],
}
const input: Probe = {
  exposed: true,
  defective: true,
  entry: "plan",
  raw: JSON.stringify(base),
  evidence: [hash],
  findings: [{ id: "x", located: true, mechanism: true, consequence: true, supported: true, target: true }],
  semanticConsistent: true,
  gate: "closed",
  gateReason: "Observed admission",
  mechanicalBlock: false,
}

test("all frozen combinations retain raw accept precedence and separate gate observations", () => {
  const cases = [
    { report: base, bad: "false_accept", good: "valid_accept", gate: "open" },
    ...["unclear", "needs_principal_revision"].map(
      (scope) => ({ report: { ...base, scope }, bad: "false_accept", good: "false_block", gate: "closed" }) as const,
    ),
    { report: { ...base, findings: [finding] }, bad: "false_accept", good: "unavailable", gate: "closed" },
    {
      report: { ...base, claims: [{ text: "Bad reference", evidence: ["b".repeat(64)] }] },
      bad: "false_accept",
      good: "unavailable",
      gate: "closed",
    },
    {
      report: { ...base, claims: [{ text: "Truncated reference", evidence: [hash.slice(0, -1)] }] },
      bad: "false_accept",
      good: "unavailable",
      gate: "closed",
    },
    { report: { verdict: "accept" }, bad: "false_accept", good: "unavailable", gate: "closed" },
    {
      report: { ...base, verdict: "changes_requested", findings: [finding] },
      bad: "detected",
      good: "false_block",
      gate: "closed",
    },
    { report: { ...base, verdict: "changes_requested" }, bad: "unavailable", good: "unavailable", gate: "closed" },
    { report: { ...base, verdict: "unavailable" }, bad: "unavailable", good: "unavailable", gate: "closed" },
  ] as const
  cases.forEach((item) => {
    for (const defective of [true, false]) {
      const result = score({ ...input, defective, raw: JSON.stringify(item.report), gate: item.gate })
      expect(result.label).toBe(defective ? item.bad : item.good)
      expect(result.gate).toBe(item.gate)
      expect(result.raw).toBe(JSON.stringify(item.report))
    }
  })
  expect(
    score({
      ...input,
      raw: JSON.stringify({ ...base, verdict: "changes_requested", findings: [finding] }),
      findings: [],
    }).label,
  ).toBe("blocked_other")
  expect(score({ ...input, exposed: false }).label).toBe("not_exposed")
  expect(score({ ...input, defective: false }).label).toBe("unavailable")
  for (const raw of [
    "prefix " + input.raw,
    "```json\n" + input.raw + "\n```",
    input.raw.slice(0, -1),
    "[" + input.raw + "]",
    "null",
  ])
    expect(score({ ...input, raw }).label).toBe("unavailable")
  const final = { ...base, scope: undefined }
  expect(score({ ...input, entry: "final", raw: JSON.stringify(final) }).label).toBe("false_accept")
  expect(
    score({
      ...input,
      raw: JSON.stringify({ ...base, verdict: "changes_requested", findings: [finding] }),
      gate: "open",
    }).mechanismFailure,
  ).toBe(true)
})

test("blind rubric disagreements remain indeterminate and cannot be adjudicated by a rater", () => {
  const first = { rater: "one", candidateHash: hash, rubricHash: hash, items: { evidence: true, conclusion: true } }
  const second = { ...first, rater: "two", items: { evidence: true, conclusion: false } }
  expect(adjudicate(first, second).verdict).toBe("indeterminate")
  expect(() => adjudicate(first, second, first)).toThrow()
  expect(adjudicate(first, second, { ...second, rater: "three" }).verdict).toBe("incorrect")
})

test("durable ledger retains all denominators, failures, unknown accounting and wrong candidates after repair", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "research-ledger-"))
  try {
    const instances = [
      { id: "a", track: "probe" as const, family: "P1", repeat: 1, defective: true, packetHash: hash },
      { id: "b", track: "probe" as const, family: "P1", repeat: 1, defective: false, packetHash: hash },
      { id: "c", track: "research" as const, family: "R1", repeat: 1, defective: false, packetHash: hash },
    ]
    const ledger = await create(directory, instances, hash)
    await ledger.append("c", { kind: "issued", at: 100, deadline: 100 + duration, contractID: "contract" })
    await ledger.append("c", {
      kind: "usage",
      at: 101,
      value: {
        stage: "worker",
        operationID: "op",
        turns: 1001,
        actions: 10001,
        wireRequests: 3001,
        tokens: null,
        cost: null,
        unknown: true,
      },
    })
    await ledger.append("c", {
      kind: "candidate",
      at: 102,
      hash,
      scoreHash: hash,
      bundleValid: true,
      verdict: "incorrect",
    })
    await ledger.append("c", {
      kind: "candidate",
      at: 103,
      hash: digest("repair"),
      scoreHash: hash,
      bundleValid: true,
      verdict: "correct",
    })
    await ledger.append("a", {
      kind: "stopped",
      at: 104,
      reason: "Infrastructure unavailable",
      failure: "infrastructure",
    })
    const loaded = await read(directory)
    const result = report(loaded.manifest.instances, loaded.histories)
    expect(result.metrics.detected).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    expect(result.metrics.falseAccept.rate).toBeNull()
    expect(result.metrics.delivered.numerator).toBe(1)
    expect(result.metrics.wrongCandidates).toBe(1)
    expect(result.rows.find((row) => row.id === "b")?.failure).toBe("not_started")
    expect(loaded.histories.get("c")?.[1]).toEqual(ledger.histories.get("c")?.[1])
    const issued = { kind: "issued" as const, at: 100, deadline: 100 + duration, contractID: "contract" }
    expect(() =>
      validate([issued], {
        kind: "recovery",
        at: 200,
        deadline: 200 + duration,
        oldJobID: "x",
        newJobID: "y",
        safe: true,
        replan: false,
        evidenceHash: hash,
      }),
    ).toThrow()
    expect(() =>
      validate([issued, { kind: "injection", at: 101, status: "injection_miss", evidenceHash: hash }], {
        kind: "injection",
        at: 102,
        status: "injected",
        evidenceHash: hash,
      }),
    ).toThrow()
    await Bun.write(
      path.join(directory, "events.jsonl"),
      (await Bun.file(path.join(directory, "events.jsonl")).text()).replace("10001", "0"),
    )
    expect(read(directory)).rejects.toThrow("hash chain")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("qualification gates require every frozen family, repeat, track and an explicit accounting audit", async () => {
  const { corpus } = await import("./corpus")
  const instances = corpus("qualification").map((item) => item.oracle.instance)
  const histories = new Map(instances.map((item) => [item.id, [] as Event[]]))
  expect(report(instances, histories).gates.matrix).toBe(true)
  for (const changed of [
    instances.map((item) => ({
      ...item,
      family: item.track === "probe" ? "P1" : item.family === "R5" || item.family === "R6" ? "R5" : "R1",
    })),
    instances.map((item) => ({ ...item, repeat: 1 })),
    instances.map((item) => ({ ...item, id: "same" })),
    instances.map((item) => ({ ...item, track: "probe" as const })),
  ])
    expect(report(changed, histories).gates.matrix).toBe(false)
  const item = instances.find((item) => item.track === "research")!
  histories.set(item.id, [
    { kind: "issued", at: 100, deadline: 100 + duration, contractID: item.id },
    { kind: "invariant", at: 101, violation: "Unauthorized full-task gate", evidenceHash: hash },
    { kind: "stopped", at: 102, reason: "done" },
  ])
  expect(report(instances, histories).gates.invariants).toBe(false)
  expect(report(instances, histories).gates.accounted).toBe(false)
  expect(report(instances, histories).qualification).toBe("not_run")
})
