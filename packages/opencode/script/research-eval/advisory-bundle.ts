import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { digest } from "./ledger"

const instructions =
  "The complete evidence is the bundle object in this same material. Read bundle directly, including its feedback, commands and operations. This reference replaces only a second serialization of that object, not an omitted artifact or an external path. The original evidence text is compact JSON with every object's keys sorted lexicographically, array order preserved, and no trailing newline; its SHA-256 is hash."

/** Share only an exactly reconstructible copy; retain the readable bundle and all historical evidence identities. */
export function shareFeedbackBundle<T extends { bundle: unknown; evidence: Record<string, string> }>(material: T) {
  const raw = ProContractRecognition.canonical(material.bundle)
  const hash = digest(raw)
  if (material.evidence[hash] !== raw) return material
  const reference = { encoding: "shared-bundle-json:1", source: "bundle", hash, instructions }
  if (Buffer.byteLength(JSON.stringify(reference)) >= Buffer.byteLength(JSON.stringify(raw))) return material
  return { ...material, evidence: { ...material.evidence, [hash]: reference } }
}

/** Offline restoration is local and checks the exact original evidence hash; it never repairs missing evidence. */
export function restoreFeedbackBundle<T extends { bundle: unknown; evidence: Record<string, unknown> }>(material: T) {
  const raw = ProContractRecognition.canonical(material.bundle)
  return {
    ...material,
    evidence: Object.fromEntries(
      Object.entries(material.evidence).map(([hash, value]) => {
        if (typeof value === "string") return [hash, value]
        if (
          !value ||
          typeof value !== "object" ||
          Object.keys(value).sort().join(",") !== "encoding,hash,instructions,source" ||
          !("encoding" in value) ||
          value.encoding !== "shared-bundle-json:1" ||
          !("source" in value) ||
          value.source !== "bundle" ||
          !("instructions" in value) ||
          value.instructions !== instructions ||
          !("hash" in value) ||
          value.hash !== hash ||
          digest(raw) !== hash
        )
          throw new Error("Shared bundle evidence is unknown, ambiguous or belongs to different material")
        return [hash, raw]
      }),
    ),
  }
}
