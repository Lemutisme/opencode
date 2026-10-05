import { expect } from "bun:test"
import { LLMClient, LLMError, LLMEvent, Model, type LLMRequest } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { mkdir, readdir, rm, symlink } from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber, Layer, Schedule, Schema, Scope, Stream } from "effect"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { ModelV2 } from "../src/model"
import { ProContract } from "../src/pro-contract"
import { ProContractOpenCode } from "../src/pro-contract/open-code"
import { ProContractPolicy } from "../src/pro-contract/policy"
import { ProContractPromotion } from "../src/pro-contract/promotion"
import { ProContractRun } from "../src/pro-contract/run"
import { ProContractVersion } from "../src/pro-contract/version"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionExecutionLocal } from "../src/session/execution/local"
import { SessionRunnerModel } from "../src/session/runner/model"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const emit = `console.log(JSON.stringify({version:1,observations:["executed"],requests:[],artifacts:[]}))`
const answer = "Test whether repeated feedback adds information before opening another branch."
const model = ModelV2.Ref.make({ providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("reason") })
const protocol: ProContractPromotion.Protocol = {
  version: 1,
  performanceRule: "task-pareto",
  evaluatorHash: Hash.sha256("protected evaluator"),
  tests: [
    { id: "safety", total: 1 },
    ...(["development", "confirmation"] as const).flatMap((panel) =>
      ["0", "1"].map((replicate) => ({
        id: `${panel}-${replicate}`,
        total: 2,
        performance: { panel, task: "task", replicate },
      })),
    ),
  ],
}

function fixture<A, E>(
  code: string,
  run: (context: {
    input: Parameters<ProContractRun.Interface["issue"]>[0]
    versions: ReturnType<typeof ProContractVersion.make>
    directory: string
    seed: ProContractPolicy.Bundle
    requests: LLMRequest[]
  }) => Effect.Effect<
    A,
    E,
    | ProContractRun.Service
    | ProContractPolicy.Service
    | ProContract.Service
    | ProContractOpenCode.Service
    | SessionV2.Service
    | SessionExecution.Service
    | Scope.Scope
  >,
  stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError> = () =>
    Stream.fromArray([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.textStart({ id: "answer" }),
      LLMEvent.textDelta({ id: "answer", text: answer }),
      LLMEvent.textEnd({ id: "answer" }),
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: { inputTokens: 10, nonCachedInputTokens: 10, outputTokens: 5 },
      }),
      LLMEvent.finish({ reason: "stop" }),
    ]),
) {
  return Effect.gen(function* () {
    const temporary = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (temporary) => Effect.promise(() => temporary[Symbol.asyncDispose]()),
    )
    const data = path.join(temporary.path, "host", "data")
    const directory = ProContractVersion.storePath(data)
    const workspace = AbsolutePath.make(path.join(temporary.path, "workspace"))
    const source = path.join(temporary.path, "source")
    yield* Effect.promise(async () => {
      await mkdir(workspace)
      await Bun.write(path.join(workspace, "input.txt"), "frozen input")
      await Bun.write(path.join(workspace, "AGENTS.md"), "PRIVATE_WORKSPACE_INSTRUCTIONS")
      await Bun.write(path.join(source, "workflow.ts"), code)
    })
    const versions = ProContractVersion.make({ directory })
    const frozen = yield* Effect.promise(() => versions.freeze({ directory: source, entrypoint: "workflow.ts" }))
    const seed: ProContractPolicy.Bundle = {
      version: 2,
      solver: "Serve using frozen approved input.",
      generator: "Research from allowed observations; suggest, never authorize.",
      versionHash: frozen.versionHash,
    }
    const requests: LLMRequest[] = []
    return yield* Effect.gen(function* () {
      const policies = yield* ProContractPolicy.Service
      const now = Date.now()
      yield* policies.authorize({ scope: "host-run-fixture", protocol, bundle: seed, now })
      return yield* run({
        input: {
          id: ProContract.ID.create(),
          scope: "host-run-fixture",
          role: "research_executor",
          task: { purpose: "research" },
          workspace,
          deadline: now + 30_000,
          now,
        },
        versions,
        directory,
        seed,
        requests,
      })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            ProContractRun.node,
            ProContractPolicy.node,
            ProContract.node,
            ProContractOpenCode.node,
            SessionV2.node,
            SessionExecution.node,
          ]),
          [
            [Database.node, Database.layerFromPath(path.join(temporary.path, "host", "contract.db"))],
            [
              Global.node,
              Global.layerWith({
                data,
                config: path.join(temporary.path, "host", "config"),
                state: path.join(temporary.path, "host", "state"),
                cache: path.join(temporary.path, "host", "cache"),
              }),
            ],
            [SessionExecution.node, SessionExecutionLocal.node],
            [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
            [
              SessionRunnerModel.node,
              SessionRunnerModel.layerWith(() =>
                Effect.succeed(Model.make({ id: "reason", provider: "fixture", route })),
              ),
            ],
            [
              LayerNodePlatform.llmClient,
              Layer.succeed(
                LLMClient.Service,
                LLMClient.Service.of({
                  prepare: () => Effect.die("No external provider in host-run fixture"),
                  generate: () => Effect.die("No external provider in host-run fixture"),
                  stream: (request) => {
                    requests.push(request)
                    return stream(request)
                  },
                }),
              ),
            ],
          ],
        ),
      ),
    )
  })
}

