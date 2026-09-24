import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { Schema } from "effect"
import { ResearchModel } from "../src/research/model"
import { ResearchProtocol } from "../src/research/protocol"
import { parse } from "../src/research/tap"

const manifest = Schema.decodeUnknownSync(ResearchModel.Manifest)({
  version: 1,
  requirements: ["real explicit case"],
  include: ["acceptance.cjs", "protected.txt"],
  dependencies: [],
  verification: {
    adapter: "node-test-tap:1",
    executable: "/usr/bin/node",
    executableHash: "a".repeat(64),
    tests: ["acceptance.cjs"],
    harness: [{ path: "acceptance.cjs", hash: "b".repeat(64) }],
    expectedTests: ["explicit case"],
    minimumTests: 1,
    maximumSkipped: 0,
    timeout: 5000,
  },
  artifacts: [{ path: "result.txt", kind: "generated" }],
  reviewer: { model: { providerID: "test", id: "test" }, agent: "build", instructions: "Review" },
})

const run = async (source: string) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "research-plan-test-"))
  const host = await mkdtemp(path.join(os.tmpdir(), "research-plan-host-"))
  try {
    const runner = { path: path.join(host, "runner.mjs"), hash: "c".repeat(64) }
    await Bun.write(runner.path, ResearchProtocol.runnerSource)
    await Bun.write(path.join(directory, "acceptance.cjs"), source)
    await Bun.write(path.join(directory, "protected.txt"), "original")
    const child = Bun.spawn([...ResearchProtocol.policy(manifest, runner).checks[0].argv], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return {
      exit,
      stderr,
      stdout,
      result: parse(stdout, manifest.verification),
      protected: await Bun.file(path.join(directory, "protected.txt")).text(),
      output: await Bun.file(path.join(directory, "result.txt")).exists(),
    }
  } finally {
    await Promise.all([rm(directory, { recursive: true, force: true }), rm(host, { recursive: true, force: true })])
  }
}

describe("Planned research restricted Node protocol", () => {
  test("runs actual tests and writes only declared outputs", async () => {
    const result = await run(
      'require("node:test")("explicit case",()=>{require("node:fs").writeFileSync("result.txt","evidence")})',
    )
    expect(result.exit).toBe(0)
    expect(result.result.verdict).toBe("passed")
    expect(result.output).toBe(true)
  })
  test("blocks write-restore and subprocess escape during the actual experiment", async () => {
    const result = await run(
      'const assert=require("node:assert/strict");require("node:test")("explicit case",()=>{assert.throws(()=>{require("node:fs").writeFileSync("protected.txt","mutated");require("node:fs").writeFileSync("protected.txt","original")},{code:"ERR_ACCESS_DENIED"});assert.throws(()=>require("node:child_process").execSync("true"),{code:"ERR_ACCESS_DENIED"})})',
    )
    expect(result.exit).toBe(0)
    expect(result.result.verdict).toBe("passed")
    expect(result.protected).toBe("original")
  })
  test("does not recognize fake TAP followed by premature exit as real test execution", async () => {
    const text =
      "TAP version 13\nok 1 - explicit case\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"
    const result = await run(
      `require("node:fs").writeSync(1,${JSON.stringify(text)});process.exit(0);require("node:test")("explicit case",()=>{throw Error("must fail")})`,
    )
    expect(result.exit).toBe(0)
    expect(result.result.verdict).toBe("failed")
    expect(result.stdout).toContain("# ok 1 - explicit case")
  })
  test("cannot gain protected write permission with symlinks or hardlinks through an output", async () => {
    const result = await run(
      'const assert=require("node:assert/strict"),fs=require("node:fs");require("node:test")("explicit case",()=>{assert.throws(()=>fs.symlinkSync("protected.txt","result.txt"),{code:"ERR_ACCESS_DENIED"});assert.throws(()=>fs.linkSync("protected.txt","result.txt"),{code:"ERR_ACCESS_DENIED"})})',
    )
    expect(result.result.verdict).toBe("passed")
    expect(result.protected).toBe("original")
    expect(result.output).toBe(false)
  })
})
