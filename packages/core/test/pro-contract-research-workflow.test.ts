import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { ProContractTrajectory } from "../src/pro-contract/trajectory"
import { ProContractVersion } from "../src/pro-contract/version"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"

const source = path.resolve(import.meta.dir, "../script/trajectory-research")
const Reason = Schema.Struct({ type: Schema.Literal("reason"), id: Schema.String, prompt: Schema.String })

async function fixture(options?: { packetPath?: string; operationTimeoutMs?: number }) {
  const root = await tmpdir()
  const workspace = path.join(root.path, "workspace")
  await mkdir(workspace)
  const original = JSON.stringify({
    sessionID: "ses_workflow_fixture",
    sessionMessageCount: 2,
    messages: {
      data: [
        {
          id: "msg_fixture_user",
          type: "user",
          text: "Investigate an observed failure without assuming that more testing will fix it.",
          time: { created: 1 },
        },
        {
          id: "msg_fixture_assistant",
          type: "assistant",
          time: { created: 2 },
          content: [{ id: "part_fixture_text", type: "text", text: "I changed the implementation without a probe." }],
        },
      ],
    },
  })
  const packet = ProContractTrajectory.project({
    source: original,
    sourceID: "fixture-development",
    sourceHash: Hash.sha256(original),
  })
  await Bun.write(path.join(workspace, "packets", "fixture.json"), JSON.stringify(packet))
  const versions = ProContractVersion.make({ directory: path.join(root.path, "store") })
  const frozen = await versions.freeze({ directory: source, entrypoint: "workflow.ts" })
  return {
    versions,
    packet,
    request: {
      versionHash: frozen.versionHash,
      task: {
        contractID: "pct_seed_workflow_fixture",
        revision: 1,
        specHash: "fixture-spec",
        input: {
          question: "What observation distinguishes poor diagnosis from insufficient implementation?",
          packets: [
            {
              path: options?.packetPath ?? "packets/fixture.json",
              sourceID: packet.source.id,
              summary: "Two public records from a development trajectory, not confirmation evidence.",
            },
          ],
          operationTimeoutMs: options?.operationTimeoutMs ?? 1_000,
        },
      },
      workspace,
      view: { responses: [], unresolvedReasoning: [] },
      deadline: Date.now() + 30_000,
    },
    [Symbol.asyncDispose]: () => root[Symbol.asyncDispose](),
  }
}

function reason(record: ProContractVersion.Record) {
  expect(record.status).toBe("completed")
  expect(record.result?.checkpoint).toBe(".research")
  expect(record.result?.artifacts).toEqual([".research"])
  expect(record.result?.requests).toHaveLength(1)
  return Schema.decodeUnknownSync(Reason)(record.result!.requests[0])
}

async function respond(
  setup: Awaited<ReturnType<typeof fixture>>,
  previous: ProContractVersion.Record,
  summary: string,
) {
  return setup.versions.run({
    ...setup.request,
    checkpoint: previous.id,
    view: {
      responses: [{ id: reason(previous).id, status: "unverified", summary }],
      unresolvedReasoning: [],
    },
  })
}

async function retained(setup: Awaited<ReturnType<typeof fixture>>, run: ProContractVersion.Record, file: string) {
  return Bun.file(path.join(await setup.versions.artifactDirectory(run.id), ".research", file)).text()
}

