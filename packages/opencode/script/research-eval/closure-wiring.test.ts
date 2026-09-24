import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { lifecycleFixture } from "./test/lifecycle"
import { lifecycleMaterials } from "./lifecycle-evaluate"
import { lifecycleDevelopment } from "./lifecycle-scenarios"
import { identities } from "./launch"
import { issue } from "./driver"
import { publish } from "./corpus"
import { digest } from "./ledger"
import { readJournal } from "./host-journal"

test("closure guidance is explicit, preserves old measurements, and rejects incompatible issuance", () => {
  const examples = lifecycleDevelopment()
  const input = {
    directory: "/tmp/unused",
    contractID: "pct_closure",
    issuedAt: 1,
    worker: { providerID: "fixture", id: "worker" },
    reviewer: { providerID: "fixture", id: "reviewer" },
    executable: "/usr/bin/node",
    executableHash: digest("node"),
    timeout: 1000,
    evaluation: "repair-lifecycle-v1" as const,
  } as Parameters<typeof issue>[1]
  const old = issue(publish(examples[0].packet), input)
  expect(old.manifest).not.toHaveProperty("feedbackGuidance")
  const next = issue(publish(examples[0].packet), { ...input, feedbackGuidance: "closure:1" })
  expect(next.manifest.feedbackGuidance).toBe("closure:1")
  expect(next.spec).toEqual(old.spec)
  expect(() =>
    issue(publish(examples[0].packet), { ...input, feedbackGuidance: "closure:1", evaluation: undefined }),
  ).toThrow()
  const before = identities({}, examples, {}, {}).scenarios!
  const after = identities({}, examples, { feedbackGuidance: "closure:1" }, {}).scenarios!
  expect(after as unknown).toEqual({ ...before, feedbackGuidance: "closure:1" })
})

test("production closure and CAS wiring retains repair intent, revised plan, verified claim and scoring provenance", async () => {
  const root = await mkdtemp("/tmp/research-closure-wiring-")
  const captured = await lifecycleFixture("repair", {
    directory: root + "/instance",
    infrastructure: { version: 1, startup: 30000, operation: 30000, cleanup: 30000, journal: "cas:1" },
    capture: true,
    feedbackGuidance: "closure:1",
  })
  if (!captured) throw new Error("Fixture capture missing")
  const result = captured.result
  expect(result.feedbackGuidance).toBe("closure:1")
  expect(result.monitored.run.input.manifest.feedbackGuidance).toBe("closure:1")
  expect(result.monitored.run.plan?.value.version).toBe(2)
  expect(result.monitored.run.completionHashes?.length).toBeGreaterThan(0)
  const object = async (hash: string, raw = false) => {
    const text = await Bun.file(captured.directory + "/archive/objects/" + hash).text()
    return raw ? text : JSON.parse(text)
  }
  const materials = await lifecycleMaterials(result, captured.example.oracle, object, captured.directory)
  expect(materials.material.measurement).toMatchObject({
    feedbackGuidance: "closure:1",
    infrastructure: result.infrastructure,
  })
  expect(materials.material.lifecycle.completions.length).toBeGreaterThan(0)
  await expect(
    lifecycleMaterials({ ...result, feedbackGuidance: undefined }, captured.example.oracle, object, captured.directory),
  ).rejects.toThrow("guidance")
  const audit = await object(result.auditHash!)
  expect(audit.state).toBe("stable_copy")
  expect(audit.files.some((file: { path: string }) => file.path.startsWith("host/operations.objects/"))).toBe(true)
  const rows = await Array.fromAsync(readJournal(captured.directory + "/host/operations.jsonl", "cas:1"))
  const issued = rows.find((row) => row.event === "command_start" && row.action === "research-issue")!
  expect(issued.payload).toMatchObject({ manifest: { feedbackGuidance: "closure:1" } })
  expect(rows.some((row) => row.event === "cleanup" && row.complete === true)).toBe(true)
}, 120000)
