import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test("selects an exact evidenced candidate and freezes the result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-contract-selection-"))
  using server = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== `Basic ${btoa("opencode:secret")}`)
        return new Response("unauthorized", { status: 401 })
      const id = new URL(request.url).pathname.split("/").at(-1)
      if (id !== "pct_a" && id !== "pct_b") return new Response("not found", { status: 404 })
      return Response.json({
        data: {
          id,
          revision: 1,
          status: "discharged",
          attestationID: id === "pct_a" ? "pca_a" : "pca_b",
          handoff: {
            subjectHash: id === "pct_a" ? "subject-a" : "subject-b",
            replay: { passed: true },
          },
        },
      })
    },
  })

  try {
    const output = path.join(dir, "selection.json")
    const a = path.join(dir, "a.json")
    const b = path.join(dir, "b.json")
    const reports = {
      a: {
        contractID: "pct_a",
        revision: 1,
        subjectHash: "subject-a",
        score: 0.8,
        timeouts: 0,
        admissible: true,
        incumbent: true,
      },
      b: {
        contractID: "pct_b",
        revision: 1,
        subjectHash: "subject-b",
        score: 0.9,
        timeouts: 1,
        admissible: true,
        incumbent: false,
      },
    }
    await Promise.all([Bun.write(a, JSON.stringify(reports.a)), Bun.write(b, JSON.stringify(reports.b))])

    const run = (target = output) =>
      Bun.spawn(["bun", "run", "script/select-contract-artifact.ts", target, b, a], {
        cwd: path.join(import.meta.dir, "../.."),
        env: {
          ...Bun.env,
          PRO_CONTRACT_API: `http://127.0.0.1:${server.port}`,
          OPENCODE_SERVER_PASSWORD: "secret",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
    const selected = run()
    expect(await selected.exited).toBe(0)
    expect((await new Response(selected.stdout).text()).trim()).toBe("pct_b@1 subject-b")
    expect(await Bun.file(output).json()).toMatchObject({
      winner: { contractID: "pct_b", revision: 1, subjectHash: "subject-b" },
      candidates: [{ contractID: "pct_a" }, { contractID: "pct_b" }],
      policyPromotion: false,
      validationOpened: false,
      holdoutOpened: false,
    })

    const repeated = run()
    expect(await repeated.exited).toBe(0)

    await Bun.write(b, JSON.stringify({ ...reports.b, score: 0.7 }))
    const conflict = run()
    expect(await conflict.exited).toBe(1)
    expect(await Bun.file(output).json()).toMatchObject({ winner: { contractID: "pct_b" } })

    const retained = path.join(dir, "retained.json")
    const keep = run(retained)
    expect(await keep.exited).toBe(0)
    expect(await Bun.file(retained).json()).toMatchObject({ winner: { contractID: "pct_a" } })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
