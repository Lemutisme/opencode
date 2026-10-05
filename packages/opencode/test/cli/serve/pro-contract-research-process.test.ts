import { describe, expect } from "bun:test"
import { ProContractPolicy } from "@opencode-ai/core/pro-contract/policy"
import { ProContractPromotion } from "@opencode-ai/core/pro-contract/promotion"
import { ProContractVersion } from "@opencode-ai/core/pro-contract/version"
import { ProContract } from "@opencode-ai/schema/pro-contract"
import { Effect, Schema } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { cliIt, type OpencodeCli } from "../../lib/cli-process"

const response = Schema.Struct({ contract: ProContract.Info, run: ProContractVersion.Record })
const output = Schema.Struct({ executor: Schema.String, decision: Schema.String, conclusion: Schema.String })
const password = "isolated-research-process-fixture"

describe("ProContract executable research lifecycle (subprocess)", () => {
  cliIt.live(
    "runs v0 → research-only v1 → v2 with independent adoption and retained valid results",
    ({ opencode, llm, home }) =>
      Effect.gen(function* () {
        const setup = yield* fixture(opencode, home, "recursive-code")
        const run = setup.command
        const seedHash = ProContractPolicy.hashBundle(setup.seed)
        const evaluate = (directory: string, versionHash: string) =>
          Effect.promise(() => measurement(home, directory, versionHash, setup.protocol))
        const baseline = yield* evaluate(setup.source, setup.seed.versionHash)
        expect(baseline.rows.filter((row) => row.id !== "safety").every((row) => row.passed === 1)).toBe(true)

        const task = yield* execute(setup, "pct_native_accepted", "incumbent", { kind: "solve" }, {}, seedHash)
        expect(task.contract.status).toBe("verification")
        expect(task.contract.spec.requires).toEqual([])
        const inspected = yield* inspectResult(setup, task)
        expect(inspected).toMatchObject({ executor: "none", decision: "continue-repair" })
        yield* attest(run, task, JSON.stringify(inspected))
        const accepted = yield* run(["contract", "show", task.contract.id])
        expect(accepted).toMatchObject({ status: "discharged" })
        const interrupted = yield* execute(
          setup,
          "pct_native_midchain_failure",
          "incumbent",
          { kind: "recover" },
          {},
          seedHash,
          2,
        )
        expect(interrupted.contract.status).toBe("escalated")

        const first = yield* execute(
          setup,
          "pct_native_generation_one",
          "research_executor",
          { kind: "research" },
          {},
          seedHash,
        )
        expect(first.run.versionHash).toBe(setup.seed.versionHash)
        expect(first.run.result?.observations).toEqual([
          { executor: "none", decision: "continue-repair", successor: "always" },
        ])
        const v1 = yield* successor(setup, first)
        const generation1 = yield* json(home, "generation-one", coordinates(first))
        const forgedRun = yield* opencode.spawn(
          [
            "contract",
            "strategy",
            "archive",
            "--scope",
            setup.scope,
            "--expected-revision",
            "1",
            "--bundle",
            v1.file,
            "--generation",
            yield* json(home, "forged-run", { ...coordinates(first), runID: task.run.id }),
            "--target-version",
            seedHash,
          ],
          { env: setup.env },
        )
        expect(forgedRun.exitCode).not.toBe(0)
        expect(forgedRun.stderr).toContain("Executable research provenance differs")
        const forgedCode = yield* opencode.spawn(
          [
            "contract",
            "strategy",
            "archive",
            "--scope",
            setup.scope,
            "--expected-revision",
            "1",
            "--bundle",
            yield* json(home, "forged-code", { ...v1.bundle, versionHash: setup.seed.versionHash }),
            "--generation",
            generation1,
            "--target-version",
            seedHash,
          ],
          { env: setup.env },
        )
        expect(forgedCode.exitCode).not.toBe(0)
        expect(forgedCode.stderr).toContain("Candidate source is not the retained run artifact")
        const forgedText = yield* opencode.spawn(
          [
            "contract",
            "strategy",
            "archive",
            "--scope",
            setup.scope,
            "--expected-revision",
            "1",
            "--bundle",
            yield* json(home, "forged-text", { ...v1.bundle, solver: "Never actually generated." }),
            "--generation",
            generation1,
            "--target-version",
            seedHash,
          ],
          { env: setup.env },
        )
        expect(forgedText.exitCode).not.toBe(0)
        expect(forgedText.stderr).toContain("Candidate policy text differs")
        expect(yield* run(["contract", "strategy", "show", setup.scope])).toEqual(setup.authorized)
        yield* run([
          "contract",
          "strategy",
          "archive",
          "--scope",
          setup.scope,
          "--expected-revision",
          "1",
          "--bundle",
          v1.file,
          "--generation",
          generation1,
          "--target-version",
          seedHash,
        ])
        const measured1 = yield* Effect.promise(() =>
          measurement(home, v1.directory, v1.bundle.versionHash, {
            ...setup.protocol,
            tests: setup.protocol.tests.filter((test) => test.performance?.panel !== "confirmation"),
          }),
        )
        expect(measured1.rows.filter((row) => row.id !== "safety").every((row) => row.passed === 1)).toBe(true)
        // Development ties do not warrant confirmation or a promotion duty; research uses an independent grant.
        const notAdopted = (yield* run(["contract", "strategy", "show", setup.scope])) as ProContractPolicy.State
        expect(notAdopted.history[notAdopted.roles.incumbent].bundleHash).toBe(seedHash)
        expect(notAdopted.history[notAdopted.roles.research_executor].bundleHash).toBe(seedHash)
        expect(notAdopted.evaluations).toEqual([])
        const qualified = Schema.decodeUnknownSync(
          Schema.Struct({ run: ProContractVersion.Record, qualification: ProContractPolicy.Qualification }),
        )(
          yield* run([
            "contract",
            "version",
            "qualify",
            v1.bundle.versionHash,
            "--task",
            yield* json(home, "qualification-task", { kind: "solve" }),
            "--workspace",
            setup.workspace,
            "--deadline",
            new Date(Date.now() + 30_000).toISOString(),
          ]),
        )
        expect(qualified.run).toMatchObject({ versionHash: v1.bundle.versionHash, status: "completed" })

        const selected = (yield* run([
          "contract",
          "strategy",
          "select-research",
          "--scope",
          setup.scope,
          "--expected-revision",
          String(notAdopted.revision),
          "--bundle-hash",
          ProContractPolicy.hashBundle(v1.bundle),
          "--qualification",
          yield* json(home, "research-qualification", qualified.qualification),
        ])) as ProContractPolicy.State
        expect(selected.history[selected.roles.incumbent].bundleHash).toBe(seedHash)
        expect(selected.history[selected.roles.research_executor].bundleHash).toBe(
          ProContractPolicy.hashBundle(v1.bundle),
        )

        // This process executes v1's changed control flow; v0 would continue repair instead.
        const second = yield* execute(
          setup,
          "pct_native_generation_two",
          "research_executor",
          { kind: "research" },
          {
            repeatedFeedback: ["same-error", "same-error"],
            excessiveOverhead: true,
          },
          ProContractPolicy.hashBundle(v1.bundle),
        )
        expect(second.run.versionHash).toBe(v1.bundle.versionHash)
        expect(second.run.result?.observations).toEqual([
          { executor: "always", decision: "distinguishing-test", successor: "on-stagnation" },
        ])
        const v2 = yield* successor(setup, second)
        expect(v2.bundle.versionHash).not.toBe(v1.bundle.versionHash)
        const generation2 = yield* json(home, "generation-two", coordinates(second))
        const forgedTarget = yield* opencode.spawn(
          [
            "contract",
            "strategy",
            "propose",
            "--scope",
            setup.scope,
            "--expected-revision",
            String(selected.revision),
            "--bundle",
            v2.file,
            "--generation",
            generation2,
            "--target-version",
            seedHash,
          ],
          { env: setup.env },
        )
        expect(forgedTarget.exitCode).not.toBe(0)
        expect(forgedTarget.stderr).toContain("Research target differs")
        const proposal2 = Schema.decodeUnknownSync(ProContract.Info)(
          yield* run([
            "contract",
            "strategy",
            "propose",
            "--scope",
            setup.scope,
            "--expected-revision",
            String(selected.revision),
            "--bundle",
            v2.file,
            "--generation",
            generation2,
            "--target-version",
            ProContractPolicy.hashBundle(v1.bundle),
          ]),
        )
        expect(JSON.parse(proposal2.spec.brief)).toMatchObject({
          baselineHash: seedHash,
          targetVersion: ProContractPolicy.hashBundle(v1.bundle),
          executorHash: ProContractPolicy.hashBundle(v1.bundle),
        })
        const measured2 = yield* evaluate(v2.directory, v2.bundle.versionHash)
        expect(measured2.rows.filter((row) => row.id !== "safety").every((row) => row.passed === 2)).toBe(true)
        const evidence2 = yield* json(home, "comparison-two", {
          protocolHash: setup.authorized.protocolHash,
          baselineHash: seedHash,
          candidateHash: ProContractPolicy.hashBundle(v2.bundle),
          receiptHash: hash(JSON.stringify({ baseline, candidate: measured2 })),
          baseline: baseline.rows,
          rows: measured2.rows,
        })
        expect(yield* run(["contract", "strategy", "settle", proposal2.id, "--evidence", evidence2])).toMatchObject({
          decision: { eligible: true },
        })
        const adopted = (yield* run(["contract", "strategy", "show", setup.scope])) as ProContractPolicy.State
        expect(adopted.history[adopted.roles.incumbent].bundleHash).toBe(ProContractPolicy.hashBundle(v2.bundle))
        expect(adopted.history[adopted.roles.research_executor].bundleHash).toBe(
          ProContractPolicy.hashBundle(v1.bundle),
        )
        const serving = yield* execute(
          setup,
          "pct_native_new_task",
          "incumbent",
          { kind: "solve" },
          {
            repeatedFeedback: ["same-error", "same-error"],
          },
          ProContractPolicy.hashBundle(v2.bundle),
        )
        expect(serving.run.versionHash).toBe(v2.bundle.versionHash)
        expect(serving.run.result?.observations).toEqual([
          { executor: "on-stagnation", decision: "distinguishing-test" },
        ])
        expect(yield* run(["contract", "version", "show", task.contract.id])).toMatchObject({
          contract: accepted,
          runs: [{ id: task.run.id, versionHash: setup.seed.versionHash }],
        })
        const recovered = Schema.decodeUnknownSync(response)(
          yield* run(["contract", "version", "resume", interrupted.contract.id]),
        )
        expect(recovered.run).toMatchObject({ versionHash: setup.seed.versionHash, status: "completed" })
        expect(recovered.contract.spec.budget).toEqual(interrupted.contract.spec.budget)
        expect(yield* run(["contract", "version", "show", interrupted.contract.id])).toMatchObject({
          runs: [
            { id: interrupted.run.id, status: "failed" },
            { id: recovered.run.id, status: "completed" },
          ],
        })

        // Candidate adoption requests are data, never authority, even when the executable lies.
        const probe = yield* execute(
          setup,
          "pct_native_probe",
          "incumbent",
          {
            kind: "probe",
            forbidden: [setup.env.OPENCODE_DB, setup.secret, import.meta.path],
          },
          {},
          ProContractPolicy.hashBundle(v2.bundle),
        )
        expect(probe.contract.status).toBe("verification")
        expect(probe.run.result?.requests).toEqual([{ kind: "adopt", evidenceHash: "f".repeat(64) }])
        yield* run(["contract", "version", "export", probe.run.id, "--directory", path.join(home, "probe-export")])
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "probe-export/probe.json")).json())).toEqual({
          readable: [false, false, false],
          sourceWritable: false,
          principalCredential: null,
        })
        const overwrite = yield* opencode.spawn(
          ["contract", "version", "export", probe.run.id, "--directory", path.join(home, "probe-export")],
          { env: setup.env },
        )
        expect(overwrite.exitCode).not.toBe(0)
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "probe-export/probe.json")).json())).toEqual({
          readable: [false, false, false],
          sourceWritable: false,
          principalCredential: null,
        })
        expect(yield* run(["contract", "strategy", "show", setup.scope])).toEqual(adopted)

        // An unsupported conclusion completes a report duty, not a performance promotion.
        const negative = yield* execute(
          setup,
          "pct_native_negative",
          "research_executor",
          { kind: "negative" },
          {},
          ProContractPolicy.hashBundle(v1.bundle),
        )
        expect(yield* inspectResult(setup, negative)).toMatchObject({
          executor: "always",
          conclusion: "Extra reflection did not help this fixture.",
        })
        const report = {
          id: hash("negative-research-report"),
          source: { contractID: negative.contract.id, revision: negative.contract.revision, runID: negative.run.id },
          executorHash: ProContractPolicy.hashBundle(v1.bundle),
          targetVersion: ProContractPolicy.hashBundle(v1.bundle),
          question: "Does extra reflection improve this deterministic fixture?",
          hypothesis: "Always-on reflection helps.",
          intervention: "Compare always-on and conditional diagnosis.",
          observations: ["The always-on version tied the seed on the independent fixture."],
          conclusion: "No benefit was observed under this fixture; no broader claim is made.",
          outcome: "unsupported" as const,
          evidenceHash: hash(JSON.stringify(measured1)),
          budget: {
            deadline: negative.contract.spec.budget.deadline,
            startedAt: negative.run.startedAt,
            finishedAt: negative.run.completedAt,
          },
        }
        const completed = yield* run([
          "contract",
          "strategy",
          "complete-research",
          "--scope",
          setup.scope,
          "--expected-revision",
          String(adopted.revision),
          "--generation",
          yield* json(home, "negative-generation", coordinates(negative)),
          "--experiment",
          yield* json(home, "negative-experiment", report),
        ])
        expect(completed).toMatchObject({ contract: { id: negative.contract.id, status: "discharged" } })
        const archived = (yield* run(["contract", "strategy", "show", setup.scope])) as ProContractPolicy.State
        expect(archived.experiments).toEqual([report])
        expect(archived.roles).toEqual(adopted.roles)
        expect(
          yield* run([
            "contract",
            "strategy",
            "view",
            setup.scope,
            "--version",
            ProContractPolicy.hashBundle(v1.bundle),
            "--experiment",
            report.id,
          ]),
        ).toMatchObject({
          versions: [{ bundleHash: ProContractPolicy.hashBundle(v1.bundle) }],
          experiments: [report],
        })

        // Return to the exact seed grant, then withdraw that method. Its independently accepted task survives.
        const rollback = (yield* run([
          "contract",
          "strategy",
          "rollback",
          setup.scope,
          "--expected-revision",
          String(archived.revision),
        ])) as ProContractPolicy.State
        expect(rollback.history[rollback.roles.incumbent].bundleHash).toBe(seedHash)
        yield* run([
          "contract",
          "strategy",
          "revoke",
          setup.scope,
          "--expected-revision",
          String(rollback.revision),
          "--evidence-hash",
          hash("withdraw seed execution only"),
        ])
        expect(yield* run(["contract", "show", task.contract.id])).toEqual(accepted)
        expect(yield* run(["contract", "show", negative.contract.id])).toMatchObject({ status: "discharged" })
        const revoked = yield* opencode.spawn(["contract", "strategy", "bind", setup.scope, "--role", "incumbent"], {
          env: setup.env,
        })
        expect(revoked.exitCode).not.toBe(0)
        expect(revoked.stderr).toContain("support was withdrawn")
        const server = yield* opencode.serve({ env: setup.env })
        const challenged = yield* Effect.promise(async () => {
          const result = await fetch(new URL(`/api/contract/${task.contract.id}/challenge`, server.url), {
            method: "POST",
            headers: { authorization: `Basic ${btoa(`opencode:${password}`)}`, "content-type": "application/json" },
            body: JSON.stringify({
              revision: task.contract.revision,
              subjectHash: task.contract.handoff!.subjectHash,
              evidenceHash: hash("independent counterexample to the result"),
              disclosure: "sealed",
            }),
            signal: AbortSignal.timeout(5_000),
          })
          return { status: result.status, body: await result.json() }
        })
        expect(challenged.status).toBe(200)
        expect(yield* run(["contract", "show", task.contract.id])).toMatchObject({ status: "escalated" })
        expect(yield* run(["contract", "version", "show", task.contract.id])).toMatchObject({
          contract: { status: "escalated" },
          runs: [{ id: task.run.id, versionHash: setup.seed.versionHash, status: "completed" }],
        })
        expect(yield* llm.calls).toBe(0)
      }),
    300_000,
  )

  cliIt.live(
    "retains failed runs and resumes the same ordinary duty under its original deadline",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        const setup = yield* fixture(opencode, home, "native-recovery")
        const failed = yield* execute(
          setup,
          "pct_native_recovery",
          "incumbent",
          { kind: "recover" },
          {},
          ProContractPolicy.hashBundle(setup.seed),
          2,
        )
        expect(failed.run).toMatchObject({ status: "failed", exitCode: 9 })
        expect(failed.contract.status).toBe("escalated")
        const before = yield* setup.command(["contract", "version", "show", failed.contract.id])
        expect(before).toMatchObject({ contract: { id: failed.contract.id, status: "escalated" } })
        // Every CLI call is a fresh host process; this resumes from durable records, not a surviving in-memory runner.
        const resumed = Schema.decodeUnknownSync(response)(
          yield* setup.command(["contract", "version", "resume", failed.contract.id]),
        )
        expect(resumed.contract.id).toBe(failed.contract.id)
        expect(resumed.contract.spec.budget).toEqual(failed.contract.spec.budget)
        expect(resumed.run.versionHash).toBe(failed.run.versionHash)
        expect(resumed.run.id).not.toBe(failed.run.id)
        expect(resumed.run.status).toBe("completed")
        expect(resumed.contract.status).toBe("verification")
        expect(yield* setup.command(["contract", "version", "show", resumed.contract.id])).toMatchObject({
          runs: [
            { id: failed.run.id, status: "failed" },
            { id: resumed.run.id, status: "completed" },
          ],
        })
        yield* setup.command([
          "contract",
          "version",
          "export",
          failed.run.id,
          "--directory",
          path.join(home, "failed-export"),
        ])
        const inspected = yield* inspectResult(setup, resumed)
        expect(inspected).toMatchObject({ executor: "none", decision: "continue-repair" })
        yield* attest(setup.command, resumed, JSON.stringify(inspected))
        expect(yield* setup.command(["contract", "show", resumed.contract.id])).toMatchObject({ status: "discharged" })
        expect(yield* llm.calls).toBe(0)
      }),
    120_000,
  )
})

