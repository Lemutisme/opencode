import { expect, test } from "bun:test"
import { oomCommand } from "../src/process-priority"

test("leaves disabled and non-Linux execution unchanged", () => {
  expect(oomCommand("echo ok", false, "linux")).toBe("echo ok")
  expect(oomCommand("echo ok", true, "darwin")).toBe("echo ok")
})

test.skipIf(process.platform !== "linux")(
  "sets the actual child and descendant priority without modifying the parent",
  async () => {
    const before = await Bun.file("/proc/self/oom_score_adj").text()
    const child = Bun.spawn(
      ["/bin/sh", "-c", oomCommand("cat /proc/self/oom_score_adj; sh -c 'cat /proc/self/oom_score_adj'", true)],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe("1000\n1000\n")
    expect(await Bun.file("/proc/self/oom_score_adj").text()).toBe(before)
  },
)
