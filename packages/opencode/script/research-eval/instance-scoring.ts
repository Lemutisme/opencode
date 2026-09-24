import { Database } from "bun:sqlite"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { digest, duration } from "./ledger"
import {
  measurementVersion,
  measures,
  revealVersion,
  terminalMaterial,
  type Judgment,
  type Rubric,
  type TerminalObservation,
} from "./advisory-measurement"

type Context = { id: string; execution: string; rater: string }
type Roles = {
  candidate: [Context, Context]
  candidateAdjudicator: Context
  feedback: [Context, Context]
  feedbackAdjudicator: Context
}
export type Freeze = {
  version: typeof measurementVersion
  reveal: typeof revealVersion
  codeHash: string
  instances: {
    id: string
    contractID: string
    agreementHash: string
    files: string[]
    started: number
    deadline: number
    roles: Roles
  }[]
  unavailable: "not_scored"
  rubric: Rubric
}
type Material = {
  candidate?: string
  terminal?: string
  source?: string
  feedback: string
  audit: string
  infrastructure: string
}
type Receipt = {
  instance: string
  phase: "candidate" | "feedback"
  context: Context
  materialHash: string
  rubricHash: string
}
type Seal = { first: Judgment; second: Judgment; resolution?: Judgment; items: Judgment["items"] }

/** New measurement entrypoint. The historical batch-wide gate is deliberately not called or modified. */
export class InstanceScoring {
  private db: Database
  private readonly freeze: Freeze

