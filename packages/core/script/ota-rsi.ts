// Issuer-owned OTA control plane. Neither mutable partition may import this file.
import { Database } from "bun:sqlite"
import { ProContract } from "@opencode/schema/pro-contract"
import { ProContractKernel } from "../src/pro-contract/kernel.js"

export type Slot = "s" | "h"
// H denotes a complete worker-harness release, not just a prompt or one module.
// These are artifact identities; the application driver must materialize the
// complete release and isolate its mutable instance state from the authority.
export type Pair = { s: string; h: string }
export type Protocol = {
  // Pin the external issuer/containment/evaluator closure, NOT the mutable
  // OpenCode worker runtime. That runtime belongs to H and changes with H.
  trusted: string
  // Width one is linear; larger widths explore a breadth-first source tree.
  expansion?: { width: number }
  completion?: { selections: number; successorHandoff: true; stopOnRejection: boolean }
  // A task-local ledger never changes a campaign's default pair. Its original
  // allowance and initial public checkpoint are part of the frozen authority.
  deployment?: {
    kind: "task"
    task: string
    started: number
    deadline: number
    checkpoint: string
    // Optional experimental adaptation schedule, not a model/tool call limit.
    // Finish the original task after these proposals, even when one is rejected.
    revisions?: number
  }
  scope: "mechanics" | "performance"
  performanceRule?: "panel-margin" | "task-pareto"
  minimumMeanGainBps?: number
  tests: {
    id: string
    total: number
    performance?: { panel: "development" | "confirmation"; task: string; replicate: string }
  }[]
  startupMs: number
  heartbeatMs: number
  probationMs: number
  evaluationConcurrency?: number
  stopOnPrimaryImprovement?: boolean
  requiredFull?: string[]
}
export type Evidence = {
  protocol: string
  subject: string
  job: string
  rows: { id: string; passed: number; total: number; valid: boolean }[]
  baseline: { subject: string; rows: Evidence["rows"] }
  // Reference to issuer-recorded execution/accounting, including incomplete usage.
  receipt: string
  // Both versions must have been evaluated from this same task checkpoint.
  checkpoint?: string
}
type Boot = {
  slot: Slot
  pair: Pair
  memory: { id: string; parent?: string; origin?: string; checkpoint?: string }
  support?: string
}
export type Lineage = {
  id: string
  root: Pair
  parent: string
  pair: Pair
  outcome: "selected" | "rejected"
}
export type State = {
  revision: number
  protocol: string
  seed: Pair
  kernel: ProContractKernel.State
  active: Boot
  fallback?: Boot
  epoch: number
  trial: boolean
  primaryImproved?: boolean
  task?: {
    id: string
    contractID: string
    checkpoint: string
    needsContinuation: boolean
    status: "open" | "delivered" | "blocked"
    revisions?: number
  }
  job?: {
    id: string
    deadline: number
    started: number
    heartbeat: number
    sequence: number
    phase: "running" | "evaluating"
    purpose?: "continuation"
    allowRevise?: boolean
    source?: { id: string; pair: Pair }
  }
  stopped?: string
  quarantine: string[]
  retainedFull: string[]
  lineage?: Lineage[]
  clock: number
}

export const SIX_HOURS = 6 * 60 * 60 * 1_000
export const opposite = (slot: Slot): Slot => (slot === "s" ? "h" : "s")
export const hash = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
export const subject = (pair: Pair) => hash(JSON.stringify({ s: pair.s, h: pair.h }))
const issuer = "ota-issuer"

/** One SQLite transaction commits the Kernel events AND the active boot pointer.
 * This uses the existing, unmodified normative reducer, not a parallel pass flag.
 * The DB/artifact store belong to the supervisor and are never candidate mounts.
 */
export class OTA {
  readonly db: Database
  readonly protocol: Protocol
  readonly digest: string

