// Fixed-pair measurement authority. This is neither an OTA proposal nor an
// audit of successful RSI. Valid zero scores complete measurements, not tasks.
import { Database } from "bun:sqlite"
import { existsSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { ProContract } from "@opencode/schema/pro-contract"
import { ProContractKernel } from "../../core/src/pro-contract/kernel"
import { hash, SIX_HOURS, subject } from "../../core/script/ota-rsi"
import type { Pair } from "../../core/script/ota-rsi"
import type { Accounting, Driver } from "../../core/script/ota-supervisor"
import { RSIRuntime } from "./rsi-runtime"

export const EvaluationPlan = Schema.Struct({
  kind: Schema.Literal("fixed-pair-evaluation-v1"),
  purpose: Schema.Literal("measurement-only"),
  profile: RSIRuntime.File,
  pair: Schema.Struct({ s: Schema.String, h: Schema.String }),
  assignments: Schema.Array(
    Schema.Struct({ id: Schema.String, total: Schema.Int, task: Schema.String, replicate: Schema.String }),
  ),
})
export type EvaluationPlan = typeof EvaluationPlan.Type
type Result = Awaited<ReturnType<Driver["evaluate"]>>
type Source = { plan: RSIRuntime.File; profile: RSIRuntime.File }
type Assignment = {
  id: string
  test: EvaluationPlan["assignments"][number]
  pair: Pair
  status: "pending" | "active" | "closed"
  deadline?: number
  contractID?: string
  result?: Result
  failure?: string
}
type State = {
  protocol: string
  pair: Pair
  trusted: string
  source: Source
  revision: number
  clock: number
  assignments: Assignment[]
  kernel: ProContractKernel.State
  stopped?: string
}
const issuer = "native-evaluation-issuer"

export class Evaluation {
  readonly db: Database
  constructor(file: string, plan: EvaluationPlan, source: Source, trusted: string) {
    Schema.decodeUnknownSync(EvaluationPlan)(plan, { onExcessProperty: "error" })
    if (
      !plan.assignments.length ||
      new Set(plan.assignments.map((test) => test.id)).size !== plan.assignments.length ||
      new Set(plan.assignments.map((test) => JSON.stringify([test.task, test.replicate]))).size !==
        plan.assignments.length ||
      plan.assignments.some(
        (test) =>
          !test.id.trim() ||
          !test.task.trim() ||
          !test.replicate.trim() ||
          !Number.isSafeInteger(test.total) ||
          test.total <= 0,
      ) ||
      ![plan.pair.s, plan.pair.h, trusted, source.plan.sha256, source.profile.sha256].every((digest) =>
        /^[a-f0-9]{64}$/.test(digest),
      ) ||
      JSON.stringify(plan.profile) !== JSON.stringify(source.profile)
    )
      throw new Error("evaluation requires a fixed pair, source and distinct instance-repeat assignments")
    if (existsSync(file)) throw new Error("evaluation ledger exists; no implicit restart or resampling")
    this.db = new Database(file, { create: true, strict: true })
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000")
    this.db.exec(
      "CREATE TABLE rsi_evaluation(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL); CREATE TABLE rsi_evaluation_event(sequence INTEGER PRIMARY KEY,value TEXT NOT NULL)",
    )
    const protocol = hash(JSON.stringify({ plan, source, trusted }))
    const state: State = {
      protocol,
      pair: { ...plan.pair },
      trusted,
      source: structuredClone(source),
      revision: 0,
      clock: 0,
      assignments: plan.assignments.map((test) => ({
        id: hash(JSON.stringify([protocol, test.id])),
        test: { ...test },
        pair: { ...plan.pair },
        status: "pending",
      })),
      kernel: ProContractKernel.empty,
    }
    this.db
      .transaction(() => {
        this.db.query("INSERT INTO rsi_evaluation VALUES(1,?)").run(JSON.stringify(state))
        this.db
          .query("INSERT INTO rsi_evaluation_event VALUES(0,?)")
          .run(JSON.stringify({ type: "frozen-measurement", state }))
      })
      .immediate()
  }

  read(): State {
    return JSON.parse(this.db.query<{ value: string }, []>("SELECT value FROM rsi_evaluation WHERE id=1").get()!.value)
  }

  begin(now: number) {
    return this.change("begin", now, (state, commands) => {
      if (state.assignments.some((assignment) => assignment.status === "active"))
        throw new Error("measurement already active")
      const assignment = state.assignments.find((assignment) => assignment.status === "pending")
      if (!assignment) throw new Error("no unevaluated assignment")
      assignment.deadline = now + SIX_HOURS
      const id = ProContract.ID.make(`pct_measure_${assignment.id}`)
      const spec = ProContract.Spec.make({
        trigger: { type: "immediate" },
        goal: "Obtain a complete valid official measurement for this frozen pair and instance-repeat; no search or deployment",
        brief: JSON.stringify({ protocol: state.protocol, source: state.source, assignment }),
        requires: [],
        authority: [],
        budget: { deadline: assignment.deadline },
        evidence: {
          type: "principal",
          claim: "This exact independent measurement has a valid official score, not necessarily a passing task",
        },
        resolution: { maxAttempts: 1, retryDelay: 0 },
      })
      apply(state, commands, {
        type: "issue",
        actor: issuer,
        draft: {
          id,
          issuer,
          executor: `measurement-worker-${assignment.id}`,
          scope: state.protocol,
          spec,
          specHash: ProContractKernel.hashSpec(spec),
        },
      })
      apply(state, commands, { type: "activate", actor: "institution", contractID: id, revision: 1, time: now })
      assignment.contractID = id
      assignment.status = "active"
    })
  }

  settle(id: string, result: Result, now: number) {
    return this.change("measurement", now, (state, commands) => {
      const assignment = state.assignments.find((assignment) => assignment.id === id)
      if (!assignment || assignment.status !== "active" || !assignment.contractID)
        throw new Error("measurement not active")
      assignment.result = structuredClone(result)
      if (now >= assignment.deadline!) return fail(state, commands, "original measurement deadline elapsed", now)
      if (!valid(result, assignment.test.total))
        return fail(state, commands, "invalid or incomplete official measurement", now)
      const contract = state.kernel.contracts[assignment.contractID]
      apply(state, commands, {
        type: "report-ready",
        actor: "institution",
        contractID: contract.id,
        revision: contract.revision,
        summary: "Official measurement completed; this is not task-success or improvement certification",
        uncertainties: [
          "A valid zero score is an observed task failure. No promotion or performance comparison is authorized.",
        ],
        subjectHash: subject(assignment.pair),
        time: now,
      })
      apply(state, commands, {
        type: "discharge",
        actor: issuer,
        contractID: contract.id,
        attestation: {
          id: ProContract.AttestationID.make(`pca_measure_${assignment.id}`),
          revision: contract.revision,
          specHash: contract.specHash,
          subjectHash: subject(assignment.pair),
          evidenceHash: hash(JSON.stringify({ protocol: state.protocol, assignment: id, result })),
          verifierID: issuer,
          class: "principal",
        },
      })
      assignment.status = "closed"
      if (state.assignments.every((assignment) => assignment.status === "closed"))
        state.stopped = "fixed evaluation completed"
    })
  }

  stop(reason: string, now: number) {
    if (!reason.trim()) throw new Error("measurement failure reason required")
    return this.change("stop", now, (state, commands) => fail(state, commands, reason, now))
  }

  report() {
    const state = this.read()
    return {
      purpose: "measurement-only",
      protocol: state.protocol,
      pair: state.pair,
      source: state.source,
      stopped: state.stopped,
      complete: state.stopped === "fixed evaluation completed",
      promoted: false,
      recursiveImprovement: false,
      searchFeedback: false,
      tasks: [...new Set(state.assignments.map((assignment) => assignment.test.task))].map((task) => {
        const assignments = state.assignments.filter((assignment) => assignment.test.task === task)
        const complete = assignments.every(
          (assignment) =>
            assignment.status === "closed" &&
            assignment.result &&
            valid(assignment.result, assignment.test.total) &&
            !assignment.failure &&
            state.kernel.contracts[assignment.contractID!]?.status === "discharged",
        )
        return {
          task,
          complete,
          mean: complete
            ? assignments.reduce((sum, assignment) => sum + assignment.result!.passed / assignment.test.total, 0) /
              assignments.length
            : null,
          assignments,
        }
      }),
      assignments: state.assignments,
    }
  }

  private change(type: string, now: number, update: (state: State, commands: ProContractKernel.Command[]) => void) {
    return this.db
      .transaction(() => {
        const state = this.read()
        if (state.stopped) throw new Error("evaluation stopped; no replay")
        if (!Number.isSafeInteger(now) || now < state.clock || now + SIX_HOURS > Number.MAX_SAFE_INTEGER)
          throw new Error("invalid or backwards measurement clock")
        const commands: ProContractKernel.Command[] = []
        update(state, commands)
        state.revision += 1
        state.clock = now
        this.db.query("UPDATE rsi_evaluation SET value=? WHERE id=1").run(JSON.stringify(state))
        this.db
          .query("INSERT INTO rsi_evaluation_event VALUES(?,?)")
          .run(state.revision, JSON.stringify({ type, now, commands }))
        return state
      })
      .immediate()
  }
}

function apply(state: State, commands: ProContractKernel.Command[], command: ProContractKernel.Command) {
  const result = ProContractKernel.transition(state.kernel, command)
  if (result.decision.type !== "accepted") throw new Error(result.decision.reason)
  state.kernel = result.state
  commands.push(command)
}

function valid(result: Result, total: number) {
  const accounting: Accounting = result.accounting
  return (
    result.valid === true &&
    result.total === total &&
    Number.isSafeInteger(result.passed) &&
    result.passed >= 0 &&
    result.passed <= total &&
    !!accounting?.source &&
    typeof accounting.incomplete === "boolean" &&
    (accounting.knownCost === null
      ? accounting.incomplete
      : typeof accounting.knownCost === "string" && /^(0|[1-9]\d*)(\.\d+)?$/.test(accounting.knownCost))
  )
}

function fail(state: State, commands: ProContractKernel.Command[], reason: string, now: number) {
  for (const assignment of state.assignments.filter((assignment) => assignment.status === "active")) {
    const contract = state.kernel.contracts[assignment.contractID!]
    apply(state, commands, {
      type: "escalate",
      actor: "institution",
      contractID: contract.id,
      revision: contract.revision,
      reason,
      time: now,
    })
    assignment.status = "closed"
    assignment.failure = reason
  }
  state.stopped = reason
}

export function stopEvaluationForRecovery(file: string, now: number) {
  if (!path.isAbsolute(file) || realpathSync(file) !== file)
    throw new Error("existing canonical evaluation ledger required")
  const db = new Database(file, { create: false, strict: true })
  try {
    db.exec("PRAGMA busy_timeout=5000")
    return db
      .transaction(() => {
        const row = db.query<{ value: string }, []>("SELECT value FROM rsi_evaluation WHERE id=1").get()
        if (!row) throw new Error("recovery cannot initialize measurement state")
        const state: State = JSON.parse(row.value)
        if (state.stopped && !state.assignments.some((assignment) => assignment.status === "active")) return state
        if (!Number.isSafeInteger(now) || now < state.clock) throw new Error("invalid recovery clock")
        const commands: ProContractKernel.Command[] = []
        fail(state, commands, "explicit measurement recovery; no allocation replay", now)
        state.clock = now
        state.revision += 1
        db.query("UPDATE rsi_evaluation SET value=? WHERE id=1").run(JSON.stringify(state))
        db.query("INSERT INTO rsi_evaluation_event VALUES(?,?)").run(
          state.revision,
          JSON.stringify({ type: "explicit-fence", now, commands }),
        )
        return state
      })
      .immediate()
  } finally {
    db.close()
  }
}

async function main() {
  const [rootArg, planArg, locked, ownerArg] = process.argv.slice(2)
  if (!rootArg || !planArg) throw new Error("usage: bun rsi-evaluation.ts NEW_ROOT PLAN | EXISTING_ROOT --fence")
  const root = path.resolve(rootArg)
  const file = path.join(root, "evaluation.sqlite")
  if (planArg === "--fence") {
    stopEvaluationForRecovery(file, Date.now())
    await Bun.write(path.join(root, "CANCEL"), "explicit measurement fence; no restart")
    await RSIRuntime.fence(root)
    return
  }
  const owner = ownerArg ? Number(ownerArg) : process.ppid
  const requireOwner = () => {
    if (!Number.isSafeInteger(owner) || owner <= 1 || process.ppid !== owner)
      throw new Error("measurement owner exited")
  }
  requireOwner()
  if (locked !== "--locked") {
    await fs.mkdir(root, { mode: 0o700 })
    const child = Bun.spawn(
      [
        "flock",
        "-n",
        "--no-fork",
        path.join(root, "evaluation.lock"),
        process.execPath,
        import.meta.path,
        root,
        path.resolve(planArg),
        "--locked",
        String(process.pid),
      ],
      { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    )
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
      process.on(signal, () => {
        void Bun.write(path.join(root, "CANCEL"), signal)
      })
    const ownerGuard = setInterval(() => {
      if (process.ppid === owner) return
      void Bun.write(path.join(root, "CANCEL"), "original measurement owner exited")
      child.kill("SIGTERM")
    }, 250)
    try {
      process.exitCode = await child.exited
    } finally {
      clearInterval(ownerGuard)
    }
    return
  }
  if (existsSync(file)) throw new Error("measurement already admitted; use --fence, never implicit restart")
  const reference = await RSIRuntime.ref(path.resolve(planArg))
  const plan = Schema.decodeUnknownSync(Schema.fromJsonString(EvaluationPlan))(await Bun.file(reference.path).text(), {
    onExcessProperty: "error",
  })
  await RSIRuntime.checked(plan.profile)
  process.env.OPENCODE_RSI_PROFILE = plan.profile.path
  const { configure } = await import("./rsi-profile")
  const { evaluateNative } = await import("./rsi-driver")
  const { Artifacts } = await import("../../core/script/ota-supervisor")
  const config = await configure(root)
  process.env.OPENAI_BASE_URL = config.native.provider.upstream
  if (config.protocol.deployment || hash(config.seed.s) !== plan.pair.s || hash(config.seed.h) !== plan.pair.h)
    throw new Error("measurement does not bind the exact frozen seed pair")
  for (const assignment of plan.assignments) {
    const task = await config.native.task(assignment)
    if (task.identity !== assignment.task)
      throw new Error("measurement alias does not match the frozen dataset identity")
  }
  const evaluation = new Evaluation(
    file,
    plan,
    { plan: reference, profile: plan.profile },
    await config.driver.fingerprint(),
  )
  const artifacts = new Artifacts(path.join(root, "objects"))
  const cancel = (reason: string) => {
    void Bun.write(path.join(root, "CANCEL"), reason)
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => cancel(signal))
  try {
    await artifacts.put(config.seed.s)
    await artifacts.put(config.seed.h)
    while (!evaluation.read().stopped) {
      requireOwner()
      await RSIRuntime.checked(reference)
      await RSIRuntime.checked(plan.profile)
      if ((await config.driver.fingerprint()) !== evaluation.read().trusted)
        throw new Error("measurement trusted closure changed")
      if (await Bun.file(path.join(root, "CANCEL")).exists()) {
        evaluation.stop("cancelled before measurement", Date.now())
        break
      }
      const disk = await fs.statfs(root)
      if (disk.bavail * disk.bsize < 64 * 1024 ** 3) {
        evaluation.stop("disk infrastructure reserve reached", Date.now())
        break
      }
      const state = evaluation.begin(Date.now())
      const assignment = state.assignments.find((assignment) => assignment.status === "active")!
      const controller = new AbortController()
      const expiry = setTimeout(() => controller.abort(), Math.max(1, assignment.deadline! - Date.now()))
      const guard = setInterval(() => {
        void (async () => {
          const disk = await fs.statfs(root)
          if (
            process.ppid !== owner ||
            (await Bun.file(path.join(root, "CANCEL")).exists()) ||
            disk.bavail * disk.bsize < 64 * 1024 ** 3 ||
            evaluation.read().stopped
          )
            controller.abort()
        })().catch(() => controller.abort())
      }, 250)
      try {
        const result = await evaluateNative(
          config.native,
          {
            pair: { s: await artifacts.get(plan.pair.s), h: await artifacts.get(plan.pair.h) },
            test: assignment.test,
            deadline: assignment.deadline!,
            signal: controller.signal,
          },
          {
            kind: "evaluation",
            database: file,
            protocol: state.protocol,
            assignment: assignment.id,
            pair: state.pair,
            deadline: assignment.deadline!,
          },
        )
        requireOwner()
        controller.signal.throwIfAborted()
        evaluation.settle(assignment.id, result, Date.now())
      } catch (error) {
        if (!evaluation.read().stopped) evaluation.stop(String(error), Date.now())
        await Bun.write(
          path.join(root, "ERROR.json"),
          JSON.stringify({
            assignment: assignment.id,
            error: String(error),
            at: Date.now(),
            performanceScoreInvented: false,
          }),
        )
        process.exitCode = 1
      } finally {
        clearTimeout(expiry)
        clearInterval(guard)
      }
    }
  } catch (error) {
    if (!evaluation.read().stopped) evaluation.stop(String(error), Date.now())
    await Bun.write(
      path.join(root, "ERROR.json"),
      JSON.stringify({
        phase: "measurement-control",
        error: String(error),
        at: Date.now(),
        performanceScoreInvented: false,
      }),
    )
    process.exitCode = 1
  } finally {
    const result = await closeEvaluation({
      root,
      evaluation,
      fence: () => config.driver.fence(),
      dispose: async () => {
        await config.native.dispose?.()
      },
    })
    if (!result.complete) process.exitCode = 1
  }
}

export async function closeEvaluation(input: {
  root: string
  evaluation: Evaluation
  fence: () => Promise<void>
  dispose: () => Promise<void>
}) {
  const cleanup = { native: false, environment: false, errors: [] as string[] }
  const userAccounting: Array<{ trial: string; source: RSIRuntime.File; rows: unknown[] }> = []
  try {
    try {
      await input.fence()
      cleanup.native = true
    } catch (error) {
      cleanup.errors.push(`native fence: ${String(error)}`)
    } finally {
      try {
        await input.dispose()
        cleanup.environment = true
      } catch (error) {
        cleanup.errors.push(`environment disposal: ${String(error)}`)
      }
    }
    try {
      for (const entry of await fs.readdir(path.join(input.root, "tau"), { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const file = path.join(input.root, "tau", entry.name, "user-requests.sqlite")
        if (!(await Bun.file(file).exists())) continue
        const db = new Database(file, { readonly: true })
        try {
          userAccounting.push({
            trial: entry.name,
            source: await RSIRuntime.ref(file),
            rows: db.query("SELECT * FROM request").all(),
          })
        } finally {
          db.close()
        }
      }
    } catch (error) {
      cleanup.errors.push(`external accounting: ${String(error)}`)
    }
    if (cleanup.errors.length && !input.evaluation.read().stopped)
      input.evaluation.stop("measurement cleanup or accounting failed", Date.now())
    const report = input.evaluation.report()
    const result = {
      ...report,
      complete: report.complete && cleanup.native && cleanup.environment && !cleanup.errors.length,
      cleanup,
      userAccounting,
    }
    await Bun.write(path.join(input.root, "RESULT.json"), JSON.stringify(result, null, 2))
    return result
  } finally {
    input.evaluation.db.close()
  }
}

if (import.meta.main) await main()
