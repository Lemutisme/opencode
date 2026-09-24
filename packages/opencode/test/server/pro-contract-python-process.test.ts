import { expect } from "bun:test"
import path from "node:path"
import { chmod, cp, readdir, rename } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { Hash } from "@opencode-ai/core/util/hash"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { start } from "../../script/research-eval/host"
import { launcher } from "../../script/research-eval/isolation"
import { processIdentity } from "../../script/research-eval/observe"
import { contractProcess } from "../fixture/contract-process"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, NodeServices.layer, FetchHttpClient.layer))
const pytorch = `import json, torch
torch.set_num_threads(1)
x = torch.tensor([2., 3.], requires_grad=True)
loss = (x * x).sum()
loss.backward()
assert loss.item() == 13 and x.grad.tolist() == [4., 6.]
open('result.json', 'w').write(json.dumps({'loss': loss.item(), 'gradient': x.grad.tolist(), 'torch': torch.__version__}))
print('PYTORCH_BACKPROP_EXECUTED', flush=True)
import ctypes, errno, os, socket
libc = ctypes.CDLL(None, use_errno=True)
assert libc.prctl(1, 0, 0, 0, 0) == -1 and ctypes.get_errno() == errno.EPERM
assert libc.syscall(317, 1, 0, 0) == -1 and ctypes.get_errno() == errno.EPERM
class Filter(ctypes.Structure):
 _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]
class Program(ctypes.Structure):
 _fields_ = [('length', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]
allow = Filter(6, 0, 0, 0x7fff0000)
program = Program(1, ctypes.pointer(allow))
assert libc.prctl(22, 2, ctypes.byref(program), 0, 0) == 0
# An added ALLOW filter cannot undo existing Landlock/seccomp restrictions.
for action in [lambda: open('check.py', 'w'), lambda: open('/etc/passwd'), lambda: socket.socket().connect(('127.0.0.1', 8317)), lambda: os.setsid()]:
 try: action()
 except PermissionError: pass
 else: raise AssertionError('nested sandbox boundary bypass')
`
const setup = Effect.fnUntraced(function* (mode: string, source = pytorch, planning = false) {
  const fixture = yield* contractProcess
  const llm = yield* TestLLMServer
  // Test the actual inherited gateway, not merely a port the outer host also denies.
  const harness = source.replaceAll("8317", new URL(llm.url).port)
  const binary = (executable: string) =>
    Effect.promise(async () => ({
      executable,
      executableHash: Hash.sha256(Buffer.from(await Bun.file(executable).arrayBuffer())),
    }))
  const isolation = yield* Effect.promise(() => launcher(fixture.storage))
  const python = mode === "startup" ? path.join(fixture.storage, "broken-python") : "/usr/local/bin/python"
  yield* Effect.promise(async () => {
    await Bun.write(
      path.join(fixture.storage, "config/opencode/opencode.json"),
      await Bun.file(path.join(fixture.directory, "opencode.json")).text(),
    )
    await Bun.write(
      path.join(fixture.storage, "models.json"),
      await Bun.file(path.join(import.meta.dir, "../tool/fixtures/models-api.json")).text(),
    )
    await Bun.write(path.join(fixture.directory, "check.py"), harness)
    await Bun.write(path.join(fixture.directory, "notes.txt"), "fixture task")
    if (mode === "startup") {
      await Bun.write(python, "#!/missing/interpreter\n")
      await chmod(python, 0o700)
    }
  })
  const input = {
    planning,
    id: `pct_python_${crypto.randomUUID()}`,
    scope: "python-production-entry",
    source: { directory: fixture.directory },
    model: { providerID: "local", id: "researcher" },
    spec: {
      trigger: { type: "immediate" },
      goal: "Run a bounded CPU tensor experiment",
      brief: "Compute loss and gradient with PyTorch and deliver evidence.",
      requires: [],
      authority: ["filesystem.read", "filesystem.write", "process.execute"],
      budget: { deadline: Date.now() + (mode === "deadline" ? 14_000 : 21_600_000) },
      evidence: { type: "principal", claim: "External recognition only" },
      resolution: { retryDelay: 1 },
    },
    manifest: {
      version: 1,
      requirements: ["Compute loss 13 and gradient [4,6]"],
      include: ["check.py", "notes.txt", "result.json", "opencode.json"],
      dependencies: [],
      verification: {
        adapter: "python-script:1",
        ...(yield* binary("/usr/bin/node")),
        python: yield* binary(python),
        isolation: yield* binary(isolation),
        tests: ["check.py"],
        harness: [{ path: "check.py", hash: Hash.sha256(harness) }],
        expectedTests: ["tensor gradient"],
        minimumTests: 1,
        maximumSkipped: 0,
        timeout: mode === "timeout" ? 3000 : 30_000,
      },
      artifacts: [{ path: "result.json", kind: "generated" }],
      reviewer: {
        model: { providerID: "local", id: "researcher" },
        agent: "deliberately-unavailable-reviewer",
        instructions: "Independent review is advisory",
      },
    },
  }
  const controller = new AbortController()
  const host = yield* Effect.promise(() =>
    start({
      storage: fixture.storage,
      directory: fixture.directory,
      launcher: isolation,
      port: Number(new URL(llm.url).port),
      bun: process.execPath,
      timeout: 30_000,
      infrastructure: { version: 1, startup: 30_000, operation: 30_000, cleanup: 30_000, journal: "cas:1" },
      deadline: input.spec.budget.deadline,
      signal: controller.signal,
    }),
  )
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await host.stop()
      if (process.env.RESEARCH_PYTHON_TEST_ARCHIVE)
        await cp(fixture.storage, path.join(process.env.RESEARCH_PYTHON_TEST_ARCHIVE, mode + "-" + input.id), {
          recursive: true,
        })
    }),
  )
  const command = (action: string, id: string = input.id, payload?: unknown) =>
    Effect.promise(() => host.command(action, id, payload))
  const gate = Promise.withResolvers<void>()
  yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
  yield* llm.push(reply().tool("read", { path: "notes.txt" }).wait(gate.promise))
  const run = (yield* command("research-issue", input.id, input)) as ResearchModel.Run
  yield* llm.wait(1)
  expect(run.input.spec.budget).toEqual({ deadline: input.spec.budget.deadline })
  return { fixture, llm, host, command, input, run, gate, calls: 1 }
})
type State = Effect.Success<ReturnType<typeof setup>>
const get = (s: State) => s.command("research-get").pipe(Effect.map((value) => value as ResearchModel.Run))
const stage = (s: State, expected: ResearchModel.Run["stage"]) =>
  pollWithTimeout(
    get(s).pipe(Effect.map((run) => (run.stage === expected ? run : undefined))),
    `Did not reach ${expected}`,
    "40 seconds",
  )
