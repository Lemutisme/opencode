import { expect, test } from "bun:test"
import { lifecycleDevelopment, lifecycleMeasurement, lifecycleScenarioVersion } from "./lifecycle-scenarios"
import { development } from "./scenarios"
import { publish } from "./corpus"
import { issue } from "./driver"
import { runInstance } from "./instance"
import { identities } from "./launch"
import { digest } from "./ledger"

test("lifecycle versions preserve fourth-round plans, truth and diagnostic checks while changing the visible protocol", () => {
  const old = development()
  const before = JSON.stringify(old)
  const examples = lifecycleDevelopment()
  expect(examples).toHaveLength(3)
  examples.forEach((item, index) => {
    expect(item.packet.version).toBe(lifecycleScenarioVersion)
    expect(item.packet.id).not.toBe(old[index].packet.id)
    expect(item.packet.plan).toEqual(old[index].packet.plan)
    expect(item.packet.files).toEqual(old[index].packet.files)
    expect(item.oracle.expected).toEqual(old[index].oracle.expected)
    expect(item.oracle.rubric).toEqual(old[index].oracle.rubric)
    expect(item.oracle.instance.defective).toBe(old[index].oracle.instance.defective)
    expect(item.packet.preparation).toEqual({})
    expect(item.packet.brief).toContain("repair-lifecycle:1")
  })
  expect(JSON.stringify(development())).toBe(before)
  const input = {
    directory: "/tmp/unused",
    contractID: "pct_eval_lifecycle",
    issuedAt: 100,
    worker: { providerID: "fixture", id: "worker" },
    reviewer: { providerID: "fixture", id: "reviewer" },
    executable: "/usr/bin/node",
    executableHash: digest("node"),
    timeout: 1000,
  } as Parameters<typeof issue>[1]
  expect(issue(publish(old[0].packet), { ...input, evaluation: "feedback-v2" }).manifest.feedbackProtocol).toBe(
    "response:1",
  )
  const issued = issue(publish(examples[0].packet), { ...input, evaluation: "repair-lifecycle-v1" })
  expect(issued.manifest.feedbackProtocol).toBe("repair-lifecycle:1")
  expect(issued.manifest.reviewPolicy).toEqual({ version: 2, plan: "advisory", delivery: "advisory" })
  expect(issued.spec.budget).toEqual({ deadline: 21_600_100 })
  expect(issued.spec.resolution).not.toHaveProperty("maxAttempts")
  const manifest = Object.fromEntries(
    ["lifecycle-evaluate.ts", "lifecycle-blind.ts", "lifecycle-scenarios.ts"].map((file) => [
      "packages/opencode/script/research-eval/" + file,
      { hash: digest(file), mode: 33188 },
    ]),
  )
  const frozen = identities(manifest, examples, {}, {})
  expect(frozen.scenarios).toEqual(lifecycleMeasurement)
  expect(Object.keys(frozen.scorer)).toHaveLength(3)
})

test("direct execution rejects cross-version scenario and protocol combinations before admission", async () => {
  for (const [packet, evaluation] of [
    [development()[0].packet, "repair-lifecycle-v1"],
    [lifecycleDevelopment()[0].packet, "feedback-v2"],
    [lifecycleDevelopment()[0].packet, undefined],
  ] as const)
    await expect(
      runInstance({ packet, evaluation, entry: "followup" } as Parameters<typeof runInstance>[0]),
    ).rejects.toThrow()
})