function fixture(opencode: OpencodeCli, home: string, scope: string) {
  return Effect.gen(function* () {
    const env = { OPENCODE_DB: path.join(home, "contracts.sqlite"), OPENCODE_SERVER_PASSWORD: password }
    const command = (args: string[], expected = 0) =>
      opencode.spawn(args, { env }).pipe(
        Effect.map((result) => {
          opencode.expectExit(result, expected, args.join(" "))
          return Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(result.stdout)
        }),
      )
    const source = path.join(home, "source")
    const workspace = path.join(home, "workspace")
    const secret = path.join(home, "principal-private.txt")
    yield* Effect.promise(async () => {
      await mkdir(workspace)
      await Bun.write(secret, "synthetic principal credential, never exposed to a candidate")
      await Bun.write(
        path.join(source, "workflow.ts"),
        Bun.file(path.join(import.meta.dir, "../../fixture/research-workflow.ts")),
      )
    })
    const frozen = Schema.decodeUnknownSync(Schema.Struct({ versionHash: Schema.String }))(
      yield* command(["contract", "version", "freeze", "--directory", source, "--entrypoint", "workflow.ts"]),
    )
    const seed = {
      version: 2 as const,
      solver: "Solve with no diagnosis.",
      generator: "Research with no diagnosis.",
      versionHash: frozen.versionHash,
    }
    const protocol: ProContractPromotion.Protocol = {
      version: 1,
      performanceRule: "task-pareto",
      evaluatorHash: hash(yield* Effect.promise(() => Bun.file(import.meta.path).text())),
      tests: [
        { id: "safety", total: 1 },
        ...(["development", "confirmation"] as const).flatMap((panel) =>
          ["0", "1"].map((replicate) => ({
            id: `${panel}-${replicate}`,
            total: 2,
            performance: { panel, task: "diagnostic-choice", replicate },
          })),
        ),
      ],
    }
    const authorized = (yield* command([
      "contract",
      "strategy",
      "authorize",
      "--scope",
      scope,
      "--bundle",
      yield* json(home, "seed", seed),
      "--protocol",
      yield* json(home, "protocol", protocol),
    ])) as ProContractPolicy.State
    return { command, home, env, source, workspace, secret, seed, protocol, authorized, scope }
  })
}

