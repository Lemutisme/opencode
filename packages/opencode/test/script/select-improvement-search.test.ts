import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(tmpdir(), "opencode-improvement-search-"))
const script = path.join(import.meta.dir, "../../script/select-improvement-search.ts")
const base = [
  proposed("m1", [], "incumbent"),
  proposed("m1", [], "incumbent"),
  evaluated("m1", "seed", 0.1, 0, 10, true),
  evaluated("m1", "seed", 0.1, 0, 10, true),
  { type: "promoted", node: "m1", assurance: "a1" },
  proposed("m2", ["m1"], "admission-only"),
  evaluated("m2", "seed", -0.05, 0.05, 12, false),
  { type: "rejected", node: "m2", falsifier: "lost-invariant" },
  proposed("m3a", ["m1"], "invariant-impact"),
  proposed("m3b", ["m1"], "local-repair"),
  proposed("m3merge", ["m2", "m3a"], "admission-plus-invariant"),
]

afterAll(() => rmSync(root, { recursive: true, force: true }))

test("keeps one incumbent while selecting unvisited graph branches", async () => {
  const linear = await run(base, "linear")
  expect(linear.code).toBe(0)
  expect(linear.report).toMatchObject({
    policy: "linear",
    incumbent: "m1",
    graph: { nodes: 5, edges: 5, evaluations: 2 },
  })
  expect(linear.report.selected.map((item: { node: string }) => item.node)).toEqual(["m1"])

  const ucb = await run(base, "ucb", 2)
  expect(ucb.code).toBe(0)
  expect(ucb.report.selected.map((item: { node: string }) => item.node)).toEqual(["m3a", "m3b"])
  expect(ucb.report.selected.every((item: { reason: string }) => item.reason === "unvisited")).toBeTrue()
})

test("uses deterministic UCB selection and retains rejected repair branches", async () => {
  const evaluatedGraph = [
    ...base,
    evaluated("m3a", "fresh", 0.3, 0, 20, true),
    evaluated("m3b", "fresh", 0.1, 0, 5, true),
    evaluated("m3merge", "fresh", 0.2, 0, 8, true),
  ]
  const result = await run(evaluatedGraph, "ucb", 5, 0)

  expect(result.code).toBe(0)
  expect(result.report.selected.map((item: { node: string }) => item.node)).toEqual([
    "m3a",
    "m3merge",
    "m3b",
    "m1",
    "m2",
  ])
  expect(result.report.selected.at(-1)).toMatchObject({
    node: "m2",
    invalid: 1,
    rejections: ["lost-invariant"],
  })

  const closed = await run([...evaluatedGraph, { type: "closed", node: "m3a", reason: "exhausted" }], "ucb", 1, 0)
  expect(closed.report.selected[0].node).toBe("m3merge")
})

test("rejects conflicting retries and forward parent references", async () => {
  const conflict = await run([...base, evaluated("m1", "seed", 0.2, 0, 10, true)], "ucb")
  expect(conflict.code).toBe(1)
  expect(conflict.stderr).toContain("conflicting evaluation")

  const forward = await run([proposed("child", ["missing"], "invalid")], "ucb")
  expect(forward.code).toBe(1)
  expect(forward.stderr).toContain("unknown parent")
})

function proposed(node: string, parents: string[], mutation: string) {
  return { type: "proposed", node, parents, mutation }
}

function evaluated(node: string, campaign: string, capability: number, regression: number, cost: number, valid: boolean) {
  return { type: "evaluated", node, campaign, capability, regression, cost, valid }
}

async function run(events: object[], policy: "linear" | "ucb", limit = 3, exploration = Math.SQRT2) {
  const file = path.join(root, `${crypto.randomUUID()}.jsonl`)
  await Bun.write(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`)
  const process = Bun.spawn(["bun", "run", script, file, policy, `${limit}`, `${exploration}`], {
    cwd: path.join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { code, stderr, report: stdout ? JSON.parse(stdout) : undefined }
}