it.live("a retry after independent research selection adopts its admitted version, not the newly selected method", () =>
  fixture(
    `await Bun.write("candidate/workflow.ts", ${JSON.stringify(emit)});
     await Bun.write("strategy.json", JSON.stringify({version:1,solver:"new solver",generator:"new researcher"}));
     console.log(JSON.stringify({version:1,observations:[],requests:[],artifacts:["candidate","strategy.json"]}));`,
    ({ input, versions }) =>
      Effect.gen(function* () {
        const runs = yield* ProContractRun.Service
        const policies = yield* ProContractPolicy.Service
        const prior = yield* runs.issue(input)
        const generation = yield* runs.execute({ contractID: prior.id })
        const frozen = yield* Effect.promise(async () =>
          versions.freeze({
            directory: path.join(await versions.artifactDirectory(generation.run.id), "candidate"),
            entrypoint: "workflow.ts",
          }),
        )
        const bundle = {
          version: 2,
          solver: "new solver",
          generator: "new researcher",
          versionHash: frozen.versionHash,
        } as const
        yield* policies.archiveCandidate({
          scope: input.scope,
          expectedRevision: 1,
          bundle,
          generation: {
            contractID: prior.id,
            revision: prior.revision,
            subjectHash: ProContractVersion.subjectHash(generation.run),
            runID: generation.run.id,
          },
          now: Date.now(),
        })
        const qualified = yield* Effect.promise(() =>
          versions.run({
            versionHash: frozen.versionHash,
            task: { purpose: "qualification" },
            view: {},
            workspace: input.workspace,
            deadline: input.deadline,
          }),
        )
        yield* policies.selectResearch({
          scope: input.scope,
          expectedRevision: 1,
          bundleHash: ProContractPolicy.hashBundle(bundle),
          qualification: { runID: qualified.id, evidenceHash: ProContractVersion.subjectHash(qualified) },
          now: Date.now(),
        })
        expect((yield* runs.issue(input)).executor).toBe(prior.executor)
        expect((yield* runs.issue({ ...input, id: ProContract.ID.create() })).executor).toBe(
          `version:${frozen.versionHash}`,
        )
        expect((yield* policies.bind({ scope: input.scope, role: "incumbent" })).versionHash).toBe(
          generation.run.versionHash,
        )
        expect(Exit.isFailure(yield* runs.issue({ ...input, task: "conflicting retry" }).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* runs.issue({ ...input, deadline: input.deadline + 1 }).pipe(Effect.exit))).toBe(
          true,
        )
        expect((yield* runs.get(prior.id)).runs).toHaveLength(1)
      }),
  ),
)

it.live("withdrawing execution permission retains independently accepted work and completed execution receipts", () =>
  fixture(emit, ({ input }) =>
    Effect.gen(function* () {
      const runs = yield* ProContractRun.Service
      const contracts = yield* ProContract.Service
      const policies = yield* ProContractPolicy.Service
      const prior = yield* runs.issue(input)
      const result = yield* runs.execute({ contractID: prior.id })
      expect(result.contract.status).toBe("verification")
      expect(result.contract.spec.requires).toEqual([])
      expect(result.contract.spec.budget).toEqual({ deadline: input.deadline })
      yield* contracts.principalAttest({
        contractID: prior.id,
        revision: prior.revision,
        specHash: prior.specHash,
        subjectHash: ProContractVersion.subjectHash(result.run),
        evidenceHash: Hash.sha256("Independent inspection of actual task output"),
      })
      const accepted = yield* contracts.get(prior.id)
      yield* policies.revoke({
        scope: input.scope,
        expectedRevision: 1,
        role: "research_executor",
        evidenceHash: Hash.sha256("Stop future execution, not evidence supporting this result"),
        now: Date.now(),
      })
      expect(yield* contracts.get(prior.id)).toEqual(accepted)
      expect(accepted?.status).toBe("discharged")
      expect((yield* runs.execute({ contractID: prior.id })).run).toEqual(result.run)
      expect((yield* runs.get(prior.id)).runs).toEqual([result.run])
    }),
  ),
)

it.live(
  "cancellation at the input-capture boundary joins the invocation instead of waiting for its original deadline",
  () =>
    fixture(
      `const input = await Bun.stdin.json();
     if (!input.view.previous.length) await Bun.sleep(30_000);
     console.log(JSON.stringify({version:1,observations:[await Bun.file("input.txt").text()],requests:[],artifacts:[]}));`,
      ({ input, directory }) =>
        Effect.gen(function* () {
          const runs = yield* ProContractRun.Service
          const prior = yield* runs.issue(input)
          const running = yield* runs.execute({ contractID: prior.id }).pipe(Effect.forkScoped)
          const captured = yield* runs.get(prior.id).pipe(
            Effect.flatMap((state) =>
              Effect.promise(async () => {
                if (!state.pending.length) return false
                const file = Bun.file(path.join(directory, "runs", state.pending[0], "input.json"))
                if (!(await file.exists())) return false
                return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ complete: Schema.Boolean })))(
                  await file.text(),
                ).complete
              }),
            ),
            Effect.repeat({ while: (ready) => !ready, times: 500, schedule: Schedule.spaced("10 millis") }),
          )
          expect(captured).toBe(true)
          yield* Fiber.interrupt(running)
          const retained = yield* runs.get(prior.id)
          expect(retained.contract.status).toBe("escalated")
          expect(retained.pending).toEqual([])
          expect(retained.runs).toHaveLength(1)
          expect(retained.runs[0].status).toBe("cancelled")
          expect(retained.contract.spec.budget).toEqual({ deadline: input.deadline })
        }),
    ),
)

