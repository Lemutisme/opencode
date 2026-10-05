import { afterAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { limits, materializeTask, order, runOracle, tasks, type FeedbackTask } from "./pro-contract-feedback-tasks"

const root = await mkdtemp(path.join(tmpdir(), "pro-contract-feedback-"))

afterAll(() => rm(root, { recursive: true, force: true }))

describe("ProContract feedback screen tasks", () => {
  test("freezes two tasks, four paired blocks, and equal shared limits", () => {
    expect(tasks.map((task) => task.id)).toEqual(["ready-control", "repair-portability"])
    expect(limits).toEqual({ maxTurns: 24, maxActions: 96, deadlineMs: 240_000, maxAttempts: 3 })
    expect(order).toEqual([
      { taskID: "ready-control", replicate: 1, arms: ["baseline", "current"] },
      { taskID: "repair-portability", replicate: 1, arms: ["current", "baseline"] },
      { taskID: "repair-portability", replicate: 2, arms: ["baseline", "current"] },
      { taskID: "ready-control", replicate: 2, arms: ["current", "baseline"] },
    ])
    expect(order.flatMap((block) => block.arms)).toHaveLength(8)
    expect(tasks.every((task) => !task.brief.includes("contract_check"))).toBe(true)
  })

  test("materializes byte-identical initial workspaces for both arms", async () => {
    for (const task of tasks) {
      const baseline = await directory(`${task.id}-baseline`)
      const current = await directory(`${task.id}-current`)
      await Promise.all([materializeTask(task, baseline), materializeTask(task, current)])

      for (const file of task.files) {
        expect(await Bun.file(path.join(baseline, file.path)).arrayBuffer()).toEqual(
          await Bun.file(path.join(current, file.path)).arrayBuffer(),
        )
        expect((await stat(path.join(baseline, file.path))).mode & 0o111).toBe(file.executable ? 0o111 : 0)
      }
      const workspaceText = task.files.map((file) => file.content).join("\n")
      task.oracle.forEach((item) => {
        expect(workspaceText).not.toContain(item.stdin)
        if (item.stdout) expect(workspaceText).not.toContain(item.stdout)
      })
    }
  })

  test("ready-control passes replay and the independent oracle without edits", async () => {
    const task = requireTask("ready-control")
    const workspace = await directory("ready-control-pass")
    await materializeTask(task, workspace)

    expect(await runReplay(task, workspace)).toMatchObject({ passed: true })
    expect(await runOracle(task, workspace)).toMatchObject({ passed: true })
  })

  test("repair-portability exposes both bounded defects in one failed replay", async () => {
    const task = requireTask("repair-portability")
    const workspace = await directory("repair-portability-fail")
    await materializeTask(task, workspace)

    const replay = await runReplay(task, workspace)
    expect(replay.passed).toBe(false)
    expect(replay.stderr).toContain("portability:")
    expect(replay.stderr).toContain("semantics:")
  })

  test("the small repair satisfies replay and an oracle that ignores validate.py", async () => {
    const task = requireTask("repair-portability")
    const workspace = await directory("repair-portability-pass")
    await materializeTask(task, workspace)
    const source = await Bun.file(path.join(workspace, "wordfreq.py")).text()
    await Bun.write(
      path.join(workspace, "wordfreq.py"),
      source
        .replace('set(Path(".cache/stopwords.txt").read_text(encoding="utf-8").splitlines())', '{"a", "an", "the"}')
        .replace("ranked[: max(args.top - 1, 0)]", "ranked[: args.top]"),
    )
    await chmod(path.join(workspace, "wordfreq.py"), 0o755)

    expect(await runReplay(task, workspace)).toMatchObject({ passed: true })
    await Bun.write(path.join(workspace, "validate.py"), "raise SystemExit(91)\n")
    await rm(path.join(workspace, ".cache"), { recursive: true, force: true })
    expect(await runOracle(task, workspace)).toMatchObject({ passed: true })
  })

  test("protected paths bind the supplied compile, validator, and ignore files", () => {
    for (const task of tasks) {
      expect(task.replay.protectedFiles).toEqual(["compile.sh", "validate.py", ".gitignore"])
      task.replay.protectedFiles.forEach((protectedFile) =>
        expect(task.files.some((file) => file.path === protectedFile)).toBe(true),
      )
      expect(task.files.find((file) => file.path === ".gitignore")?.content).toContain(".cache/")
    }
  })
})

async function directory(name: string) {
  const target = path.join(root, name)
  await rm(target, { recursive: true, force: true })
  return target
}

function requireTask(id: FeedbackTask["id"]) {
  const task = tasks.find((item) => item.id === id)
  if (!task) throw new Error(`Missing task ${id}`)
  return task
}

async function runReplay(task: FeedbackTask, workspace: string) {
  const results = await task.replay.checks.reduce(
    async (pending, check) => {
      const completed = await pending
      const process = Bun.spawn([...check.argv], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
      const result = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      return [...completed, { passed: result[2] === check.exit, stdout: result[0], stderr: result[1] }]
    },
    Promise.resolve([] as Array<{ passed: boolean; stdout: string; stderr: string }>),
  )
  return {
    passed: results.every((result) => result.passed),
    stdout: results.map((result) => result.stdout).join(""),
    stderr: results.map((result) => result.stderr).join(""),
  }
}
