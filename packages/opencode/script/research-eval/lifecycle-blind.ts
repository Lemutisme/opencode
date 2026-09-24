import path from "node:path"
import { digest } from "./ledger"
import { adjudicate } from "./score"
import { lifecycleDevelopment } from "./lifecycle-scenarios"
import { checkedTerminal, cohortState } from "./terminal"
import type { Infrastructure } from "./infrastructure"
import type { runInstance } from "./instance"

export function requireLifecycleAdjudication(input: {
  first: Parameters<typeof adjudicate>[0]
  second: Parameters<typeof adjudicate>[1]
  resolution?: Parameters<typeof adjudicate>[2]
}) {
  const rating = adjudicate(input.first, input.second, input.resolution)
  if (!input.resolution && Object.keys(rating.items).some((key) => input.first.items[key] !== input.second.items[key]))
    throw new Error("Lifecycle scoring requires independent adjudication before sealing disagreements")
}

/** Do not create feedback files until every fixed model-cohort candidate has two sealed judgments. */
export async function lifecycleRevealGate(directory: string, result: Awaited<ReturnType<typeof runInstance>>) {
  const cohortRoot = path.dirname(directory)
  const cohort =
    result.mode === "model" || result.infrastructure
      ? ((await Bun.file(path.join(cohortRoot, "cohort.json")).json()) as {
          mode: string
          instances: { id: string }[]
          configuration: {
            evaluation: string
            runner: string
            order: string[]
            infrastructure?: Infrastructure
            feedbackGuidance?: "closure:1"
          }
        })
      : undefined
  if (JSON.stringify(cohort?.configuration.infrastructure) !== JSON.stringify(result.infrastructure))
    throw new Error("Lifecycle infrastructure policy changed")
  if (cohort && cohort.configuration.feedbackGuidance !== result.feedbackGuidance)
    throw new Error("Lifecycle feedback guidance changed")
  if (result.infrastructure) await cohortState(directory, result.codeHash)
  const expected = lifecycleDevelopment().map((item) => item.packet.id)
  if (
    cohort &&
    (cohort.mode !== "development-calibration" ||
      cohort.configuration.evaluation !== "repair-lifecycle-v1" ||
      cohort.configuration.runner !== result.codeHash ||
      JSON.stringify(cohort.configuration.order) !== JSON.stringify(expected) ||
      JSON.stringify(cohort.instances.map((item) => item.id)) !== JSON.stringify(expected) ||
      !expected.includes(path.basename(directory)))
  )
    throw new Error("Lifecycle reveal requires the fixed three-instance cohort")
  const directories = cohort ? expected.map((id) => path.join(cohortRoot, id)) : [directory]
  const rows = cohort
    ? (await Bun.file(path.join(cohortRoot, "events.jsonl")).text())
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              hash: string
              previous: string
              id: string
              evidence: string
            },
        )
    : []
  const chain = { hash: cohort ? digest(await Bun.file(path.join(cohortRoot, "cohort.json")).text()) : "" }
  if (cohort && rows.length !== expected.length) throw new Error("Lifecycle cohort execution is incomplete")
  for (const [index, target] of directories.entries()) {
    if (result.infrastructure && (await Bun.file(path.join(target, "terminal-ref.json")).exists())) {
      await checkedTerminal(target, result.codeHash)
      chain.hash = rows[index].hash
      continue
    }
    const reference = (await Bun.file(path.join(target, "scoring-ref.json")).json()) as { hash: string }
    const bytes = await Bun.file(path.join(target, "scoring.json")).text()
    const bound = JSON.parse(bytes) as {
      candidateHash: string
      rubricHash: string
      resultHash: string
      codeHash: string
      evaluation: string
    }
    if (
      digest(bytes) !== reference.hash ||
      bytes !== (await Bun.file(path.join(target, "archive/objects", reference.hash)).text()) ||
      bound.codeHash !== result.codeHash ||
      bound.evaluation !== "repair-lifecycle-v1"
    )
      throw new Error("Lifecycle cohort candidate scoring identity changed")
    const original = await Bun.file(path.join(target, "archive/objects", bound.resultHash)).text()
    const instance = JSON.parse(original) as Awaited<ReturnType<typeof runInstance>>
    if (
      digest(original) !== bound.resultHash ||
      instance.mode !== result.mode ||
      JSON.stringify(instance.infrastructure) !== JSON.stringify(result.infrastructure) ||
      instance.evaluation !== "repair-lifecycle-v1" ||
      instance.feedbackGuidance !== result.feedbackGuidance ||
      instance.monitored.run.input.manifest.feedbackGuidance !== result.feedbackGuidance ||
      instance.monitored.run.input.manifest.feedbackProtocol !== "repair-lifecycle:1"
    )
      throw new Error("Lifecycle cohort result protocol changed")
    if (cohort) {
      const { hash, ...row } = rows[index]
      if (
        row.id !== expected[index] ||
        row.previous !== chain.hash ||
        hash !== digest(JSON.stringify(row)) ||
        row.evidence !== bound.resultHash ||
        instance.monitored.run.id !== "pct_eval_" + row.id
      )
        throw new Error("Lifecycle candidate is outside the fixed execution chain")
      chain.hash = hash
    }
    const sealed = (await Bun.file(path.join(target, "blind/sealed.json")).json()) as ReturnType<typeof adjudicate> & {
      hash: string
    }
    const checked = adjudicate(sealed.first, sealed.second, sealed.resolution)
    const rubricBytes = await Bun.file(path.join(target, "blind/objects", bound.rubricHash)).text()
    const candidateBytes = await Bun.file(path.join(target, "blind/objects", bound.candidateHash)).text()
    if (
      digest(rubricBytes) !== bound.rubricHash ||
      digest(candidateBytes) !== bound.candidateHash ||
      digest(JSON.stringify(checked)) !== sealed.hash ||
      sealed.first.candidateHash !== bound.candidateHash ||
      sealed.first.rubricHash !== bound.rubricHash ||
      JSON.stringify(Object.keys(checked.items).sort()) !==
        JSON.stringify(Object.keys(JSON.parse(rubricBytes)).sort()) ||
      (!sealed.resolution &&
        Object.keys(checked.items).some((key) => sealed.first.items[key] !== sealed.second.items[key]))
    )
      throw new Error("Lifecycle reveal requires complete independent candidate seals and adjudication")
  }
}