const advance = Effect.fnUntraced(function* (s: State, actions: ReturnType<typeof reply>[]) {
  const gate = Promise.withResolvers<void>()
  yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
  yield* s.llm.push(...actions, reply().tool("read", { path: "notes.txt" }).wait(gate.promise))
  s.gate.resolve()
  yield* s.llm.wait(s.calls + actions.length + 1).pipe(
    Effect.timeout("35 seconds"),
    Effect.tapError(() => get(s).pipe(Effect.tap((run) => Effect.sync(() => console.error(run.stage, run.reason))))),
  )
  return { ...s, gate, calls: s.calls + actions.length + 1, run: yield* get(s) }
})
const view = Effect.fnUntraced(function* (s: State) {
  const next = yield* advance(s, [reply().tool("contract_request", { kind: "research_view", payload: {} })])
  const input = (yield* s.llm.inputs).at(-1) as { messages: { role: string; content: string }[] }
  const result = JSON.parse(input.messages.filter((message) => message.role === "tool").at(-1)!.content).result as {
    view: string
    actions: { plan: { kind: string; payload: Record<string, unknown> } }
    experiment?: { verdict: string; reason: string }
  }
  return { ...next, view: result }
})
const prepare = (s: Effect.Success<ReturnType<typeof view>>) =>
  reply().tool("contract_request", {
    kind: "prepare_candidate",
    payload: { view: s.view.view, summary: "Actual formal result", uncertainties: [] },
  })
const verification = Effect.fnUntraced(function* (s: State, run: ResearchModel.Run) {
  const hash = run.verificationHash ?? run.lastExperiment?.verificationHash ?? run.previous.at(-1)?.verificationHash
  expect(hash).toBeDefined()
  const raw = String(yield* s.command("research-object", hash!))
  expect(Hash.sha256(raw)).toBe(hash!)
  const result = JSON.parse(raw) as ResearchModel.Verification
  for (const file of result.evidence) {
    const bytes = String(yield* s.command("research-object", file.hash))
    expect(Hash.sha256(bytes)).toBe(file.hash)
    expect(Buffer.byteLength(bytes)).toBe(file.bytes)
  }
  return result
})

it.live(
  "Python interpreter/launcher identity changes still prevent formal execution",
  () =>
    Effect.gen(function* () {
      const initial = yield* view(yield* setup("identity"))
      yield* Effect.promise(async () => {
        const target = initial.input.manifest.verification.isolation.executable
        await Bun.write(target + ".replacement", "changed launcher")
        await rename(target + ".replacement", target)
      })
      yield* initial.llm.push(prepare(initial))
      initial.gate.resolve()
      const run = yield* stage(initial, "unavailable")
      expect(run.reason).toContain("Approved verifier executable changed")
      expect(run.bundleHash).toBeUndefined()
      expect(run.verificationHash).toBeUndefined()
      expect(run.input.spec.budget.deadline).toBe(initial.input.spec.budget.deadline)
    }),
  60_000,
)

