import { expect, test } from "bun:test"
import path from "node:path"
import { renderPreview } from "../script/trajectory-research/workflow"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"

const budget = Math.floor((128 * 1024) / 6)

function inspection() {
  const windows = ["alpha", "beta", "gamma"].flatMap((sourceID, source) =>
    [0, 1].map((window) => ({
      sourceID,
      packetHash: Hash.sha256(`${sourceID}-packet`),
      source: { id: sourceID, hash: Hash.sha256(`${sourceID}-source`) },
      scope: { interpretation: "unverified-observations", sourceCompleteness: "declared-complete" },
      capture: "complete",
      totalRecords: 4,
      index: [],
      records: [0, 1].map((item) => ({
        id: `${sourceID}-window-${window}-record-${item}`,
        hash: Hash.sha256(`${sourceID}-${window}-${item}-record`),
        messageID: `msg_${sourceID}_${window}_${item}`,
        type: "tool",
        time: { created: source * 100 + window * 10 + item },
        tool: {
          name: "bash",
          status: ["completed", "error", "pending"][source],
          input: { status: "complete", text: "Inspect the recorded observation, not an inferred intention." },
          content: [
            {
              order: 0,
              text: {
                status: "complete",
                text:
                  source === 0 && window === 0 && item === 0
                    ? "The first record must not monopolize the next reasoning view. ".repeat(15_000)
                    : `${sourceID} window ${window} record ${item}: distinguishing observed output`,
              },
            },
          ],
          output: source === 2 ? "pending" : "recorded",
          interpretation: "unverified-observation",
        },
      })),
      nextOffset: (window + 1) * 2,
    })),
  )
  return {
    kind: "inspection",
    interpretation: "unverified-observation",
    value: {
      rationale: "Compare all selected source windows without letting their ordering choose the visible evidence.",
      status: "observed",
      value: windows,
    },
  }
}

test("inspection preview balances sources, repeated windows and records under the original total byte bound", () => {
  const event = inspection()
  const original = JSON.stringify(event, null, 2)
  const preview = renderPreview(original, budget)
  const encoded = JSON.stringify(preview)
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(budget)
  expect(preview).toHaveProperty("fullHash", Hash.sha256(original))
  expect(preview).toMatchObject({
    capture: "inspection-preview",
    recordColumns: ["id", "hash", "type", "tool", "status", "output", "fields"],
    fieldColumns: ["path", "text", "omittedBytes", "sourceStatus"],
    windows: event.value.value.map((window) => ({
      sourceID: window.sourceID,
      sourceHash: window.source.hash,
      packetHash: window.packetHash,
      records: window.records.map((record) => [
        record.id,
        record.hash,
        record.type,
        record.tool.name,
        record.tool.status,
        record.tool.output,
        expect.any(Array),
      ]),
    })),
  })
  for (const window of event.value.value) {
    expect(encoded).toContain(window.sourceID)
    expect(encoded).toContain(window.packetHash)
    expect(encoded).toContain(window.source.hash)
    for (const record of window.records) {
      expect(encoded).toContain(record.id)
      expect(encoded).toContain(record.hash)
      expect(encoded).toContain(record.tool.status)
      if (record.id !== "alpha-window-0-record-0") expect(encoded).toContain(record.tool.content[0].text.text)
    }
  }
  expect(encoded).toMatch(/omitted|preview|truncated/)
})

test("field missingness and source truncation are not disguised as complete empty observations", () => {
  const event = inspection()
  const window = event.value.value[0]
  const record = window.records[0]
  const original = JSON.stringify({
    ...event,
    value: {
      ...event.value,
      rationale: "retain missingness ".repeat(4_000),
      value: [
        {
          ...window,
          capture: "truncated",
          scope: { ...window.scope, sourceCompleteness: "partial" },
          records: [
            {
              ...record,
              tool: {
                ...record.tool,
                output: "unavailable",
                input: { status: "unavailable", reason: "field-byte-guard" },
                content: [{ order: 0, status: "unavailable", reason: "non-text-output" }],
                error: { status: "redacted", text: "partial error", omitted: 2 },
              },
            },
          ],
        },
      ],
    },
  })
  const preview = renderPreview(original, budget)
  const encoded = JSON.stringify(preview)
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(budget)
  expect(preview).toMatchObject({ windows: [{ capture: "truncated", sourceCompleteness: "partial" }] })
  expect(encoded).toContain("unavailable:field-byte-guard")
  expect(encoded).toContain("unavailable:non-text-output")
  expect(encoded).toContain("redacted")
  expect(encoded).toContain("partial error")
})

test("preview measures its complete serialized UTF-8 representation, including escaping and metadata", () => {
  for (const original of [
    '"\\\n\t'.repeat(10_000),
    "观察🙂研究".repeat(10_000),
    JSON.stringify({ kind: "decision", value: { summary: '"\\\n\t🙂'.repeat(10_000) } }),
  ]) {
    const preview = renderPreview(original, 1_024)
    const encoded = JSON.stringify(preview)
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(1_024)
    expect(preview).toHaveProperty("fullHash", Hash.sha256(original))
    expect(encoded).not.toContain("�")
    expect(encoded).toMatch(/preview|unavailable/)
  }
})

test("a small inspection budget explicitly reports unavailable evidence instead of silently dropping later records", () => {
  const original = JSON.stringify(inspection())
  const preview = renderPreview(original, 256)
  expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(256)
  expect(preview).toHaveProperty("capture", "unavailable")
  expect(preview).toHaveProperty("fullHash", Hash.sha256(original))
  expect(JSON.stringify(preview)).toMatch(/budget|guard|bound|metadata|bytes/)
})

test("invalid or impossibly small byte guards fail explicitly", () => {
  for (const bytes of [0, 1, 8, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => renderPreview("an observation", bytes)).toThrow()
})

test("complete small observations remain complete and previewing does not rewrite full retained event bytes", async () => {
  const small = '{"kind":"critique","value":"There is insufficient evidence for the claim."}'
  const preview = renderPreview(small, budget)
  expect(preview).toMatchObject({ capture: "complete", text: small })
  expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(budget)

  await using root = await tmpdir()
  const file = path.join(root.path, "inspection.json")
  const original = JSON.stringify(inspection(), null, 2)
  await Bun.write(file, original)
  const rendered = renderPreview(await Bun.file(file).text(), budget)
  expect(Buffer.byteLength(JSON.stringify(rendered))).toBeLessThanOrEqual(budget)
  expect(await Bun.file(file).text()).toBe(original)
  expect(Hash.sha256(await Bun.file(file).text())).toBe(Hash.sha256(original))
})
