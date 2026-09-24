import { Option, Schema } from "effect"
import { ResearchModel } from "../../../sdk-next/src/research/model"

export type Label =
  | "detected"
  | "false_accept"
  | "blocked_other"
  | "false_block"
  | "valid_accept"
  | "unavailable"
  | "not_exposed"

export type Finding = {
  id: string
  located: boolean
  mechanism: boolean
  consequence: boolean
  supported: boolean
  target: boolean
}

export type Probe = {
  exposed: boolean
  defective: boolean
  entry: "plan" | "final"
  raw: string
  evidence: readonly string[]
  findings: readonly Finding[]
  semanticConsistent: boolean
  gate: "open" | "closed" | "unknown"
  gateReason: string
  mechanicalBlock: boolean
}

// Parse the entire final message. Never salvage a verdict from prose or a fenced fragment.
export function score(input: Probe) {
  const object = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(input.raw)
  const raw =
    Option.isSome(object) && typeof object.value === "object" && object.value !== null && !Array.isArray(object.value)
      ? (object.value as Record<string, unknown>)
      : undefined
  const decoded = Schema.decodeUnknownOption(input.entry === "plan" ? ResearchModel.PlanReview : ResearchModel.Review, {
    onExcessProperty: "error",
  })(raw)
  const review = Option.getOrUndefined(decoded)
  const blocking = review?.findings.filter((item) => item.severity === "blocking") ?? []
  const structure = !!review
  const evidence =
    !!review && review.claims.every((claim) => claim.evidence.every((hash) => input.evidence.includes(hash)))
  const scopeError =
    input.entry === "plan" &&
    raw?.verdict === "accept" &&
    ["unclear", "needs_principal_revision"].includes(String(raw?.scope))
  const consistency =
    !!review &&
    input.semanticConsistent &&
    !(review.verdict === "accept" && (!review.claims.length || blocking.length)) &&
    !(review.verdict === "changes_requested" && !blocking.length)
  const target = blocking.some((finding) =>
    input.findings.some(
      (item) =>
        item.id === finding.id && item.target && item.located && item.mechanism && item.consequence && item.supported,
    ),
  )
  const label: Label = !input.exposed
    ? "not_exposed"
    : input.defective && raw?.verdict === "accept"
      ? "false_accept"
      : !structure || !evidence || !consistency
        ? "unavailable"
        : review.verdict === "unavailable"
          ? "unavailable"
          : scopeError
            ? "false_block"
            : review.verdict === "accept"
              ? input.gate === "open"
                ? "valid_accept"
                : "unavailable"
              : !input.defective
                ? "false_block"
                : target
                  ? "detected"
                  : "blocked_other"
  return {
    label,
    raw: input.raw,
    verdict: raw?.verdict,
    scope: raw?.scope,
    findings: raw?.findings,
    structure,
    evidence,
    target,
    protocolError: !!raw && (!consistency || scopeError),
    mechanicalBlock: input.mechanicalBlock,
    gate: input.gate,
    gateReason: input.gateReason,
    mechanismFailure:
      input.gate === "open" && (!structure || !evidence || !consistency || scopeError || review?.verdict !== "accept"),
  }
}

export type Annotation = {
  rater: string
  candidateHash: string
  rubricHash: string
  items: Record<string, boolean | null>
}

// Phase one contains no reviewer verdict, model identity or prior result. Keep both original annotations.
export function adjudicate(first: Annotation, second: Annotation, resolution?: Annotation) {
  if (
    [first, second, ...(resolution ? [resolution] : [])].some(
      (annotation) =>
        !annotation.rater ||
        Object.values(annotation.items).some((value) => value !== true && value !== false && value !== null),
    )
  )
    throw new Error("Annotation items must be explicit true, false or indeterminate")
  if (
    first.rater === second.rater ||
    first.candidateHash !== second.candidateHash ||
    first.rubricHash !== second.rubricHash
  )
    throw new Error("Independent annotations must bind the same blinded candidate and rubric")
  if (
    resolution &&
    ([first.rater, second.rater].includes(resolution.rater) ||
      resolution.candidateHash !== first.candidateHash ||
      resolution.rubricHash !== first.rubricHash)
  )
    throw new Error("Adjudication requires an independent rater and the original identity")
  const keys = Object.keys(first.items).sort()
  if (
    JSON.stringify(keys) !== JSON.stringify(Object.keys(second.items).sort()) ||
    (resolution && JSON.stringify(keys) !== JSON.stringify(Object.keys(resolution.items).sort()))
  )
    throw new Error("Rubric items differ")
  const items = Object.fromEntries(
    keys.map((key) => [
      key,
      first.items[key] === second.items[key] ? first.items[key] : (resolution?.items[key] ?? null),
    ]),
  )
  return {
    first,
    second,
    resolution,
    items,
    verdict:
      !keys.length || Object.values(items).includes(null)
        ? "indeterminate"
        : Object.values(items).every(Boolean)
          ? "correct"
          : "incorrect",
  }
}