  constructor(path: string, protocol: Protocol, seed: Pair) {
    requireHash(protocol.trusted)
    if (protocol.expansion && (!Number.isSafeInteger(protocol.expansion.width) || protocol.expansion.width < 1))
      throw new Error("expansion width must be a positive integer")
    if (
      protocol.completion &&
      (!Number.isSafeInteger(protocol.completion.selections) ||
        protocol.completion.selections < 1 ||
        protocol.completion.successorHandoff !== true ||
        typeof protocol.completion.stopOnRejection !== "boolean" ||
        !protocol.expansion ||
        protocol.stopOnPrimaryImprovement)
    )
      throw new Error(
        "finite completion requires a positive selection count, source lineage and successor handoff only",
      )
    if (protocol.deployment) {
      if (protocol.stopOnPrimaryImprovement)
        throw new Error("task deployment requires actual continuation, not primary-improvement stopping")
      if (
        protocol.deployment.kind !== "task" ||
        typeof protocol.deployment.task !== "string" ||
        !protocol.deployment.task.trim() ||
        !Number.isSafeInteger(protocol.deployment.started) ||
        protocol.deployment.started < 0 ||
        !Number.isSafeInteger(protocol.deployment.deadline) ||
        protocol.deployment.deadline <= protocol.deployment.started ||
        protocol.deployment.deadline - protocol.deployment.started > SIX_HOURS
      )
        throw new Error("task deployment requires one task and its original deadline of at most six hours")
      requireHash(protocol.deployment.checkpoint)
      if (
        protocol.deployment.revisions !== undefined &&
        (!Number.isSafeInteger(protocol.deployment.revisions) ||
          protocol.deployment.revisions < 0 ||
          protocol.completion)
      )
        throw new Error("task revision schedule requires a nonnegative count and cannot use recursive completion")
    }
    requirePair(seed)
    if (
      !Number.isInteger(protocol.evaluationConcurrency ?? 1) ||
      (protocol.evaluationConcurrency ?? 1) < 1 ||
      (protocol.evaluationConcurrency ?? 1) > 16
    )
      throw new Error("invalid evaluation concurrency")
    if (!protocol.tests.length || new Set(protocol.tests.map((test) => test.id)).size !== protocol.tests.length)
      throw new Error("nonempty fixed test manifest required")
    protocol.tests.forEach((test) => {
      if (!test.id || !Number.isSafeInteger(test.total) || test.total <= 0) throw new Error("invalid test denominator")
      if (
        test.performance &&
        (!["development", "confirmation"].includes(test.performance.panel) ||
          !test.performance.task ||
          !test.performance.replicate)
      )
        throw new Error("invalid performance assignment")
    })
    if (protocol.performanceRule !== undefined && !["panel-margin", "task-pareto"].includes(protocol.performanceRule))
      throw new Error("unknown performance rule")
    if (protocol.performanceRule === "task-pareto" && protocol.minimumMeanGainBps !== undefined)
      throw new Error("task-pareto uses strict growth, not a mean margin")
    if (
      protocol.performanceRule !== "task-pareto" &&
      (!Number.isSafeInteger(protocol.minimumMeanGainBps) ||
        protocol.minimumMeanGainBps! <= 0 ||
        protocol.minimumMeanGainBps! > 10_000)
    )
      throw new Error("freeze a positive minimum mean gain in basis points")
    if (protocol.scope !== "mechanics" && protocol.scope !== "performance")
      throw new Error("explicit evaluation scope required")
    if (protocol.scope === "performance") {
      for (const panel of ["development", "confirmation"]) {
        const tasks = protocol.tests.filter((test) => test.performance?.panel === panel)
        if (!tasks.length) throw new Error("development and confirmation evidence required")
        for (const task of new Set(tasks.map((test) => test.performance!.task))) {
          const replicas = tasks
            .filter((test) => test.performance!.task === task)
            .map((test) => test.performance!.replicate)
          if (
            !task ||
            replicas.length < 2 ||
            replicas.some((replica) => !replica) ||
            new Set(replicas).size !== replicas.length
          )
            throw new Error("at least two distinct executions per performance task required")
        }
      }
    }
    if (!protocol.tests.some((test) => !test.performance)) throw new Error("fixed safety tests required")
    const assigned = new Set(
      protocol.tests.flatMap((test) =>
        test.performance ? [`${test.performance.panel}:${test.performance.task}`] : [],
      ),
    )
    if ((protocol.requiredFull ?? []).some((task) => !assigned.has(task)))
      throw new Error("required full pass is not assigned")
    ;[protocol.startupMs, protocol.heartbeatMs, protocol.probationMs].forEach((ms) => {
      if (!Number.isSafeInteger(ms) || ms <= 0 || ms > SIX_HOURS) throw new Error("invalid watchdog interval")
    })
    this.protocol = structuredClone(protocol)
    this.digest = hash(JSON.stringify(this.protocol))
    this.db = new Database(path, { create: true, strict: true })
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ota_state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ota_event (sequence INTEGER PRIMARY KEY, value TEXT NOT NULL);
    `)
    const compatible = this.db
      .transaction(() => {
        const row = this.db.query<{ value: string }, []>("SELECT value FROM ota_state WHERE id = 1").get()
        if (row) {
          const prior: State = JSON.parse(row.value)
          return prior.protocol === this.digest && !!prior.seed && subject(prior.seed) === subject(seed)
        }
        const state: State = {
          revision: 0,
          protocol: this.digest,
          seed,
          kernel: ProContractKernel.empty,
          active: { slot: "s", pair: seed, memory: { id: "e1" } },
          epoch: 1,
          trial: false,
          quarantine: [],
          retainedFull: [],
          clock: 0,
          ...(protocol.deployment
            ? {
                task: {
                  id: protocol.deployment.task,
                  contractID: taskContractID(this.digest, protocol.deployment.task),
                  checkpoint: protocol.deployment.checkpoint,
                  needsContinuation: true,
                  status: "open" as const,
                  ...(protocol.deployment.revisions !== undefined ? { revisions: 0 } : {}),
                },
              }
            : {}),
        }
        const commands: ProContractKernel.Command[] = []
        if (protocol.deployment) {
          const id = ProContract.ID.make(state.task!.contractID)
          const spec = ProContract.Spec.make({
            trigger: { type: "immediate" },
            goal: "Deliver a host-verified sealed result for this original task within its original deadline",
            brief: JSON.stringify({
              protocol: this.digest,
              task: protocol.deployment.task,
              checkpoint: protocol.deployment.checkpoint,
            }),
            requires: [],
            authority: [],
            budget: { deadline: protocol.deployment.deadline },
            evidence: { type: "principal", claim: "The trusted task verifier accepts this exact task checkpoint" },
            resolution: { maxAttempts: 1, retryDelay: 0 },
          })
          apply(state, commands, {
            type: "issue",
            actor: issuer,
            draft: {
              id,
              issuer,
              executor: "task-runtime",
              scope: this.digest,
              spec,
              specHash: ProContractKernel.hashSpec(spec),
            },
          })
          apply(state, commands, {
            type: "activate",
            actor: "institution",
            contractID: id,
            revision: 1,
            time: protocol.deployment.started,
          })
        }
        this.db.query("INSERT INTO ota_state VALUES (1, ?)").run(JSON.stringify(state))
        this.db.query("INSERT INTO ota_event VALUES (0, ?)").run(
          JSON.stringify({
            type: "authorized-seed",
            pair: seed,
            performancePromotion: false,
            ...(commands.length ? { commands } : {}),
          }),
        )
        return true
      })
      .immediate()
    if (!compatible) {
      this.db.close()
      throw new Error("frozen OTA protocol or seed changed")
    }
  }

  read(): State {
    return JSON.parse(this.db.query<{ value: string }, []>("SELECT value FROM ota_state WHERE id = 1").get()!.value)
  }

  history(): unknown[] {
    return this.db
      .query<{ value: string }, []>("SELECT value FROM ota_event ORDER BY sequence")
      .all()
      .map((row) => JSON.parse(row.value))
  }

  begin(revision: number, now: number) {
    return this.change(revision, now, "begin", (state) => {
      if (state.job) throw new Error("an admitted job already exists")
      requireTask(this.protocol, state, now)
      requireStanding(state, state.active)
      if (
        state.task &&
        !state.task.needsContinuation &&
        this.protocol.deployment?.revisions !== undefined &&
        (state.task.revisions ?? 0) >= this.protocol.deployment.revisions
      )
        throw new Error("task revision schedule exhausted; no further source proposal")
      state.job = {
        id: `job-${state.revision + 1}-${state.epoch}`,
        deadline: Math.min(now + SIX_HOURS, this.protocol.deployment?.deadline ?? now + SIX_HOURS),
        started: now,
        heartbeat: now,
        sequence: -1,
        phase: "running",
        ...(state.task?.needsContinuation
          ? {
              purpose: "continuation" as const,
              ...(this.protocol.deployment?.revisions !== undefined
                ? { allowRevise: (state.task.revisions ?? 0) < this.protocol.deployment.revisions }
                : {}),
            }
          : this.protocol.expansion
            ? { source: expansionParent(state, this.protocol.expansion.width) }
            : {}),
      }
    })
  }

  // Only the trusted host transport observer calls this. Candidate stdout, a
  // touched file, a live PID, or a supervisor timer are NOT progress evidence.
  heartbeat(revision: number, epoch: number, job: string, sequence: number, now: number) {
    return this.change(revision, now, "activity", (state) => {
      requireJob(state, epoch, job, now)
      if (state.job!.phase !== "running" || this.expired(state, now)) throw new Error("activity arrived after lease")
      if (!Number.isSafeInteger(sequence) || sequence <= state.job!.sequence) throw new Error("replayed activity")
      state.job!.heartbeat = now
      state.job!.sequence = sequence
      if (now - state.job!.started >= this.protocol.probationMs) state.trial = false
    })
  }

  // Called only AFTER a useful completed handoff and acknowledged worker stop.
  // A short successful operation need not be kept busy to fill probation time.
  handedOff(revision: number, epoch: number, job: string, now: number, checkpoint?: string) {
    return this.change(revision, now, "quiescent-handoff", (state) => {
      requireTask(this.protocol, state, now)
      requireJob(state, epoch, job, now)
      if (state.job!.purpose === "continuation") throw new Error("task continuation requires a verified task handoff")
      if (state.job!.phase !== "running" || this.expired(state, now)) throw new Error("handoff arrived after lease")
      state.job!.phase = "evaluating"
      if (checkpoint) {
        requireHash(checkpoint)
        state.active.memory.checkpoint = checkpoint
      }
      state.trial = false
    })
  }

  // Acknowledged worker stop closes the execution lease before external grading.
  // No synthetic provider heartbeat or health confirmation is needed while the
  // grader uses the remainder of the task's original deadline.
  continuationReady(revision: number, epoch: number, job: string, now: number) {
    return this.change(revision, now, "quiescent-task-continuation", (state) => {
      requireTask(this.protocol, state, now)
      requireJob(state, epoch, job, now)
      requireStanding(state, state.active)
      if (
        !state.task?.needsContinuation ||
        state.job!.purpose !== "continuation" ||
        state.job!.phase !== "running" ||
        this.expired(state, now)
      )
        throw new Error("live task continuation stop acknowledgement required")
      state.job!.phase = "evaluating"
      return { task: state.task.id, pair: state.active.pair, checkpoint: state.task.checkpoint, job }
    })
  }

  // The host calls this only after fencing the worker and checking its public
  // task artifact. Candidate testimony is neither completion nor authority.
  continued(
    revision: number,
    epoch: number,
    job: string,
    handoff: { previous: string; checkpoint: string; receipt: string; outcome: "revise" | "delivered" | "blocked" },
    now: number,
  ) {
    return this.change(revision, now, "task-continuation", (state, commands) => {
      requireTask(this.protocol, state, now)
      requireJob(state, epoch, job, now)
      requireStanding(state, state.active)
      if (!state.task?.needsContinuation || state.job!.purpose !== "continuation" || state.job!.phase !== "evaluating")
        throw new Error("current task continuation handoff required")
      requireHash(handoff.previous)
      requireHash(handoff.checkpoint)
      requireHash(handoff.receipt)
      if (handoff.previous !== state.task.checkpoint) throw new Error("task checkpoint changed before handoff")
      if (!["revise", "delivered", "blocked"].includes(handoff.outcome)) throw new Error("invalid task handoff outcome")
      if (
        handoff.outcome === "revise" &&
        this.protocol.deployment?.revisions !== undefined &&
        (state.task.revisions ?? 0) >= this.protocol.deployment.revisions
      )
        throw new Error("task revision schedule exhausted; finish the original task with the incumbent")
      const task = state.kernel.contracts[state.task.contractID]
      if (handoff.outcome === "delivered") {
        apply(state, commands, {
          type: "report-ready",
          actor: "institution",
          contractID: task.id,
          revision: task.revision,
          subjectHash: handoff.checkpoint,
          summary: "The isolated runtime delivered this exact public task checkpoint to the trusted task verifier",
          uncertainties: ["Task delivery does not establish general runtime improvement."],
          time: now,
        })
        apply(state, commands, {
          type: "discharge",
          actor: issuer,
          contractID: task.id,
          attestation: {
            id: ProContract.AttestationID.make(
              `pca_ota_task_${hash(JSON.stringify([task.id, handoff.checkpoint, handoff.receipt]))}`,
            ),
            revision: task.revision,
            specHash: task.specHash,
            subjectHash: handoff.checkpoint,
            evidenceHash: handoff.receipt,
            verifierID: issuer,
            class: "principal",
          },
        })
      }
      if (handoff.outcome === "blocked")
        apply(state, commands, {
          type: "escalate",
          actor: "institution",
          contractID: task.id,
          revision: task.revision,
          reason: `Trusted task verifier reported blocked: ${handoff.receipt}`,
          time: now,
        })
      state.task.checkpoint = handoff.checkpoint
      state.task.needsContinuation = false
      // This is only a projection of the original task Contract's standing.
      state.task.status =
        state.kernel.contracts[task.id].status === "discharged"
          ? "delivered"
          : state.kernel.contracts[task.id].status === "active"
            ? "open"
            : "blocked"
      state.trial = false
      delete state.job
      return { ...handoff, task: state.task.id, pair: state.active.pair }
    })
  }

  settle(revision: number, pair: Pair, evidence: Evidence, now: number) {
    return this.change(revision, now, "qualification", (state, commands) => {
      requireTask(this.protocol, state, now)
      if (!state.job || state.job.phase !== "evaluating") throw new Error("quiescent handoff required")
      if (state.job.purpose === "continuation") throw new Error("task continuation is not a source proposal")
      if (state.job.id !== evidence.job) throw new Error("evidence names another job")
      if (state.task && evidence.checkpoint !== state.task.checkpoint)
        throw new Error("evaluation must bind the current task checkpoint")
      if (!state.task && evidence.checkpoint !== undefined)
        throw new Error("task evidence cannot deploy a campaign pair")
      requireStanding(state, state.active)
      requirePair(pair)
      if (
        this.protocol.expansion &&
        state.lineage?.some(
          (node) => subject(node.root) === subject(state.active.pair) && subject(node.pair) === subject(pair),
        )
      )
        throw new Error("this exact pair was already evaluated under this incumbent")
      const target = opposite(state.active.slot)
      if (
        pair[state.active.slot] !== state.active.pair[state.active.slot] ||
        pair[target] === state.active.pair[target]
      )
        throw new Error("only the inactive partition may change")
      if (state.quarantine.includes(subject(pair))) throw new Error("failed boot is quarantined")
      if (evidence.baseline.subject !== subject(state.active.pair)) throw new Error("baseline is not the current pair")
      const decision = qualify(this.protocol, this.digest, pair, evidence, state.retainedFull)
      const passed = decision.eligible
      if (state.task && this.protocol.deployment?.revisions !== undefined) {
        state.task.revisions = (state.task.revisions ?? 0) + 1
        state.task.needsContinuation = true
      }
      if (state.job.source) {
        state.lineage ??= []
        state.lineage.push({
          id: hash(JSON.stringify([state.protocol, state.job.id, subject(pair)])),
          root: state.active.pair,
          parent: state.job.source.id,
          pair,
          outcome: passed ? "selected" : "rejected",
        })
      }
      if (decision.safety) state.retainedFull = [...new Set([...state.retainedFull, ...decision.baselineFull])]
      const id = ProContract.ID.make(`pct_ota_${hash(JSON.stringify([this.digest, state.job.id, subject(pair)]))}`)
      const spec = ProContract.Spec.make({
        trigger: { type: "immediate" },
        goal: "Authorize this exact pair under the frozen safety and full-pass-first performance gate, subject to health withdrawal",
        brief: JSON.stringify({ protocol: this.digest, pair, job: state.job.id, target }),
        requires: [], // Parentage is not evidence dependency: rollback must remain possible.
        authority: [],
        // Issuer-only atomic settlement; not a renewed model-execution allowance.
        budget: { deadline: now + 60_000 },
        evidence: {
          type: "principal",
          claim: "Safety passed and the scoped performance gate permits guarded OTA boot",
        },
        resolution: { maxAttempts: 1, retryDelay: 0 },
      })
      apply(state, commands, {
        type: "issue",
        actor: issuer,
        draft: {
          id,
          issuer,
          executor: `partition-${state.active.slot}`,
          scope: this.digest,
          spec,
          specHash: ProContractKernel.hashSpec(spec),
        },
      })
      if (!passed) {
        apply(state, commands, {
          type: "escalate",
          actor: "institution",
          contractID: id,
          revision: 1,
          reason: `Frozen gate failed: ${hash(JSON.stringify(evidence))}`,
          time: now,
        })
        delete state.job
        return { evidence, decision, passed: false }
      }
      apply(state, commands, { type: "activate", actor: "institution", contractID: id, revision: 1, time: now })
      apply(state, commands, {
        type: "report-ready",
        actor: "institution",
        contractID: id,
        revision: 1,
        subjectHash: subject(pair),
        summary: spec.goal,
        uncertainties: ["Full pass is scoped to the fixed suite; it is not proof of general improvement."],
        time: now,
      })
      apply(state, commands, {
        type: "discharge",
        actor: issuer,
        contractID: id,
        attestation: {
          id: ProContract.AttestationID.make(`pca_ota_${id}`),
          revision: 1,
          specHash: ProContractKernel.hashSpec(spec),
          subjectHash: subject(pair),
          evidenceHash: hash(JSON.stringify(evidence)),
          verifierID: issuer,
          class: "principal",
        },
      })
      state.fallback = state.active
      state.active = {
        slot: target,
        pair,
        support: id,
        memory: { id: `e${state.epoch + 1}`, parent: state.active.memory.id, origin: state.active.memory.checkpoint },
      }
      state.epoch += 1
      state.trial = true
      state.primaryImproved = decision.primaryImproved
      if (state.task) state.task.needsContinuation = true
      state.retainedFull = [...new Set([...state.retainedFull, ...decision.full])]
      delete state.job
      return { evidence, decision, passed: true }
    })
  }

  rejectPreparation(revision: number, pair: Pair, reason: string, receipt: string, now: number) {
    return this.change(revision, now, "preparation-rejected", (state, commands) => {
      requireTask(this.protocol, state, now)
      if (state.job?.phase !== "evaluating") throw new Error("quiescent proposal required")
      if (state.job.purpose === "continuation") throw new Error("task continuation is not a source proposal")
      requireStanding(state, state.active)
      requirePair(pair)
      requireHash(receipt)
      if (pair[state.active.slot] !== state.active.pair[state.active.slot]) throw new Error("active partition changed")
      const id = ProContract.ID.make(`pct_ota_build_${hash(JSON.stringify([state.protocol, state.job.id, pair]))}`)
      const spec = ProContract.Spec.make({
        trigger: { type: "immediate" },
        goal: "Qualify this source proposal for evaluation",
        brief: JSON.stringify({ protocol: state.protocol, pair, job: state.job.id }),
        requires: [],
        authority: [],
        budget: { deadline: now + 60_000 },
        evidence: { type: "principal", claim: "The proposed artifact builds under the frozen recipe" },
        resolution: { maxAttempts: 1, retryDelay: 0 },
      })
      apply(state, commands, {
        type: "issue",
        actor: issuer,
        draft: {
          id,
          issuer,
          executor: `partition-${state.active.slot}`,
          scope: state.protocol,
          spec,
          specHash: ProContractKernel.hashSpec(spec),
        },
      })
      apply(state, commands, {
        type: "escalate",
        actor: "institution",
        contractID: id,
        revision: 1,
        reason: `Preparation failed: ${receipt}`,
        time: now,
      })
      if (state.task && this.protocol.deployment?.revisions !== undefined) {
        state.task.revisions = (state.task.revisions ?? 0) + 1
        state.task.needsContinuation = true
      }
      delete state.job
      return { reason, receipt, performanceEvaluated: false }
    })
  }

  expired(state: State, now: number) {
    if (!state.job || state.job.phase !== "running") return false
    const timeout = state.job.sequence < 0 ? this.protocol.startupMs : this.protocol.heartbeatMs
    return now - state.job.heartbeat >= timeout
  }

  // Fence/kill the OLD worker and wait for acknowledgement BEFORE this method.
  // The next boot gets a new epoch but inherits the interrupted job's deadline.
  rollback(revision: number, reason: string, now: number) {
    return this.change(revision, now, "rollback", (state, commands) => {
      if (!state.fallback) throw new Error("no acknowledged fallback; stop instead")
      requireStanding(state, state.fallback)
      if (state.active.support) {
        const id = ProContract.ID.make(state.active.support)
        const current = state.kernel.contracts[id]
        if (current.status === "discharged")
          apply(state, commands, {
            type: "challenge",
            actor: issuer,
            contractID: id,
            challenge: {
              revision: current.revision,
              subjectHash: subject(state.active.pair),
              evidenceHash: hash(JSON.stringify({ reason, epoch: state.epoch, time: now })),
              disclosure: "sealed",
              time: now,
            },
          })
      }
      state.quarantine.push(subject(state.active.pair))
      state.active = {
        ...state.fallback,
        memory: {
          id: `e${state.epoch + 1}`,
          parent: state.fallback.memory.id,
          origin: state.fallback.memory.checkpoint,
        },
      }
      delete state.fallback
      state.epoch += 1
      state.trial = false
      state.primaryImproved = false
      if (state.task) state.task.needsContinuation = true
      if (state.job) {
        // No fresh six-hour allowance after rollback or supervisor restart.
        state.job.started = now
        state.job.heartbeat = now
        state.job.sequence = -1
        state.job.phase = "running"
        if (state.task) {
          state.job.purpose = "continuation"
          if (this.protocol.deployment?.revisions !== undefined)
            state.job.allowRevise = (state.task.revisions ?? 0) < this.protocol.deployment.revisions
          delete state.job.source
        }
        if (!state.task && this.protocol.expansion)
          state.job.source = expansionParent(state, this.protocol.expansion.width)
      }
      return { reason }
    })
  }

  stop(revision: number, reason: string, now: number) {
    return this.change(revision, now, "stop", (state, commands) => {
      const task = state.task && state.kernel.contracts[state.task.contractID]
      if (task && (task.status === "active" || task.status === "verification")) {
        apply(state, commands, {
          type: "escalate",
          actor: "institution",
          contractID: task.id,
          revision: task.revision,
          reason: `Task stopped without verified delivery: ${reason}`,
          time: now,
        })
        state.task!.status = "blocked"
      }
      state.stopped = reason
      return { reason }
    })
  }

  private change(
    revision: number,
    now: number,
    type: string,
    update: (state: State, commands: ProContractKernel.Command[]) => unknown,
  ) {
    return this.db
      .transaction(() => {
        const state = this.read()
        if (hash(JSON.stringify(this.protocol)) !== this.digest) throw new Error("frozen OTA protocol changed")
        if (state.revision !== revision) throw new Error("stale supervisor revision")
        if (state.stopped) throw new Error(`OTA stopped: ${state.stopped}`)
        if (!Number.isSafeInteger(now) || now < state.clock) throw new Error("clock moved backwards; fail closed")
        const commands: ProContractKernel.Command[] = []
        const details = update(state, commands)
        state.revision += 1
        state.clock = now
        this.db.query("UPDATE ota_state SET value = ? WHERE id = 1").run(JSON.stringify(state))
        this.db
          .query("INSERT INTO ota_event VALUES (?, ?)")
          .run(state.revision, JSON.stringify({ type, time: now, epoch: state.epoch, commands, details }))
        return state
      })
      .immediate()
  }
}

export function qualify(protocol: Protocol, digest: string, pair: Pair, evidence: Evidence, retained: string[] = []) {
  requireHash(evidence.receipt)
  if (evidence.protocol !== digest || evidence.subject !== subject(pair)) throw new Error("stale or foreign evidence")
  const tables = [evidence.baseline.rows, evidence.rows].map((rows) => {
    if (rows.length !== protocol.tests.length || new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new Error("missing or duplicate tests")
    return protocol.tests.map((test) => {
      const row = rows.find((row) => row.id === test.id)
      if (
        !row ||
        row.total !== test.total ||
        !Number.isSafeInteger(row.passed) ||
        row.passed < 0 ||
        row.passed > row.total ||
        typeof row.valid !== "boolean"
      )
        throw new Error("test identity or denominator changed")
      if (!row.valid) throw new Error("incomplete evaluator evidence; stop, do not retry as a negative candidate")
      return { ...row, performance: test.performance }
    })
  })
  const safety = tables.every((rows) => rows.filter((row) => !row.performance).every((row) => row.passed === row.total))
  const panels = ["development", "confirmation"].flatMap((panel) => {
    const tasks = [
      ...new Set(
        protocol.tests.filter((test) => test.performance?.panel === panel).map((test) => test.performance!.task),
      ),
    ]
    if (!tasks.length) return []
    const scores = tables.map((rows) => {
      const summaries = tasks.map((task) => {
        const executions = rows.filter((row) => row.performance?.panel === panel && row.performance.task === task)
        const sum = executions.map((row) => [BigInt(row.passed), BigInt(row.total)] as const).reduce(add, [0n, 1n])
        return {
          task,
          full: executions.every((row) => row.passed === row.total),
          mean: [sum[0], sum[1] * BigInt(executions.length)] as const,
        }
      })
      const sum = summaries.map((row) => row.mean).reduce(add, [0n, 1n])
      return {
        tasks: summaries,
        full: summaries.filter((row) => row.full).map((row) => `${panel}:${row.task}`),
        mean: [sum[0], sum[1] * BigInt(tasks.length)] as const,
      }
    })
    const gain = add(scores[1].mean, [-scores[0].mean[0], scores[0].mean[1]])
    const lost = [...new Set([...scores[0].full, ...retained.filter((key) => key.startsWith(panel + ":"))])].filter(
      (key) => !scores[1].full.includes(key),
    )
    const added = scores[1].full.filter((key) => !scores[0].full.includes(key))
    const missingRequired = (protocol.requiredFull ?? []).filter(
      (key) => key.startsWith(panel + ":") && !scores[1].full.includes(key),
    )
    const changes = scores[1].tasks.map((task, index) => ({
      task: `${panel}:${task.task}`,
      gain: add(task.mean, [-scores[0].tasks[index].mean[0], scores[0].tasks[index].mean[1]]),
    }))
    const regressed = changes.filter((task) => task.gain[0] < 0n).map((task) => task.task)
    const improved =
      protocol.performanceRule === "task-pareto"
        ? changes.some((task) => task.gain[0] > 0n)
        : added.length > 0 || gain[0] * 10_000n >= BigInt(protocol.minimumMeanGainBps!) * gain[1]
    return [
      {
        panel,
        lost,
        added,
        baselineFull: scores[0].full,
        full: scores[1].full,
        totalTasks: tasks.length,
        meanGain: Number((gain[0] * 1_000_000_000_000n) / gain[1]) / 1_000_000_000_000,
        meanGainExact: gain.map(String),
        improved,
        missingRequired,
        regressed,
        eligible:
          !lost.length &&
          !missingRequired.length &&
          (protocol.performanceRule === "task-pareto"
            ? !regressed.length
            : improved || scores.every((score) => score.full.length === tasks.length)),
      },
    ]
  })
  return {
    eligible:
      safety &&
      panels.every((panel) => panel.eligible) &&
      (panels.length === 0 || panels.some((panel) => panel.improved)),
    safety,
    panels,
    full: panels.flatMap((panel) => panel.full),
    baselineFull: panels.flatMap((panel) => panel.baselineFull),
    primaryImproved:
      safety &&
      panels.every((panel) => panel.eligible) &&
      panels.some((panel) =>
        panel.added.some((task) => !retained.includes(task) && !(protocol.requiredFull ?? []).includes(task)),
      ),
    allFull: panels.length > 0 && safety && panels.every((panel) => panel.full.length === panel.totalTasks),
    scope: protocol.scope,
  }
}

/** Source ancestry is not execution standing. Only the active pair runs the
 * proposer; rejected, materialized children may supply inactive source bytes.
 * A promotion starts a new root with the newly fixed active partition.
 */
export function expansionParent(state: State, width: number) {
  const root = subject(state.active.pair)
  const nodes = (state.lineage ?? []).filter((node) => subject(node.root) === root)
  const candidates = [{ id: root, pair: state.active.pair }, ...nodes]
  const parent = candidates.find((candidate) => nodes.filter((node) => node.parent === candidate.id).length < width)
  if (!parent) throw new Error("no expandable source parent")
  return { id: parent.id, pair: parent.pair }
}

function add(left: readonly [bigint, bigint], right: readonly [bigint, bigint]): readonly [bigint, bigint] {
  const numerator = left[0] * right[1] + right[0] * left[1]
  const denominator = left[1] * right[1]
  const divisor = gcd(numerator < 0n ? -numerator : numerator, denominator)
  return [numerator / divisor, denominator / divisor]
}

function gcd(left: bigint, right: bigint): bigint {
  return right === 0n ? left : gcd(right, left % right)
}

function requireHash(value: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid content identity")
}

function requirePair(pair: Pair) {
  if (Object.keys(pair).sort().join(",") !== "h,s") throw new Error("only s and h artifacts are mutable")
  requireHash(pair.s)
  requireHash(pair.h)
}

function requireStanding(state: State, boot: Boot) {
  if (!boot.support) return // Explicitly authorized seed, NOT a performance attestation.
  const support = state.kernel.contracts[boot.support]
  if (support?.status !== "discharged" || support.handoff?.subjectHash !== subject(boot.pair))
    throw new Error("boot support was withdrawn")
}

function requireTask(protocol: Protocol, state: State, now: number) {
  if (!protocol.deployment) return
  if (now < protocol.deployment.started) throw new Error("original task has not started")
  if (now >= protocol.deployment.deadline) throw new Error("original task deadline reached")
  if (state.task?.status !== "open") throw new Error("task is already delivered or blocked")
  const task = state.kernel.contracts[state.task.contractID]
  if (
    state.task.id !== protocol.deployment.task ||
    state.task.contractID !== taskContractID(state.protocol, protocol.deployment.task) ||
    task?.status !== "active" ||
    task.scope !== state.protocol ||
    task.spec.budget.deadline !== protocol.deployment.deadline
  )
    throw new Error("original task Contract is not active under this frozen scope")
}

function taskContractID(protocol: string, task: string) {
  return ProContract.ID.make(`pct_ota_task_${hash(JSON.stringify([protocol, task]))}`)
}

function requireJob(state: State, epoch: number, job: string, now: number) {
  if (state.epoch !== epoch || state.job?.id !== job) throw new Error("stale activation or job")
  if (now >= state.job.deadline) throw new Error("original job deadline reached")
}

function apply(state: State, commands: ProContractKernel.Command[], command: ProContractKernel.Command) {
  const result = ProContractKernel.transition(state.kernel, command)
  if (result.decision.type !== "accepted") throw new Error(result.decision.reason)
  state.kernel = result.state
  commands.push(command)
}