it.live("cancelled executable work needs explicit resume and reuses the original input and deadline", () =>
  fixture(
    `const input = await Bun.stdin.json();
     if (!input.view.previous.length) {
       await Bun.write("started", "candidate entered its blocking operation");
       await Bun.sleep(30_000);
     }
     console.log(JSON.stringify({version:1,observations:[await Bun.file("input.txt").text()],requests:[],artifacts:[]}));`,
    ({ input, directory, versions }) =>
      Effect.gen(function* () {
        const runs = yield* ProContractRun.Service
        const contracts = yield* ProContract.Service
        const prior = yield* runs.issue(input)
        const running = yield* runs.execute({ contractID: prior.id }).pipe(Effect.forkScoped)
        const started = yield* runs.get(prior.id).pipe(
          Effect.flatMap((state) =>
            Effect.promise(async () => {
              if (!state.pending.length) return false
              return Bun.file(path.join(directory, "runs", state.pending[0], "workspace", "started")).exists()
            }),
          ),
          Effect.repeat({ while: (ready) => !ready, times: 500, schedule: Schedule.spaced("10 millis") }),
        )
        expect(started).toBe(true)
        yield* Fiber.interrupt(running)
        expect((yield* contracts.get(prior.id))?.status).toBe("escalated")
        const cancelled = yield* runs.get(prior.id)
        expect(cancelled.runs[0]?.status).toBe("cancelled")
        expect(Exit.isFailure(yield* runs.execute({ contractID: prior.id }).pipe(Effect.exit))).toBe(true)
        expect((yield* runs.get(prior.id)).runs).toEqual(cancelled.runs)
        yield* Effect.promise(() => Bun.write(path.join(input.workspace, "input.txt"), "changed after cancellation"))
        const resumed = yield* runs.execute({ contractID: prior.id, resume: true })
        expect(resumed.contract.status).toBe("verification")
        expect(resumed.run.result?.observations).toEqual(["frozen input"])
        expect(resumed.contract.spec.budget).toEqual({ deadline: input.deadline })
        const retained = yield* runs.get(prior.id)
        expect(retained.runs).toHaveLength(2)
        expect(retained.runs[0]).toEqual(cancelled.runs[0])
        expect(yield* Effect.promise(() => versions.request(resumed.run.id))).toMatchObject({
          deadline: input.deadline,
        })
      }),
  ),
)

it.live("an interrupted invocation is unknown, not fabricated completion, and cannot automatically replay", () =>
  fixture(emit, ({ input, directory }) =>
    Effect.gen(function* () {
      const runs = yield* ProContractRun.Service
      const contracts = yield* ProContract.Service
      const prior = yield* runs.issue(input)
      const interrupted = crypto.randomUUID()
      // Fault injection: the durable pre-invocation claim survived, but no outcome receipt did.
      yield* Effect.promise(() =>
        Bun.write(
          path.join(directory, "contracts", Hash.sha256(prior.id) + ".json"),
          JSON.stringify({ contractID: prior.id, runs: [interrupted], responses: [], reasoning: [] }),
        ),
      )
      expect(yield* runs.get(prior.id)).toMatchObject({ runs: [], pending: [interrupted] })
      expect(Exit.isFailure(yield* runs.execute({ contractID: prior.id }).pipe(Effect.exit))).toBe(true)
      expect((yield* contracts.get(prior.id))?.status).toBe("escalated")
      expect(yield* runs.get(prior.id)).toMatchObject({ runs: [], pending: [interrupted] })
      const resumed = yield* runs.execute({ contractID: prior.id, resume: true })
      expect(resumed.contract.status).toBe("verification")
      expect(yield* runs.get(prior.id)).toMatchObject({ runs: [resumed.run], pending: [interrupted] })
      expect(
        yield* Effect.promise(() => Bun.file(path.join(directory, "runs", interrupted, "result.json")).exists()),
      ).toBe(false)
    }),
  ),
)

it.live("an expired original deadline cannot be extended by retry or explicit resume", () =>
  fixture(`await Bun.sleep(30_000); ${emit}`, ({ input }) =>
    Effect.gen(function* () {
      const runs = yield* ProContractRun.Service
      const fixed = { ...input, deadline: Date.now() + 700 }
      const prior = yield* runs.issue(fixed)
      yield* runs.execute({ contractID: prior.id }).pipe(Effect.exit)
      const expired = yield* runs.get(prior.id)
      expect(expired.runs).toHaveLength(1)
      expect(expired.runs[0].status).toBe("deadline")
      expect(expired.contract.status).toBe("escalated")
      expect(Exit.isFailure(yield* runs.execute({ contractID: prior.id, resume: true }).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* runs.issue({ ...fixed, deadline: Date.now() + 30_000 }).pipe(Effect.exit))).toBe(
        true,
      )
      expect((yield* runs.get(prior.id)).runs).toEqual(expired.runs)
      expect((yield* runs.get(prior.id)).contract.spec.budget).toEqual({ deadline: fixed.deadline })
    }),
  ),
)

