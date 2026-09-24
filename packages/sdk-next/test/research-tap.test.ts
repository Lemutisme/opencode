import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "../src/research/tap"
import { RelativePath } from "@opencode-ai/core/schema"

const protocol = {
  tests: [RelativePath.make("acceptance.cjs")],
  expectedTests: ["explicit case"],
  minimumTests: 1,
  maximumSkipped: 0,
} as const
const run = async (source: string) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "research-tap-"))
  try {
    await Bun.write(path.join(directory, "acceptance.cjs"), source)
    const child = Bun.spawn(
      ["/usr/bin/node", "--test", "--test-reporter=tap", "--test-concurrency=1", "acceptance.cjs"],
      { cwd: directory, stdout: "pipe", stderr: "pipe" },
    )
    const [text, exit] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { text, exit, result: parse(text, protocol) }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("Approved Node TAP evidence", () => {
  test("accepts actual explicit Node events", async () => {
    const output = await run('require("node:test")("explicit case",()=>{});')
    expect(output.exit).toBe(0)
    expect(output.result.verdict).toBe("passed")
    expect(output.result.tests).toHaveLength(1)
  })
  test("rejects exit-zero empty file wrappers and conditional absent cases", async () => {
    for (const source of [
      "",
      'if(false) require("node:test")("explicit case",()=>{});',
      'require("node:test")("substituted",()=>{});',
    ]) {
      const output = await run(source)
      expect(output.exit).toBe(0)
      expect(output.result.verdict).toBe("failed")
    }
  })
  test("rejects skipped, TODO and failed explicit cases", async () => {
    for (const source of [
      'require("node:test").skip("explicit case",()=>{});',
      'require("node:test").todo("explicit case",()=>{});',
      'require("node:test")("explicit case",()=>{throw Error("failure")});',
    ]) {
      expect((await run(source)).result.verdict).toBe("failed")
    }
  })
  test("rejects truncation, duplicate identities, contradictory counts, nested output and bailout", async () => {
    const output = (await run('require("node:test")("explicit case",()=>{});')).text
    for (const malformed of [
      output.slice(0, output.indexOf("1..1")),
      output.replace("ok 1", "ok 2"),
      output.replace("# tests 1", "# tests 2"),
      `${output}\n1..1`,
      output.replace("ok 1", "    ok 1"),
      output.replace("# pass 1", "# pass 0"),
    ])
      expect(parse(malformed, protocol).verdict).toBe("unavailable")
    expect(parse(`${output}\nBail out!`, protocol).verdict).toBe("failed")
  })
})