  constructor(filename: string, freeze: Freeze) {
    if (
      freeze.version !== measurementVersion ||
      freeze.reveal !== revealVersion ||
      freeze.unavailable !== "not_scored" ||
      !/^[a-f0-9]{64}$/.test(freeze.codeHash) ||
      !freeze.instances.length ||
      new Set(freeze.instances.map((item) => item.id)).size !== freeze.instances.length ||
      new Set(freeze.instances.map((item) => item.contractID)).size !== freeze.instances.length ||
      freeze.instances.some(
        (item) =>
          !item.id ||
          !item.contractID ||
          !/^[a-f0-9]{64}$/.test(item.agreementHash) ||
          !item.files.length ||
          !Number.isFinite(item.started) ||
          item.deadline - item.started !== duration,
      )
    )
      throw new Error("Explicit measurement, context policy and original six-hour coordinates are required")
    const contexts = freeze.instances.flatMap((item) => [
      ...item.roles.candidate,
      item.roles.candidateAdjudicator,
      ...item.roles.feedback,
      item.roles.feedbackAdjudicator,
    ])
    if (
      contexts.some((item) => !item.id || !item.execution || !item.rater) ||
      new Set(contexts.map((item) => item.id)).size !== contexts.length ||
      new Set(contexts.map((item) => item.execution)).size !== contexts.length ||
      freeze.instances.some((item) =>
        [
          [...item.roles.candidate, item.roles.candidateAdjudicator],
          [...item.roles.feedback, item.roles.feedbackAdjudicator],
        ].some((group) => new Set(group.map((context) => context.rater)).size !== 3),
      )
    )
      throw new Error("Pre-register distinct raters and fresh isolated execution contexts; aliases are not isolation")
    if (
      ["research_result", "reviewer_judgment", "feedback_handling", "audit_completeness"].some(
        (dimension) => !Object.values(freeze.rubric).some((item) => item.dimension === dimension),
      ) ||
      Object.values(freeze.rubric).some((item) => !item.question)
    )
      throw new Error("Freeze a nonempty rubric for each measurement dimension before any materials or judgments")
    this.freeze = JSON.parse(JSON.stringify(freeze))
    const immutable = (value: unknown): void => {
      if (!value || typeof value !== "object") return
      Object.values(value).forEach(immutable)
      Object.freeze(value)
    }
    immutable(this.freeze)
    this.db = new Database(filename, { create: true, strict: true })
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS object (hash TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS material (id TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grant_record (hash TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS judgment (context TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seal (id TEXT NOT NULL, phase TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(id,phase));
      CREATE TABLE IF NOT EXISTS gap (id TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exposure (execution TEXT PRIMARY KEY, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event (seq INTEGER PRIMARY KEY, hash TEXT NOT NULL);`)
    const previous = this.db.query<{ value: string }, []>("SELECT value FROM config WHERE id=1").get()
    if (previous && previous.value !== JSON.stringify(this.freeze))
      throw new Error("Frozen measurement configuration changed")
    if (!previous) this.db.query("INSERT INTO config VALUES(1,?)").run(JSON.stringify(this.freeze))
  }

  close() {
    this.db.close()
  }

  /** Trusted exporter input. Candidate materials contain task, exact files, plan and evidence only. */
  prepare(
    id: string,
    input: {
      source: { contractID: string; agreementHash: string; deadline: number; files: string[]; archiveHash: string }
      candidate: unknown
      feedback: unknown
      audit: unknown
      infrastructure: unknown
    },
  ) {
    return this.db.transaction(() => {
      const instance = this.instance(id)
      if (
        input.source.contractID !== instance.contractID ||
        input.source.agreementHash !== instance.agreementHash ||
        input.source.deadline !== instance.deadline ||
        JSON.stringify(input.source.files) !== JSON.stringify(instance.files) ||
        !/^[a-f0-9]{64}$/.test(input.source.archiveHash)
      )
        throw new Error("Export belongs to another frozen instance or file allowlist")
      if (input.candidate === undefined || input.candidate === null)
        throw new Error("Use confirmed terminal material for absence")
      return this.bind(id, {
        source: this.put(input.source),
        candidate: this.put(input.candidate),
        feedback: this.put(input.feedback),
        audit: this.put(input.audit),
        infrastructure: this.put(input.infrastructure),
      })
    })()
  }

  terminal(id: string, input: TerminalObservation, feedback: unknown, infrastructure: unknown) {
    return this.db.transaction(() => {
      const item = this.instance(id)
      const terminal = terminalMaterial(input)
      if (
        terminal.originalDeadline !== item.deadline ||
        terminal.agreement.id !== item.contractID ||
        ProContractRecognition.fingerprint(terminal.agreement) !== item.agreementHash
      )
        throw new Error("Terminal evidence belongs to another agreement or original deadline")
      return this.bind(id, {
        terminal: this.put(terminal),
        feedback: this.put(feedback),
        audit: this.put({ completion: "not_observed", reason: terminal.reason }),
        infrastructure: this.put(infrastructure),
      })
    })()
  }

  gap(id: string, reason: string, evidence: unknown) {
    this.instance(id)
    if (!reason) throw new Error("A scoring gap must retain its specific reason")
    return this.db.transaction(() => {
      const hash = this.put({ id, reason, evidence, status: "not_scored" })
      this.db.query("INSERT INTO gap VALUES (?,?)").run(id, hash)
      this.event({ kind: "gap", id, hash })
      return hash
    })()
  }

  grant(id: string, phase: Receipt["phase"], contextID: string) {
    return this.db.transaction(() => {
      const instance = this.instance(id)
      const contexts =
        phase === "candidate"
          ? [...instance.roles.candidate, instance.roles.candidateAdjudicator]
          : [...instance.roles.feedback, instance.roles.feedbackAdjudicator]
      const context = contexts.find((item) => item.id === contextID)
      if (!context) throw new Error("Context is not assigned this instance and phase")
      const material = this.material(id)
      if (
        phase === "candidate" &&
        (!material.candidate || this.db.query("SELECT 1 FROM exposure WHERE execution=?").get(context.execution))
      )
        throw new Error("Candidate scoring requires a real candidate and an unexposed context")
      if (phase === "feedback") {
        if (!material.terminal) this.sealed(id, "candidate")
        else this.object(material.terminal)
      }
      const isAdjudicator =
        context.id ===
        (phase === "candidate" ? instance.roles.candidateAdjudicator.id : instance.roles.feedbackAdjudicator.id)
      const pair = phase === "candidate" ? instance.roles.candidate : instance.roles.feedback
      const prior = isAdjudicator ? pair.map((item) => this.rating(item.id)) : []
      const rubric = Object.fromEntries(
        Object.entries(this.freeze.rubric).filter(([, rule]) =>
          phase === "candidate" ? rule.dimension === "research_result" : rule.dimension !== "research_result",
        ),
      )
      const receipt: Receipt = {
        instance: id,
        phase,
        context,
        materialHash: phase === "candidate" ? material.candidate! : material.feedback,
        rubricHash: this.put(rubric),
      }
      const hash = this.put(receipt)
      this.object(receipt.materialHash)
      this.db.query("INSERT OR IGNORE INTO grant_record VALUES(?)").run(hash)
      if (phase === "feedback") this.db.query("INSERT OR IGNORE INTO exposure VALUES(?,?)").run(context.execution, hash)
      this.event({ kind: "grant", hash })
      return { receipt: hash, ...receipt, material: this.object(receipt.materialHash), rubric, prior }
    })()
  }

  rate(receiptHash: string, judgment: Judgment) {
    return this.db.transaction(() => {
      if (!this.db.query("SELECT 1 FROM grant_record WHERE hash=?").get(receiptHash))
        throw new Error("Unknown material grant receipt")
      const receipt = this.object<Receipt>(receiptHash)
      const rubric = this.object<Rubric>(receipt.rubricHash)
      if (
        judgment.context !== receipt.context.id ||
        judgment.rater !== receipt.context.rater ||
        judgment.materialHash !== receipt.materialHash ||
        judgment.rubricHash !== receipt.rubricHash ||
        JSON.stringify(Object.keys(judgment.items).sort()) !== JSON.stringify(Object.keys(rubric).sort())
      )
        throw new Error("Judgment identity or frozen rubric differs from its grant")
      this.object(receipt.materialHash)
      const material = this.object<{ evidence?: Record<string, string> }>(receipt.materialHash)
      const evidence = new Set([
        receipt.materialHash,
        ...Object.entries(material.evidence ?? {})
          .filter(([hash, bytes]) => typeof bytes === "string" && digest(bytes) === hash)
          .map(([hash]) => hash),
      ])
      for (const item of Object.values(judgment.items)) {
        if (
          !["scored", "not_observed", "not_applicable", "insufficient_evidence", "not_scored"].includes(item.status) ||
          !item.reason ||
          (item.status === "scored" ? typeof item.value !== "boolean" || !item.evidence.length : item.value !== null) ||
          item.evidence.some((hash) => !/^[a-f0-9]{64}$/.test(hash) || !evidence.has(hash))
        )
          throw new Error("Judgments require explicit availability, reasons and evidence in the granted material")
      }
      const hash = this.put(judgment)
      const previous = this.db
        .query<{ hash: string }, [string]>("SELECT hash FROM judgment WHERE context=?")
        .get(judgment.context)
      if (previous && previous.hash !== hash)
        throw new Error("An independent judgment is already sealed; no selective retries")
      this.db.query("INSERT OR IGNORE INTO judgment VALUES(?,?)").run(judgment.context, hash)
      this.event({ kind: "judgment", receipt: receiptHash, hash })
      return hash
    })()
  }

  seal(id: string, phase: Receipt["phase"]) {
    return this.db.transaction(() => {
      const instance = this.instance(id)
      const pair = phase === "candidate" ? instance.roles.candidate : instance.roles.feedback
      const first = this.rating(pair[0].id)
      const second = this.rating(pair[1].id)
      const conflict = Object.keys(first.items).some(
        (key) =>
          first.items[key].status !== second.items[key].status || first.items[key].value !== second.items[key].value,
      )
      const resolution = conflict
        ? this.rating(
            phase === "candidate" ? instance.roles.candidateAdjudicator.id : instance.roles.feedbackAdjudicator.id,
          )
        : undefined
      const items = Object.fromEntries(
        Object.keys(first.items).map((key) => [
          key,
          first.items[key].status === second.items[key].status && first.items[key].value === second.items[key].value
            ? first.items[key]
            : resolution!.items[key],
        ]),
      )
      const hash = this.put({ first, second, ...(resolution ? { resolution } : {}), items })
      const previous = this.db
        .query<{ hash: string }, [string, string]>("SELECT hash FROM seal WHERE id=? AND phase=?")
        .get(id, phase)
      if (previous && previous.hash !== hash) throw new Error("Existing independent seal cannot change")
      this.db.query("INSERT OR IGNORE INTO seal VALUES(?,?,?)").run(id, phase, hash)
      this.event({ kind: "seal", id, phase, hash })
      return hash
    })()
  }

  report() {
    const rows = this.freeze.instances.map((instance) => {
      try {
        const bound = this.db.query<{ hash: string }, [string]>("SELECT hash FROM material WHERE id=?").get(instance.id)
        const material = bound ? this.object<Material>(bound.hash) : undefined
        if (material?.candidate) this.object(material.candidate)
        if (material?.terminal) this.object(material.terminal)
        const candidate = this.db
          .query<{ hash: string }, [string]>("SELECT hash FROM seal WHERE id=? AND phase='candidate'")
          .get(instance.id)
        const feedback = this.db
          .query<{ hash: string }, [string]>("SELECT hash FROM seal WHERE id=? AND phase='feedback'")
          .get(instance.id)
        return {
          id: instance.id,
          ...measures({
            candidate: candidate ? this.sealed(instance.id, "candidate").items : undefined,
            feedback: feedback ? this.sealed(instance.id, "feedback").items : undefined,
            candidateStatus: !material ? "unknown" : material.candidate ? "present" : "absent",
            rubric: this.freeze.rubric,
            audit: material ? this.object(material.audit) : { status: "not_scored" },
            infrastructure: {
              facts: material ? this.object(material.infrastructure) : { status: "unknown" },
              gaps: this.db
                .query<{ hash: string }, [string]>("SELECT hash FROM gap WHERE id=?")
                .all(instance.id)
                .map((row) => this.object(row.hash)),
            },
          }),
          candidateSeal: candidate?.hash,
          feedbackSeal: feedback?.hash,
        }
      } catch (error) {
        return {
          id: instance.id,
          ...measures({
            candidate: undefined,
            feedback: undefined,
            candidateStatus: "unknown",
            rubric: this.freeze.rubric,
            audit: { status: "insufficient_evidence" },
            infrastructure: { status: "corrupt_or_unavailable", reason: String(error) },
          }),
          candidateSeal: undefined,
          feedbackSeal: undefined,
        }
      }
    })
    return {
      version: measurementVersion,
      reveal: revealVersion,
      denominator: rows.length,
      status: rows.every(
        (row) =>
          row.feedbackSeal &&
          (row.candidateSeal || row.researchResult.candidate === "absent") &&
          [
            ...Object.values(row.feedbackHandling.reviewer),
            ...Object.values(row.feedbackHandling.researcher),
            ...Object.values(row.auditCompleteness.judgments),
            ...(row.researchResult.candidate === "present" ? Object.values(row.researchResult.items) : []),
          ].every((item) => item.status !== "not_scored"),
      )
        ? "complete"
        : "partial",
      rows,
    }
  }

  private instance(id: string) {
    const item = this.freeze.instances.find((item) => item.id === id)
    if (!item) throw new Error("Instance is outside the frozen denominator")
    return item
  }
  private bind(id: string, material: Material) {
    const hash = this.put(material)
    const previous = this.db.query<{ hash: string }, [string]>("SELECT hash FROM material WHERE id=?").get(id)
    if (previous && previous.hash !== hash) throw new Error("Instance material is immutable; unknown is not absent")
    this.db.query("INSERT OR IGNORE INTO material VALUES(?,?)").run(id, hash)
    this.event({ kind: "material", id, hash })
    return hash
  }
  private material(id: string) {
    const row = this.db.query<{ hash: string }, [string]>("SELECT hash FROM material WHERE id=?").get(id)
    if (!row) throw new Error("Instance material has not been sealed")
    return this.object<Material>(row.hash)
  }
  private rating(context: string) {
    const row = this.db.query<{ hash: string }, [string]>("SELECT hash FROM judgment WHERE context=?").get(context)
    if (!row) throw new Error("Independent judgment unavailable; retain not_scored")
    return this.object<Judgment>(row.hash)
  }
  private sealed(id: string, phase: Receipt["phase"]) {
    const row = this.db
      .query<{ hash: string }, [string, string]>("SELECT hash FROM seal WHERE id=? AND phase=?")
      .get(id, phase)
    if (!row) throw new Error("This instance requires its own complete independent seal")
    const seal = this.object<Seal>(row.hash)
    const material = this.material(id)
    this.object(phase === "candidate" ? material.candidate! : material.feedback)
    if (seal.first.materialHash !== (phase === "candidate" ? material.candidate : material.feedback))
      throw new Error("Seal no longer binds the granted material")
    return seal
  }
  private put(value: unknown) {
    const bytes = JSON.stringify(value)
    const hash = digest(bytes)
    this.db.query("INSERT OR IGNORE INTO object VALUES(?,?)").run(hash, bytes)
    if (JSON.stringify(this.object(hash)) !== bytes) throw new Error("Object identity conflict")
    return hash
  }
  private object<T = unknown>(hash: string): T {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM object WHERE hash=?").get(hash)
    if (!row || digest(row.value) !== hash) throw new Error("Sealed measurement evidence is unavailable or corrupt")
    return JSON.parse(row.value)
  }
  private event(value: unknown) {
    const previous =
      this.db.query<{ hash: string }, []>("SELECT hash FROM event ORDER BY seq DESC LIMIT 1").get()?.hash ??
      digest(JSON.stringify(this.freeze))
    this.db.query("INSERT INTO event(hash) VALUES(?)").run(this.put({ previous, value }))
  }
}
