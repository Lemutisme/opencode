import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { lifecycleFixture } from "./test/lifecycle"
import { lifecycleDevelopment } from "./lifecycle-scenarios"
import { runInstance } from "./instance"
import { codeIdentity } from "./provenance"
import { digest } from "./ledger"
import { put } from "./archive"
import { prepareScoring, sealCandidate, revealFeedback, finalizeScoring } from "./evaluate"
import { sealTerminal, checkedTerminal } from "./terminal"
import { launcher } from "./isolation"
import { qualification } from "./qualification"
import { reconcile } from "./usage-reconciliation"
import { identities } from "./launch"

test("two actual candidates plus pre-issuance failure seal before feedback and complete independent fixture scoring", async () => {
  const root = await mkdtemp("/tmp/research-terminal-cohort-")
  const infrastructure = { version: 1 as const, startup: 30000, operation: 30000, cleanup: 30000 }
  const codeHash = await codeIdentity()
  const examples = lifecycleDevelopment()
  const cohort = JSON.stringify({
    mode: "development-calibration",
    configuration: {
      runner: codeHash,
      evaluation: "repair-lifecycle-v1",
      infrastructure,
      order: examples.map((row) => row.packet.id),
    },
    instances: examples.map((row) => row.oracle.instance),
  })
  await Bun.write(root + "/cohort.json", cohort)
  const first = (await lifecycleFixture("remove-bad", {
    directory: root + "/" + examples[0].packet.id,
    infrastructure,
    capture: true,
  }))!
  const second = (await lifecycleFixture("negative", {
    directory: root + "/" + examples[1].packet.id,
    infrastructure,
    capture: true,
  }))!
  for (const instance of [first, second]) {
    const trace = (await Bun.file(instance.directory + "/host/issuance.jsonl").text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    for (const phase of [
      "preparation",
      "snapshot_service",
      "snapshot_capture",
      "snapshot_save",
      "materialize",
      "contract_commit",
    ]) {
      expect(trace.find((event) => event.phase === phase && event.event === "start")).toMatchObject({
        contractID: instance.result.monitored.run.id,
      })
      expect(trace.find((event) => event.phase === phase && event.event === "exit")?.outcome).toBe("succeeded")
    }
    expect(new Set(trace.map((event) => event.requestID)).size).toBe(1)
    expect(trace.every((event) => event.operationDeadline <= instance.result.deadline)).toBe(true)
  }
  const failedDirectory = root + "/" + examples[2].packet.id
  const route = {
    endpoint: "http://127.0.0.1:1/v1/chat/completions",
    model: "unused",
    parameters: {},
    credential: null,
  }
  await expect(
    runInstance({
      mode: "local-fixture",
      evaluation: "repair-lifecycle-v1",
      infrastructure,
      directory: failedDirectory,
      packet: examples[2].packet,
      entry: "followup",
      routes: { worker: route, reviewer: route },
      limits: { worker: { context: 10000, output: 1000 }, reviewer: { context: 10000, output: 1000 } },
      timeouts: { provider: 1000, verification: 1000, cleanup: 1000 },
      bun: process.execPath,
      node: "/nonexistent/research-verifier",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow()
  const failure = await Bun.file(failedDirectory + "/failure.json").json()
  const retained = await Bun.file(failedDirectory + "/archive/objects/" + failure.hash).json()
  expect(retained.attempted).toBe(false)
  expect(retained.deadline).toBe(retained.issuedAt + 21_600_000)
  expect(retained.records).toEqual([])
  const evidence = [
    await put(root, first.result),
    await put(root, second.result),
    await put(root, { instance: examples[2].packet.id, failure: failure.reason, retained: failure }),
  ]
  const chain = { previous: digest(cohort) }
  const rows = examples.map((example, index) => {
    const row = {
      previous: chain.previous,
      at: Date.now(),
      id: example.packet.id,
      status: index === 2 ? "infrastructure_failure" : "pending_scoring",
      evidence: evidence[index],
    }
    chain.previous = digest(JSON.stringify(row))
    return { ...row, hash: chain.previous }
  })
  await Bun.write(root + "/events.jsonl", rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
  const candidates = []
  for (const run of [first, second]) {
    const scoring = await prepareScoring({
      directory: run.directory,
      result: run.result,
      packet: run.example.packet,
      oracle: run.example.oracle,
      launcher: await launcher(root + "/scoring-isolation"),
      timeout: 5000,
    })
    const annotation = {
      rater: "fixture-one",
      candidateHash: scoring.candidateHash,
      rubricHash: scoring.rubricHash,
      items: Object.fromEntries(Object.keys(run.example.oracle.rubric).map((key) => [key, true])),
    }
    candidates.push({ run, scoring, annotation })
    await expect(sealTerminal(run.directory)).rejects.toThrow("candidate")
  }
  await sealCandidate({
    directory: first.directory,
    first: candidates[0].annotation,
    second: { ...candidates[0].annotation, rater: "fixture-two" },
  })
  const disputed = {
    ...candidates[1].annotation,
    rater: "fixture-two",
    items: { ...candidates[1].annotation.items, numeric: false },
  }
  await expect(
    sealCandidate({ directory: second.directory, first: candidates[1].annotation, second: disputed }),
  ).rejects.toThrow("adjudication")
  await expect(revealFeedback(first.directory)).rejects.toThrow()
  await sealCandidate({
    directory: second.directory,
    first: candidates[1].annotation,
    second: disputed,
    resolution: { ...candidates[1].annotation, rater: "fixture-adjudicator" },
  })
  await expect(revealFeedback(first.directory)).rejects.toThrow()
  const terminal = await sealTerminal(failedDirectory)
  expect(terminal.candidateQuality).toBe("not_scored")
  expect(terminal.candidateStatus).toBe("unknown")
  expect(terminal.coordinates).toEqual({ issuedAt: retained.issuedAt, deadline: retained.deadline })
  expect(await Bun.file(failedDirectory + "/blind/sealed.json").exists()).toBe(false)
  await checkedTerminal(failedDirectory, codeHash)
  const altered = await put(failedDirectory + "/archive", { unexpected: "new related evidence" })
  await expect(revealFeedback(first.directory)).rejects.toThrow("changed after sealing")
  const { unlink } = await import("node:fs/promises")
  await unlink(failedDirectory + "/archive/objects/" + altered)
  for (const candidate of candidates) {
    const revealed = await revealFeedback(candidate.run.directory)
    expect<unknown>(revealed.material.measurement).toEqual(identities({}, examples, { infrastructure }, {}).scenarios)
    const rating = {
      rater: "fixture-one",
      candidateHash: revealed.candidateHash,
      rubricHash: revealed.rubricHash,
      items: Object.fromEntries(
        Object.keys(revealed.rubric).map((key) => [
          key,
          key.endsWith(".unsupportedObjection") || key === "spontaneousTargetCorrection" ? false : true,
        ]),
      ),
    }
    const scored = await finalizeScoring({
      directory: candidate.run.directory,
      first: rating,
      second: { ...rating, rater: "fixture-two" },
    })
    expect(scored.verdict).toBe("correct")
    expect(scored.qualification).toBe("not_run")
  }
  const report = await qualification(root, root + "-report")
  if (!("evaluation" in report)) throw new Error("Expected lifecycle report")
  expect(report.denominator).toBe(3)
  expect(report.rows.map((row) => row.scoring)).toEqual(["scored", "scored", "not_scored"])
  expect(report.rows[2].terminal).toMatchObject({ rule: "candidate-or-terminal:1", candidateQuality: "not_scored" })
  const accounting = await reconcile({ directory: root, output: root + "-accounting" })
  expect(accounting.accountingComplete).toBe(false)
  expect(accounting.rows[2].unresolved).toContain("pre_issuance_operation_snapshot_unavailable")
  // A subsequently discovered actual candidate cannot inherit the old unknown seal.
  await Bun.write(failedDirectory + "/cleanup-failure.json", JSON.stringify({ result: first.result }))
  await expect(checkedTerminal(failedDirectory, codeHash)).rejects.toThrow("candidate")
  console.log("Terminal cohort fixture evidence:", root)
}, 240_000)
