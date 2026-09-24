import type { prepareAdvisoryArchive } from "./advisory-archive"
import { digest } from "./ledger"

type Field = { value: unknown } | { ref: string }
type History = {
  encoding: "shared-run-fields:1"
  instructions: string
  contents: Record<string, { hash: string; value: unknown }>
  rows: Record<string, Field>[]
}

/** Only the observation's feedback presentation changes; candidate and formal scoring materials stay intact. */
export function shareFeedbackHistory(material: Awaited<ReturnType<typeof prepareAdvisoryArchive>>["feedback"]) {
  const history = shareRunHistory(material.trajectory.archive.runs)
  if (Buffer.byteLength(JSON.stringify(history)) >= Buffer.byteLength(JSON.stringify(material.trajectory.archive.runs)))
    return material
  return {
    ...material,
    trajectory: { ...material.trajectory, archive: { ...material.trajectory.archive, runs: history } },
  }
}

/** Share exact repeated field values, never events or versions. Every referenced value remains in this request. */
export function shareRunHistory(runs: Record<string, unknown>[]): History {
  const counts = new Map<string, number>()
  for (const run of runs)
    for (const value of Object.values(run)) {
      const json = JSON.stringify(value)
      if (json === undefined) throw new Error("Run history fields must be JSON values")
      // A representation threshold, not a research or request budget: smaller values stay inline.
      if (Buffer.byteLength(json) >= 256) counts.set(json, (counts.get(json) ?? 0) + 1)
    }
  const references = new Map(
    [...counts].filter(([, count]) => count > 1).map(([json], index) => [json, "f" + (index + 1)]),
  )
  return {
    encoding: "shared-run-fields:1",
    instructions:
      "Each row is one original run state, in original order. Each field is either {value: originalValue} or {ref: id}. Resolve ref using contents[id].value; its full content is included here, not at an external path. References are local to this history. Read the referenced values when assessing a state. Repeated states and every version remain separate rows. No content was summarized or removed.",
    contents: Object.fromEntries(
      [...references].map(([json, id]) => [id, { hash: digest(json), value: JSON.parse(json) as unknown }]),
    ),
    rows: runs.map((run) =>
      Object.fromEntries(
        Object.entries(run).map(([key, value]) => {
          const ref = references.get(JSON.stringify(value))
          return [key, ref ? { ref } : { value }]
        }),
      ),
    ),
  }
}

/** Offline integrity check: no archive access or cross-request lookup is allowed during reconstruction. */
export function restoreRunHistory(history: History) {
  if (history.encoding !== "shared-run-fields:1") throw new Error("Unknown run history encoding")
  for (const entry of Object.values(history.contents))
    if (digest(JSON.stringify(entry.value)) !== entry.hash) throw new Error("Shared run field is corrupt")
  return history.rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, field]) => {
        if (Object.keys(field).length !== 1) throw new Error("Ambiguous run field")
        if ("value" in field) return [key, field.value]
        if (!Object.hasOwn(history.contents, field.ref)) throw new Error("Missing shared run field")
        return [key, history.contents[field.ref].value]
      }),
    ),
  )
}