it.live(
  "a native reason request uses the real strict Session runner then resumes version code with retained accounting",
  () =>
    fixture(
      `const input = await Bun.stdin.json();
     const response = input.view.responses[0];
     console.log(JSON.stringify({version:1,observations:response ? [response] : [],
       requests:response ? [] : [{type:"reason",id:"diagnose",prompt:"What distinguishes stalled feedback?"}],artifacts:[]}));`,
      ({ input, requests, versions }) =>
        Effect.gen(function* () {
          const runs = yield* ProContractRun.Service
          const contracts = yield* ProContract.Service
          const bindings = yield* ProContractOpenCode.Service
          const sessions = yield* SessionV2.Service
          const prior = yield* runs.issue({ ...input, model })
          const result = yield* runs.execute({ contractID: prior.id })
          expect(result.contract.status).toBe("verification")
          expect(result.contract.attestationID).toBeUndefined()
          expect(result.run.result?.observations).toMatchObject([
            { id: "diagnose", status: "unverified", summary: answer },
          ])
          expect(requests).toHaveLength(1)
          expect(requests[0].tools).toEqual([])
          expect(requests[0].toolChoice?.type).toBe("none")
          expect(JSON.stringify(requests[0])).not.toContain("PRIVATE_WORKSPACE_INSTRUCTIONS")
          const retained = yield* runs.get(prior.id)
          expect(retained.runs).toHaveLength(2)
          expect(retained.runs.every((run) => run.versionHash === result.run.versionHash)).toBe(true)
          expect(retained.responses).toHaveLength(1)
          expect(retained.reasoning).toEqual([
            { id: "diagnose", runID: retained.runs[0].id, contractID: retained.responses[0].contractID },
          ])
          expect(retained.responses[0].usage).toMatchObject({ turns: 1, actions: 0 })
          expect(Number.isFinite(retained.responses[0].usage.cost)).toBe(true)
          const child = yield* contracts.get(retained.responses[0].contractID)
          expect(child).toMatchObject({
            status: "released",
            spec: { requires: [], budget: { deadline: input.deadline } },
          })
          expect(child?.attestationID).toBeUndefined()
          expect(yield* bindings.get(retained.responses[0].contractID)).toMatchObject({ turnsUsed: 1, actionsUsed: 0 })
          expect(
            (yield* sessions.messages({ sessionID: retained.responses[0].sessionID })).some(
              (message) => message.type === "assistant",
            ),
          ).toBe(true)
          expect(yield* Effect.promise(() => versions.request(result.run.id))).toMatchObject({
            view: { responses: retained.responses },
            deadline: input.deadline,
          })
          expect((yield* runs.execute({ contractID: prior.id })).run).toEqual(result.run)
          expect(requests).toHaveLength(1)
        }),
    ),
)

it.live(
  "malformed reasoning requests retain process output but escalate rather than leave an active responsibility",
  () =>
    fixture(
      `console.log(JSON.stringify({version:1,observations:[],requests:[{type:"reason",id:"malformed",prompt:"question",accept:true}],artifacts:[]}));`,
      ({ input, requests }) =>
        Effect.gen(function* () {
          const runs = yield* ProContractRun.Service
          const prior = yield* runs.issue({ ...input, model })
          expect(Exit.isFailure(yield* runs.execute({ contractID: prior.id }).pipe(Effect.exit))).toBe(true)
          const retained = yield* runs.get(prior.id)
          expect(retained.contract.status).toBe("escalated")
          expect(retained.contract.handoff).toBeUndefined()
          expect(retained.runs).toHaveLength(1)
          expect(retained.runs[0].stdout).toContain('"accept":true')
          expect(requests).toHaveLength(0)
        }),
    ),
)

it.live("a duplicate reasoning request cannot replay paid provider work or leave the parent active", () =>
  fixture(
    `console.log(JSON.stringify({version:1,observations:[],requests:[{type:"reason",id:"same",prompt:"Choose the next experiment"}],artifacts:[]}));`,
    ({ input, requests }) =>
      Effect.gen(function* () {
        const runs = yield* ProContractRun.Service
        const contracts = yield* ProContract.Service
        const prior = yield* runs.issue({ ...input, model })
        expect(Exit.isFailure(yield* runs.execute({ contractID: prior.id }).pipe(Effect.exit))).toBe(true)
        const retained = yield* runs.get(prior.id)
        expect(retained.contract.status).toBe("escalated")
        expect(retained.contract.handoff).toBeUndefined()
        expect(retained.runs).toHaveLength(2)
        expect(requests).toHaveLength(1)
        expect(retained.reasoning).toHaveLength(1)
        expect(retained.responses).toHaveLength(1)
        expect((yield* contracts.get(retained.responses[0].contractID))?.status).toBe("released")
        expect(Exit.isFailure(yield* runs.execute({ contractID: prior.id }).pipe(Effect.exit))).toBe(true)
        expect(requests).toHaveLength(1)
      }),
  ),
)

