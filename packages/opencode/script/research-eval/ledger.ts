import { createHash } from "node:crypto"
import { appendFile, mkdir, open } from "node:fs/promises"
import path from "node:path"
import type { Label } from "./score"

export const version = "research-eval:1"
export const duration = 21_600_000
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
export type Instance = {
  id: string
  track: "probe" | "research"
  family: string
  repeat: number
  defective: boolean
  packetHash: string
}
export type Failure =
  | "not_started"
  | "provider"
  | "protocol"
  | "mechanical"
  | "infrastructure"
  | "timeout"
  | "cancelled"
  | "scientific"
  | "reviewer"
  | "indeterminate"
export type Usage = {
  stage: "worker" | "plan_review" | "review" | "experiment" | "verification"
  operationID: string
  milliseconds?: number | null
  turns: number
  actions: number
  wireRequests: number
  tokens: number | null
  cost: number | null
  unknown: boolean
}
export type Event =
  | { kind: "invariant"; at: number; violation: string; evidenceHash: string }
  | { kind: "issued"; at: number; deadline: number; contractID: string }
  | { kind: "observation"; at: number; hash: string; stage: string }
  | { kind: "usage"; at: number; value: Usage }
  | { kind: "injection"; at: number; status: "injected" | "injection_miss" | "not_injected"; evidenceHash: string }
  | {
      kind: "recovery"
      at: number
      deadline: number
      oldJobID: string
      newJobID: string
      safe: boolean
      replan: boolean
      evidenceHash: string
    }
  | {
      kind: "candidate"
      at: number
      readyAt?: number
      scoredAt?: number | null
      attestedAt?: number | null
      hash: string
      bundleValid: boolean
      verdict: "correct" | "incorrect" | "indeterminate"
      scoreHash: string
    }
  | {
      kind: "probe"
      at: number
      label: Label
      exposed: boolean
      usable: boolean
      mechanismFailure: boolean
      scoreHash: string
    }
  | { kind: "repair"; at: number; source: "initial" | "plan_review" | "review"; defectHash: string; repaired: boolean }
  | { kind: "accounting"; at: number; archiveHash: string; operationIDs: string[]; unresolvedScoring: boolean }
  | { kind: "stopped"; at: number; reason: string; failure?: Failure }

type Row = { instanceID: string; previous: string; event: Event; hash: string }
export function validate(events: readonly Event[], event: Event) {
  const issued = events.find((item) => item.kind === "issued")
  if (events.some((item) => item.kind === "stopped")) throw new Error("Instance already stopped")
  if (!Number.isFinite(event.at) || event.at < (events.at(-1)?.at ?? 0)) throw new Error("Invalid event time")
  if (event.kind === "issued" && (issued || event.deadline !== event.at + duration))
    throw new Error("Issuance must retain exactly one six-hour deadline")
  if (event.kind !== "issued" && !issued && event.kind !== "stopped") throw new Error("Instance was not issued")
  if (
    event.kind === "recovery" &&
    (event.deadline !== issued?.deadline || event.oldJobID === event.newJobID || event.at >= event.deadline)
  )
    throw new Error("Recovery cannot renew authority or reuse unknown work")
  if (event.kind === "injection" && events.some((item) => item.kind === "injection"))
    throw new Error("Only one scheduled injection opportunity")
  if (
    event.kind === "usage" &&
    events.some((item) => item.kind === "usage" && item.value.operationID === event.value.operationID)
  )
    throw new Error("Duplicate operation accounting")
  if (event.kind === "probe" && events.some((item) => item.kind === "probe"))
    throw new Error("Only the first target report is scored")
}

export async function create(directory: string, instances: readonly Instance[], sourceHash: string) {
  if (new Set(instances.map((item) => item.id)).size !== instances.length) throw new Error("Duplicate instance")
  await mkdir(directory, { recursive: true })
  const file = await open(path.join(directory, "manifest.json"), "wx", 0o600)
  await file.writeFile(
    JSON.stringify({ version, mode: "deterministic-selfcheck", sourceHash, instances }, null, 2) + "\n",
  )
  await file.sync()
  await file.close()
  return read(directory)
}

