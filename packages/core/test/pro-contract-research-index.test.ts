import { describe, expect, test } from "bun:test"
import { lstat, mkdir } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { operationIndex, renderIndexedContext, renderPreview } from "../script/trajectory-research/workflow"
import { ProContractVersion } from "../src/pro-contract/version"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"

function event(index: number, kind: string, value: unknown) {
  const raw = JSON.stringify({ kind, interpretation: "unverified-observation", value })
  return { index, kind, path: `.research/events/${index}-${kind}.json`, hash: Hash.sha256(raw), summary: kind, raw }
}

function decision(index: number, action: unknown) {
  return event(index, "decision", {
    id: `research-${index}`,
    status: "unverified",
    summary: typeof action === "string" ? action : JSON.stringify(action),
  })
}

function compute(index: number, output = "observed output") {
  return event(index, "compute", {
    status: "exited",
    exitCode: 0,
    startedAt: 1,
    completedAt: 2,
    stdout: { text: output, bytes: Buffer.byteLength(output), truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
  })
}

function context(events: ReturnType<typeof event>[], notebook = "") {
  const rows = operationIndex(events)
  const archive = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "")
  return renderIndexedContext(
    events,
    rows,
    { archive: ".research/context/index.jsonl", hash: Hash.sha256(archive), bytes: Buffer.byteLength(archive) },
    {
      archive: ".research/context/notebook.txt",
      hash: Hash.sha256(notebook),
      bytes: Buffer.byteLength(notebook),
      text: notebook,
    },
  )
}

const action = {
  type: "compute",
  rationale: "Distinguish a declaration from a recorded outcome.",
  prediction: "Exit zero alone does not prove that a named file was read.",
  program: 'if (false) await Bun.file("never-read.json").text(); console.log("observed")',
}

test("exact index preserves declarations, program reference and recorded execution facts without inventing IO", () => {
  const events = [event(0, "catalog", []), decision(1, action), compute(2)]
  const rows = operationIndex(events)
  expect(rows).toHaveLength(2)
  expect(rows[1]).toMatchObject({
    association: "adjacent-method-records-not-evidence-dependencies",
    events: events.slice(1).map(({ raw, summary, ...event }) => event),
    outcome: "recorded",
    action: {
      interpretation: "unverified-declared-action",
      validity: "valid-action",
      value: {
        type: "compute",
        rationale: action.rationale,
        prediction: action.prediction,
        program: {
          sourceHash: Hash.sha256(action.program),
          bytes: Buffer.byteLength(action.program),
          archive: events[1].path,
          sourcePreview: { text: action.program, omittedBytes: 0 },
          interpretation: "code-text-not-observed-IO",
        },
      },
    },
    outcomes: [
      {
        eventIndex: 2,
        status: "exited",
        exitCode: 0,
        interpretation: "unverified-recorded-outcome",
        stdout: { bytes: 15, truncated: false },
        stderr: { bytes: 0, truncated: false },
      },
    ],
  })
  expect(rows[0].action).toBeUndefined()
})

test("malformed actions stay unparsed, no-outcome actions stay unresolved, and fenced JSON matches execution parsing", () => {
  const malformed = decision(0, "not an action")
  const invalid = event(1, "invalid-action", { error: "Expected action JSON" })
  expect(operationIndex([malformed, invalid])[0]).toMatchObject({
    action: { validity: "invalid-action", value: { unparsedAction: "not an action" } },
    outcomes: [{ kind: "invalid-action", status: "not-executed" }],
  })
  const pending = operationIndex([decision(2, `\`\`\`json\n${JSON.stringify(action)}\n\`\`\``)])[0]
  expect(pending).toMatchObject({ outcome: "not-recorded", outcomes: [], action: { validity: "valid-action" } })
  expect(pending.action?.value).toHaveProperty("rationale", action.rationale)
  expect(operationIndex([decision(0, { type: "adopt" })])[0].action?.validity).toBe("invalid-action")
})

test("isolated surrogate notes and program text are invalid actions, not falsely exact UTF-8 files", () => {
  for (const invalid of [
    { ...action, notes: "\ud800" },
    { ...action, program: "\ud800" },
  ]) {
    const row = operationIndex([decision(0, invalid)])[0]
    expect(row.action).toMatchObject({
      validity: "invalid-action",
      error: expect.stringContaining("well-formed Unicode"),
    })
    expect(row.action?.value).toHaveProperty("unparsedAction", JSON.stringify(invalid))
  }
})

test("a noncompute program-named extension remains exact JSON data, not claimed UTF-8 program bytes", () => {
  const row = operationIndex([
    decision(0, {
      type: "inspect",
      rationale: "Inspect recorded behavior",
      selections: [{ sourceID: "fixture" }],
      program: "\ud800",
    }),
  ])[0]
  expect(row.action?.validity).toBe("valid-action")
  expect(row.action?.value).toHaveProperty("program", "\ud800")
})