it.live("interrupted native reasoning keeps its paid child reference and explicit parent resume cannot replay it", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    return yield* fixture(
      `console.log(JSON.stringify({version:1,observations:[],requests:[{type:"reason",id:"stalled",prompt:"Diagnose this failure"}],artifacts:[]}));`,
      ({ input, requests }) =>
        Effect.gen(function* () {
          const runs = yield* ProContractRun.Service
          const contracts = yield* ProContract.Service
          const bindings = yield* ProContractOpenCode.Service
          const execution = yield* SessionExecution.Service
          const prior = yield* runs.issue({ ...input, model })
          const running = yield* runs.execute({ contractID: prior.id }).pipe(Effect.forkScoped)
          yield* Deferred.await(started)
          yield* Fiber.interrupt(running)
          yield* Deferred.await(stopped)
          expect((yield* execution.active).size).toBe(0)
          expect((yield* contracts.get(prior.id))?.status).toBe("escalated")
          const retained = yield* runs.get(prior.id)
          expect(retained.responses).toEqual([])
          expect(retained.reasoning).toHaveLength(1)
          expect((yield* contracts.get(retained.reasoning[0].contractID))?.status).toBe("escalated")
          expect(yield* bindings.get(retained.reasoning[0].contractID)).toMatchObject({ turnsUsed: 1, actionsUsed: 0 })
          expect(Exit.isFailure(yield* runs.execute({ contractID: prior.id }).pipe(Effect.exit))).toBe(true)
          expect(Exit.isFailure(yield* runs.execute({ contractID: prior.id, resume: true }).pipe(Effect.exit))).toBe(
            true,
          )
          expect((yield* contracts.get(prior.id))?.status).toBe("escalated")
          expect((yield* contracts.get(retained.reasoning[0].contractID))?.spec.budget).toEqual({
            deadline: input.deadline,
          })
          expect(requests).toHaveLength(1)
        }),
      () =>
        Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))).pipe(
          Stream.ensuring(Deferred.succeed(stopped, undefined)),
        ),
    )
  }),
)

it.live(
  "releasing a parent interrupts its active native reasoning without accepting a response or running a successor",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      return yield* fixture(
        `console.log(JSON.stringify({version:1,observations:[],requests:[{type:"reason",id:"released",prompt:"Choose a discriminating test"}],artifacts:[]}));`,
        ({ input, requests }) =>
          Effect.gen(function* () {
            const runs = yield* ProContractRun.Service
            const contracts = yield* ProContract.Service
            const bindings = yield* ProContractOpenCode.Service
            const execution = yield* SessionExecution.Service
            const prior = yield* runs.issue({ ...input, model })
            const running = yield* runs.execute({ contractID: prior.id }).pipe(Effect.exit, Effect.forkScoped)
            yield* Deferred.await(started)
            expect(
              (yield* contracts.release({ contractID: prior.id, reason: "User cancels further research" })).decision
                .type,
            ).toBe("accepted")
            expect(Exit.isFailure(yield* Fiber.join(running))).toBe(true)
            yield* Deferred.await(stopped)
            const retained = yield* runs.get(prior.id)
            expect(retained.contract.status).toBe("released")
            expect(retained.contract.handoff).toBeUndefined()
            expect(retained.contract.attestationID).toBeUndefined()
            expect(retained.responses).toEqual([])
            expect(retained.runs).toHaveLength(1)
            expect(retained.reasoning).toHaveLength(1)
            expect((yield* contracts.get(retained.reasoning[0].contractID))?.status).toBe("escalated")
            expect(yield* bindings.get(retained.reasoning[0].contractID)).toMatchObject({
              turnsUsed: 1,
              actionsUsed: 0,
            })
            expect((yield* execution.active).size).toBe(0)
            expect((yield* runs.execute({ contractID: prior.id })).contract.status).toBe("released")
            expect(requests).toHaveLength(1)
            expect((yield* runs.get(prior.id)).runs).toEqual(retained.runs)
          }),
        () =>
          Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))).pipe(
            Stream.ensuring(Deferred.succeed(stopped, undefined)),
          ),
      )
    }),
)

it.live("a native reasoning request without an explicit model grant cannot become a ready handoff", () =>
  fixture(
    `console.log(JSON.stringify({version:1,observations:[],requests:[{type:"reason",id:"no-grant",prompt:"Reason without authority"}],artifacts:[]}));`,
    ({ input, requests }) =>
      Effect.gen(function* () {
        const runs = yield* ProContractRun.Service
        const prior = yield* runs.issue(input)
        expect(Exit.isFailure(yield* runs.execute({ contractID: prior.id }).pipe(Effect.exit))).toBe(true)
        const retained = yield* runs.get(prior.id)
        expect(retained.contract.status).toBe("escalated")
        expect(retained.contract.handoff).toBeUndefined()
        expect(retained.runs).toHaveLength(1)
        expect(retained.runs[0].result?.requests).toEqual([
          { type: "reason", id: "no-grant", prompt: "Reason without authority" },
        ])
        expect(retained.reasoning).toEqual([])
        expect(retained.responses).toEqual([])
        expect(requests).toHaveLength(0)
      }),
  ),
)

