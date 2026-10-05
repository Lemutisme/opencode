import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { ProContract } from "../src/pro-contract"
import type { Observation } from "./pro-contract-adversarial-worker"
import { tmpdir } from "./fixture/tmpdir"

async function fixture() {
  const temporary = await tmpdir()
  const project = path.join(temporary.path, "project")
  await mkdir(project)
  await Bun.write(path.join(project, "strategy.json"), "{}")
  await $`git init`.cwd(project).quiet()
  await $`git config core.fsmonitor false`.cwd(project).quiet()
  await $`git config commit.gpgsign false`.cwd(project).quiet()
  await $`git config user.email test@opencode.test`.cwd(project).quiet()
  await $`git config user.name Test`.cwd(project).quiet()
  await $`git add .`.cwd(project).quiet()
  await $`git commit -m initial`.cwd(project).quiet()
  return temporary
}

async function run(directory: string, stage: string, contractID?: ProContract.ID, opening?: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "pro-contract-adversarial-worker.ts"),
      stage,
      directory,
      ...(contractID || opening ? [contractID ?? ""] : []),
      ...(opening ? [opening] : []),
    ],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(directory, "xdg-data"),
        XDG_CONFIG_HOME: path.join(directory, "xdg-config"),
        XDG_CACHE_HOME: path.join(directory, "xdg-cache"),
        OPENCODE_DISABLE_MODELS_FETCH: "true",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ stage, code, stderr }).toEqual({ stage, code: 0, stderr: "" })
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as Observation & {
    pid: number
    proposals?: ProContract.ID[]
    accepted?: boolean
    error?: string
    contract?: ProContract.Contract
  }
}

describe("ProContract adversarial process persistence", () => {
  test("waits for a concurrent startup lock before reading the unchanged policy", async () => {
    await using temporary = await fixture()
    const seeded = await run(temporary.path, "race-seed")
    const { Database } = await import("bun:sqlite")
    using database = new Database(path.join(temporary.path, "policy.db"))
    // Switching from rollback journaling forces the first WAL pragma to take a lock.
    database.run("PRAGMA journal_mode = DELETE")
    database.run("BEGIN EXCLUSIVE")
    const opening = path.join(temporary.path, "opening")
    const observed = run(temporary.path, "observe", undefined, opening).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    const deadline = Date.now() + 10_000
    while (!(await Bun.file(opening).exists())) {
      if (Date.now() >= deadline) throw new Error("Database worker did not reach initialization")
      await Bun.sleep(10)
    }
    const waiting = await Promise.race([observed.then(() => false), Bun.sleep(200).then(() => true)])
    database.run("COMMIT")
    const completed = await observed
    if ("error" in completed) throw completed.error
    expect(waiting).toBe(true)
    expect(completed.result.state).toEqual(seeded.state)
    expect(completed.result.support).toEqual(seeded.support)
  }, 30_000)

  test("restart preserves policy evidence, explicit withdrawal, and historical full-pass protection", async () => {
    await using temporary = await fixture()
    const promoted = await run(temporary.path, "promote")
    const recovered = await run(temporary.path, "observe")
    expect(recovered.pid).not.toBe(promoted.pid)
    expect(recovered.state).toEqual(promoted.state)
    expect(recovered.support).toEqual(promoted.support)
    expect(recovered.quiet).toEqual(promoted.quiet)

    const withdrawn = await run(temporary.path, "withdraw")
    expect(withdrawn.state.revision).toBe(4)
    expect(withdrawn.state.selected).toBe(0)
    expect(withdrawn.state.retainedFull).toEqual(["development:task"])
    expect(withdrawn.support[2].contract?.status).toBe("escalated")
    expect(withdrawn.support[2].attestation).toBeUndefined()
    const retried = await run(temporary.path, "withdrawn-retry")
    expect(retried.state).toEqual(withdrawn.state)
    expect(retried.support).toEqual(withdrawn.support)

    const rejected = await run(temporary.path, "retained-full")
    expect(rejected.state.revision).toBe(5)
    expect(rejected.state.selected).toBe(0)
    expect(rejected.state.history).toEqual(withdrawn.state.history)
    expect(rejected.state.evaluations).toHaveLength(2)
    const final = await run(temporary.path, "observe")
    expect(final.state).toEqual(rejected.state)
    expect(final.support).toEqual(rejected.support)
    expect(final.quiet).toEqual(rejected.quiet)
  }, 120_000)

  test("independent processes cannot both select against one frozen baseline revision", async () => {
    await using temporary = await fixture()
    const seeded = await run(temporary.path, "race-seed")
    expect(seeded.proposals).toHaveLength(2)
    const results = await Promise.all([
      run(temporary.path, "race-first", seeded.proposals![0]),
      run(temporary.path, "race-second", seeded.proposals![1]),
    ])
    expect(results[0].pid).not.toBe(results[1].pid)
    expect(results.filter((result) => result.accepted)).toHaveLength(1)
    expect(results.filter((result) => !result.accepted)).toHaveLength(1)
    expect(results.find((result) => !result.accepted)?.error).toContain("baseline is no longer selected")
    expect(results.map((result) => result.contract?.status).toSorted()).toEqual(["discharged", "dormant"])
    const recovered = await run(temporary.path, "observe")
    expect(recovered.state.revision).toBe(2)
    expect(recovered.state.history).toHaveLength(3)
    expect(recovered.state.evaluations).toHaveLength(1)
    expect(results.find((result) => result.accepted)?.contract?.id).toBe(recovered.state.history[2].contractID)
  }, 120_000)
})
