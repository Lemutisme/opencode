import { expect, test } from "bun:test"
import path from "node:path"
import { check, freezeDeployment, launch } from "./launch"
import { digest } from "./ledger"
import { qualification } from "./qualification"

test("launch rejects missing configuration before creating a cohort or contacting providers", async () => {
  const output = "/tmp/s6c-must-not-exist-" + crypto.randomUUID()
  await expect(
    launch({ version: 1, worker: null, reviewer: null }, output, new AbortController().signal),
  ).rejects.toThrow()
  expect(await Bun.file(path.join(output, "cohort.json")).exists()).toBe(false)
})

test("complete deployment freeze binds actual source and objects; credentials stay unresolved", async () => {
  const directory = "/tmp/opencode-s6c-launch-check-" + crypto.randomUUID()
  const model = {
    endpoint: "https://fixture.invalid/v1/chat/completions",
    model: "offline-freeze-fixture",
    variant: "default",
    parameters: { temperature: 0 },
    seed: "unsupported",
    context: 100_000,
    output: 4000,
    credentialEnv: "S6C_MISSING_FIXTURE_CREDENTIAL",
  }
  const deployment = await freezeDeployment(
    {
      version: 1,
      mode: "development-calibration",
      worker: model,
      reviewer: model,
      bun: process.execPath,
      node: "/usr/bin/node",
      timeouts: { provider: 900_000, tool: 600_000, verification: 10000, cleanup: 30000 },
    },
    directory,
  )
  const checked = await check(deployment)
  expect(checked.examples).toHaveLength(3)
  expect(checked.credentialSources.every((item) => !item.configured)).toBe(true)
  await expect(launch(deployment, directory + "/cohort", new AbortController().signal)).rejects.toThrow("credential")
  expect(await Bun.file(directory + "/cohort/cohort.json").exists()).toBe(false)
  const frozen = await Bun.file(deployment.frozen).json()
  const manifest = await Bun.file(deployment.snapshot + "/manifest.json").json()
  const subset = JSON.stringify({ "bun.lock": manifest["bun.lock"] })
  await Bun.write(deployment.snapshot + "/manifest.json", subset)
  await Bun.write(deployment.frozen, JSON.stringify({ ...frozen, sourceSnapshot: digest(subset) }))
  await expect(check(deployment)).rejects.toThrow("complete tracked and untracked")
  await Bun.write(deployment.snapshot + "/manifest.json", JSON.stringify(manifest, null, 2) + "\n")
  const arbitrary = "{}"
  const hash = digest(arbitrary)
  await Bun.write(deployment.objects + "/" + hash, arbitrary)
  await Bun.write(deployment.frozen, JSON.stringify({ ...frozen, scorer: hash }))
  await expect(check(deployment)).rejects.toThrow("actual scorer")
  console.log("S6c offline freeze rejection evidence:", directory)
}, 90_000)

test("explicit v2 freeze binds scenarios, rejects qualification and preserves a cancelled three-row denominator", async () => {
  const directory = "/tmp/opencode-v2-freeze-" + crypto.randomUUID()
  const model = {
    endpoint: "http://127.0.0.1:8317/v1/responses",
    model: "offline-v2-fixture",
    variant: "low",
    parameters: { reasoning_effort: "low" },
    seed: "unsupported",
    context: 100_000,
    output: 4000,
    credentialEnv: null,
  }
  const setup = {
    version: 1,
    evaluation: "feedback-v2",
    mode: "development-calibration",
    worker: model,
    reviewer: model,
    bun: process.execPath,
    node: "/usr/bin/node",
    timeouts: { provider: 900_000, tool: 600_000, verification: 10000, cleanup: 30000 },
  }
  await expect(freezeDeployment({ ...setup, mode: "qualification" }, directory + "-denied")).rejects.toThrow(
    "V2 qualification",
  )
  const deployment = await freezeDeployment(setup, directory)
  const checked = await check(deployment)
  expect(checked.frozen.evaluation).toBe("feedback-v2")
  expect(checked.frozen.scenarios).toMatch(/^[a-f0-9]{64}$/)
  expect(checked.examples.every((item) => item.packet.version === "feedback-development:1")).toBe(true)
  await expect(check({ ...deployment, evaluation: undefined })).rejects.toThrow("policy differs")
  const controller = new AbortController()
  controller.abort()
  const result = await launch(deployment, directory + "/cancelled", controller.signal)
  expect(result.denominator).toBe(3)
  expect(result.qualification).toBe("not_run")
  expect(result.rows.every((row) => row.status === "not_started")).toBe(true)
  const report = await qualification(directory + "/cancelled", directory + "/report")
  expect(report.qualification).toBe("not_run")
  expect("evaluation" in report).toBe(true)
  const hash = digest("{}")
  await Bun.write(deployment.objects + "/" + hash, "{}")
  await Bun.write(deployment.frozen, JSON.stringify({ ...checked.frozen, scenarios: hash }))
  await expect(check(deployment)).rejects.toThrow("scenario measurement")
  console.log("V2 offline freeze evidence:", directory)
}, 120_000)

