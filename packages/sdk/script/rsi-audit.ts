// Independent, evaluation-only audit. Never writes or resumes the source OTA.
import { Database } from "bun:sqlite"
import { existsSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { ProContract } from "@opencode/schema/pro-contract"
import { ProContractKernel } from "../../core/src/pro-contract/kernel"
import { hash, SIX_HOURS, subject } from "../../core/script/ota-rsi"
import type { Pair, Protocol, State } from "../../core/script/ota-rsi"
import type { NativeConfiguration } from "./rsi-driver"
import type { Accounting, Driver } from "../../core/script/ota-supervisor"

export type AuditSource = {
  database: string
  revision: number
  protocol: string
  stateHash: string
  pair: Pair
  seed: Pair
}
export type AuditTest = { id: string; total: number }
export type AuditResult = Awaited<ReturnType<Driver["evaluate"]>>
export type AuditAssignment = {
  id: string
  arm: "seed" | "final"
  test: AuditTest
  pair: Pair
  status: "pending" | "active" | "closed"
  deadline?: number
  contractID?: string
  result?: AuditResult
  failure?: string
}
export type AuditState = {
  protocol: string
  source: AuditSource
  trusted: string
  revision: number
  clock: number
  assignments: AuditAssignment[]
  kernel: ProContractKernel.State
  stopped?: string
}
const issuer = "rsi-audit-issuer"

export function readAuditSource(database: string): AuditSource {
  if (!path.isAbsolute(database) || realpathSync(database) !== database)
    throw new Error("canonical source database required")
  const db = new Database(database, { readonly: true, strict: true })
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA query_only=ON")
    const row = db.query<{ value: string }, []>("SELECT value FROM ota_state WHERE id=1").get()
    if (!row) throw new Error("source OTA state missing")
    const state: State = JSON.parse(row.value)
    if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !/^[a-f0-9]{64}$/.test(state.protocol))
      throw new Error("invalid source coordinates")
    if (state.stopped !== "recursive closure completed" || state.trial || state.task)
      throw new Error("audit requires completed inter-task recursive closure without a trial")
    const support = state.active.support && state.kernel.contracts[state.active.support]
    if (!support || support.status !== "discharged" || support.handoff?.subjectHash !== subject(state.active.pair))
      throw new Error("final pair has no discharged source support")
    if (!support.attestationID || !state.kernel.attestations[support.attestationID])
      throw new Error("final pair support has no attestation")
    for (const pair of [state.seed, state.active.pair])
      if (![pair.s, pair.h].every((value) => /^[a-f0-9]{64}$/.test(value))) throw new Error("invalid source pair")
    return {
      database,
      revision: state.revision,
      protocol: state.protocol,
      stateHash: hash(row.value),
      pair: state.active.pair,
      seed: state.seed,
    }
  } finally {
    db.close()
  }
}

export function requireAuditSource(source: AuditSource) {
  if (JSON.stringify(readAuditSource(source.database)) !== JSON.stringify(source))
    throw new Error("source stopped snapshot changed")
}

// IDs are assignment labels, not dataset identities. Ask the pinned task factory
// to bind them before any allocation; renamed aliases cannot become holdouts.
export async function auditTasks(
  tests: ReadonlyArray<AuditTest>,
  selection: ReadonlyArray<Protocol["tests"][number]>,
  task: NativeConfiguration["task"],
) {
  if (tests.length !== 2 || new Set(tests.map((test) => test.id)).size !== 2)
    throw new Error("audit requires two distinct repeat IDs")
  if (!selection.length) throw new Error("source has no selection assignment identities")
  const assignments = await Promise.all(
    [...tests, ...selection].map(async (test) => {
      const identity = (await task(test)).identity
      if (typeof identity !== "string" || !identity.trim())
        throw new Error("trusted task adapter must provide an explicit dataset identity")
      return { id: test.id, identity }
    }),
  )
  const audit = assignments.slice(0, 2)
  const searched = assignments.slice(2)
  if (audit[0].identity !== audit[1].identity) throw new Error("audit repeats must resolve to one instance identity")
  if (searched.some((item) => item.identity === audit[0].identity))
    throw new Error("audit instance was assigned to selection; renamed IDs are not isolation")
  return { identity: audit[0].identity, audit, selection: searched }
}

