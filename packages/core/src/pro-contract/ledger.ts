export * as ContractLedger from "./ledger.js"

import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { ProContract } from "@opencode/schema/pro-contract"
import { ProContractKernel } from "./kernel.js"
import { RSI } from "./rsi.js"

export type Method = { hash: string; grant: ProContract.ID }
export type Task = {
  id: ProContract.ID
  input: string
  checkpoint: string
  feedback: string[]
  execution?: { id: string; method: Method }
}
export type State = {
  revision: number
  kernel: ProContractKernel.State
  protocol: RSI.Protocol
  active: Method
  methods: Record<string, RSI.Method>
  tasks: Record<string, Task>
  compared: string[]
  retained: string[]
  seed: string
  proposals: Record<string, { task: ProContract.ID; checkpoint: string; source: string }>
}

/** Private, issuer-owned ledger. It is never mounted into a native worker. */
export class Store {
  readonly db: Database

  constructor(file: string, protocol: RSI.Protocol, seed: RSI.Method) {
    RSI.protocol(protocol)
    RSI.method(seed)
    this.db = new Database(file, { create: true, strict: true })
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event (seq INTEGER PRIMARY KEY, data TEXT NOT NULL, previous TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS object (hash TEXT PRIMARY KEY, data TEXT NOT NULL);
    `)
    if (this.db.query("SELECT id FROM state").get()) {
      const state = this.read()
      if (RSI.hash(state.protocol) !== RSI.hash(protocol) || state.seed !== RSI.hash(seed))
        throw new Error("Existing ledger belongs to a different frozen protocol or seed")
      this.verify()
      return
    }
    const method = RSI.method(seed)
    const hash = RSI.hash(method)
    const state: State = {
      revision: 0,
      kernel: ProContractKernel.empty,
      protocol,
      active: { hash, grant: ProContract.ID.make(`pct_seed_${hash}`) },
      methods: { [hash]: method },
      tasks: {},
      compared: [],
      retained: [],
      seed: hash,
      proposals: {},
    }
    this.db.query("INSERT INTO state VALUES (1, ?, ?)").run(JSON.stringify(state), RSI.hash(state))
    this.change({ type: "seed-authorized", protocol, method }, (state, apply) => {
      this.grant(
        state.active.grant,
        "Permission to execute the exact seed method; not a quality claim",
        hash,
        [],
        apply,
      )
    })
  }

  read(): State {
    const row = this.db.query<{ data: string; hash: string }, []>("SELECT data, hash FROM state WHERE id = 1").get()!
    const state = JSON.parse(row.data) as State
    if (RSI.hash(state) !== row.hash) throw new Error("Ledger projection integrity failure")
    return state
  }

  object(value: unknown) {
    const hash = RSI.hash(value)
    this.db.query("INSERT OR IGNORE INTO object VALUES (?, ?)").run(hash, JSON.stringify(value))
    return hash
  }

  inspect(hash: string): unknown {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM object WHERE hash = ?").get(hash)
    if (!row) throw new Error(`Missing evidence object ${hash}`)
    const value: unknown = JSON.parse(row.data)
    if (RSI.hash(value) !== hash) throw new Error("Evidence object integrity failure")
    return value
  }

  issue(input: { id: ProContract.ID; goal: string; deadline: number; checkpoint: string; identity: string }) {
    return this.change({ type: "task-admitted", input }, (state, apply) => {
      const existing = state.tasks[input.id]
      if (existing) {
        if (existing.input !== RSI.hash(input)) throw new Error("Conflicting task admission")
        return existing
      }
      const spec = this.spec(input.goal, input.deadline)
      apply({
        type: "issue",
        actor: "principal",
        draft: {
          id: input.id,
          scope: RSI.hash(state.protocol),
          spec,
          issuer: "principal",
          executor: "native-session",
          specHash: ProContractKernel.hashSpec(spec),
        },
      })
      apply({ type: "activate", actor: "institution", contractID: input.id, revision: 1, time: Date.now() })
      const task: Task = { id: input.id, input: RSI.hash(input), checkpoint: input.checkpoint, feedback: [] }
      state.tasks[input.id] = task
      return task
    })
  }

  begin(id: ProContract.ID, execution: string) {
    return this.change({ type: "execution-admitted", task: id, execution }, (state) => {
      const task = state.tasks[id]
      this.assertTask(state, id)
      this.assertMethod(state, state.active)
      if (task.execution) throw new Error("Unclosed execution: fence explicitly before resuming")
      task.execution = { id: execution, method: state.active }
      return task.execution
    })
  }

  checkpoint(id: ProContract.ID, execution: string, checkpoint: string, summary: string) {
    this.change({ type: "checkpoint-retained", task: id, execution, checkpoint, summary }, (state) => {
      const task = state.tasks[id]
      if (task?.execution?.id !== execution) throw new Error("Stale execution handoff")
      task.checkpoint = checkpoint
      task.feedback.push(summary)
      delete task.execution
    })
  }

  /** Fence receipt is retained even on expiry; it never grants another allocation. */
  interrupted(id: ProContract.ID, reason: string, fenced: boolean) {
    this.change({ type: "interrupted", task: id, reason, fenced }, (state, apply) => {
      const task = state.tasks[id]
      if (!task) throw new Error("Unknown task")
      if (fenced) delete task.execution
      task.feedback.push(reason)
      apply({ type: "escalate", actor: "institution", contractID: id, revision: 1, reason, time: Date.now() })
    })
  }

  resume(id: ProContract.ID) {
    this.change({ type: "explicit-resume", task: id }, (state, apply) => {
      if (state.tasks[id]?.execution) throw new Error("Execution fencing is unacknowledged")
      apply({ type: "resume", actor: "principal", contractID: id })
      apply({ type: "activate", actor: "institution", contractID: id, revision: 1, time: Date.now() })
    })
  }

  settleTask(
    id: ProContract.ID,
    evidence: { passed: number; total: number; valid: boolean; feedback?: string },
    mode: "feedback" | "terminal" = "feedback",
  ) {
    this.change({ type: "task-verification", task: id, evidence, mode }, (state, apply) => {
      this.assertTask(state, id)
      const task = state.tasks[id]
      if (task.execution) throw new Error("Verify only fenced work")
      if (!evidence.valid) throw new Error("Missing verifier evidence is not a score")
      if (
        !Number.isSafeInteger(evidence.passed) ||
        !Number.isSafeInteger(evidence.total) ||
        evidence.total <= 0 ||
        evidence.passed < 0 ||
        evidence.passed > evidence.total
      )
        throw new Error("Invalid verifier score")
      const hash = this.object({ task: id, checkpoint: task.checkpoint, ...evidence })
      apply({
        type: "report-ready",
        actor: "institution",
        contractID: id,
        revision: 1,
        summary: "Independently verified sealed work",
        uncertainties: [],
        subjectHash: task.checkpoint,
        time: Date.now(),
      })
      if (evidence.passed === evidence.total) {
        this.discharge(state, id, task.checkpoint, hash, apply)
        return
      }
      apply({
        type: "challenge",
        actor: "principal",
        contractID: id,
        challenge: {
          revision: 1,
          subjectHash: task.checkpoint,
          evidenceHash: hash,
          ...(mode === "terminal"
            ? { disclosure: "sealed" as const }
            : {
                disclosure: "executor" as const,
                summary: evidence.feedback || "Independent verification did not accept the task",
              }),
          time: Date.now(),
        },
      })
      if (mode === "terminal") return
      task.feedback.push(evidence.feedback || "Independent verification did not accept the task")
      apply({ type: "activate", actor: "institution", contractID: id, revision: 1, time: Date.now() })
    })
  }

  note(id: ProContract.ID, text: string) {
    this.change({ type: "public-observation", task: id, text }, (state) => {
      state.tasks[id].feedback.push(text)
    })
  }

  propose(id: ProContract.ID, parent: Method, candidate: RSI.Method, source: string) {
    return this.change({ type: "comparison-admitted", id, parent, candidate, source }, (state) => {
      this.assertTask(state, id)
      this.assertMethod(state, parent)
      const receipt = Schema.decodeUnknownSync(RSI.Execution)(this.inspect(source))
      if (
        receipt.task !== id ||
        receipt.evaluation ||
        receipt.output !== state.tasks[id].checkpoint ||
        receipt.deadline !== state.kernel.contracts[id].spec.budget.deadline ||
        RSI.hash(receipt.parent) !== RSI.hash(parent) ||
        receipt.method !== parent.hash ||
        receipt.handoff.action !== "propose" ||
        RSI.hash(receipt.handoff.method) !== RSI.hash(candidate)
      )
        throw new Error("Proposal does not bind the actual producer and checkpoint")
      const key = RSI.hash({ parent, candidate: RSI.hash(candidate), protocol: state.protocol })
      if (state.proposals[key]) throw new Error("This candidate already has a comparison allocation")
      state.proposals[key] = { task: id, checkpoint: receipt.output, source }
      return key
    })
  }

  select(parent: Method, candidate: RSI.Method, measurements: readonly RSI.Measurement[]) {
    return this.change({ type: "method-comparison", parent, candidate, measurements }, (state, apply) => {
      this.assertMethod(state, parent)
      if (state.active.hash !== parent.hash || state.active.grant !== parent.grant) throw new Error("Incumbent changed")
      const method = RSI.method(candidate)
      const hash = RSI.hash(method)
      if (hash === parent.hash) throw new Error("Unchanged method is not an improvement")
      const key = RSI.hash({ parent, candidate: hash, protocol: state.protocol })
      if (state.compared.includes(key)) throw new Error("This candidate was already compared with this incumbent")
      const proposal = state.proposals[key]
      if (!proposal) throw new Error("Comparison was not admitted")
      this.assertTask(state, proposal.task)
      if (state.tasks[proposal.task].checkpoint !== proposal.checkpoint) throw new Error("Proposal checkpoint changed")
      const executions = new Set<string>()
      for (const row of measurements) {
        const execution = Schema.decodeUnknownSync(RSI.Execution)(this.inspect(row.execution))
        if (executions.has(execution.id)) throw new Error("A physical execution cannot fill two measurement slots")
        executions.add(execution.id)
        if (execution.segments) {
          if (!execution.segments.length) throw new Error("Empty evaluation continuation chain")
          const segments = execution.segments.map((hash) => Schema.decodeUnknownSync(RSI.Execution)(this.inspect(hash)))
          segments.forEach((segment, index) => {
            if (segment.segments || executions.has(segment.id)) throw new Error("Reused or nested evaluation execution")
            executions.add(segment.id)
            if (
              segment.task !== execution.task ||
              !segment.evaluation ||
              segment.method !== execution.method ||
              RSI.hash(segment.parent) !== RSI.hash(execution.parent) ||
              segment.deadline !== execution.deadline ||
              RSI.hash(segment.assignment) !== RSI.hash(execution.assignment) ||
              segment.input !== (index ? segments[index - 1].output : execution.input) ||
              (index < segments.length - 1 && segment.handoff.action !== "checkpoint")
            )
              throw new Error("Evaluation continuation changed its admitted method, input or allowance")
          })
          if (
            segments.at(-1)!.output !== execution.output ||
            RSI.hash(segments.at(-1)!.handoff) !== RSI.hash(execution.handoff)
          )
            throw new Error("Evaluation handoff does not match its final segment")
        }
        const verification = Schema.decodeUnknownSync(RSI.Verification)(this.inspect(row.verification))
        const test = state.protocol.tests.find((test) => test.id === row.test)
        if (
          !test ||
          !execution.evaluation ||
          execution.task !== proposal.task ||
          RSI.hash(execution.parent) !== RSI.hash(parent) ||
          execution.method !== (row.side === "baseline" ? parent.hash : hash) ||
          execution.input !== test.checkpoint ||
          execution.output !== row.artifact ||
          execution.deadline !== state.kernel.contracts[proposal.task].spec.budget.deadline ||
          execution.assignment?.test !== row.test ||
          execution.assignment.repeat !== row.repeat ||
          execution.assignment.side !== row.side ||
          verification.artifact !== row.artifact ||
          verification.verifier !== test.verifier ||
          verification.passed !== row.passed ||
          verification.total !== row.total ||
          verification.valid !== row.valid
        )
          throw new Error("Measurement is not bound to its admitted execution and verifier")
      }
      const decision = RSI.compare(state.protocol, measurements, state.retained)
      const evidence = this.object({ parent, candidate: hash, protocol: state.protocol, measurements, decision })
      const evaluation = ProContract.ID.make(`pct_measurement_${key}`)
      this.grant(evaluation, "Record a complete paired measurement, not permission to deploy", evidence, [], apply)
      state.methods[hash] = method
      state.compared.push(key)
      state.retained = decision.retained
      if (decision.eligible) {
        const grant = ProContract.ID.make(`pct_adoption_${key}`)
        this.grant(
          grant,
          "Authorize this exact method under the frozen task-Pareto protocol",
          hash,
          [{ contractID: evaluation, revision: 1 }],
          apply,
          evidence,
        )
        state.active = { hash, grant }
      }
      return { ...decision, evidence, evaluation, active: state.active }
    })
  }

  withdraw(id: ProContract.ID, reason: string) {
    this.change({ type: "support-withdrawn", id, reason }, (state, apply) => {
      const contract = state.kernel.contracts[id]
      if (!contract?.handoff) throw new Error("No accepted support to withdraw")
      apply({
        type: "challenge",
        actor: "principal",
        contractID: id,
        challenge: {
          revision: contract.revision,
          subjectHash: contract.handoff.subjectHash,
          evidenceHash: this.object({ reason }),
          disclosure: "executor",
          summary: reason,
          time: Date.now(),
        },
      })
    })
  }

  assertTask(state: State, id: ProContract.ID) {
    const contract = state.kernel.contracts[id]
    if (!contract || contract.status !== "active" || Date.now() >= contract.spec.budget.deadline)
      throw new Error("Task is not active within its original deadline")
  }

  assertMethod(state: State, method: Method) {
    const contract = state.kernel.contracts[method.grant]
    if (contract?.status !== "discharged" || contract.handoff?.subjectHash !== method.hash)
      throw new Error("Exact execution grant is absent or withdrawn")
  }

  close() {
    this.db.close()
  }

  verify() {
    const rows = this.db
      .query<{ seq: number; data: string; previous: string; hash: string }, []>("SELECT * FROM event ORDER BY seq")
      .all()
    rows.forEach((row, index) => {
      const previous = index ? rows[index - 1].hash : "0".repeat(64)
      if (row.seq !== index + 1 || row.previous !== previous || row.hash !== RSI.hash({ previous, data: row.data }))
        throw new Error("Ledger event-chain integrity failure")
    })
    const state = this.read()
    if (
      rows.length !== state.revision ||
      (JSON.parse(rows.at(-1)!.data) as { projection: string }).projection !== RSI.hash(state)
    )
      throw new Error("Ledger projection does not match its event frontier")
  }

  private change<A>(fact: unknown, f: (state: State, apply: (command: ProContractKernel.Command) => void) => A) {
    return this.db
      .transaction(() => {
        const state = this.read()
        const commands: ProContractKernel.Command[] = []
        const apply = (command: ProContractKernel.Command) => {
          const next = ProContractKernel.transition(state.kernel, command)
          if (next.decision.type === "rejected") throw new Error(next.decision.reason)
          state.kernel = next.state
          commands.push(command)
        }
        const result = f(state, apply)
        state.revision++
        const previous =
          this.db.query<{ hash: string }, []>("SELECT hash FROM event ORDER BY seq DESC LIMIT 1").get()?.hash ??
          "0".repeat(64)
        const data = JSON.stringify({ fact, commands, projection: RSI.hash(state) })
        this.db
          .query("INSERT INTO event VALUES (?, ?, ?, ?)")
          .run(state.revision, data, previous, RSI.hash({ previous, data }))
        this.db.query("UPDATE state SET data = ?, hash = ? WHERE id = 1").run(JSON.stringify(state), RSI.hash(state))
        return result
      })
      .immediate()
  }

  private spec(goal: string, deadline: number, requires: readonly ProContract.Requirement[] = []): ProContract.Spec {
    return {
      trigger: { type: "immediate" },
      goal,
      brief: goal,
      requires,
      authority: [],
      budget: { deadline },
      evidence: { type: "principal" },
      resolution: { maxAttempts: 1, retryDelay: 0 },
    }
  }

  private grant(
    id: ProContract.ID,
    goal: string,
    subject: string,
    requires: readonly ProContract.Requirement[],
    apply: (command: ProContractKernel.Command) => void,
    evidence = subject,
  ) {
    const spec = this.spec(goal, Date.now() + 60000, requires)
    apply({
      type: "issue",
      actor: "principal",
      draft: {
        id,
        scope: "methods",
        spec,
        issuer: "principal",
        executor: "independent-verifier",
        specHash: ProContractKernel.hashSpec(spec),
      },
    })
    apply({ type: "activate", actor: "institution", contractID: id, revision: 1, time: Date.now() })
    apply({
      type: "report-ready",
      actor: "institution",
      contractID: id,
      revision: 1,
      summary: goal,
      uncertainties: [],
      subjectHash: subject,
      time: Date.now(),
    })
    apply({
      type: "discharge",
      actor: "principal",
      contractID: id,
      attestation: {
        id: ProContract.AttestationID.create(),
        revision: 1,
        specHash: ProContractKernel.hashSpec(spec),
        subjectHash: subject,
        evidenceHash: evidence,
        verifierID: "principal",
        class: "principal",
      },
    })
  }

  private discharge(
    state: State,
    id: ProContract.ID,
    subjectHash: string,
    evidenceHash: string,
    apply: (command: ProContractKernel.Command) => void,
  ) {
    apply({
      type: "discharge",
      actor: "principal",
      contractID: id,
      attestation: {
        id: ProContract.AttestationID.create(),
        revision: 1,
        specHash: state.kernel.contracts[id].specHash,
        subjectHash,
        evidenceHash,
        verifierID: "principal",
        class: "principal",
      },
    })
  }
}