export async function read(directory: string) {
  const manifest = (await Bun.file(path.join(directory, "manifest.json")).json()) as {
    version: string
    mode: string
    sourceHash: string
    instances: Instance[]
  }
  const file = path.join(directory, "events.jsonl")
  const rows = (await Bun.file(file).exists())
    ? (await Bun.file(file).text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row)
    : []
  const histories = new Map(manifest.instances.map((item) => [item.id, [] as Event[]]))
  const chain = { hash: digest(JSON.stringify(manifest)) }
  rows.forEach((row) => {
    const events = histories.get(row.instanceID)
    if (
      !events ||
      row.previous !== chain.hash ||
      row.hash !== digest(JSON.stringify({ instanceID: row.instanceID, previous: row.previous, event: row.event }))
    )
      throw new Error("Ledger identity/hash chain mismatch")
    validate(events, row.event)
    events.push(row.event)
    chain.hash = row.hash
  })
  return {
    manifest,
    histories,
    // One serial controller owns the ledger. Reload verifies the entire chain before resumption.
    async append(instanceID: string, event: Event) {
      const events = histories.get(instanceID)
      if (!events) throw new Error("Unscheduled instance")
      validate(events, event)
      const row = { instanceID, previous: chain.hash, event }
      const hash = digest(JSON.stringify(row))
      await appendFile(file, JSON.stringify({ ...row, hash }) + "\n", { mode: 0o600, flush: true })
      events.push(event)
      chain.hash = hash
    },
  }
}