type Fixture = Effect.Success<ReturnType<typeof fixture>>

function execute(
  setup: Fixture,
  id: string,
  role: string,
  task: object,
  view: object,
  targetVersion: string,
  expected = 0,
) {
  return Effect.gen(function* () {
    return Schema.decodeUnknownSync(response)(
      yield* setup.command(
        [
          "contract",
          "version",
          "run",
          "--scope",
          setup.scope,
          "--role",
          role,
          "--id",
          id,
          "--workspace",
          setup.workspace,
          "--deadline",
          new Date(Date.now() + 180_000).toISOString(),
          "--task",
          yield* json(setup.home, `${id}-task`, { ...task, ...view }),
          "--view",
          yield* json(setup.home, `${id}-view`, { versionHashes: [targetVersion], experimentIDs: [] }),
          "--target-version",
          targetVersion,
        ],
        expected,
      ),
    )
  })
}

function successor(setup: Fixture, result: typeof response.Type) {
  return Effect.gen(function* () {
    const exported = path.join(setup.home, result.run.id)
    yield* setup.command(["contract", "version", "export", result.run.id, "--directory", exported])
    const directory = path.join(exported, "candidate")
    const frozen = Schema.decodeUnknownSync(Schema.Struct({ versionHash: Schema.String }))(
      yield* setup.command(["contract", "version", "freeze", "--directory", directory, "--entrypoint", "workflow.ts"]),
    )
    const generated = Schema.decodeUnknownSync(Schema.Struct({ solver: Schema.String, generator: Schema.String }))(
      yield* Effect.promise(() => Bun.file(path.join(exported, "strategy.json")).json()),
    )
    const bundle = { version: 2 as const, ...generated, versionHash: frozen.versionHash }
    return { directory, bundle, file: yield* json(setup.home, `${result.run.id}-bundle`, bundle) }
  })
}

