import path from "path"
import type { ResearchModel } from "./model"
import { parsePython } from "./python"

/** This parser accepts the flat protocol of the pinned Node runner, never arbitrary shell success. */
export function parse(
  text: string,
  protocol: Pick<
    ResearchModel.Manifest["verification"],
    "tests" | "expectedTests" | "minimumTests" | "maximumSkipped"
  > &
    Partial<Pick<ResearchModel.Manifest["verification"], "adapter">>,
) {
  if (protocol.adapter === "python-script:1") return parsePython(text, protocol)
  const tests: { name: string; passed: boolean; skipped: boolean; todo: boolean }[] = []
  const plans: number[] = []
  const diagnostics = { open: false }
  const summary = new Map<string, number>()
  const unavailable = (reason: string) => ({ verdict: "unavailable" as const, reason, tests })
  const failed = (reason: string) => ({ verdict: "failed" as const, reason, tests })
  const lines = text.replaceAll("\r\n", "\n").split("\n")
  if (lines.shift() !== "TAP version 13") return unavailable("Expected a TAP 13 header")
  for (const line of lines) {
    if (diagnostics.open) {
      if (line === "  ...") diagnostics.open = false
      else if (line && !line.startsWith("  ")) return unavailable("Malformed TAP diagnostic")
      continue
    }
    if (line === "  ---") {
      if (!tests.length) return unavailable("Diagnostic without a test")
      diagnostics.open = true
      continue
    }
    if (!line.trim()) continue
    if (/^Bail out!/i.test(line)) return failed("Runner bailed out")
    if (/^\s+(?:ok|not ok|1\.\.)\b/.test(line)) return unavailable("Nested TAP is not supported by this profile")
    const count = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line)
    if (count) {
      if (summary.has(count[1])) return unavailable("Duplicate runner summary")
      summary.set(count[1], Number(count[2]))
      continue
    }
    if (line.startsWith("#")) continue
    const plan = /^1\.\.(\d+)(?:\s+#\s+SKIP\b.*)?$/i.exec(line)
    if (plan) {
      plans.push(Number(plan[1]))
      continue
    }
    const test = /^(ok|not ok) (\d+) - (.+?)(?:\s+#\s+(SKIP|TODO)\b.*)?$/i.exec(line)
    if (!test) return unavailable("Unrecognized TAP line")
    if (Number(test[2]) !== tests.length + 1) return unavailable("Missing or duplicate test number")
    if (tests.some((item) => item.name === test[3])) return unavailable("Duplicate test name")
    tests.push({
      name: test[3],
      passed: test[1] === "ok",
      skipped: test[4]?.toUpperCase() === "SKIP",
      todo: test[4]?.toUpperCase() === "TODO",
    })
  }
  if (diagnostics.open || plans.length !== 1 || plans[0] !== tests.length)
    return unavailable("Incomplete or inconsistent TAP plan")
  if (
    tests.some((test) =>
      protocol.tests.some(
        (file) => test.name === file || test.name === path.basename(file) || test.name.endsWith(`/${file}`),
      ),
    )
  )
    return failed("A file-level wrapper is not an explicit test case")
  if (
    tests.length !== protocol.expectedTests.length ||
    protocol.expectedTests.some((name) => !tests.some((test) => test.name === name))
  )
    return failed("Required explicit test cases were not executed")
  if (["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"].some((key) => !summary.has(key)))
    return unavailable("Node runner summary is missing")
  if (
    summary.get("tests") !== tests.length ||
    summary.get("suites") !== 0 ||
    summary.get("skipped") !== tests.filter((test) => test.skipped).length ||
    summary.get("todo") !== tests.filter((test) => test.todo).length
  )
    return unavailable("Runner summary contradicts explicit events")
  if (summary.get("cancelled") !== 0 || summary.get("fail") !== 0 || tests.some((test) => !test.passed || test.todo))
    return failed("One or more required tests failed, were cancelled or remain TODO")
  if (
    tests.filter((test) => test.skipped).length > protocol.maximumSkipped ||
    tests.filter((test) => !test.skipped && !test.todo).length < protocol.minimumTests
  )
    return failed("Insufficient executed tests or excessive skips")
  if (summary.get("pass") !== tests.filter((test) => test.passed && !test.skipped && !test.todo).length)
    return unavailable("Passing count contradicts explicit events")
  return { verdict: "passed" as const, reason: "The approved Node runner reported all required explicit cases", tests }
}
