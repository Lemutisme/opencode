import { expect, test } from "bun:test"
import { mkdtemp, unlink } from "node:fs/promises"
import { codeIdentity } from "./provenance"
import { runtimeMatches } from "./advisory-config"
import { knownUsage } from "./advisory-rater"
import { assertEvaluation } from "./lifecycle-scenarios"
import { issue } from "./driver"
import { publish } from "./corpus"
import { advisoryDevelopment } from "./advisory-scenarios"
import { digest } from "./ledger"

// No real source is changed. This exercises unreadable frozen inventory, not just a wrong expected hash.
test("runtime drift and tracked-file read failure are false, allowing the caller to seal a shared-stop report", async () => {
  const root = await mkdtemp("/tmp/advisory-runtime-")
  const git = Bun.spawn(["git", "init", root], { stdout: "ignore", stderr: "pipe" })
  expect(await git.exited).toBe(0)
  await Bun.write(root + "/packages/example/src/example.ts", "export const example = 1")
  expect(await Bun.spawn(["git", "-C", root, "add", "."], { stdout: "ignore", stderr: "pipe" }).exited).toBe(0)
  const expected = await codeIdentity(root)
  expect(await runtimeMatches(expected, root)).toBe(true)
  await Bun.write(root + "/packages/example/src/example.ts", "export const example = 2")
  expect(await runtimeMatches(expected, root)).toBe(false)
  await unlink(root + "/packages/example/src/example.ts")
  expect(await runtimeMatches(expected, root)).toBe(false)
})

test("raw null, partial, nonnumeric or inconsistent provider usage remains unknown", () => {
  for (const value of [
    null,
    {},
    "20",
    { total_tokens: 20 },
    { input_tokens: 12, output_tokens: 8, total_tokens: 21 },
    { input_tokens: -1, output_tokens: 1, total_tokens: 0 },
  ])
    expect(knownUsage(value)).toBe(false)
  expect(knownUsage({ input_tokens: 12, output_tokens: 8, total_tokens: 20 })).toBe(true)
  expect(knownUsage({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 })).toBe(true)
})

test("legacy scoring and mixed scenario/manifest identity reject advisory materials", () => {
  const packet = publish(advisoryDevelopment()[0].packet)
  const issued = issue(packet, {
    directory: "/unused",
    contractID: "pct_example",
    issuedAt: Date.now(),
    worker: { providerID: "test", id: "worker" },
    reviewer: { providerID: "test", id: "reviewer" },
    executable: "/usr/bin/node",
    executableHash: digest("fixture"),
    timeout: 1000,
    evaluation: "advisory-v3",
  } as Parameters<typeof issue>[1])
  expect(() => assertEvaluation({ evaluation: "advisory-v3", manifest: issued.manifest })).toThrow("dedicated")
  expect(() =>
    assertEvaluation(
      { evaluation: "advisory-v3", scenario: "feedback-development:1", manifest: issued.manifest },
      true,
    ),
  ).toThrow("matching")
  expect(() =>
    assertEvaluation(
      {
        evaluation: "advisory-v3",
        scenario: packet.version,
        manifest: { ...issued.manifest, reviewPolicy: { version: 1 } },
      },
      true,
    ),
  ).toThrow("matching")
})