test("critic text remains an unverified outcome linked by adjacency, not a scientific acceptance", () => {
  const request = decision(0, {
    type: "critique",
    claim: "A mechanism works",
    alternatives: ["More time helped"],
    question: "What falsifies it?",
  })
  expect(operationIndex([request])[0].outcome).toBe("not-recorded")
  const critique = event(1, "critique", { id: "critic-response", status: "unverified", summary: "Confounded" })
  expect(operationIndex([request, critique])[0]).toMatchObject({
    outcome: "recorded",
    outcomes: [{ kind: "critique", status: "unverified", interpretation: "unverified-recorded-outcome" }],
    action: { value: { type: "critique", alternatives: ["More time helped"] } },
  })
  expect(context([request, critique]).recent[0].observation).toEqual(renderPreview(critique.raw, 21_845))
})

test("latest three outcome previews are unchanged while older operations remain indexed beyond six events", () => {
  const events = Array.from({ length: 8 }, (_, index) => [
    decision(index * 2, { ...action, rationale: `Question ${index}` }),
    compute(index * 2 + 1, `Observation ${index} 观察🙂\"\\\n`.repeat(4_000)),
  ]).flat()
  const view = context(events)
  expect(view.recent).toHaveLength(3)
  expect(view.recent.map((event) => event.observation)).toEqual(
    events
      .filter((event) => event.kind !== "decision")
      .slice(-3)
      .map((event) => renderPreview(event.raw, 21_845)),
  )
  expect(view.operationIndex.omittedRanges).toEqual([])
  expect(JSON.stringify(view.operationIndex)).toContain("Question 0")
  expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(128 * 1024)
})

test("large Unicode notebook and index explicitly clip with hashes, exact omitted ordinals and bounded serialized view", () => {
  const events = Array.from({ length: 90 }, (_, index) => [
    decision(index * 2, {
      ...action,
      rationale: `Question ${index} 观察🙂`.repeat(400),
      program: `${action.program}; /*${"语🙂".repeat(1_000)}*/`,
    }),
    compute(index * 2 + 1, '"\\\n\t观察🙂'.repeat(8_000)),
  ]).flat()
  const notebook = '笔记🙂"\\\n'.repeat(30_000)
  const view = context(events, notebook)
  expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(128 * 1024)
  expect(Buffer.byteLength(JSON.stringify(view.operationIndex))).toBeLessThanOrEqual(32 * 1024)
  expect(Buffer.byteLength(JSON.stringify(view.notebook.observation))).toBeLessThanOrEqual(16 * 1024)
  expect(view.notebook).toMatchObject({
    hash: Hash.sha256(notebook),
    bytes: Buffer.byteLength(notebook),
    observation: { capture: "preview", fullHash: Hash.sha256(notebook), omittedBytes: expect.any(Number) },
  })
  expect(view.operationIndex.totalRows).toBe(90)
  expect(view.operationIndex.omittedRanges).toEqual([{ from: 0, to: 89 - view.operationIndex.selected.length }])
  expect(view.operationIndex.selected.map((item) => item.ordinal)).toEqual(
    Array.from(
      { length: view.operationIndex.selected.length },
      (_, index) => 90 - view.operationIndex.selected.length + index,
    ),
  )
  for (const item of view.operationIndex.selected)
    expect(Buffer.byteLength(JSON.stringify(item.observation))).toBeLessThanOrEqual(4096)
  expect(JSON.stringify(view)).not.toContain("�")
  expect(operationIndex(events)[0].action?.value).toHaveProperty(
    "rationale",
    JSON.parse(JSON.parse(events[0].raw).value.summary).rationale,
  )
})

test("declared operation fields stay visible before oversized optional notes or extension properties", () => {
  const events = [
    decision(0, { notes: "old notes ".repeat(10_000), extra: "extension ".repeat(10_000), ...action }),
    compute(1),
  ]
  const view = context(events)
  expect(JSON.stringify(view.operationIndex)).toContain(action.rationale)
  expect(JSON.stringify(view.operationIndex)).toContain(action.prediction)
  expect(JSON.stringify(view.operationIndex)).toContain("code-text-not-observed-IO")
  expect(operationIndex(events)[0].action?.value).toHaveProperty("notes", "old notes ".repeat(10_000))
  expect(operationIndex(events)[0].action?.value).toHaveProperty("extra", "extension ".repeat(10_000))
})

test("oversized mandatory event metadata fails explicitly rather than silently replacing recent outcomes", () => {
  const observation = { ...compute(0), summary: "unrepresentable metadata".repeat(20_000) }
  expect(() => context([observation])).toThrow("Unchanged recent evidence and metadata")
})

