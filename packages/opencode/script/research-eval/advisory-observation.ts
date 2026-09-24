import path from "node:path"
import { issue } from "./driver"
import { publish, type Packet } from "./corpus"
import { object } from "./advisory-config"
import type { checkAdvisory } from "./advisory-config"
import type { runInstance } from "./instance"
import type { hostEvidence } from "./host-evidence"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import { digest, duration } from "./ledger"

/** Cross-bind actual issuance coordinates and every archived observer dependency before terminal use. */
export async function checkObservation(input: {
  directory: string
  checked: Awaited<ReturnType<typeof checkAdvisory>>
  packet: Packet
  result?: Awaited<ReturnType<typeof runInstance>>
}) {
  const attempt = (await Bun.file(path.join(input.directory, "attempt.json")).json()) as {
    mode: string
    evaluation: string
    infrastructure: unknown
    codeHash: string
    contractID: string
    issuedAt: number
    deadline: number
  }
  const config = input.checked.config
  if (
    attempt.contractID !== "pct_eval_" + input.packet.id ||
    attempt.mode !== config.mode ||
    attempt.evaluation !== "advisory-v3" ||
    JSON.stringify(attempt.infrastructure) !== JSON.stringify(config.infrastructure) ||
    attempt.codeHash !== input.checked.frozen.runner ||
    !Number.isFinite(attempt.issuedAt) ||
    attempt.deadline - attempt.issuedAt !== duration
  )
    throw new Error("Attempt differs from frozen instance, infrastructure or original deadline")
  const admission = (await Bun.file(path.join(input.directory, "admission.json")).json()) as {
    mode: string
    issuedAt: number
    deadline: number
    agreement: ResearchModel.Input
  }
  const agreement = issue(publish(input.packet), {
    directory: path.join(input.directory, "workspace"),
    contractID: attempt.contractID,
    issuedAt: attempt.issuedAt,
    worker: { providerID: "evaluation", id: "worker" } as ResearchModel.Input["model"],
    reviewer: { providerID: "evaluation", id: "reviewer" } as ResearchModel.Input["model"],
    executable: config.node,
    executableHash: input.checked.frozen.runtimes.node.hash,
    timeout: config.timeouts.verification,
    evaluation: "advisory-v3",
  })
  if (
    admission.mode !== config.mode ||
    admission.issuedAt !== attempt.issuedAt ||
    admission.deadline !== attempt.deadline ||
    JSON.stringify(admission.agreement) !== JSON.stringify(agreement)
  )
    throw new Error("Admission differs from the frozen public task or original attempt")
  const archive = path.join(input.directory, "archive")
  const result =
    input.result ??
    (await object<{
      mode: string
      evaluation: string
      codeHash: string
      infrastructure: unknown
      issuedAt: number
      deadline: number
      agreement: ResearchModel.Input
      auditHash: string
    }>(archive, (await Bun.file(path.join(input.directory, "failure.json")).json()).hash))
  const bound = "monitored" in result ? result.monitored.run.input : result.agreement
  if (
    result.mode !== attempt.mode ||
    result.evaluation !== attempt.evaluation ||
    result.codeHash !== attempt.codeHash ||
    JSON.stringify(result.infrastructure) !== JSON.stringify(attempt.infrastructure) ||
    result.issuedAt !== attempt.issuedAt ||
    result.deadline !== attempt.deadline ||
    JSON.stringify(bound) !== JSON.stringify(agreement) ||
    !result.auditHash
  )
    throw new Error("Result/failure does not bind this original admission")
  const audit = await object<Awaited<ReturnType<typeof hostEvidence>>>(archive, result.auditHash)
  if (audit.contractID !== attempt.contractID || audit.capturedAt < attempt.issuedAt)
    throw new Error("Host observation belongs to another instance or time")
  for (const ref of [...audit.files, ...("sources" in audit ? audit.sources : [])]) {
    if (
      !/^[a-f0-9]{64}$/.test(ref.hash) ||
      digest(new Uint8Array(await Bun.file(path.join(archive, "objects", ref.hash)).arrayBuffer())) !== ref.hash
    )
      throw new Error("Host observation dependency is missing or corrupt")
  }
  const confirmed =
    audit.cleanup?.complete === true &&
    audit.cleanup.status === "confirmed" &&
    (!audit.journal || ("allConfirmed" in audit.journal && audit.journal.allConfirmed === true))
  return { agreement, attempt, audit, confirmed }
}
