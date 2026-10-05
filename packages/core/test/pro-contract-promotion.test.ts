import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProContractPromotion } from "../src/pro-contract/promotion"
import { Hash } from "../src/util/hash"

const protocol = {
  version: 1,
  performanceRule: "task-pareto",
  evaluatorHash: "a".repeat(64),
  tests: [
    { id: "safety", total: 2 },
    { id: "dev-1", total: 10, performance: { panel: "development", task: "task", replicate: "1" } },
    { id: "dev-2", total: 10, performance: { panel: "development", task: "task", replicate: "2" } },
    { id: "confirm-1", total: 10, performance: { panel: "confirmation", task: "task", replicate: "1" } },
    { id: "confirm-2", total: 10, performance: { panel: "confirmation", task: "task", replicate: "2" } },
  ],
} satisfies ProContractPromotion.Protocol

function evidence(
  candidate: readonly number[],
  baseline: readonly number[] = [2, 5, 5, 5, 5],
  manifest: ProContractPromotion.Protocol = protocol,
): ProContractPromotion.Evidence {
  return {
    protocolHash: ProContractPromotion.hashProtocol(manifest),
    candidateHash: "b".repeat(64),
    baselineHash: "c".repeat(64),
    receiptHash: "d".repeat(64),
    rows: manifest.tests.map((test, index) => ({
      id: test.id,
      passed: candidate[index],
      total: test.total,
      valid: true,
    })),
    baseline: manifest.tests.map((test, index) => ({
      id: test.id,
      passed: baseline[index],
      total: test.total,
      valid: true,
    })),
  }
}