/** A new audit ledger admits exactly four evaluation allocations, never an OTA
 * proposal or deployment. Interrupted ledgers cannot be resumed/re-sampled.
 */
export class Audit {
  readonly db: Database
  constructor(file: string, source: AuditSource, tests: ReadonlyArray<AuditTest>, trusted: string) {
    requireAuditSource(source)
    if (
      tests.length !== 2 ||
      new Set(tests.map((test) => test.id)).size !== 2 ||
      tests.some((test) => !test.id || !Number.isSafeInteger(test.total) || test.total <= 0) ||
      tests[0].total !== tests[1].total
    )
      throw new Error("audit freezes exactly two distinct repeats with one denominator")
    if (!/^[a-f0-9]{64}$/.test(trusted)) throw new Error("audit requires a frozen trusted closure")
    if (existsSync(file)) throw new Error("audit ledger already exists; no replay or resampling")
    this.db = new Database(file, { create: true, strict: true })
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000")
    this.db.exec(`
      CREATE TABLE rsi_audit (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE rsi_audit_event (sequence INTEGER PRIMARY KEY, value TEXT NOT NULL);
    `)
    const protocol = hash(
      JSON.stringify({
        kind: "independent-audit",
        source,
        tests,
        trusted,
        rule: "task-pareto",
        order: "paired-seed-final",
      }),
    )
    const state: AuditState = {
      protocol,
      source: structuredClone(source),
      trusted,
      revision: 0,
      clock: 0,
      assignments: tests.flatMap((test) =>
        (["seed", "final"] as const).map((arm) => ({
          id: hash(JSON.stringify([protocol, test.id, arm])),
          arm,
          test: { ...test },
          pair: { ...(arm === "seed" ? source.seed : source.pair) },
          status: "pending" as const,
        })),
      ),
      kernel: ProContractKernel.empty,
    }
    this.db
      .transaction(() => {
        this.db.query("INSERT INTO rsi_audit VALUES(1,?)").run(JSON.stringify(state))
        this.db.query("INSERT INTO rsi_audit_event VALUES(0,?)").run(JSON.stringify({ type: "frozen-audit", state }))
      })
      .immediate()
  }

  read(): AuditState {
    return JSON.parse(this.db.query<{ value: string }, []>("SELECT value FROM rsi_audit WHERE id=1").get()!.value)
  }

