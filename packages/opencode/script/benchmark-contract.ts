import { ProContract } from "@opencode-ai/schema/pro-contract"
import { Schema } from "effect"

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Budget = Schema.Struct({
  deadline: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  turns: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)).pipe(Schema.optional),
  actions: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)).pipe(Schema.optional),
})

const PublicManifest = Schema.Struct({
  version: Schema.Literal(1),
  instructionHash: Digest,
  finalEvaluatorHash: Digest,
  visibility: Schema.Literal("public"),
  provenance: Schema.NonEmptyString,
  replay: ProContract.ReplayPolicy,
})

const ExternalManifest = Schema.Struct({
  version: Schema.Literal(2),
  instructionHash: Digest,
  finalEvaluatorHash: Digest,
  visibility: Schema.Literal("sealed"),
  mode: Schema.Literal("external-only"),
  provenance: Schema.NonEmptyString,
  // Final tests are host-only authority, never a public replay oracle.
  replay: Schema.optional(Schema.Never),
})

export const Manifest = Schema.Union([PublicManifest, ExternalManifest])

const Admission = Schema.Struct({
  id: Schema.NonEmptyString,
  scope: Schema.NonEmptyString,
  instruction: Schema.NonEmptyString,
  executionPolicy: Schema.NonEmptyString,
  location: Schema.Struct({ directory: Schema.NonEmptyString }),
  model: Schema.Struct({
    providerID: Schema.NonEmptyString,
    id: Schema.NonEmptyString,
    variant: Schema.NonEmptyString,
  }),
  budget: Budget,
  manifest: Manifest,
})

export function admission(input: unknown) {
  const value = Schema.decodeUnknownSync(Admission)(input)
  if (value.budget.deadline <= Date.now()) throw new Error("The original deadline has expired")
  if (hash(value.instruction) !== value.manifest.instructionHash)
    throw new Error("Verification manifest does not match the task instruction")
  if (value.manifest.version === 1 && value.manifest.replay.checks.length === 0)
    throw new Error(
      "An automated benchmark requires an issuer-approved executable public check; artifacts alone are not enough",
    )
  if (value.manifest.version === 1 && value.manifest.replay.checks.some((check) => check.argv.length === 0))
    throw new Error("Public check command is empty")
  return {
    id: value.id,
    scope: value.scope,
    goal: value.instruction,
    brief: value.instruction,
    executionPolicy: value.executionPolicy,
    location: value.location,
    model: value.model,
    trigger: { type: "immediate" as const },
    authority: ["filesystem.read", "filesystem.write", "process.execute"],
    budget: value.budget,
    requires: [],
    evidence: {
      type: "principal" as const,
      claim: acceptanceClaim(value.instruction, value.manifest.finalEvaluatorHash),
      ...(value.manifest.version === 1 ? { replay: value.manifest.replay } : {}),
    },
    resolution: { maxAttempts: 1, retryDelay: 0 },
  }
}

const Subject = Schema.Struct({
  contractID: Schema.NonEmptyString,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  specHash: Schema.NonEmptyString,
  subjectHash: Schema.NonEmptyString,
  evaluatorHash: Digest,
})

const Verdict = Schema.Struct({
  subject: Subject,
  current: Schema.Struct({
    id: Schema.NonEmptyString,
    revision: Schema.Number,
    specHash: Schema.NonEmptyString,
    status: Schema.String,
    handoff: Schema.Struct({ subjectHash: Schema.NonEmptyString }),
    spec: Schema.Struct({ goal: Schema.NonEmptyString, evidence: Schema.Struct({ claim: Schema.NonEmptyString }) }),
  }),
  generationSealed: Schema.Literal(true),
  sealHash: Digest,
  evaluatorHash: Digest,
  artifactsHash: Digest,
  outcome: Schema.Literals(["passed", "failed", "unavailable"]),
  reportHash: Digest,
})

export function verdict(input: unknown) {
  const value = Schema.decodeUnknownSync(Verdict)(input)
  if (value.current.status !== "verification") throw new Error("The Contract is not awaiting independent verification")
  if (
    value.evaluatorHash !== value.subject.evaluatorHash ||
    value.current.spec.evidence.claim !== acceptanceClaim(value.current.spec.goal, value.subject.evaluatorHash)
  )
    throw new Error("The evaluator is not the frozen task-acceptance authority")
  if (
    value.subject.contractID !== value.current.id ||
    value.subject.revision !== value.current.revision ||
    value.subject.specHash !== value.current.specHash ||
    value.subject.subjectHash !== value.current.handoff.subjectHash
  )
    throw new Error("The evaluator report targets a stale or different candidate")
  const evidence = {
    version: 1,
    subject: value.subject,
    sealHash: value.sealHash,
    evaluatorHash: value.evaluatorHash,
    artifactsHash: value.artifactsHash,
    outcome: value.outcome,
    reportHash: value.reportHash,
    disclosure: "sealed",
  }
  const evidenceHash = hash(JSON.stringify(evidence))
  if (value.outcome === "unavailable") return { action: "pending" as const, evidenceHash, evidence }
  if (value.outcome === "failed")
    return {
      action: "challenge" as const,
      path: `/api/contract/${value.subject.contractID}/challenge`,
      body: {
        revision: value.subject.revision,
        subjectHash: value.subject.subjectHash,
        evidenceHash,
        disclosure: "sealed",
      },
      evidenceHash,
      evidence,
    }
  // The host must retain its single-writer seal from this comparison through
  // attestation. This helper does not make the legacy HTTP endpoint a CAS API.
  return {
    action: "attest" as const,
    path: `/api/contract/${value.subject.contractID}/attestation`,
    body: { evidenceHash },
    evidenceHash,
    evidence,
  }
}

export function phase(status: string) {
  if (status === "active" || status === "dormant") return "continue"
  if (status === "verification") return "evaluate"
  if (status === "discharged") return "complete"
  if (status === "escalated") return "blocked"
  if (status === "released") return "released"
  throw new Error(`Unknown Contract status: ${status}`)
}

export function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

export function acceptanceClaim(instruction: string, evaluatorHash: string) {
  return `Evaluator ${evaluatorHash} accepts the exact candidate against the approved criteria for this task: ${instruction}`
}

if (import.meta.main) {
  const input = await Bun.stdin.json()
  const command = process.argv[2]
  if (command !== "admission" && command !== "verdict") throw new Error("Expected admission or verdict")
  console.log(JSON.stringify(command === "admission" ? admission(input) : verdict(input)))
}