describe("ProContract task-pareto promotion", () => {
  test("promotes any strict task mean improvement with no regression", () => {
    expect(ProContractPromotion.qualify(protocol, evidence([2, 6, 5, 5, 5]))).toEqual({
      eligible: true,
      safety: true,
      improved: ["development:task"],
      regressed: [],
      full: [],
      baselineFull: [],
      lostFull: [],
    })
  })

  test("does not promote ties, including a fully passing tie", () => {
    expect(ProContractPromotion.qualify(protocol, evidence([2, 5, 5, 5, 5])).eligible).toBe(false)
    expect(ProContractPromotion.qualify(protocol, evidence([2, 10, 10, 10, 10], [2, 10, 10, 10, 10]))).toMatchObject({
      eligible: false,
      improved: [],
      full: ["development:task", "confirmation:task"],
    })
  })

  test("does not average away a task regression across panels", () => {
    expect(ProContractPromotion.qualify(protocol, evidence([2, 10, 10, 4, 5]))).toMatchObject({
      eligible: false,
      improved: ["development:task"],
      regressed: ["confirmation:task"],
    })
  })

  test("does not average away a task regression within a panel", () => {
    const manifest = {
      ...protocol,
      tests: [
        ...protocol.tests,
        { id: "other-1", total: 10, performance: { panel: "development" as const, task: "other", replicate: "1" } },
        { id: "other-2", total: 10, performance: { panel: "development" as const, task: "other", replicate: "2" } },
      ],
    }
    expect(
      ProContractPromotion.qualify(manifest, evidence([2, 10, 10, 5, 5, 4, 5], [2, 5, 5, 5, 5, 5, 5], manifest)),
    ).toMatchObject({
      eligible: false,
      improved: ["development:task"],
      regressed: ["development:other"],
    })
  })

  test("compares the fixed repetition mean, not each repetition individually", () => {
    expect(ProContractPromotion.qualify(protocol, evidence([2, 7, 4, 5, 5]))).toMatchObject({
      eligible: true,
      improved: ["development:task"],
      regressed: [],
    })
  })

  test("gives normalized repetitions equal weight instead of pooling their denominators", () => {
    const manifest = {
      ...protocol,
      tests: protocol.tests.map((test, index) => ({ ...test, total: [2, 2, 100, 10, 10][index] })),
    }
    expect(
      ProContractPromotion.qualify(manifest, evidence([2, 2, 40, 5, 5], [2, 1, 50, 5, 5], manifest)),
    ).toMatchObject({
      eligible: true,
      improved: ["development:task"],
    })
    expect(ProContractPromotion.qualify(manifest, evidence([2, 2, 0, 5, 5], [2, 1, 50, 5, 5], manifest))).toMatchObject(
      {
        eligible: false,
        improved: [],
        regressed: [],
      },
    )
  })

  test("distinguishes gains and regressions smaller than floating-point precision", () => {
    const max = Number.MAX_SAFE_INTEGER
    const manifest = {
      ...protocol,
      tests: protocol.tests.map((test, index) => ({ ...test, total: [2, max, max - 2, 10, 10][index] })),
    }
    expect((1 / max + (max - 3) / (max - 2)) / 2).toBe((2 / max + (max - 4) / (max - 2)) / 2)
    expect(
      ProContractPromotion.qualify(manifest, evidence([2, 1, max - 3, 5, 5], [2, 2, max - 4, 5, 5], manifest)),
    ).toMatchObject({
      eligible: true,
      improved: ["development:task"],
    })
    expect(
      ProContractPromotion.qualify(manifest, evidence([2, 2, max - 4, 6, 5], [2, 1, max - 3, 5, 5], manifest)),
    ).toMatchObject({
      eligible: false,
      improved: ["confirmation:task"],
      regressed: ["development:task"],
    })
  })

  test.each(["candidate", "baseline"])("requires complete safety passes in the %s", (side) => {
    const report = evidence(
      side === "candidate" ? [1, 6, 5, 5, 5] : [2, 6, 5, 5, 5],
      side === "baseline" ? [1, 5, 5, 5, 5] : undefined,
    )
    expect(ProContractPromotion.qualify(protocol, report)).toMatchObject({ eligible: false, safety: false })
  })

  test("protects every baseline full pass", () => {
    expect(ProContractPromotion.qualify(protocol, evidence([2, 9, 10, 6, 5], [2, 10, 10, 5, 5]))).toMatchObject({
      eligible: false,
      baselineFull: ["development:task"],
      lostFull: ["development:task"],
    })
    expect(ProContractPromotion.qualify(protocol, evidence([2, 10, 10, 6, 5], [2, 10, 10, 5, 5])).eligible).toBe(true)
  })

  test("protects historical full passes even when the baseline no longer passes fully", () => {
    expect(ProContractPromotion.qualify(protocol, evidence([2, 6, 5, 5, 5]), ["development:task"])).toMatchObject({
      eligible: false,
      regressed: [],
      baselineFull: [],
      lostFull: ["development:task"],
    })
    expect(ProContractPromotion.qualify(protocol, evidence([2, 10, 10, 5, 5]), ["development:task"]).eligible).toBe(
      true,
    )
    expect(() => ProContractPromotion.qualify(protocol, evidence([2, 6, 5, 5, 5]), ["development:absent"])).toThrow(
      "retained full pass",
    )
  })

  test("requires the issuer-frozen full-pass tasks", () => {
    const manifest = { ...protocol, requiredFull: ["confirmation:task"] }
    expect(ProContractPromotion.qualify(manifest, evidence([2, 6, 5, 5, 5], undefined, manifest)).eligible).toBe(false)
    expect(ProContractPromotion.qualify(manifest, evidence([2, 5, 5, 10, 10], undefined, manifest)).eligible).toBe(true)
  })

  test("matches rows by identity and returns serializable results without mutating inputs", () => {
    const report = evidence([2, 6, 5, 5, 5])
    const shuffled = { ...report, rows: [...report.rows].reverse(), baseline: [...report.baseline].reverse() }
    const before = JSON.stringify({ protocol, shuffled })
    const result = ProContractPromotion.qualify(protocol, shuffled)
    expect(JSON.parse(JSON.stringify(result))).toEqual(ProContractPromotion.qualify(protocol, report))
    expect(JSON.stringify({ protocol, shuffled })).toBe(before)
  })
})