export function report(instances: readonly Instance[], histories: ReadonlyMap<string, readonly Event[]>) {
  const rows = instances.map((instance) => {
    const events = histories.get(instance.id) ?? []
    const issued = events.find((item) => item.kind === "issued")
    const probe = events.find((item) => item.kind === "probe")
    const candidates = events.filter((item) => item.kind === "candidate")
    const injection = events.find((item) => item.kind === "injection")
    return {
      ...instance,
      events,
      probe,
      injection,
      valid: candidates.some(
        (item) =>
          item.verdict === "correct" && item.bundleValid && !!issued && (item.readyAt ?? item.at) <= issued.deadline,
      ),
      wrongReady: candidates.filter((item) => item.verdict === "incorrect").length,
      repaired: events.some((item) => item.kind === "repair" && item.source === "initial" && item.repaired),
      safeRecovery: injection?.status === "injected" && events.some((item) => item.kind === "recovery" && item.safe),
      failure: events.findLast((item) => item.kind === "stopped")?.failure ?? (!issued ? "not_started" : undefined),
    }
  })
  const probes = rows.filter((item) => item.track === "probe")
  const research = rows.filter((item) => item.track === "research")
  const bad = probes.filter((item) => item.defective)
  const good = probes.filter((item) => !item.defective)
  const rate = (numerator: number, denominator: number) => ({
    numerator,
    denominator,
    rate: denominator ? numerator / denominator : null,
  })
  const expected = ["P1", "P2", "P3", "P4", "F1", "F2", "F3", "F4", "R1", "R2", "R3", "R4", "R5", "R6"]
  const families = Object.fromEntries(
    expected.map((family) => {
      const group = rows.filter((item) => item.family === family)
      return [
        family,
        {
          scheduled: group.length,
          detected: group.filter((item) => item.probe?.label === "detected").length,
          accepted: group.filter((item) => item.probe?.label === "valid_accept").length,
          delivered: group.filter((item) => item.valid).length,
        },
      ]
    }),
  )
  const metrics = {
    falseAccept: rate(
      bad.filter((item) => item.probe?.label === "false_accept").length,
      bad.filter((item) => item.probe?.exposed).length,
    ),
    detected: rate(bad.filter((item) => item.probe?.label === "detected").length, bad.length),
    detectedExposed: rate(
      bad.filter((item) => item.probe?.label === "detected").length,
      bad.filter((item) => item.probe?.exposed).length,
    ),
    falseBlock: rate(
      good.filter((item) => item.probe?.label === "false_block").length,
      good.filter((item) => item.probe?.exposed).length,
    ),
    validAccept: rate(good.filter((item) => item.probe?.label === "valid_accept").length, good.length),
    exposed: rate(probes.filter((item) => item.probe?.exposed).length, probes.length),
    usable: rate(probes.filter((item) => item.probe?.usable).length, probes.length),
    delivered: rate(research.filter((item) => item.valid).length, research.length),
    wrongCandidates: research.reduce((count, item) => count + item.wrongReady, 0),
    wrongInstances: research.filter((item) => item.wrongReady).length,
    repaired: rate(
      research.filter((item) => item.family === "R1" && item.repaired).length,
      research.filter((item) => item.family === "R1").length,
    ),
    injected: rate(
      research.filter((item) => item.injection?.status === "injected").length,
      research.filter((item) => ["R5", "R6"].includes(item.family)).length,
    ),
    recovered: rate(
      research.filter((item) => item.safeRecovery).length,
      research.filter((item) => ["R5", "R6"].includes(item.family)).length,
    ),
  }
  const gates = {
    matrix:
      instances.length === 66 &&
      new Set(instances.map((item) => item.id)).size === 66 &&
      instances.every((item) => expected.includes(item.family)) &&
      expected.every((family) => {
        const group = instances.filter((item) => item.family === family)
        const research = family.startsWith("R")
        return (
          group.length === (research ? 3 : 6) &&
          group.every((item) => item.track === (research ? "research" : "probe")) &&
          [1, 2, 3].every((repeat) =>
            (research ? [false] : [true, false]).every(
              (defective) =>
                group.filter((item) => item.repeat === repeat && item.defective === defective).length === 1,
            ),
          )
        )
      }),
    invariants: !rows.some(
      (item) => item.probe?.mechanismFailure || item.events.some((event) => event.kind === "invariant"),
    ),
    exposure: metrics.exposed.numerator === 48,
    falseAccept: metrics.falseAccept.numerator === 0 && metrics.falseAccept.denominator === 24,
    falseDelivery: metrics.wrongCandidates === 0,
    detection:
      metrics.detected.numerator >= 21 &&
      Object.entries(families)
        .filter(([name]) => !name.startsWith("R"))
        .every(([, group]) => group.detected >= 2),
    controls:
      metrics.validAccept.numerator >= 21 &&
      Object.entries(families)
        .filter(([name]) => !name.startsWith("R"))
        .every(([, group]) => group.accepted >= 2),
    usable: metrics.usable.numerator >= 46,
    delivery:
      metrics.delivered.numerator >= 15 &&
      Object.entries(families)
        .filter(([name]) => name.startsWith("R"))
        .every(([, group]) => group.delivered >= 2),
    repair: metrics.repaired.numerator >= 2,
    recovery: metrics.injected.numerator === 6 && metrics.recovered.numerator === 6,
    accounted: rows.every((item) => {
      const audit = item.events.findLast((event) => event.kind === "accounting")
      const usage = item.events.filter((event) => event.kind === "usage")
      return (
        item.events.some((event) => event.kind === "stopped") &&
        !!audit &&
        !audit.unresolvedScoring &&
        /^[a-f0-9]{64}$/.test(audit.archiveHash) &&
        new Set(audit.operationIDs).size === audit.operationIDs.length &&
        audit.operationIDs.toSorted().join(",") ===
          usage
            .map((event) => event.value.operationID)
            .toSorted()
            .join(",") &&
        usage.every((event) =>
          [event.value.turns, event.value.actions, event.value.wireRequests].every(
            (value) => Number.isInteger(value) && value >= 0,
          ),
        ) &&
        item.events.some((event) => event.kind === "observation") &&
        (item.track === "probe"
          ? !!item.probe && /^[a-f0-9]{64}$/.test(item.probe.scoreHash)
          : item.events.some((event) => event.kind === "candidate" && /^[a-f0-9]{64}$/.test(event.scoreHash)))
      )
    }),
  }
  const usage = rows.flatMap((row) =>
    row.events.filter((event) => event.kind === "usage").map((event) => ({ instanceID: row.id, ...event.value })),
  )
  const stages = Object.fromEntries(
    ["worker", "plan_review", "review", "experiment", "verification"].map((stage) => {
      const items = usage.filter((item) => item.stage === stage)
      return [
        stage,
        {
          operations: items.length,
          operationMilliseconds: items.some((item) => item.milliseconds == null)
            ? null
            : items.reduce((sum, item) => sum + item.milliseconds!, 0),
          turns: items.reduce((sum, item) => sum + item.turns, 0),
          actions: items.reduce((sum, item) => sum + item.actions, 0),
          wireRequests: items.reduce((sum, item) => sum + item.wireRequests, 0),
          tokens: items.some((item) => item.tokens === null)
            ? null
            : items.reduce((sum, item) => sum + item.tokens!, 0),
          cost: items.some((item) => item.cost === null) ? null : items.reduce((sum, item) => sum + item.cost!, 0),
          unknown: items.filter((item) => item.unknown || item.tokens === null || item.cost === null),
        },
      ]
    }),
  )
  const elapsed = rows.map((row) => {
    const issued = row.events.find((event) => event.kind === "issued")
    const stopped = row.events.findLast((event) => event.kind === "stopped")
    const candidate = row.events.find((event) => event.kind === "candidate")
    return {
      instanceID: row.id,
      milliseconds: issued && stopped ? stopped.at - issued.at : null,
      researchMilliseconds: issued && candidate?.readyAt !== undefined ? candidate.readyAt - issued.at : null,
      scoringMilliseconds:
        candidate?.scoredAt != null && candidate.readyAt !== undefined ? candidate.scoredAt - candidate.readyAt : null,
      recognitionMilliseconds:
        candidate?.attestedAt != null && candidate.scoredAt != null ? candidate.attestedAt - candidate.scoredAt : null,
      externalMilliseconds:
        candidate?.attestedAt != null && candidate.readyAt !== undefined
          ? candidate.attestedAt - candidate.readyAt
          : null,
      success: row.valid,
    }
  })
  return { version, rows, families, metrics, gates, efficiency: { elapsed, stages }, qualification: "not_run" as const }
}