describe.skipIf(process.platform !== "linux" || process.arch !== "x64" || !Bun.which("bwrap"))(
  "evolvable trajectory research workflow",
  () => {
    test("asks a bounded research question, inspects only selected public records, and keeps source references", async () => {
      await using setup = await fixture()
      const first = await setup.versions.run(setup.request)
      const initial = reason(first)
      expect(initial.prompt).toContain(setup.request.task.input.question)
      expect(initial.prompt).toContain(setup.packet.source.id)
      expect(first.result?.observations ?? []).not.toContainEqual({ status: "accepted" })

      const inspected = await respond(
        setup,
        first,
        JSON.stringify({
          type: "inspect",
          selections: [{ sourceID: setup.packet.source.id, recordIDs: [setup.packet.records[1].id] }],
          rationale: "Check whether the recorded change followed a distinguishing observation.",
        }),
      )
      const next = reason(inspected)
      expect(next.id).not.toBe(initial.id)
      expect(next.prompt).toContain("I changed the implementation without a probe.")
      expect(next.prompt).toContain(setup.packet.records[1].id)
      expect(next.prompt).toContain(setup.packet.source.hash)
      expect(await setup.versions.read(first.id)).toEqual(first)
      expect(await Bun.file(path.join(setup.request.workspace, ".research/state.json")).exists()).toBe(false)
    })

    test("malformed and unsupported actions become correction observations rather than successful reports", async () => {
      await using setup = await fixture()
      const first = await setup.versions.run(setup.request)
      const invalid = await respond(setup, first, "This is prose, not a JSON action.")
      const correction = reason(invalid)
      expect(correction.id).not.toBe(reason(first).id)
      expect(correction.prompt.toLowerCase()).toMatch(/invalid|parse|json|error/)
      const unsupported = await respond(
        setup,
        invalid,
        JSON.stringify({ type: "adopt", evidenceHash: "self-approved" }),
      )
      expect(reason(unsupported).prompt.toLowerCase()).toMatch(/invalid|unsupported|unknown|error/)
      expect(
        await Bun.file(
          path.join(await setup.versions.artifactDirectory(unsupported.id), ".research/report.json"),
        ).exists(),
      ).toBe(false)
      expect(await setup.versions.read(invalid.id)).toEqual(invalid)
    })

    test("unknown or missing native observations fail closed without replaying the pending request", async () => {
      await using setup = await fixture()
      const first = await setup.versions.run(setup.request)
      const pending = reason(first)
      const absent = await setup.versions.run({ ...setup.request, checkpoint: first.id })
      expect(absent.status).toBe("failed")
      expect(absent.result).toBeUndefined()
      expect(absent.stderr).toMatch(/pending|response|observation|replay/i)
      const unresolved = await setup.versions.run({
        ...setup.request,
        checkpoint: first.id,
        view: { responses: [], unresolvedReasoning: [{ id: pending.id }] },
      })
      expect(unresolved.status).toBe("failed")
      expect(unresolved.result).toBeUndefined()
      expect(unresolved.stderr).toMatch(/unknown|unresolved|replay|recovery/i)
      expect(await setup.versions.read(first.id)).toEqual(first)
    })

    test("native observations must uniquely match the pending request and cannot masquerade as accepted evidence", async () => {
      await using setup = await fixture()
      const first = await setup.versions.run(setup.request)
      const pending = reason(first)
      const response = { id: pending.id, status: "unverified", summary: '{"type":"adopt"}' }
      const duplicate = await setup.versions.run({
        ...setup.request,
        checkpoint: first.id,
        view: { responses: [response, response], unresolvedReasoning: [] },
      })
      expect(duplicate.status).toBe("failed")
      expect(duplicate.stderr).toContain("unique unverified observation")
      const accepted = await setup.versions.run({
        ...setup.request,
        checkpoint: first.id,
        view: { responses: [{ ...response, status: "accepted" }], unresolvedReasoning: [] },
      })
      expect(accepted.status).toBe("failed")
      expect(accepted.result).toBeUndefined()
      expect(await setup.versions.read(first.id)).toEqual(first)
    })

    test("staged preexisting research state cannot falsely complete a new task without a retained checkpoint", async () => {
      await using setup = await fixture()
      await Bun.write(
        path.join(setup.request.workspace, ".research/state.json"),
        JSON.stringify({
          version: 1,
          identity: Hash.sha256(
            JSON.stringify({
              versionHash: setup.request.versionHash,
              task: setup.request.task,
              deadline: setup.request.deadline,
            }),
          ),
          turn: 0,
          notebook: "A task input is not a retained execution.",
          events: [],
          completed: true,
        }),
      )
      const refused = await setup.versions.run(setup.request)
      expect(refused.status).toBe("failed")
      expect(refused.result).toBeUndefined()
      expect(refused.stderr).toContain("not a retained version checkpoint")
    })

    test("packet inspection refuses undeclared sources and traversal instead of expanding the reading grant", async () => {
      await using setup = await fixture()
      const first = await setup.versions.run(setup.request)
      const refused = await respond(
        setup,
        first,
        JSON.stringify({
          type: "inspect",
          selections: [{ sourceID: "../secret.json" }],
          rationale: "An undeclared source is not made readable by referring to its path.",
        }),
      )
      expect(reason(refused).prompt.toLowerCase()).toMatch(/unknown|undeclared|unavailable|invalid|error/)
      await using escaped = await fixture({ packetPath: "../fixture.json" })
      const invalid = await escaped.versions.run(escaped.request)
      expect(invalid.status).toBe("failed")
      expect(invalid.result).toBeUndefined()
      expect(invalid.stderr).toMatch(/path|relative|escape|packet/i)
    })

    test("local compute failures and timeouts are observations, not missing work or acceptance evidence", async () => {
      await using setup = await fixture({ operationTimeoutMs: 100 })
      const first = await setup.versions.run(setup.request)
      const failure = await respond(
        setup,
        first,
        JSON.stringify({
          type: "compute",
          program: 'throw new Error("diagnostic-fixture-failure")',
          rationale: "An experiment may fail without erasing the study.",
          prediction: "The retained outcome records the error.",
        }),
      )
      expect(reason(failure).prompt).toContain("diagnostic-fixture-failure")
      const timeout = await respond(
        setup,
        failure,
        JSON.stringify({
          type: "compute",
          program: "while (true) {}",
          rationale: "Check the individual-operation watchdog, not a cumulative research cap.",
          prediction: "The child is terminated before the unchanged task deadline.",
        }),
      )
      expect(timeout.completedAt - timeout.startedAt).toBeLessThan(5_000)
      expect(reason(timeout).prompt.toLowerCase()).toMatch(/timeout|timed.out|deadline/)
      expect((await setup.versions.request(timeout.id)) as object).toHaveProperty("deadline", setup.request.deadline)
      expect(await setup.versions.read(failure.id)).toEqual(failure)
    })

    test("criticism remains unverified feedback that changes the next research decision", async () => {
      await using setup = await fixture()
      const first = await setup.versions.run(setup.request)
      const critique = await respond(
        setup,
        first,
        JSON.stringify({
          type: "critique",
          claim: "Repeated testing always improves outcomes.",
          alternatives: ["Repeated testing can consume time without adding information."],
          question: "Which observation would distinguish these explanations?",
        }),
      )
      expect(reason(critique).prompt).toContain("Repeated testing always improves outcomes.")
      const response = await respond(
        setup,
        critique,
        "A repeated identical failure is not independent support. Measure whether the next probe distinguishes a mechanism.",
      )
      expect(reason(response).prompt).toContain("not independent support")
      expect(reason(response).prompt.toLowerCase()).toMatch(/unverified|critique|observation/)
    })

    test("an inherited pipe held by a detached compute descendant cannot extend the operation timeout", async () => {
      await using setup = await fixture({ operationTimeoutMs: 100 })
      setup.request.deadline = Date.now() + 5_000
      const first = await setup.versions.run(setup.request)
      const timeout = await respond(
        setup,
        first,
        JSON.stringify({
          type: "compute",
          program: `
            Bun.spawn([process.execPath, "-e", "await Bun.sleep(10000)"], {
              detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit"
            });
            await Bun.sleep(10);
            process.exit(0);
          `,
          rationale: "A descendant which inherits a pipe must not convert a short operation into a hung study.",
          prediction: "The operation returns timeout and the enclosing sandbox removes remaining descendants.",
        }),
      )
      expect(timeout.status).toBe("completed")
      expect(timeout.completedAt - timeout.startedAt).toBeLessThan(2_000)
      expect(reason(timeout).prompt.toLowerCase()).toContain("timeout")
    })

    test("compute output floods are bounded and explicitly marked as partial observations", async () => {
      await using setup = await fixture()
      const first = await setup.versions.run(setup.request)
      const output = await respond(
        setup,
        first,
        JSON.stringify({
          type: "compute",
          program: 'console.log("x".repeat(1024 * 1024)); await Bun.sleep(10000)',
          rationale: "Bound one observation without imposing a cumulative research budget.",
          prediction: "The retained output is partial and marked output-limit, not successful completion.",
        }),
      )
      expect(output.status).toBe("completed")
      expect(output.completedAt - output.startedAt).toBeLessThan(3_000)
      expect(reason(output).prompt).toContain("output-limit")
      expect(reason(output).prompt).toContain("omittedBytes")
      expect(output.stdout.length).toBeLessThan(512 * 1024)
    })

    test("a negative report needs no successor and cannot authorize method adoption", async () => {
      await using setup = await fixture()
      const first = await setup.versions.run(setup.request)
      const report = await respond(
        setup,
        first,
        JSON.stringify({
          type: "conclude",
          report: "The available trajectory does not distinguish the hypotheses; no improvement is established.",
          uncertainty: ["One public trajectory is insufficient for a causal conclusion."],
          nextResearch: ["Compare matched starts with a discriminating probe."],
        }),
      )
      expect(report.status).toBe("completed")
      expect(report.result?.requests).toEqual([])
      expect(await retained(setup, report, "report.json")).toContain("no improvement is established")
      expect(
        await Bun.file(
          path.join(await setup.versions.artifactDirectory(report.id), ".research/candidate/workflow.ts"),
        ).exists(),
      ).toBe(false)
      expect(report.result?.observations).not.toContainEqual({ status: "accepted" })
    })

    test("research and solver successors are separate artifacts from the report, with no automatic promotion", async () => {
      await using setup = await fixture()
      const first = await setup.versions.run(setup.request)
      const report = await respond(
        setup,
        first,
        JSON.stringify({
          type: "conclude",
          report: "A candidate strategy warrants an experiment, not adoption.",
          uncertainty: ["No fresh comparison has run."],
          nextResearch: ["Compare at the same parent, experience, and deadline."],
          solverInstructions: "After repeated identical feedback, seek a discriminating probe before another repair.",
          researchInstructions:
            "Test whether the next observation changes the hypothesis ranking before spending more.",
        }),
      )
      expect(report.status).toBe("completed")
      expect(report.result?.requests).toEqual([])
      expect(await retained(setup, report, "solver-policy.txt")).toContain("discriminating probe")
      expect(await retained(setup, report, "candidate/workflow.ts")).toBe(
        await Bun.file(path.join(source, "workflow.ts")).text(),
      )
      expect(JSON.parse(await retained(setup, report, "candidate/policy.json"))).toMatchObject({
        version: 1,
        researchInstructions: "Test whether the next observation changes the hypothesis ranking before spending more.",
      })
      expect(await retained(setup, report, "report.json")).toContain("not adoption")
      expect(await setup.versions.inspect(setup.request.versionHash)).toBeDefined()

      const successor = await setup.versions.freeze({
        directory: path.join(await setup.versions.artifactDirectory(report.id), ".research/candidate"),
        entrypoint: "workflow.ts",
      })
      expect(successor.versionHash).not.toBe(setup.request.versionHash)
      const next = await setup.versions.run({
        ...setup.request,
        versionHash: successor.versionHash,
        task: { ...setup.request.task, contractID: "pct_successor_research" },
      })
      expect(reason(next).prompt).toContain(
        "Test whether the next observation changes the hypothesis ranking before spending more.",
      )
      expect(next.versionHash).toBe(successor.versionHash)
      expect(await setup.versions.read(report.id)).toEqual(report)
    })
  },
)