describe("promotion protocol validation and identity", () => {
  test("hashes schema-canonical objects, independent of property insertion order", () => {
    const reordered = {
      tests: protocol.tests.map((test) => ({
        ...(test.performance
          ? {
              performance: {
                replicate: test.performance.replicate,
                task: test.performance.task,
                panel: test.performance.panel,
              },
            }
          : {}),
        total: test.total,
        id: test.id,
      })),
      evaluatorHash: protocol.evaluatorHash,
      performanceRule: protocol.performanceRule,
      version: protocol.version,
    }
    expect(ProContractPromotion.hashProtocol(reordered)).toBe(ProContractPromotion.hashProtocol(protocol))
    expect(ProContractPromotion.hashProtocol(protocol)).toBe(
      Hash.sha256(JSON.stringify(Schema.decodeUnknownSync(ProContractPromotion.Protocol)(protocol))),
    )
    expect(ProContractPromotion.hashProtocol({ ...protocol, evaluatorHash: "e".repeat(64) })).not.toBe(
      ProContractPromotion.hashProtocol(protocol),
    )
  })

  test.each([
    ["wrong version", { ...protocol, version: 2 }],
    ["old promotion rule", { ...protocol, performanceRule: "panel-margin" }],
    ["implicit mean margin", { ...protocol, minimumMeanGainBps: 1 }],
    ["invalid evaluator identity", { ...protocol, evaluatorHash: "not-a-hash" }],
    ["missing evaluator identity", { ...protocol, evaluatorHash: undefined }],
    ["empty manifest", { ...protocol, tests: [] }],
    ["duplicate test identity", { ...protocol, tests: [...protocol.tests, protocol.tests[0]] }],
    ["no safety tests", { ...protocol, tests: protocol.tests.slice(1) }],
    [
      "no development",
      { ...protocol, tests: protocol.tests.filter((test) => test.performance?.panel !== "development") },
    ],
    [
      "no confirmation",
      { ...protocol, tests: protocol.tests.filter((test) => test.performance?.panel !== "confirmation") },
    ],
    ["one repetition", { ...protocol, tests: protocol.tests.filter((test) => test.id !== "dev-2") }],
    [
      "duplicate repetition",
      {
        ...protocol,
        tests: protocol.tests.map((test) =>
          test.id === "dev-2" ? { ...test, performance: protocol.tests[1].performance } : test,
        ),
      },
    ],
    ["unassigned full pass", { ...protocol, requiredFull: ["development:absent"] }],
  ])("rejects %s", (_, input) => {
    expect(() => ProContractPromotion.requireProtocol(input)).toThrow()
    expect(() => ProContractPromotion.hashProtocol(input)).toThrow()
  })

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])("rejects invalid denominator %s", (total) => {
    expect(() =>
      ProContractPromotion.requireProtocol({
        ...protocol,
        tests: [{ ...protocol.tests[0], total }, ...protocol.tests.slice(1)],
      }),
    ).toThrow()
  })

  test.each([
    { panel: "unknown", task: "task", replicate: "1" },
    { panel: "development", task: "", replicate: "1" },
    { panel: "development", task: "task", replicate: "" },
  ])("rejects invalid performance assignments %j", (performance) => {
    expect(() =>
      ProContractPromotion.requireProtocol({
        ...protocol,
        tests: protocol.tests.map((test) => (test.id === "dev-1" ? { ...test, performance } : test)),
      }),
    ).toThrow()
  })
})

describe("promotion evidence admission", () => {
  test.each(["protocolHash", "candidateHash", "baselineHash", "receiptHash"])(
    "requires a content identity for %s",
    (field) => {
      expect(() =>
        ProContractPromotion.qualify(protocol, { ...evidence([2, 6, 5, 5, 5]), [field]: "invalid" }),
      ).toThrow()
    },
  )

  test("rejects a stale protocol binding and unrecognized evidence fields", () => {
    expect(() =>
      ProContractPromotion.qualify(protocol, { ...evidence([2, 6, 5, 5, 5]), protocolHash: "f".repeat(64) }),
    ).toThrow("protocol")
    expect(() => ProContractPromotion.qualify(protocol, { ...evidence([2, 6, 5, 5, 5]), promotion: true })).toThrow()
  })

  describe.each(["rows", "baseline"] as const)("validates %s", (field) => {
    test.each([
      ["negative passed", { passed: -1 }],
      ["fractional passed", { passed: 0.5 }],
      ["unsafe passed", { passed: Number.MAX_SAFE_INTEGER + 1 }],
      ["passed exceeds denominator", { passed: 3 }],
      ["changed denominator", { total: 3 }],
      ["unknown identity", { id: "foreign" }],
      ["incomplete evidence", { valid: false }],
      ["nonboolean validity", { valid: 1 }],
    ])("rejects %s", (_, change) => {
      const report = evidence([2, 6, 5, 5, 5])
      expect(() =>
        ProContractPromotion.qualify(protocol, {
          ...report,
          [field]: [{ ...report[field][0], ...change }, ...report[field].slice(1)],
        }),
      ).toThrow()
    })

    test("rejects missing, extra, and duplicate rows", () => {
      const report = evidence([2, 6, 5, 5, 5])
      expect(() => ProContractPromotion.qualify(protocol, { ...report, [field]: report[field].slice(1) })).toThrow(
        "Missing or duplicate",
      )
      expect(() =>
        ProContractPromotion.qualify(protocol, {
          ...report,
          [field]: [...report[field], { ...report[field][0], id: "extra" }],
        }),
      ).toThrow("Missing or duplicate")
      expect(() =>
        ProContractPromotion.qualify(protocol, {
          ...report,
          [field]: [report[field][0], ...report[field].slice(0, -1)],
        }),
      ).toThrow("Missing or duplicate")
    })
  })
})