  begin(now: number) {
    return this.change("begin", now, (state, commands) => {
      requireAuditSource(state.source)
      if (state.assignments.some((item) => item.status === "active")) throw new Error("audit assignment already active")
      const assignment = state.assignments.find((item) => item.status === "pending")
      if (!assignment) throw new Error("audit has no unevaluated assignment")
      const id = ProContract.ID.make(`pct_audit_${assignment.id}`)
      assignment.deadline = now + SIX_HOURS
      const spec = ProContract.Spec.make({
        trigger: { type: "immediate" },
        goal: "Complete this exact independent evaluation; no search feedback or deployment authority",
        brief: JSON.stringify({ protocol: state.protocol, source: state.source, assignment }),
        requires: [],
        authority: [],
        budget: { deadline: assignment.deadline },
        evidence: {
          type: "principal",
          claim: "Evaluation completed with a valid task score; not a claim of improvement",
        },
        resolution: { maxAttempts: 1, retryDelay: 0 },
      })
      apply(state, commands, {
        type: "issue",
        actor: issuer,
        draft: {
          id,
          issuer,
          executor: `audit-worker-${assignment.id}`,
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

  settle(id: string, result: AuditResult, now: number) {
    return this.change("evaluation", now, (state, commands) => {
      const assignment = state.assignments.find((item) => item.id === id)
      if (!assignment || assignment.status !== "active" || !assignment.contractID)
        throw new Error("assignment is not active")
      requireAuditSource(state.source)
      assignment.result = structuredClone(result)
      const failure =
        now >= assignment.deadline!
          ? "original audit deadline elapsed"
          : !validResult(result, assignment.test)
            ? "invalid or incomplete audit evidence"
            : undefined
      if (failure) return fail(state, commands, failure, now)
      const contract = state.kernel.contracts[assignment.contractID]
      apply(state, commands, {
        type: "report-ready",
        actor: "institution",
        contractID: contract.id,
        revision: contract.revision,
        summary: "Independent evaluation completed; score is evidence, not deployment authority",
        subjectHash: subject(assignment.pair),
        uncertainties: [
          "This attestation certifies evaluation completion, not task success or performance improvement.",
        ],
        time: now,
      })
      apply(state, commands, {
        type: "discharge",
        actor: issuer,
        contractID: contract.id,
        attestation: {
          id: ProContract.AttestationID.make(`pca_audit_${assignment.id}`),
          revision: contract.revision,
          specHash: contract.specHash,
          subjectHash: subject(assignment.pair),
          evidenceHash: hash(JSON.stringify({ protocol: state.protocol, assignment: assignment.id, result })),
          verifierID: issuer,
          class: "principal",
        },
      })
      assignment.status = "closed"
      if (state.assignments.every((item) => item.status === "closed")) state.stopped = "independent audit completed"
    })
  }

  stop(reason: string, now: number) {
    if (!reason.trim()) throw new Error("audit stop reason required")
    return this.change("stop", now, (state, commands) => fail(state, commands, reason, now))
  }

  report() {
    const state = this.read()
    const valid =
      state.stopped === "independent audit completed" &&
      state.assignments.every(
        (item) =>
          item.status === "closed" &&
          item.result &&
          validResult(item.result, item.test) &&
          !!item.contractID &&
          state.kernel.contracts[item.contractID]?.status === "discharged",
      )
    // Both repeats have the same frozen denominator. Compare integer counts,
    // not rounded rates: e.g. (0 + 3)/10 and (1 + 2)/10 are exactly tied.
    const passed = (arm: AuditAssignment["arm"]) =>
      valid
        ? state.assignments
            .filter((item) => item.arm === arm)
            .reduce((total, item) => total + BigInt(item.result!.passed), 0n)
        : null
    const seed = passed("seed")
    const final = passed("final")
    const denominator = 2 * state.assignments[0].test.total
    return {
      protocol: state.protocol,
      source: state.source,
      stopped: state.stopped,
      valid,
      rule: "task-pareto",
      repeats: 2,
      means: {
        seed: seed === null ? null : Number(seed) / denominator,
        final: final === null ? null : Number(final) / denominator,
      },
      netImprovement: seed === null || final === null ? null : final > seed,
      delta: seed === null || final === null ? null : Number(final - seed) / denominator,
      promoted: false,
      searchFeedback: false,
      accounting: state.assignments.map((item) => ({
        assignment: item.id,
        accounting: item.result?.accounting ?? null,
      })),
      assignments: state.assignments,
    }
  }

  private change(
    type: string,
    now: number,
    update: (state: AuditState, commands: ProContractKernel.Command[]) => void,
  ) {
    return this.db
      .transaction(() => {
        const state = this.read()
        if (state.stopped) throw new Error("audit is stopped; no replay")
        if (!Number.isSafeInteger(now) || now < state.clock || now + SIX_HOURS > Number.MAX_SAFE_INTEGER)
          throw new Error("invalid or backwards audit clock")
        const commands: ProContractKernel.Command[] = []
        update(state, commands)
        state.revision += 1
        state.clock = now
        this.db.query("UPDATE rsi_audit SET value=? WHERE id=1").run(JSON.stringify(state))
        this.db
          .query("INSERT INTO rsi_audit_event VALUES(?,?)")
          .run(state.revision, JSON.stringify({ type, now, commands }))
        return state
      })
      .immediate()
  }
}

function apply(state: AuditState, commands: ProContractKernel.Command[], command: ProContractKernel.Command) {
  const result = ProContractKernel.transition(state.kernel, command)
  if (result.decision.type !== "accepted") throw new Error(result.decision.reason)
  state.kernel = result.state
  commands.push(command)
}

function validResult(result: AuditResult, test: AuditTest) {
  const accounting: Accounting = result.accounting
  return (
    result.valid === true &&
    Number.isSafeInteger(result.passed) &&
    result.passed >= 0 &&
    result.passed <= test.total &&
    result.total === test.total &&
    !!accounting?.source &&
    typeof accounting.incomplete === "boolean" &&
    (accounting.knownCost === null
      ? accounting.incomplete
      : typeof accounting.knownCost === "string" && /^(0|[1-9]\d*)(\.\d+)?$/.test(accounting.knownCost))
  )
}

function fail(state: AuditState, commands: ProContractKernel.Command[], reason: string, now: number) {
  for (const assignment of state.assignments.filter((item) => item.status === "active")) {
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

/** Explicit recovery changes only outstanding evaluation standing. It never
 * reopens assignments, renews deadlines or loads a model/profile credential.
 */
export function stopAuditForRecovery(file: string, now: number) {
  if (!path.isAbsolute(file) || realpathSync(file) !== file) throw new Error("existing canonical audit ledger required")
  const db = new Database(file, { create: false, strict: true })
  try {
    db.exec("PRAGMA busy_timeout=5000")
    return db
      .transaction(() => {
        const row = db.query<{ value: string }, []>("SELECT value FROM rsi_audit WHERE id=1").get()
        if (!row) throw new Error("audit state missing; recovery cannot initialize it")
        const state: AuditState = JSON.parse(row.value)
        if (state.stopped && !state.assignments.some((item) => item.status === "active")) return state
        if (!Number.isSafeInteger(now) || now < state.clock) throw new Error("invalid recovery clock")
        const commands: ProContractKernel.Command[] = []
        fail(state, commands, "explicit audit recovery; no allocation replay", now)
        state.revision += 1
        state.clock = now
        db.query("UPDATE rsi_audit SET value=? WHERE id=1").run(JSON.stringify(state))
        db.query("INSERT INTO rsi_audit_event VALUES(?,?)").run(
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

/** Only host-owned metadata below this audit's native run tree can name grades.
 * Workspace/candidate files and symlinked directories are never recovery input.
 */
export async function auditGrades(root: string) {
  if (realpathSync(root) !== root) throw new Error("canonical audit root required")
  const native = path.join(root, "native")
  if (!existsSync(native)) return []
  const controlled = async (directory: string) => {
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.uid !== process.getuid!() || info.mode & 0o022)
      throw new Error("recovery directory is not host-owned: " + directory)
    if ((await fs.realpath(directory)) !== directory) throw new Error("recovery directory cannot follow a symlink")
  }
  await controlled(native)
  const grades = await Promise.all(
    (await fs.readdir(native, { withFileTypes: true })).map(async (entry) => {
      if (entry.isSymbolicLink()) throw new Error("native recovery entry is a symlink")
      if (!entry.isDirectory()) return []
      const run = path.join(native, entry.name)
      await controlled(run)
      const directory = path.join(run, "grades")
      if (!existsSync(directory)) return []
      await controlled(directory)
      return Promise.all(
        (await fs.readdir(directory, { withFileTypes: true })).map(async (entry) => {
          if (entry.isSymbolicLink()) throw new Error("grade recovery entry is a symlink")
          if (!entry.isDirectory()) return undefined
          const grade = path.join(directory, entry.name)
          await controlled(grade)
          const control = path.join(grade, "control.json")
          if (!existsSync(control)) return undefined // No control means no Docker admission ever started.
          const info = await fs.lstat(control)
          if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || info.size > 1024 * 1024)
            throw new Error("grade control is not bounded host metadata")
          return grade
        }),
      )
    }),
  )
  return grades.flat().filter((grade): grade is string => grade !== undefined)
}

async function recoverAudit(root: string) {
  const { RSIRuntime } = await import("./rsi-runtime")
  const directory = path.join(root, "recovery", crypto.randomUUID())
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const native = await RSIRuntime.fence(root).then(
    () => ({ acknowledged: true }),
    (error) => ({ acknowledged: false, error: String(error) }),
  )
  const locations = await auditGrades(root).then(
    (grades) => ({ grades, error: undefined as string | undefined }),
    (error) => ({ grades: [] as string[], error: String(error) }),
  )
  const grades = await Promise.all(
    locations.grades.map(async (grade, index) => {
      const child = Bun.spawn(["python3", path.join(import.meta.dir, "rsi-programbench.py"), "--fence", grade], {
        stdin: "ignore",
        stdout: Bun.file(path.join(directory, `${index}.stdout`)),
        stderr: Bun.file(path.join(directory, `${index}.stderr`)),
        env: { PATH: process.env.PATH, HOME: "/nonexistent", PYTHONDONTWRITEBYTECODE: "1" },
      })
      return { grade, acknowledged: (await child.exited) === 0, receipt: path.join(grade, "RECOVERY_FENCE.json") }
    }),
  )
  const report = {
    acknowledged: native.acknowledged && !locations.error && grades.every((grade) => grade.acknowledged),
    action: "fence-only",
    allocations: 0,
    native,
    grades,
    error: locations.error,
  }
  await Bun.write(path.join(directory, "RESULT.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, receipt: path.join(directory, "RESULT.json") }))
  process.exitCode = report.acknowledged ? 0 : 1
}

export function requireAuditOwner(owner: number) {
  if (!Number.isSafeInteger(owner) || owner <= 1 || process.ppid !== owner)
    throw new Error("original audit owner exited or changed")
}

async function main() {
  const [rootArg, sourceArg, locked, ownerArg] = process.argv.slice(2)
  const owner = ownerArg ? Number(ownerArg) : process.ppid
  if (!rootArg || !sourceArg)
    throw new Error("usage: bun script/rsi-audit.ts NEW_ROOT SOURCE_CAMPAIGN | EXISTING_ROOT --fence")
  const root = path.resolve(rootArg)
  if (sourceArg === "--fence") {
    // Revoke admission before trying the issuer's OS lock. A live issuer must
    // quiesce; recovery never competes with it to create or evaluate work.
    if (realpathSync(root) !== root) throw new Error("canonical existing audit root required")
    stopAuditForRecovery(path.join(root, "audit.sqlite"), Date.now())
    await Bun.write(path.join(root, "CANCEL"), "explicit audit fence; no allocation replay")
    if (locked !== "--locked") {
      const child = Bun.spawn(
        [
          "flock",
          "-n",
          "--no-fork",
          path.join(root, "audit.lock"),
          process.execPath,
          import.meta.path,
          root,
          "--fence",
          "--locked",
        ],
        {
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        },
      )
      process.exitCode = await child.exited
      if (process.exitCode !== 0)
        console.error(
          "Audit fencing is unacknowledged; a live issuer must quiesce before retrying --fence. No allocation was resumed.",
        )
      return
    }
    await recoverAudit(root)
    return
  }
  requireAuditOwner(owner)
  const sourceRoot = path.resolve(sourceArg)
  if (root === sourceRoot || root.startsWith(sourceRoot + path.sep) || sourceRoot.startsWith(root + path.sep))
    throw new Error("audit and source roots must be independent")
  if (locked !== "--locked") await fs.mkdir(root, { mode: 0o700 })
  const cancel = (signal: string) => {
    void Bun.write(path.join(root, "CANCEL"), signal)
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => cancel(signal))
  if (locked !== "--locked") {
    const child = Bun.spawn(
      [
        "flock",
        "-n",
        "--no-fork",
        path.join(root, "audit.lock"),
        process.execPath,
        import.meta.path,
        root,
        sourceRoot,
        "--locked",
        String(process.pid),
      ],
      {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      },
    )
    process.exitCode = await child.exited
    return
  }
  const source = readAuditSource(path.join(sourceRoot, "ota.sqlite"))
  const disk = await fs.statfs(root)
  if (disk.bavail * disk.bsize < 64 * 1024 ** 3) throw new Error("disk infrastructure reserve reached")
  const { configure } = await import("./rsi-profile")
  const { evaluateNative } = await import("./rsi-driver")
  const { Artifacts } = await import("../../core/script/ota-supervisor")
  const config = await configure(root)
  requireAuditOwner(owner)
  if (
    config.protocol.deployment ||
    hash(JSON.stringify(config.protocol)) !== source.protocol ||
    hash(config.seed.s) !== source.seed.s ||
    hash(config.seed.h) !== source.seed.h
  )
    throw new Error("audit profile does not match the stopped campaign")
  if (!config.audit || config.audit.some((test) => config.protocol.tests.some((prior) => prior.id === test.id)))
    throw new Error("audit requires separately frozen, search-isolated assignments")
  const tasks = await auditTasks(config.audit, config.protocol.tests, config.native.task)
  await fs.writeFile(path.join(root, "AUDIT_TASKS.json"), JSON.stringify(tasks, null, 2), { flag: "wx", mode: 0o400 })
  const code = hash(await Bun.file(import.meta.path).bytes())
  const trusted = hash(JSON.stringify({ driver: config.protocol.trusted, audit: code, tasks }))
  requireAuditOwner(owner)
  const audit = new Audit(path.join(root, "audit.sqlite"), source, config.audit, trusted)
  const artifacts = new Artifacts(path.join(sourceRoot, "objects"))
  try {
    while (!audit.read().stopped) {
      requireAuditOwner(owner)
      if (await Bun.file(path.join(root, "CANCEL")).exists()) {
        audit.stop("cancelled before audit allocation", Date.now())
        break
      }
      const disk = await fs.statfs(root)
      if (disk.bavail * disk.bsize < 64 * 1024 ** 3) throw new Error("disk infrastructure reserve reached")
      if (
        (await config.driver.fingerprint()) !== config.protocol.trusted ||
        hash(await Bun.file(import.meta.path).bytes()) !== code
      )
        throw new Error("trusted audit closure changed")
      requireAuditOwner(owner)
      const begun = audit.begin(Date.now())
      const assignment = begun.assignments.find((item) => item.status === "active")!
      const controller = new AbortController()
      const timer = setInterval(() => {
        try {
          requireAuditSource(source)
        } catch (error) {
          controller.abort(error)
        }
        if (Date.now() >= assignment.deadline! || process.ppid !== owner || existsSync(path.join(root, "CANCEL")))
          controller.abort(new Error("audit cancelled or original deadline reached"))
      }, 100)
      try {
        const result = await evaluateNative(
          config.native,
          {
            test: assignment.test,
            pair: await artifacts.pair(assignment.pair),
            deadline: assignment.deadline!,
            signal: controller.signal,
          },
          {
            kind: "audit",
            database: path.join(root, "audit.sqlite"),
            protocol: begun.protocol,
            assignment: assignment.id,
            pair: assignment.pair,
            deadline: assignment.deadline!,
          },
        )
        controller.signal.throwIfAborted()
        audit.settle(assignment.id, result, Date.now())
      } finally {
        // evaluateNative resolves/rejects only after worker/grader teardown.
        clearInterval(timer)
      }
      await Bun.write(path.join(root, "RESULT.json"), JSON.stringify(audit.report(), null, 2))
    }
  } catch (error) {
    if (!audit.read().stopped) audit.stop(error instanceof Error ? error.message : String(error), Date.now())
  } finally {
    await Bun.write(path.join(root, "RESULT.json"), JSON.stringify(audit.report(), null, 2))
    process.exitCode = audit.report().valid ? 0 : 1
    audit.db.close()
    await config.native.dispose?.()
  }
}

if (import.meta.main) await main()