it.live(
  "changed Python harness is rejected before executing its replacement",
  () =>
    Effect.gen(function* () {
      const initial = yield* view(yield* setup("protected"))
      yield* Effect.promise(() =>
        Bun.write(path.join(initial.run.workspace.directory, "check.py"), "print('unauthorized replacement')"),
      )
      const failed = yield* advance(initial, [prepare(initial)])
      const result = yield* verification(failed, failed.run)
      expect(result.verdict).toBe("failed")
      expect(result.reason).toContain("Protected input changed before execution; no test ran")
      const replay = JSON.parse(String(yield* failed.command("research-object", result.replay.evidenceHash)))
      expect(replay.checks).toHaveLength(0)
      expect(failed.run.bundleHash).toBeUndefined()
      yield* failed.command("research-cancel")
    }),
  60_000,
)

it.live(
  "production host runs PyTorch backprop, archives evidence, and submits with zero responses",
  () =>
    Effect.gen(function* () {
      const initial = yield* view(yield* setup("success", pytorch, true))
      const planned = yield* view(
        yield* advance(initial, [reply().tool("contract_request", initial.view.actions.plan)]),
      )
      expect(planned.run.stage).toBe("execution")
      const tested = yield* view(
        yield* advance(planned, [
          reply().tool("contract_request", { kind: "experiment", payload: { view: planned.view.view } }),
        ]),
      )
      expect(tested.view.experiment?.verdict).toBe("passed")
      const result = yield* verification(tested, tested.run)
      expect(result.verdict).toBe("passed")
      const artifact = result.evidence.find((file) => file.path === "artifacts/result.json")!
      expect(JSON.parse(String(yield* tested.command("research-object", artifact.hash)))).toMatchObject({
        loss: 13,
        gradient: [4, 6],
      })
      expect(tested.run.executionPrompt).toContain("submit_candidate")
      const feedback = yield* view(yield* advance(tested, [prepare(tested)]))
      expect(feedback.run.stage).toBe("feedback")
      yield* feedback.llm.push(
        reply().tool("contract_request", { kind: "submit_candidate", payload: { view: feedback.view.view } }),
      )
      feedback.gate.resolve()
      const ready = yield* stage(feedback, "ready")
      const bundle = JSON.parse(String(yield* feedback.command("research-object", ready.bundleHash!)))
      expect(bundle.treatment.status).toBe("not_provided")
      expect(
        bundle.feedback.every(
          (item: { outcome: { availability: string } }) => item.outcome.availability === "unavailable",
        ),
      ).toBe(true)
      expect(ready.input.spec.budget.deadline).toBe(initial.input.spec.budget.deadline)
    }),
  120_000,
)

it.live(
  "production host reports a real Python assertion failure and resumes Researcher with evidence",
  () =>
    Effect.gen(function* () {
      const initial = yield* view(
        yield* setup("failure", pytorch + "raise AssertionError('intentional gradient acceptance failure')\n"),
      )
      const failed = yield* advance(initial, [prepare(initial)])
      expect(failed.run.stage).toBe("execution")
      const result = yield* verification(failed, failed.run)
      expect(result.verdict).toBe("failed")
      expect(result.reason).toContain("Python started")
      expect(failed.run.executionPrompt).toContain("Python started")
      const stderr = result.evidence.find((file) => file.path === "check-0-stderr.txt")!
      expect(String(yield* failed.command("research-object", stderr.hash))).toContain(
        "intentional gradient acceptance failure",
      )
      expect(result.evidence.some((file) => file.path === "artifacts/result.json")).toBe(true)
      yield* failed.command("research-cancel")
    }),
  90_000,
)

for (const mode of ["startup", "timeout"])
  it.live(
    `production host records ${mode} as unavailable with preserved evidence`,
    () =>
      Effect.gen(function* () {
        const initial = yield* view(
          yield* setup(mode, mode === "timeout" ? pytorch + "import time\ntime.sleep(60)\n" : pytorch),
        )
        yield* initial.llm.push(prepare(initial))
        initial.gate.resolve()
        const run = yield* stage(initial, "unavailable")
        const result = yield* verification(initial, run)
        expect(result.verdict).toBe("unavailable")
        expect(result.reason).toContain(mode === "startup" ? "did not start" : "interrupted")
        expect(run.bundleHash).toBeUndefined()
        expect(run.input.spec.budget.deadline).toBe(initial.input.spec.budget.deadline)
        if (mode === "timeout") {
          const replay = JSON.parse(String(yield* initial.command("research-object", result.replay.evidenceHash)))
          expect(replay.checks[0].observation.receipt.execution).toBe("timed-out")
        }
      }),
    90_000,
  )