it.live("a run receipt without its checksum is pending, never returned as completed or silently replayed", () =>
  fixture(emit, ({ input, directory }) =>
    Effect.gen(function* () {
      const runs = yield* ProContractRun.Service
      const prior = yield* runs.issue(input)
      const completed = yield* runs.execute({ contractID: prior.id })
      const receipt = path.join(directory, "runs", completed.run.id, "result.json")
      const bytes = yield* Effect.promise(() => Bun.file(receipt).text())
      // Fault injection: retained output without the final integrity marker is not an outcome receipt.
      yield* Effect.promise(() => rm(path.join(directory, "runs", completed.run.id, "result.sha256")))
      expect(yield* runs.get(prior.id)).toMatchObject({ runs: [], pending: [completed.run.id] })
      expect(Exit.isFailure(yield* runs.execute({ contractID: prior.id }).pipe(Effect.exit))).toBe(true)
      expect(yield* runs.get(prior.id)).toMatchObject({ runs: [], pending: [completed.run.id] })
      expect(yield* Effect.promise(() => Bun.file(receipt).text())).toBe(bytes)
    }),
  ),
)

it.live("explicit recovery can capture the authorized input after cancellation before the first snapshot", () =>
  fixture(
    `console.log(JSON.stringify({version:1,observations:[await Bun.file("input.txt").text()],requests:[],artifacts:[]}));`,
    ({ input, versions, directory, seed }) =>
      Effect.gen(function* () {
        const runs = yield* ProContractRun.Service
        const contracts = yield* ProContract.Service
        const prior = yield* runs.issue(input)
        if (seed.version !== 2) return yield* Effect.die("Fixture must use a frozen executable")
        const cancelled = yield* Effect.promise(() =>
          versions.run({
            versionHash: seed.versionHash,
            targetVersion: seed.versionHash,
            task: { contractID: prior.id, revision: prior.revision, specHash: prior.specHash, input: input.task },
            view: {},
            workspace: input.workspace,
            deadline: input.deadline,
            signal: AbortSignal.abort(),
          }),
        )
        expect(cancelled.status).toBe("cancelled")
        expect(yield* Effect.promise(() => versions.input(cancelled.id))).toMatchObject({ complete: false })
        // Fault injection: process cancellation persisted before the host could reconcile its active responsibility.
        yield* contracts.activate(prior.id, prior.revision, Date.now())
        yield* Effect.promise(() =>
          Bun.write(
            path.join(directory, "contracts", Hash.sha256(prior.id) + ".json"),
            JSON.stringify({ contractID: prior.id, runs: [cancelled.id], responses: [], reasoning: [] }),
          ),
        )
        const resumed = yield* runs.execute({ contractID: prior.id, resume: true })
        expect(resumed.contract.status).toBe("verification")
        expect(resumed.run.result?.observations).toEqual(["frozen input"])
        expect(resumed.contract.spec.budget).toEqual({ deadline: input.deadline })
        expect((yield* runs.get(prior.id)).runs).toEqual([cancelled, resumed.run])
        expect(yield* Effect.promise(() => versions.input(resumed.run.id))).toMatchObject({ complete: true })
        expect(yield* Effect.promise(() => versions.read(cancelled.id))).toEqual(cancelled)
      }),
  ),
)

it.live("explicit recovery uses a crash-preserved input without inventing an outcome for the pending invocation", () =>
  fixture(
    `const input = await Bun.stdin.json();
     console.log(JSON.stringify({version:1,
       observations:[await Bun.file("input.txt").text(), (input.view.previous ?? []).map(item => ({id:item.id,status:item.status}))],
       requests:[],artifacts:[]}));`,
    ({ input, versions, directory, seed }) =>
      Effect.gen(function* () {
        const runs = yield* ProContractRun.Service
        const contracts = yield* ProContract.Service
        const prior = yield* runs.issue(input)
        if (seed.version !== 2) return yield* Effect.die("Fixture must use a frozen executable")
        const interrupted = yield* Effect.promise(() =>
          versions.run({
            versionHash: seed.versionHash,
            targetVersion: seed.versionHash,
            task: { contractID: prior.id, revision: prior.revision, specHash: prior.specHash, input: input.task },
            view: {},
            workspace: input.workspace,
            deadline: input.deadline,
          }),
        )
        expect(interrupted.status).toBe("completed")
        expect(yield* Effect.promise(() => versions.input(interrupted.id))).toMatchObject({ complete: true })
        yield* contracts.activate(prior.id, prior.revision, Date.now())
        // Fault injection: input capture survived a host crash, but final completion markers did not.
        yield* Effect.promise(async () => {
          await rm(path.join(directory, "runs", interrupted.id, "result.json"))
          await rm(path.join(directory, "runs", interrupted.id, "result.sha256"))
          await Bun.write(
            path.join(directory, "contracts", Hash.sha256(prior.id) + ".json"),
            JSON.stringify({ contractID: prior.id, runs: [interrupted.id], responses: [], reasoning: [] }),
          )
          await Bun.write(path.join(input.workspace, "input.txt"), "different input after host crash")
        })
        expect(yield* runs.get(prior.id)).toMatchObject({ runs: [], pending: [interrupted.id] })
        expect(Exit.isFailure(yield* runs.execute({ contractID: prior.id }).pipe(Effect.exit))).toBe(true)
        expect((yield* runs.get(prior.id)).contract.status).toBe("escalated")
        const resumed = yield* runs.execute({ contractID: prior.id, resume: true })
        expect(resumed.contract.status).toBe("verification")
        expect(resumed.contract.spec.budget).toEqual({ deadline: input.deadline })
        expect(resumed.run.result?.observations).toEqual(["frozen input", [{ id: interrupted.id, status: "unknown" }]])
        expect(yield* runs.get(prior.id)).toMatchObject({ runs: [resumed.run], pending: [interrupted.id] })
        expect(yield* Effect.promise(() => Bun.file(path.join(input.workspace, "input.txt")).text())).toBe(
          "different input after host crash",
        )
        expect(
          yield* Effect.promise(() => Bun.file(path.join(directory, "runs", interrupted.id, "result.json")).exists()),
        ).toBe(false)
        expect(
          yield* Effect.promise(() => Bun.file(path.join(directory, "runs", interrupted.id, "result.sha256")).exists()),
        ).toBe(false)
      }),
  ),
)

