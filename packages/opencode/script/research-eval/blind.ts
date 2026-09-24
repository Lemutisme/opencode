import { mkdir, open } from "node:fs/promises"
import path from "node:path"
import { adjudicate, type Annotation } from "./score"
import { digest } from "./ledger"
import { put } from "./archive"

export async function prepare(
  directory: string,
  input: {
    agreement: string
    files: Record<string, string>
    rawEvidence: Record<string, string>
    rubric: Record<string, string>
  },
) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const candidate = { agreement: input.agreement, files: input.files, rawEvidence: input.rawEvidence }
  const candidateHash = await put(directory, candidate)
  const rubricHash = await put(directory, input.rubric)
  const handle = await open(path.join(directory, "blind.json"), "wx", 0o600)
  await handle.writeFile(JSON.stringify({ candidateHash, rubricHash }) + "\n")
  await handle.sync()
  await handle.close()
  return { candidateHash, rubricHash }
}

export async function seal(directory: string, first: Annotation, second: Annotation, resolution?: Annotation) {
  const bound = (await Bun.file(path.join(directory, "blind.json")).json()) as {
    candidateHash: string
    rubricHash: string
  }
  if (first.candidateHash !== bound.candidateHash || first.rubricHash !== bound.rubricHash)
    throw new Error("Annotation does not match the blinded materials")
  const rubric = (await Bun.file(path.join(directory, "objects", bound.rubricHash)).json()) as Record<string, string>
  if (JSON.stringify(Object.keys(rubric).sort()) !== JSON.stringify(Object.keys(first.items).sort()))
    throw new Error("Every frozen rubric item must be annotated")
  const result = adjudicate(first, second, resolution)
  const handle = await open(path.join(directory, "sealed.json"), "wx", 0o600)
  await handle.writeFile(JSON.stringify({ ...result, hash: digest(JSON.stringify(result)) }) + "\n")
  await handle.sync()
  await handle.close()
  return result
}

export async function unseal(directory: string, rawReviewer: string) {
  const sealed = (await Bun.file(path.join(directory, "sealed.json")).json()) as ReturnType<typeof adjudicate> & {
    hash: string
  }
  const result = adjudicate(sealed.first, sealed.second, sealed.resolution)
  if (digest(JSON.stringify(result)) !== sealed.hash) throw new Error("Phase-one scoring changed")
  return { phaseOne: result, reviewerHash: await put(directory, rawReviewer), rawReviewer }
}
