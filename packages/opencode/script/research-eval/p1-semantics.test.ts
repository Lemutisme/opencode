import { expect, test } from "bun:test"
import { corpus } from "./corpus"
import { rubric } from "./evaluate"

// These are local semantic regressions, not model trials or additions to the frozen matrix.
// The operation and its prose are paired explicitly; no keyword is used as a correctness oracle.
test("P1 selection/evaluation data relationships survive equivalent independence wording", async () => {
  const phrases = [
    "report this independent diagnostic as exploratory only",
    "report an exploratory diagnostic independent of parameter selection",
    "describe the exploratory result as held-out evaluation",
    "report an exploratory estimate from observations untouched by threshold selection",
  ]
  for (const split of ["development", "qualification"] as const) {
    const frozen = corpus(split).filter((item) => item.oracle.instance.family === "P1")
    const before = JSON.stringify(frozen)
    for (const item of frozen) {
      const data = JSON.parse(item.packet.files["data.json"]) as {
        a: number[]
        b: number[]
        observationIDs: string[]
        primaryIDs: string[]
        split: { train: string[]; validation: string[]; test: string[] }
        exploratoryThresholds: number[]
      }
      const implementation: {
        rate: (values: number[], threshold: number) => number
        effect: (a: number[], b: number[]) => number
      } = await import(
        "data:text/javascript;base64," + Buffer.from(item.packet.files["analysis.mjs"]).toString("base64")
      )
      const selectedSource = /Select the threshold .*? on (validation|held-out test) IDs, breaking ties/.exec(
        item.packet.plan.method,
      )?.[1]
      if (!selectedSource) throw new Error("The frozen plan does not identify its threshold-selection data")
      const source = selectedSource === "validation" ? "validation" : "test"
      const contrast = (ids: string[], threshold: number) =>
        implementation.rate(
          ids.map((id) => data.b[data.observationIDs.indexOf(id)]),
          threshold,
        ) -
        implementation.rate(
          ids.map((id) => data.a[data.observationIDs.indexOf(id)]),
          threshold,
        )
      const choices = data.exploratoryThresholds.map((threshold) => ({
        threshold,
        contrast: contrast(data.split[source], threshold),
      }))
      const selected = choices.toSorted((a, b) => b.contrast - a.contrast || a.threshold - b.threshold)[0]
      const relation = {
        selectionIDs: data.split[source],
        evaluationIDs: data.split.test,
        reusedIDs: data.split.test.filter((id) => data.split[source].includes(id)),
        threshold: selected.threshold,
        selectionContrast: selected.contrast,
        testContrast: contrast(data.split.test, selected.threshold),
        primaryEffect: implementation.effect(data.a, data.b),
      }
      expect(relation.threshold).toBe(data.exploratoryThresholds[item.oracle.instance.defective ? 1 : 0])
      expect(relation.selectionContrast).toBe(1)
      expect(relation.testContrast).toBe(item.oracle.instance.defective ? 1 : 0)
      expect(relation.reusedIDs).toEqual(item.oracle.instance.defective ? data.split.test : [])
      expect(relation.primaryEffect).toBe(3)
      expect(data.primaryIDs).toEqual(data.observationIDs)
      phrases.forEach((phrase) => {
        const method = item.packet.plan.method.replace("report this independent diagnostic as exploratory only", phrase)
        expect(method).toContain(phrase)
        expect(method).toContain(item.oracle.instance.defective ? "on held-out test IDs" : "on validation IDs")
        expect(method).toContain(item.oracle.instance.defective ? "on those same test IDs" : "on held-out test IDs")
        expect(method).toContain("Keep the fixed all-pair primary result unchanged")
        // Merely renaming the diagnostic cannot remove overlap, create overlap, or change the fixed primary.
        expect(relation.reusedIDs.length > 0).toBe(item.oracle.instance.defective)
        expect(rubric(item.oracle).method).toContain("selection uses validation")
        expect(rubric(item.oracle).method).toContain("same test independent is defective")
      })
    }
    expect(JSON.stringify(corpus(split).filter((item) => item.oracle.instance.family === "P1"))).toBe(before)
  }
})