it.live("an incomplete pending input capture cannot silently fall back to a changed live workspace", () =>
  fixture(emit, ({ input, versions, directory, seed }) =>
    Effect.gen(function* () {
      const runs = yield* ProContractRun.Service
      const contracts = yield* ProContract.Service
      const prior = yield* runs.issue(input)
      if (seed.version !== 2) return yield* Effect.die("Fixture must use a frozen executable")
      const interrupted = yield* Effect.promise(() =>
        versions.run({
          versionHash: seed.versionHash,
          targetVersion: seed.versionHash,
          task: { contractID: prior.id, revision: prior.revision, specHash: prior.specHash, input: input.task },
          view: {},
          workspace: input.workspace,
          deadline: input.deadline,
        }),
      )
      expect(interrupted.status).toBe("completed")
      const original = path.join(directory, "runs", interrupted.id)
      const request = yield* Effect.promise(() => Bun.file(path.join(original, "request.json")).text())
      const checksum = yield* Effect.promise(() => Bun.file(path.join(original, "input.sha256")).text())
      yield* contracts.activate(prior.id, prior.revision, Date.now())
      // Fault injection: capture files/checksum survived, but the input manifest and final outcome did not.
      yield* Effect.promise(async () => {
        await rm(path.join(original, "result.json"))
        await rm(path.join(original, "result.sha256"))
        await rm(path.join(original, "input.json"))
        await Bun.write(
          path.join(directory, "contracts", Hash.sha256(prior.id) + ".json"),
          JSON.stringify({ contractID: prior.id, runs: [interrupted.id], responses: [], reasoning: [] }),
        )
        await Bun.write(path.join(input.workspace, "input.txt"), "unapproved changed input after crash")
      })
      expect(Exit.isFailure(yield* runs.execute({ contractID: prior.id, resume: true }).pipe(Effect.exit))).toBe(true)
      const retained = yield* runs.get(prior.id)
      expect(retained.contract.status).toBe("escalated")
      expect(retained.contract.escalation?.reason).toContain("Run input capture is incomplete")
      expect(retained.contract.handoff).toBeUndefined()
      expect(retained.runs).toEqual([])
      expect(retained.pending).toContain(interrupted.id)
      expect(yield* Effect.promise(() => readdir(path.join(directory, "runs")))).toEqual([interrupted.id])
      expect(yield* Effect.promise(() => Bun.file(path.join(original, "input", "input.txt")).text())).toBe(
        "frozen input",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(original, "request.json")).text())).toBe(request)
      expect(yield* Effect.promise(() => Bun.file(path.join(original, "input.sha256")).text())).toBe(checksum)
      expect(yield* Effect.promise(() => Bun.file(path.join(original, "input.json")).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(input.workspace, "input.txt")).text())).toBe(
        "unapproved changed input after crash",
      )
    }),
  ),
)

it.live(
  "protected storage cannot become an executable workspace through admission or post-admission symlink replacement",
  () =>
    fixture(emit, ({ input, directory }) =>
      Effect.gen(function* () {
        const runs = yield* ProContractRun.Service
        const contracts = yield* ProContract.Service
        const protectedDirectory = path.resolve(directory, "../..")
        const alias = AbsolutePath.make(path.join(path.dirname(input.workspace), "protected-alias"))
        yield* Effect.promise(async () => {
          await Bun.write(path.join(protectedDirectory, "private.txt"), "protected responsibility storage")
          await symlink(protectedDirectory, alias, "dir")
        })
        expect(Exit.isFailure(yield* runs.issue({ ...input, workspace: alias }).pipe(Effect.exit))).toBe(true)
        expect(yield* contracts.get(input.id!)).toBeUndefined()
        const prior = yield* runs.issue(input)
        yield* Effect.promise(async () => {
          await rm(input.workspace, { recursive: true })
          await symlink(protectedDirectory, input.workspace, "dir")
        })
        expect(Exit.isFailure(yield* runs.execute({ contractID: prior.id }).pipe(Effect.exit))).toBe(true)
        const retained = yield* runs.get(prior.id)
        expect(retained.contract.status).toBe("escalated")
        expect(retained.contract.handoff).toBeUndefined()
        expect(retained.runs).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(path.join(protectedDirectory, "private.txt")).text())).toBe(
          "protected responsibility storage",
        )
      }),
    ),
)

