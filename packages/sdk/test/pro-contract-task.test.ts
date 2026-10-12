import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ProContractRSI } from "../src/pro-contract"
import { ProContractTask } from "../src/pro-contract/task"

const profile = {
  runtime: { directory: "/runtime", bun: "/tools/bun", python: "/usr/bin/python3", bwrap: "/usr/bin/bwrap" },
  model: { id: "scripted", effort: "max", upstream: "http://127.0.0.1:1/v1" },
  method: { instructions: "Retain exact public evidence and request independent acceptance." },
}

test("the fixed-task profile needs no research panel or proposal allowance", () => {
  expect(Schema.decodeUnknownSync(ProContractTask.Configuration)(profile, { onExcessProperty: "error" })).toEqual(
    profile,
  )
  expect(Object.keys(ProContractTask.Configuration.fields)).toEqual(["runtime", "model", "method", "reserveBytes"])
})

test("the evidence-led fixed method is explicit and has no research instruction", () => {
  expect(
    Schema.decodeUnknownSync(ProContractTask.Configuration)({ ...profile, method: ProContractTask.evidenceMethod }),
  ).toMatchObject({
    method: ProContractTask.evidenceMethod,
  })
  expect(ProContractTask.evidenceMethod.instructions).toContain("working frontier")
  expect(ProContractTask.evidenceMethod.instructions).toContain("A summary is an index")
  expect(ProContractTask.evidenceMethod.instructions).not.toContain("propose")
  expect(ProContractTask.evidenceMethod.instructions).not.toContain("R2")
})

test("research settings cannot be smuggled through a task-only profile", () => {
  expect(() =>
    Schema.decodeUnknownSync(ProContractTask.Configuration)(
      { ...profile, proposals: 1 },
      { onExcessProperty: "error" },
    ),
  ).toThrow()
  expect(() => ProContractTask.open("/not-created", Object.assign({}, profile, { tests: [] }))).toThrow()
})

test("missing performance panels cannot silently downgrade a research admission", async () => {
  await expect(
    ProContractRSI.open("/not-created", {
      runtime: profile.runtime,
      model: profile.model,
      seed: profile.method,
      tests: [],
    }),
  ).rejects.toThrow("Without performance panels")
  await expect(
    ProContractRSI.open("/not-created", {
      runtime: profile.runtime,
      model: profile.model,
      seed: profile.method,
      proposals: 1,
      tests: [],
    }),
  ).rejects.toThrow("Without performance panels")
})