test("explicit local gateway freeze needs no credential and retains the three calibration rows", async () => {
  const directory = "/tmp/opencode-s6c-local-freeze-" + crypto.randomUUID()
  const model = {
    endpoint: "http://127.0.0.1:8317/v1/responses",
    model: "offline-local-fixture",
    variant: "low",
    parameters: { reasoning_effort: "low" },
    seed: "unsupported",
    context: 100_000,
    output: 4000,
    credentialEnv: null,
  }
  const deployment = await freezeDeployment(
    {
      version: 1,
      mode: "development-calibration",
      worker: model,
      reviewer: model,
      bun: process.execPath,
      node: "/usr/bin/node",
      timeouts: { provider: 900_000, tool: 600_000, verification: 10000, cleanup: 30000 },
    },
    directory,
  )
  const checked = await check(deployment)
  expect(checked.credentialSources).toEqual([
    { role: "worker", kind: "local-no-auth", configured: true },
    { role: "reviewer", kind: "local-no-auth", configured: true },
  ])
  const controller = new AbortController()
  controller.abort()
  const result = await launch(deployment, directory + "/cancelled-cohort", controller.signal)
  expect(result.denominator).toBe(3)
  expect(result.rows.every((row) => row.status === "not_started")).toBe(true)
}, 90_000)

test("explicit lifecycle freeze binds scenarios, rejects qualification and preserves a cancelled three-row denominator", async () => {
  const directory = "/tmp/opencode-lifecycle-freeze-" + crypto.randomUUID()
  const model = {
    endpoint: "http://127.0.0.1:8317/v1/responses",
    model: "offline-v2-fixture",
    variant: "low",
    parameters: { reasoning_effort: "low" },
    seed: "unsupported",
    context: 100_000,
    output: 4000,
    credentialEnv: null,
  }
  const setup = {
    version: 1,
    evaluation: "repair-lifecycle-v1",
    mode: "development-calibration",
    worker: model,
    reviewer: model,
    bun: process.execPath,
    node: "/usr/bin/node",
    timeouts: { provider: 900_000, tool: 600_000, verification: 10000, cleanup: 30000 },
  }
  await expect(freezeDeployment({ ...setup, mode: "qualification" }, directory + "-denied")).rejects.toThrow(
    "V2 qualification",
  )
  const deployment = await freezeDeployment(setup, directory)
  const checked = await check(deployment)
  expect(checked.frozen.evaluation).toBe("repair-lifecycle-v1")
  expect(checked.frozen.scenarios).toMatch(/^[a-f0-9]{64}$/)
  expect(checked.examples.every((item) => item.packet.version === "repair-lifecycle-development:1")).toBe(true)
  await expect(check({ ...deployment, evaluation: undefined })).rejects.toThrow("policy differs")
  const controller = new AbortController()
  controller.abort()
  const result = await launch(deployment, directory + "/cancelled", controller.signal)
  expect(result.denominator).toBe(3)
  expect(result.qualification).toBe("not_run")
  expect(result.rows.every((row) => row.status === "not_started")).toBe(true)
  const report = await qualification(directory + "/cancelled", directory + "/report")
  expect(report.qualification).toBe("not_run")
  expect("evaluation" in report).toBe(true)
  const hash = digest("{}")
  await Bun.write(deployment.objects + "/" + hash, "{}")
  await Bun.write(deployment.frozen, JSON.stringify({ ...checked.frozen, scenarios: hash }))
  await expect(check(deployment)).rejects.toThrow("scenario measurement")
  console.log("Lifecycle offline freeze evidence:", directory)
}, 120_000)