for (const mode of ["cancel", "deadline"])
  it.live(
    `production ${mode} stops Python and descendants and preserves available evidence`,
    () =>
      Effect.gen(function* () {
        const initial = yield* view(
          yield* setup(
            mode,
            pytorch +
              `import os, time, subprocess, sys
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
open('result.json', 'w').write(json.dumps({'parent': os.getpid(), 'child': child.pid}))
print('WAITING_FOR_CANCEL', flush=True)
time.sleep(60)
`,
          ),
        )
        yield* initial.llm.push(prepare(initial))
        initial.gate.resolve()
        const pids = yield* pollWithTimeout(
          Effect.promise(async () => {
            const root = path.join(initial.fixture.storage, "tmp")
            const paths = await readdir(root, { recursive: true })
            for (const name of paths.filter((name) => name.endsWith("/result.json"))) {
              const text = await Bun.file(path.join(root, name)).text()
              if (text.includes('"parent"')) return JSON.parse(text) as { parent: number; child: number }
            }
          }),
          "Python did not publish cancellation readiness",
          "30 seconds",
        )
        const before = yield* get(initial)
        if (mode === "deadline") {
          // The actual launch boundary closes IPC at the original deadline.
          // Observe cleanup offline; do not extend it to obtain a nicer terminal record.
          yield* Effect.promise(() => initial.host.child.exited).pipe(Effect.timeout("20 seconds"))
          yield* Effect.promise(() => initial.host.stop())
          expect(Date.now()).toBeGreaterThanOrEqual(initial.input.spec.budget.deadline)
          expect(before.input.spec.budget.deadline).toBe(initial.input.spec.budget.deadline)
          expect(yield* Effect.promise(() => processIdentity(pids.parent))).toBeUndefined()
          expect(yield* Effect.promise(() => processIdentity(pids.child))).toBeUndefined()
          const files = yield* Effect.promise(() => readdir(initial.fixture.storage))
          const cleanup = yield* Effect.promise(() =>
            Bun.file(
              path.join(
                initial.fixture.storage,
                files.find((file) => file.startsWith("cleanup-") && file.endsWith(".json"))!,
              ),
            ).json(),
          )
          expect(cleanup).toMatchObject({ status: "confirmed", reason: "original_deadline", complete: true })
          const closed = yield* Effect.promise(() =>
            initial.host.command("research-get", initial.input.id).then(
              () => false,
              () => true,
            ),
          )
          expect(closed).toBe(true)
          return
        }
        if (mode === "cancel") yield* initial.command("research-cancel")
        const cancelled = yield* stage(initial, mode === "cancel" ? "cancelled" : "unavailable")
        expect(cancelled.bundleHash).toBeUndefined()
        yield* pollWithTimeout(
          Effect.promise(async () =>
            !(await processIdentity(pids.parent)) && !(await processIdentity(pids.child)) ? true : undefined,
          ),
          "Python tree survived cancellation",
          "15 seconds",
        )
        const job = (yield* initial.command("job-get", before.verifierJobID!)) as ProContractJob.Job
        expect(mode === "cancel" ? ["cancelled", "interrupted"] : ["cancelled", "interrupted", "failed"]).toContain(
          job.status,
        )
        const replay = yield* pollWithTimeout(
          Effect.promise(async () => {
            const directory = path.join(initial.fixture.storage, "data/opencode/pro-contract/replay")
            const files = await readdir(directory).catch(() => [] as string[])
            for (const name of files.filter((name) => name.endsWith(".json"))) {
              const raw = await Bun.file(path.join(directory, name)).text()
              const value = JSON.parse(raw)
              if (
                value.contractID === initial.input.id &&
                value.checks.some(
                  (check: { observation: { receipt: { execution: string } } }) =>
                    check.observation.receipt.execution !== "completed",
                )
              ) {
                expect(Hash.sha256(raw)).toBe(name.slice(0, -5))
                return value
              }
            }
          }),
          "Cancellation replay was not retained",
          "15 seconds",
        )
        if (mode === "cancel") expect(replay.incomplete.reason).toBe("interrupted")
        expect(replay.passed).toBe(false)
        expect(replay.checks[0].observation.receipt.execution).not.toBe("completed")
        expect(cancelled.input.spec.budget.deadline).toBe(initial.input.spec.budget.deadline)
      }),
    90_000,
  )