it.live(
  "explicit result dependencies survive method withdrawal but reopen when their actual evidence is challenged",
  () =>
    fixture(
      `const input = await Bun.stdin.json();
     console.log(JSON.stringify({version:1,observations:input.view.contracts ?? [],requests:[],artifacts:[]}));`,
      ({ input, versions }) =>
        Effect.gen(function* () {
          const runs = yield* ProContractRun.Service
          const contracts = yield* ProContract.Service
          const policies = yield* ProContractPolicy.Service
          const source = yield* runs.issue({ ...input, id: ProContract.ID.create(), task: "Produce prerequisite A" })
          const produced = yield* runs.execute({ contractID: source.id })
          yield* contracts.principalAttest({
            contractID: source.id,
            revision: source.revision,
            specHash: source.specHash,
            subjectHash: ProContractVersion.subjectHash(produced.run),
            evidenceHash: Hash.sha256("Independent evidence supporting prerequisite A"),
          })
          const acceptedSource = (yield* contracts.get(source.id))!
          expect(acceptedSource.status).toBe("discharged")
          const secret = ProContract.ID.create()
          yield* contracts.issue({
            id: secret,
            scope: input.scope,
            executor: "independent-principal",
            spec: {
              ...ProContract.defaultSpec("PRIVATE_UNLISTED_RESULT_SENTINEL", input.now),
              budget: { deadline: input.deadline },
            },
          })
          const dependent = {
            ...input,
            task: "Produce B using independently accepted prerequisite A",
            requires: [{ contractID: source.id, revision: source.revision }],
            view: { versionHashes: [], experimentIDs: [], contractIDs: [source.id] },
          }
          const admitted = yield* runs.issue(dependent)
          expect(admitted.spec.requires).toEqual(dependent.requires)
          expect(yield* runs.issue(dependent)).toEqual(admitted)
          expect(Exit.isFailure(yield* runs.issue({ ...dependent, requires: [] }).pipe(Effect.exit))).toBe(true)
          const invalid = ProContract.ID.create()
          expect(
            Exit.isFailure(
              yield* runs
                .issue({
                  ...input,
                  id: invalid,
                  view: { versionHashes: [], experimentIDs: [], contractIDs: [ProContract.ID.create()] },
                })
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(yield* contracts.get(invalid)).toBeUndefined()
          const result = yield* runs.execute({ contractID: admitted.id })
          const visible = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
            JSON.stringify(ProContract.info(acceptedSource)),
          )
          expect(result.contract.status).toBe("verification")
          expect(result.run.result?.observations).toEqual([visible])
          const envelope = yield* Effect.promise(() => versions.request(result.run.id))
          expect(envelope).toMatchObject({ view: { contracts: [visible] } })
          expect(JSON.stringify(envelope)).not.toContain(secret)
          expect(JSON.stringify(envelope)).not.toContain("PRIVATE_UNLISTED_RESULT_SENTINEL")
          yield* contracts.principalAttest({
            contractID: admitted.id,
            revision: admitted.revision,
            specHash: admitted.specHash,
            subjectHash: ProContractVersion.subjectHash(result.run),
            evidenceHash: Hash.sha256("Independent evidence supporting B, conditional on A"),
          })
          const acceptedResult = (yield* contracts.get(admitted.id))!
          expect(acceptedResult.status).toBe("discharged")
          yield* policies.revoke({
            scope: input.scope,
            expectedRevision: 1,
            role: "research_executor",
            evidenceHash: Hash.sha256("Withdraw this working method, not its independently verified results"),
            now: Date.now(),
          })
          expect(yield* contracts.get(source.id)).toEqual(acceptedSource)
          expect(yield* contracts.get(admitted.id)).toEqual(acceptedResult)
          yield* contracts.challenge({
            contractID: source.id,
            revision: source.revision,
            subjectHash: ProContractVersion.subjectHash(produced.run),
            evidenceHash: Hash.sha256("New independent counterevidence invalidates prerequisite A"),
            disclosure: "sealed",
            time: Date.now(),
          })
          const reopened = (yield* contracts.get(admitted.id))!
          expect(reopened.status).toBe("escalated")
          expect(reopened.escalation?.reason).toContain(source.id)
          expect(reopened.handoff).toBeUndefined()
          expect(reopened.attestationID).toBeUndefined()
          expect(reopened.spec.requires).toEqual(dependent.requires)
          expect((yield* contracts.get(source.id))?.status).toBe("escalated")
          expect(yield* contracts.getAttestation(acceptedResult.attestationID!)).toBeDefined()
          expect((yield* runs.get(admitted.id)).runs).toEqual([result.run])
        }),
    ),
)
