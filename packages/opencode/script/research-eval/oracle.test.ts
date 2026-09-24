import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { corpus } from "./corpus"
import { objective } from "./oracle"

test("formal R3 output binds the fixed population; independent checks reject relabelled or cherry-picked evidence", async () => {
  const example = corpus("development").find((item) => item.oracle.instance.family === "R3")!
  const directory = await mkdtemp(path.join(os.tmpdir(), "s6c-population-"))
  try {
    await Promise.all(
      Object.entries({ ...example.packet.files, ...example.packet.preparation }).map(([file, value]) =>
        Bun.write(path.join(directory, file), value),
      ),
    )
    const child = Bun.spawn(["/usr/bin/node", "--test", "acceptance.mjs"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
    const exit = await child.exited
    clearTimeout(timer)
    expect(exit).toBe(0)
    const raw = await Bun.file(path.join(directory, "result.json")).json()
    const report = await Bun.file(path.join(directory, "report.json")).text()
    const measured = objective(example.oracle, { report, raw: JSON.stringify(raw), values: example.oracle.outputs })
    expect(Object.values(measured)).not.toContain(false)
    expect(raw).toMatchObject({ effect: 1, observations: 8, observationIDs: ["pair-1", "pair-2", "pair-3", "pair-4"] })
    expect(JSON.parse(report).conclusion).toBe("negative")
    const schema = await Bun.file(path.join(directory, "report.schema.json")).json()
    expect(schema.properties.evidence.items.required).toEqual(["path"])
    expect(schema.properties.evidence.items.properties.path.enum).toEqual([
      "data.json",
      "result.json",
      "analysis.mjs",
      "acceptance.mjs",
    ])
    expect(
      schema.properties.evidence.allOf.map(
        (item: { contains: { properties: { path: { const: string } } } }) => item.contains.properties.path.const,
      ),
    ).toEqual(["data.json", "result.json"])
    expect(example.packet.brief).toContain("put explanatory prose in description, never inside path")
    for (const evidence of [
      schema.properties.evidence.examples[0],
      [{ path: "data.json" }, { path: "result.json" }],
      [
        { path: "data.json", description: "Raw pairs (not an experimental conclusion)" },
        { path: "result.json", description: "Bound experiment output" },
      ],
    ])
      expect(
        objective(example.oracle, {
          report: JSON.stringify({ ...JSON.parse(report), evidence }),
          raw: JSON.stringify(raw),
          values: example.oracle.outputs,
        }).references,
      ).toBe(true)
    for (const evidence of [
      ["data.json", "result.json"],
      [{ path: "data.json (raw pairs)" }, { path: "result.json" }],
      [{ path: "data.json" }, { path: "../result.json" }],
      [{ path: "data.json" }, { path: "acceptance.mjs" }],
      [{ path: "data.json" }, { path: "result.json", description: "" }],
    ])
      expect(
        objective(example.oracle, {
          report: JSON.stringify({ ...JSON.parse(report), evidence }),
          raw: JSON.stringify(raw),
          values: example.oracle.outputs,
        }).references,
      ).toBe(false)
    for (const change of [
      { primaryIDs: raw.split.test },
      { observationIDs: ["pair-1", "pair-2", "pair-3", "pair-3"] },
      { split: { ...raw.split, validation: raw.split.test, test: raw.split.validation } },
    ])
      expect(
        objective(example.oracle, {
          report,
          raw: JSON.stringify({ ...raw, ...change }),
          values: example.oracle.outputs,
        }).population,
      ).toBe(false)
    expect(
      objective(example.oracle, {
        report: JSON.stringify({ ...JSON.parse(report), conclusion: "positive" }),
        raw: JSON.stringify(raw),
        values: example.oracle.outputs,
      }).conclusion,
    ).toBe(false)
    expect(
      objective(example.oracle, { report, raw: JSON.stringify({ ...raw, effect: 3 }), values: example.oracle.outputs })
        .numeric,
    ).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