const Reason = Schema.Struct({ type: Schema.Literal("reason"), id: Schema.String, prompt: Schema.String })
function reason(run: ProContractVersion.Record) {
  expect(run.status).toBe("completed")
  return Schema.decodeUnknownSync(Reason)(run.result!.requests![0])
}

describe.skipIf(process.platform !== "linux" || process.arch !== "x64" || !Bun.which("bwrap"))(
  "indexed context through the actual frozen workflow",
  () => {
    test("materializes ordinary hashed index and notebook archives before advertising them, retaining prior work", async () => {
      await using root = await tmpdir()
      const workspace = path.join(root.path, "workspace")
      await mkdir(workspace)
      const versions = ProContractVersion.make({ directory: path.join(root.path, "store") })
      const frozen = await versions.freeze({
        directory: path.resolve(import.meta.dir, "../script/trajectory-research"),
        entrypoint: "workflow.ts",
      })
      const request = {
        versionHash: frozen.versionHash,
        task: {
          contractID: "pct_index_fixture",
          revision: 1,
          specHash: "index-fixture",
          input: { question: "What changed and what remains unknown?", packets: [] },
        },
        workspace,
        deadline: Date.now() + 30_000,
        view: { responses: [], unresolvedReasoning: [] },
      }
      const initial = await versions.run(request)
      const runs = [initial]
      const notebook = '观察🙂"\\\n'.repeat(30_000)
      for (const ordinal of [0, 1, 2, 3, 4]) {
        const previous = runs.at(-1)!
        runs.push(
          await versions.run({
            ...request,
            checkpoint: previous.id,
            view: {
              responses: [
                {
                  id: reason(previous).id,
                  status: "unverified",
                  summary: JSON.stringify({ ...action, rationale: `Question ${ordinal}`, notes: notebook }),
                },
              ],
              unresolvedReasoning: [],
            },
          }),
        )
      }
      const last = runs.at(-1)!
      const prompt = reason(last).prompt
      const view = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1))
      expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(128 * 1024)
      expect(view.recent).toHaveLength(3)
      expect(view.eventCount).toBe(11)
      const directory = await versions.artifactDirectory(last.id)
      for (const reference of [view.operationIndex, view.notebook]) {
        const file = path.join(directory, reference.archive)
        expect((await lstat(file)).isFile()).toBe(true)
        expect((await lstat(file)).isSymbolicLink()).toBe(false)
        const text = await Bun.file(file).text()
        expect(Hash.sha256(text)).toBe(reference.hash)
        expect(Buffer.byteLength(text)).toBe(reference.bytes)
      }
      expect(await Bun.file(path.join(directory, view.notebook.archive)).text()).toBe(notebook)
      const rows = (await Bun.file(path.join(directory, view.operationIndex.archive)).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(rows).toHaveLength(6)
      expect(rows[1].action.value.rationale).toBe("Question 0")
      expect(rows[1].outcomes[0]).toMatchObject({ status: "exited", exitCode: 0, stdout: { truncated: false } })
      expect(rows[1].action.value.program.interpretation).toBe("code-text-not-observed-IO")
      expect(await versions.read(initial.id)).toEqual(initial)

      const malformed = await versions.run({
        ...request,
        checkpoint: initial.id,
        view: {
          responses: [
            { id: reason(initial).id, status: "unverified", summary: JSON.stringify({ ...action, notes: "\ud800" }) },
          ],
          unresolvedReasoning: [],
        },
      })
      expect(reason(malformed).prompt).toContain("well-formed Unicode")
      expect(reason(malformed).prompt).toContain("invalid-action")

      for (const refusal of [
        {
          program: 'await Bun.write(".research/events/0-catalog.json", "tampered")',
          error: "Research event bytes differ",
        },
        {
          program: `await Bun.write(".research/context/${Hash.sha256("")}.txt", "tampered")`,
          error: "Research context archive bytes changed",
        },
        {
          program: `const { unlink, symlink } = await import("node:fs/promises"); await unlink(".research/context/${Hash.sha256("")}.txt"); await symlink("never-created.txt", ".research/context/${Hash.sha256("")}.txt")`,
          error: "Research context archive must be an ordinary file",
        },
      ]) {
        const refused = await versions.run({
          ...request,
          checkpoint: initial.id,
          view: {
            responses: [
              {
                id: reason(initial).id,
                status: "unverified",
                summary: JSON.stringify({ ...action, program: refusal.program }),
              },
            ],
            unresolvedReasoning: [],
          },
        })
        expect(refused.status).toBe("failed")
        expect(refused.stderr).toContain(refusal.error)
        expect(refused.result).toBeUndefined()
      }
    }, 30_000)
  },
)