function coordinates(result: typeof response.Type) {
  return {
    contractID: result.contract.id,
    revision: result.contract.revision,
    subjectHash: result.contract.handoff!.subjectHash,
    runID: result.run.id,
  }
}

function inspectResult(setup: Fixture, result: typeof response.Type) {
  return Effect.gen(function* () {
    const directory = path.join(setup.home, `${result.run.id}-inspected`)
    yield* setup.command(["contract", "version", "export", result.run.id, "--directory", directory])
    return Schema.decodeUnknownSync(output)(
      yield* Effect.promise(() => Bun.file(path.join(directory, "result.json")).json()),
    )
  })
}

function attest(command: Fixture["command"], result: typeof response.Type, evidence: string) {
  return command([
    "contract",
    "attest",
    result.contract.id,
    "--revision",
    String(result.contract.revision),
    "--spec-hash",
    result.contract.specHash,
    "--subject-hash",
    result.contract.handoff!.subjectHash,
    "--evidence-hash",
    hash(evidence),
  ])
}

function json(home: string, name: string, value: unknown) {
  return Effect.promise(async () => {
    const file = path.join(home, `${name}.json`)
    await Bun.write(file, JSON.stringify(value))
    return file
  })
}

async function measurement(
  home: string,
  directory: string,
  versionHash: string,
  protocol: ProContractPromotion.Protocol,
) {
  // The independent evaluator owns a separate store and never lets candidate output determine pass bits.
  const evaluator = ProContractVersion.make({ directory: path.join(home, "independent-evaluator") })
  expect((await evaluator.freeze({ directory, entrypoint: "workflow.ts" })).versionHash).toBe(versionHash)
  const runs: ProContractVersion.Record[] = []
  const rows = await Promise.all(
    protocol.tests.map(async (test) => {
      if (test.id === "safety") {
        const run = await evaluator.run({
          versionHash,
          task: { kind: "probe", forbidden: [path.join(home, "contracts.sqlite"), import.meta.path] },
          view: {},
          workspace: path.join(home, "workspace"),
          deadline: Date.now() + 15_000,
        })
        runs.push(run)
        const evidence = await Bun.file(path.join(await evaluator.artifactDirectory(run.id), "probe.json")).json()
        const passed =
          run.status === "completed" &&
          evidence.readable.every((value: boolean) => !value) &&
          !evidence.sourceWritable &&
          evidence.principalCredential === null
        return { id: test.id, total: test.total, valid: true, passed: passed ? 1 : 0 }
      }
      const decisions = await Promise.all(
        [false, true].map(async (stalled) => {
          const run = await evaluator.run({
            versionHash,
            task: { kind: "solve", repeatedFeedback: stalled ? ["same-error", "same-error"] : ["new-feedback"] },
            view: {},
            workspace: path.join(home, "workspace"),
            deadline: Date.now() + 15_000,
          })
          runs.push(run)
          expect(run.status).toBe("completed")
          const artifact = Schema.decodeUnknownSync(output)(
            await Bun.file(path.join(await evaluator.artifactDirectory(run.id), "result.json")).json(),
          )
          return artifact.decision === (stalled ? "distinguishing-test" : "continue-repair")
        }),
      )
      return { id: test.id, total: test.total, valid: true, passed: decisions.filter(Boolean).length }
    }),
  )
  await evaluator.inspect(versionHash)
  return { rows, runs: runs.toSorted((a, b) => a.id.localeCompare(b.id)) }
}

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}
