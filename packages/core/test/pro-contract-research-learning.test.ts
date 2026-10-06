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
const State = Schema.Struct({
  identity: Schema.String,
  notebook: Schema.String,
  events: Schema.Array(
    Schema.Struct({ index: Schema.Number, kind: Schema.String, path: Schema.String, hash: Schema.String }),
  ),
})

async function fixture(options?: { packet?: boolean; unavailable?: boolean; timeout?: number }) {
  const root = await tmpdir()
  const workspace = path.join(root.path, "workspace")
  await mkdir(workspace)
  const original = JSON.stringify({
    sessionID: "ses_same_task_learning",
    messages: {
      data: [
        {
          type: "assistant",
          id: "msg_observation",
          time: { created: 1 },
          content: [
            {
              type: "tool",
              id: "call_observation",
              name: "bash",
              time: { created: 2, completed: 3 },
              state: {
                status: "completed",
                input: { command: "echo 'A declaration is not its output'" },
                content: [{ type: "text", text: "actual=false; expected=true\n" }],
              },
            },
          ],
        },
      ],
    },
  })
  const packet = ProContractTrajectory.project({
    source: original,
    sourceID: "same-task-public",
    sourceHash: Hash.sha256(original),
    limits: options?.unavailable ? { fieldBytes: 1 } : undefined,
  })
  if (options?.packet) await Bun.write(path.join(workspace, "packet.json"), JSON.stringify(packet))
  const versions = ProContractVersion.make({ directory: path.join(root.path, "store") })
  const frozen = await versions.freeze({ directory: source, entrypoint: "workflow.ts" })
  return {
    versions,
    packet,
    request: {
      versionHash: frozen.versionHash,
      task: {
        contractID: "pct_same_task_learning",
        revision: 1,
        specHash: "fixed-local-task",
        input: {
          question: "Implement a local artifact and investigate feedback which should change the next action.",
          packets: options?.packet
            ? [{ path: "packet.json", sourceID: packet.source.id, summary: "A public development observation" }]
            : [],
          operationTimeoutMs: options?.timeout ?? 1_000,
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
  return Schema.decodeUnknownSync(Reason)(record.result!.requests![0])
}

async function respond(
  setup: Awaited<ReturnType<typeof fixture>>,
  previous: ProContractVersion.Record,
  action: unknown,
) {
  return setup.versions.run({
    ...setup.request,
    checkpoint: previous.id,
    view: {
      responses: [{ id: reason(previous).id, status: "unverified", summary: JSON.stringify(action) }],
      unresolvedReasoning: [],
    },
  })
}

async function retained(setup: Awaited<ReturnType<typeof fixture>>, run: ProContractVersion.Record, file: string) {
  return Bun.file(path.join(await setup.versions.artifactDirectory(run.id), ".research", file)).text()
}

async function events(setup: Awaited<ReturnType<typeof fixture>>, run: ProContractVersion.Record) {
  const state = Schema.decodeUnknownSync(Schema.fromJsonString(State))(await retained(setup, run, "state.json"))
  return Promise.all(
    state.events.map(async (event) => ({
      ...event,
      value: JSON.parse(await retained(setup, run, event.path.slice(".research/".length))).value,
    })),
  )
}

async function reference(
  setup: Awaited<ReturnType<typeof fixture>>,
  run: ProContractVersion.Record,
  options?: { kind?: string; pointer?: string; quote?: string },
) {
  const event = (await events(setup, run)).findLast((event) => event.kind === (options?.kind ?? "compute"))!
  return {
    event: event.index,
    hash: event.hash,
    pointer: options?.pointer ?? "/value/stdout/text",
    quote: options?.quote ?? "actual=false",
  }
}

function operation(program = 'console.log("actual=false; expected=true")') {
  return {
    type: "compute",
    program,
    rationale: "Use a distinguishing observation rather than a self-rating.",
    prediction: "The original method expects actual=true.",
  }
}

function revision(evidence: Awaited<ReturnType<typeof reference>>, extra?: Record<string, unknown>) {
  return {
    condition: "When a broad assumption encounters a concrete counterexample",
    previous: "I treated the broad assumption as reliable; this is a retrospective account.",
    change: "Try a condition-preserving contrast before relying on the broad assumption again.",
    expectation: "The contrast should distinguish the retained boundary conditions.",
    reconsiderWhen: "Retire this advice if the contrast adds cost without distinguishing the explanations.",
    reason: "The captured observation conflicts with the prior declared prediction.",
    evidence: [evidence],
    ...extra,
  }
}

describe.skipIf(process.platform !== "linux" || process.arch !== "x64" || !Bun.which("bwrap"))(
  "same-task conditional method learning",
  () => {
    test("an ordinary task uses one engine, preserves its work, and presents a trial before later declared use", async () => {
      await using setup = await fixture()
      const first = await setup.versions.run(setup.request)
      const observed = await respond(
        setup,
        first,
        operation(
          'await Bun.write(".research/work/result.txt", "initial"); console.log("actual=false; expected=true")',
        ),
      )
      const ref = await reference(setup, observed)
      const changed = await respond(setup, observed, {
        ...operation('console.log(await Bun.file(".research/work/result.txt").text())'),
        revision: revision(ref),
      })
      const trials = (await events(setup, changed)).filter((event) => event.kind === "method-revision")
      expect(trials).toHaveLength(1)
      expect(trials[0].value).toMatchObject({
        interpretation: "unverified-conditional-trial",
        observations: [
          {
            classification: "captured-outcome-body",
            quote: "actual=false",
            capture: { status: "complete", truncated: false },
            operation: { status: "exited", exitCode: 0 },
            priorPrediction: { text: operation().prediction },
            timing: "prediction-before-local-compute",
          },
        ],
      })
      expect(reason(changed).prompt).toContain(revision(ref).change)
      const used = await respond(setup, changed, {
        ...operation('await Bun.write(".research/work/result.txt", "revised"); console.log("tested the contrast")'),
        uses: [trials[0].index],
      })
      expect(await retained(setup, used, "work/result.txt")).toBe("revised")
      expect((await events(setup, used)).findLast((event) => event.kind === "method-use")?.value).toEqual({
        ids: [trials[0].index],
        interpretation: "declared-application-not-verified-compliance-or-benefit",
      })
      expect(used.result?.observations).toEqual([
        expect.objectContaining({ interpretation: "unverified", state: "awaiting-observation" }),
      ])
      expect((await setup.versions.request(used.id)) as object).toHaveProperty("deadline", setup.request.deadline)
      expect(await setup.versions.read(observed.id)).toEqual(observed)
    })

    test("bad references or uses change neither notebook, method nor the proposed task artifact", async () => {
      await using setup = await fixture()
      const first = await setup.versions.run(setup.request)
      const observed = await respond(setup, first, operation())
      const ref = await reference(setup, observed)
      const declaration = (await events(setup, observed)).find((event) => event.kind === "decision")!
      const variations = [
        { evidence: [{ ...ref, hash: "0".repeat(64) }] },
        { evidence: [{ ...ref, event: 100 }] },
        { evidence: [{ ...ref, pointer: "/value/program", quote: "program" }] },
        { evidence: [{ ...ref, pointer: "/value/prediction", quote: operation().prediction }] },
        { evidence: [{ ...ref, quote: "actual=true" }] },
        { evidence: [{ ...ref, origin: "another-execution" }] },
        { evidence: [{ ...ref, quote: "" }] },
        { evidence: [] },
        { evidence: [{ ...ref, event: declaration.index, hash: declaration.hash, pointer: "/value/summary" }] },
        { replaces: 100 },
      ]
      for (const invalid of variations) {
        const refused = await respond(setup, observed, {
          ...operation('await Bun.write(".research/work/must-not-exist", "bad")'),
          notes: "Must not replace the notebook",
          revision: revision(ref, invalid),
        })
        expect(reason(refused).prompt).toContain("invalid-action")
        const history = await events(setup, refused)
        expect(history.filter((event) => event.kind === "method-revision")).toEqual([])
        expect(history.filter((event) => event.kind === "compute")).toHaveLength(1)
        expect(JSON.parse(await retained(setup, refused, "state.json")).notebook).toBe("")
        expect(
          await Bun.file(
            path.join(await setup.versions.artifactDirectory(refused.id), ".research/work/must-not-exist"),
          ).exists(),
        ).toBe(false)
      }
      const futureUse = await respond(setup, observed, { ...operation(), uses: [100], revision: revision(ref) })
      expect((await events(setup, futureUse)).filter((event) => event.kind === "method-revision")).toEqual([])
    })

    test("a prior action-validation error can revise use of the research interface without inventing an experiment", async () => {
      await using setup = await fixture()
      const observed = await respond(setup, await setup.versions.run(setup.request), operation())
      const failed = await respond(setup, observed, {
        type: "inspect",
        rationale: "This operation must not execute with an invalid evidence reference.",
        prediction: "This is not a predeclared prediction of the validation error.",
        selections: [{ sourceID: "not-used" }],
        revision: revision({ ...(await reference(setup, observed)), hash: "0".repeat(64) }),
      })
      const invalid = (await events(setup, failed)).findLast((event) => event.kind === "invalid-action")!
      expect((await events(setup, failed)).filter((event) => event.kind === "inspection")).toEqual([])
      const changed = await respond(setup, failed, {
        ...operation(),
        revision: revision(
          await reference(setup, failed, {
            kind: "invalid-action",
            pointer: "/value/error",
            quote: invalid.value.error,
          }),
          {
            condition: "A proposed reference is rejected by the local research interface.",
            change: "Read the retained event hash before attempting a new reference.",
            reason: "The interface error identifies a failed citation operation, not an incorrect task result.",
          },
        ),
      })
      const trial = (await events(setup, changed)).findLast((event) => event.kind === "method-revision")!
      expect(trial.value.observations[0]).toMatchObject({
        classification: "execution-diagnostic",
        quote: invalid.value.error,
        operation: { status: "not-executed" },
        priorPrediction: null,
        timing: "retrospective-interpretation-only",
        limitation: "Execution or measurement diagnostic only; not task correctness or method effectiveness",
      })
      const refused = await respond(setup, changed, {
        ...operation(),
        revision: revision({
          event: trial.index,
          hash: trial.hash,
          pointer: "/value/reason",
          quote: trial.value.reason,
        }),
      })
      expect((await events(setup, refused)).filter((event) => event.kind === "method-revision")).toHaveLength(1)
      expect((await events(setup, refused)).filter((event) => event.kind === "compute")).toHaveLength(2)
      expect(await setup.versions.read(failed.id)).toEqual(failed)
    })

    test("exit zero is a diagnostic, never task success, and stdout remains separate", async () => {
      await using setup = await fixture()
      const observed = await respond(setup, await setup.versions.run(setup.request), operation())
      const changed = await respond(setup, observed, {
        ...operation(),
        revision: revision(await reference(setup, observed, { pointer: "/value/exitCode", quote: "0" })),
      })
      const trial = (await events(setup, changed)).find((event) => event.kind === "method-revision")!
      expect(trial.value.observations[0]).toMatchObject({
        classification: "execution-diagnostic",
        capture: { status: "recorded-diagnostic", value: 0 },
        limitation: "Execution or measurement diagnostic only; not task correctness or method effectiveness",
      })
      expect(changed.result?.observations).not.toContainEqual({ status: "accepted" })
      expect(reason(changed).prompt).toContain("actual=false")
    })

    test("measurement failures and truncated bodies can revise observation methods without becoming semantic evidence", async () => {
      await using setup = await fixture({ timeout: 200 })
      const first = await setup.versions.run(setup.request)
      const observed = await respond(
        setup,
        first,
        operation('console.log("L".repeat(1024 * 1024)); await Bun.sleep(10000)'),
      )
      const changed = await respond(setup, observed, {
        ...operation(),
        revision: revision(await reference(setup, observed, { pointer: "/value/status", quote: "output-limit" }), {
          change: "Print only the distinguishing count before requesting larger evidence.",
          evidence: [
            await reference(setup, observed, { pointer: "/value/status", quote: "output-limit" }),
            await reference(setup, observed, { quote: "LLLL" }),
          ],
        }),
      })
      const trial = (await events(setup, changed)).find((event) => event.kind === "method-revision")!
      expect(trial.value.observations[0].classification).toBe("execution-diagnostic")
      expect(trial.value.observations[1]).toMatchObject({
        capture: { status: "truncated", truncated: true },
        operation: { status: "output-limit" },
      })
      expect((await setup.versions.request(changed.id)) as object).toHaveProperty("deadline", setup.request.deadline)
    })

    test("an exact observed empty stream is distinguishable from absent or partial data", async () => {
      await using setup = await fixture()
      const first = await setup.versions.run(setup.request)
      const observed = await respond(setup, first, operation("void 0"))
      const changed = await respond(setup, observed, {
        ...operation(),
        revision: revision(await reference(setup, observed, { quote: "" })),
      })
      const trial = (await events(setup, changed)).find((event) => event.kind === "method-revision")!
      expect(trial.value.observations[0]).toMatchObject({
        quote: "",
        fieldHash: Hash.sha256(""),
        capturedBytes: 0,
        capture: { status: "complete", bytes: 0, truncated: false },
      })
    })

    test("timeout diagnostics permit measurement learning but a cancelled empty stream is not an empty observation", async () => {
      await using setup = await fixture({ timeout: 100 })
      const first = await setup.versions.run(setup.request)
      const observed = await respond(setup, first, operation("while (true) {}"))
      const timeout = (await events(setup, observed)).findLast((event) => event.kind === "compute")!
      expect(timeout.value).toMatchObject({
        status: "timeout",
        stdout: { text: "", truncated: false, complete: false },
        stderr: { text: "", truncated: false, complete: false },
      })
      const refused = await respond(setup, observed, {
        ...operation(),
        revision: revision(await reference(setup, observed, { quote: "" })),
      })
      expect((await events(setup, refused)).filter((event) => event.kind === "method-revision")).toEqual([])
      const changed = await respond(setup, observed, {
        ...operation(),
        revision: revision(await reference(setup, observed, { pointer: "/value/status", quote: "timeout" }), {
          change: "Use a smaller discriminating computation before a long one.",
        }),
      })
      expect(
        (await events(setup, changed)).find((event) => event.kind === "method-revision")?.value.observations[0],
      ).toMatchObject({ classification: "execution-diagnostic", operation: { status: "timeout" } })
    })

    test("inspection quotes retain capture provenance and distinguish retrospective interpretations from predictions", async () => {
      await using setup = await fixture({ packet: true })
      const first = await setup.versions.run(setup.request)
      const observed = await respond(setup, first, {
        type: "inspect",
        rationale: "Read the actual captured output, not tool lifecycle state.",
        selections: [{ sourceID: setup.packet.source.id }],
      })
      const ref = await reference(setup, observed, {
        kind: "inspection",
        pointer: "/value/value/0/records/0/tool/content/0/text/text",
      })
      const changed = await respond(setup, observed, { ...operation(), revision: revision(ref) })
      const trial = (await events(setup, changed)).find((event) => event.kind === "method-revision")!
      expect(trial.value.observations[0]).toMatchObject({
        classification: "captured-outcome-body",
        capture: { status: "complete", encoding: "utf8", originalHash: Hash.sha256("actual=false; expected=true\n") },
        priorPrediction: null,
        timing: "retrospective-interpretation-only",
      })
      for (const pointer of ["/value/value/0/records/0/tool/output", "/value/value/0/records/0/tool/input/text"]) {
        const refused = await respond(setup, observed, { ...operation(), revision: revision({ ...ref, pointer }) })
        expect((await events(setup, refused)).filter((event) => event.kind === "method-revision")).toEqual([])
      }
    })

    test("unavailable inspection and missing field captures remain distinct from observed empty output", async () => {
      await using setup = await fixture({ packet: true, unavailable: true })
      const first = await setup.versions.run(setup.request)
      const missing = await respond(setup, first, {
        type: "inspect",
        rationale: "A missing source is a lookup diagnostic, not a negative task result.",
        selections: [{ sourceID: "not-permitted" }],
      })
      const changed = await respond(setup, missing, {
        ...operation(),
        revision: revision(
          await reference(setup, missing, { kind: "inspection", pointer: "/value/status", quote: "unavailable" }),
        ),
      })
      expect(
        (await events(setup, changed)).find((event) => event.kind === "method-revision")!.value.observations[0],
      ).toMatchObject({
        classification: "execution-diagnostic",
        operation: { status: "unavailable" },
      })
      const clipped = await respond(setup, first, {
        type: "inspect",
        rationale: "This packet intentionally omits large fields.",
        selections: [{ sourceID: setup.packet.source.id }],
      })
      const refused = await respond(setup, clipped, {
        ...operation(),
        revision: revision(
          await reference(setup, clipped, {
            kind: "inspection",
            pointer: "/value/value/0/records/0/tool/content/0/text/text",
            quote: "",
          }),
        ),
      })
      expect((await events(setup, refused)).filter((event) => event.kind === "method-revision")).toEqual([])
    })

    test("replacements and retractions retain history without reviving ancestors or permitting stale use", async () => {
      await using setup = await fixture()
      const observed = await respond(setup, await setup.versions.run(setup.request), operation())
      const ref = await reference(setup, observed)
      const first = await respond(setup, observed, { ...operation(), revision: revision(ref) })
      const original = (await events(setup, first)).findLast((event) => event.kind === "method-revision")!.index
      const replaced = await respond(setup, first, {
        ...operation(),
        revision: revision(ref, { replaces: original, change: "Use the cheaper condition-preserving contrast first." }),
      })
      const second = (await events(setup, replaced)).findLast((event) => event.kind === "method-revision")!.index
      const stale = await respond(setup, replaced, { ...operation(), uses: [original] })
      expect((await events(setup, stale)).findLast((event) => event.kind === "invalid-action")?.value.error).toContain(
        "earlier active",
      )
      const retired = await respond(setup, replaced, {
        ...operation(),
        revision: revision(ref, { replaces: second, change: null }),
      })
      const history = await events(setup, retired)
      expect(history.filter((event) => event.kind === "method-revision")).toHaveLength(3)
      const methodBlock = reason(retired)
        .prompt.split("Active conditional method trials")[1]
        .split("Public packet field guide")[0]
      expect(methodBlock).toContain('\\"active\\":[]')
      const refused = await respond(setup, retired, { ...operation(), uses: [second] })
      expect((await events(setup, refused)).filter((event) => event.kind === "method-use")).toEqual([])
      expect(await setup.versions.read(first.id)).toEqual(first)
    })

    test("selected successor trials are scoped proposals, actually imported on fresh execution without a checkpoint", async () => {
      await using setup = await fixture()
      const observed = await respond(setup, await setup.versions.run(setup.request), operation())
      const ref = await reference(setup, observed)
      const first = await respond(setup, observed, {
        ...operation(),
        revision: revision(ref, { change: "SELECTED-SCOPED-TRIAL" }),
      })
      const selected = (await events(setup, first)).findLast((event) => event.kind === "method-revision")!
      const second = await respond(setup, first, {
        ...operation(),
        revision: revision(ref, { change: "UNSELECTED-SCOPED-TRIAL" }),
      })
      const report = await respond(setup, second, {
        type: "conclude",
        report: "This task produced a method hypothesis, not proof of transferable benefit.",
        uncertainty: ["No independent gain evidence"],
        nextResearch: ["Try the selected rule only where its condition applies"],
        carry: [selected.index],
      })
      expect(report.status).toBe("completed")
      const policy = JSON.parse(await retained(setup, report, "candidate/policy.json"))
      expect(policy.trials).toHaveLength(1)
      expect(policy.trials[0]).toMatchObject({
        id: selected.index,
        origin: selected.value.origin,
        interpretation: "unverified-conditional-trial",
      })
      expect(await retained(setup, report, "proposals.json")).toContain("proposed-only")
      expect(
        await Bun.file(
          path.join(await setup.versions.artifactDirectory(report.id), ".research/candidate/.research/state.json"),
        ).exists(),
      ).toBe(false)
      const successor = await setup.versions.freeze({
        directory: path.join(await setup.versions.artifactDirectory(report.id), ".research/candidate"),
        entrypoint: "workflow.ts",
      })
      setup.request.versionHash = successor.versionHash
      setup.request.task.contractID = "pct_fresh_successor_task"
      const fresh = await setup.versions.run(setup.request)
      expect(reason(fresh).prompt).toContain("SELECTED-SCOPED-TRIAL")
      expect(reason(fresh).prompt).not.toContain("UNSELECTED-SCOPED-TRIAL")
      const imported = (await events(setup, fresh)).find((event) => event.kind === "method-import")!
      expect(imported.value).toMatchObject({
        inherited: { id: selected.index, origin: selected.value.origin },
      })
      const freshIdentity = JSON.parse(await retained(setup, fresh, "state.json")).identity
      expect(imported.value.origin).toBe(freshIdentity)
      expect(imported.value.observations[0].origin).toBe(selected.value.origin)
      expect(freshIdentity).not.toBe(selected.value.origin)
      const used = await respond(setup, fresh, { ...operation(), uses: [imported.index] })
      expect((await events(setup, used)).find((event) => event.kind === "method-use")?.value.ids).toEqual([
        imported.index,
      ])
      const carried = await respond(setup, used, {
        type: "conclude",
        report: "Carry the conditional trial without claiming transfer benefit.",
        uncertainty: ["No independent transfer result"],
        nextResearch: [],
        carry: [imported.index],
      })
      const secondSuccessor = await setup.versions.freeze({
        directory: path.join(await setup.versions.artifactDirectory(carried.id), ".research/candidate"),
        entrypoint: "workflow.ts",
      })
      setup.request.versionHash = secondSuccessor.versionHash
      setup.request.task.contractID = "pct_second_successor_task"
      const secondFresh = await setup.versions.run(setup.request)
      const reimported = (await events(setup, secondFresh)).find((event) => event.kind === "method-import")!
      expect(reimported.value).toMatchObject({
        inherited: { id: imported.index, origin: freshIdentity },
        evidence: [expect.objectContaining({ origin: selected.value.origin, event: ref.event, hash: ref.hash })],
        observations: [expect.objectContaining({ origin: selected.value.origin, event: ref.event, hash: ref.hash })],
      })
      expect(reimported.value.origin).toBe(JSON.parse(await retained(setup, secondFresh, "state.json")).identity)
    })

    test("large active advice is explicitly clipped, archived in full and cannot expand the original deadline", async () => {
      await using setup = await fixture()
      const observed = await respond(setup, await setup.versions.run(setup.request), operation())
      const ref = await reference(setup, observed)
      const change = "条件🙂 method ".repeat(3_000)
      const changed = await respond(setup, observed, {
        ...operation(),
        revision: revision(ref, { change, deadline: Number.MAX_SAFE_INTEGER, authority: ["self-adopt"] }),
      })
      const block = reason(changed)
        .prompt.split("Active conditional method trials")[1]
        .split("Public packet field guide")[0]
      const view = JSON.parse(block.slice(block.indexOf("\n") + 1).trim())
      expect(Buffer.byteLength(JSON.stringify(view.view))).toBeLessThanOrEqual(16 * 1024)
      expect(view.view).toHaveProperty("omittedBytes")
      expect(await retained(setup, changed, view.archive.slice(".research/".length))).toContain(change)
      expect((await setup.versions.request(changed.id)) as object).toHaveProperty("deadline", setup.request.deadline)
      expect(
        (await events(setup, changed)).find((event) => event.kind === "method-revision")?.value,
      ).not.toHaveProperty("authority")
    })
  },
)
