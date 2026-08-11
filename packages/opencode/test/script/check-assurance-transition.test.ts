import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(tmpdir(), "opencode-assurance-transition-"))
const refs = Object.fromEntries(
  ["h0", "h1", "j0", "j1", "eval", "bridge"].map((id) => [
    id,
    { contractID: `pct_${id}`, revision: 1, attestationID: `pca_${id}`, subjectHash: `subject-${id}` },
  ]),
) as Record<string, { contractID: string; revision: number; attestationID: string; subjectHash: string }>
const requirements = {
  eval: [refs.h1, refs.j0],
  bridge: [refs.j0, refs.j1],
}
let sequence = 0
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== `Basic ${btoa("opencode:secret")}`)
        return new Response("unauthorized", { status: 401 })
      const id = new URL(request.url).pathname.split("/").at(-1)?.replace("pct_", "") ?? ""
      const ref = refs[id]
      if (!ref) return new Response("not found", { status: 404 })
      return Response.json({
        data: {
          id: ref.contractID,
          revision: ref.revision,
          status: "discharged",
          attestationID: ref.attestationID,
          handoff: { subjectHash: ref.subjectHash },
          spec: {
            requires: (requirements[id as keyof typeof requirements] ?? []).map((item) => ({
              contractID: item.contractID,
              revision: item.revision,
            })),
          },
        },
      })
    },
  })
})

afterAll(() => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

test("accepts an executor transition and freezes the next frontier", async () => {
  const input = transition()
  const result = await run(input)

  expect(result.code).toBe(0)
  expect(result.report).toMatchObject({
    decision: "accept",
    reasons: [],
    provenance: ["world-model-hash"],
    generation: 1,
    lineageHash: expect.any(String),
    executor: refs.h1,
    judge: refs.j0,
  })
  expect(result.report.risk.used).toBeCloseTo(0.005)

  const repeated = await run(input, result.output)
  expect(repeated.code).toBe(0)
  expect(repeated.stdout).toBe(result.stdout)
})

test("uses an accepted report as the base of a predecessor-grounded judge bridge", async () => {
  const first = await run(transition())
  const result = await run(fromFrontier(first.stdout, { judge: refs.j1, bridge: refs.bridge }))

  expect(result.code).toBe(0)
  expect(result.report).toMatchObject({ judge: refs.j1, generation: 2 })
  expect(result.report.lineageHash).not.toBe(first.report.lineageHash)
})

test("rejects self-grounding, missing bridges, stale support, and excess risk", async () => {
  const cases = [
    { input: transition({ evidence: [refs.h1] }), reason: "cannot certify itself" },
    { input: transition({ evidence: [refs.h0] }), reason: "lacks predecessor-grounded requirement" },
    { input: transition({ judge: refs.j1 }), reason: "requires a bridge" },
    { input: transition({ judge: refs.j1, bridge: refs.eval }), reason: "bridge pct_eval lacks requirement pct_j1" },
    {
      input: transition({ executor: { ...refs.h1, attestationID: "pca_stale" } }),
      reason: "stale or unsupported",
    },
    { input: transition({ riskIncrement: 0.1 }), reason: "cumulative risk limit" },
  ]

  for (const item of cases) {
    const result = await run(item.input)
    expect(result.code).toBe(1)
    expect(result.report.reasons.join("\n")).toContain(item.reason)
  }
})

function frontier() {
  return {
    version: 1,
    decision: "accept",
    generation: 0,
    lineageHash: "root-lineage",
    executor: refs.h0,
    judge: refs.j0,
    risk: { used: 0, limit: 0.05 },
  }
}

function transition(change: Record<string, unknown> = {}) {
  const value = frontier()
  const source = `${JSON.stringify(value, null, 2)}\n`
  return fromFrontier(source, { executor: refs.h1, ...change })
}

function fromFrontier(source: string, change: Record<string, unknown> = {}) {
  const current = JSON.parse(source)
  const value = {
    version: current.version,
    decision: current.decision,
    generation: current.generation,
    lineageHash: current.lineageHash,
    executor: current.executor,
    judge: current.judge,
    risk: current.risk,
  }
  return {
    frontier: source,
    transition: {
      version: 1,
      previousHash: new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex"),
      executor: value.executor,
      judge: value.judge,
      evidence: [refs.eval],
      riskIncrement: 0.005,
      provenance: ["world-model-hash"],
      ...change,
    },
  }
}

async function run(input: ReturnType<typeof transition>, output?: string) {
  const id = sequence++
  const frontierFile = path.join(root, `${id}-frontier.json`)
  const transitionFile = path.join(root, `${id}-transition.json`)
  const reportFile = output ?? path.join(root, `${id}-report.json`)
  await Promise.all([
    Bun.write(frontierFile, input.frontier),
    Bun.write(transitionFile, JSON.stringify(input.transition)),
  ])
  const proc = Bun.spawn(
    ["bun", "run", "script/check-assurance-transition.ts", frontierFile, transitionFile, reportFile],
    {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        PRO_CONTRACT_API: server.url.origin,
        OPENCODE_SERVER_PASSWORD: "secret",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(stderr).toBe("")
  return { code, stdout, output: reportFile, report: JSON.parse(stdout) }
}
