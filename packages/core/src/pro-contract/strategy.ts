export * as ProContractStrategy from "./strategy"

import path from "path"
import { Context, Effect, FileSystem, Layer, Schema, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { filesystem } from "../effect/app-node-platform"
import { Global } from "../global"
import { SessionSchema } from "../session/schema"
import { Hash } from "../util/hash"

export const Kind = Schema.Literals([
  "bootstrap",
  "spec-probe",
  "differential",
  "roundtrip",
  "business-audit",
  "resource-safe",
  "counterexample-review",
])
export const Criterion = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9_-]+$/)),
  requirement: Schema.NonEmptyString,
  sourceQuote: Schema.NonEmptyString,
  strategy: Kind,
  command: Schema.NonEmptyString,
  timeout: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(600_000)),
})
export const Check = Schema.Struct({
  criterion: Schema.String,
  passed: Schema.Boolean,
  observation: Schema.String,
})
export const State = Schema.Struct({
  version: Schema.Literal(1),
  specHash: Schema.String,
  criteria: Schema.NonEmptyArray(Criterion),
  rounds: Schema.Number,
  strategy: Kind,
  checks: Schema.Array(Check),
  revisions: Schema.Array(Schema.Struct({ reason: Schema.NonEmptyString, previousChecks: Schema.Array(Check) })),
  subjectHash: Schema.optional(Schema.String),
  ready: Schema.Boolean,
})
export type State = typeof State.Type

export function plan(specHash: string, goal: string, criteria: (typeof Criterion.Type)[]) {
  if (criteria.length === 0 || new Set(criteria.map((item) => item.id)).size !== criteria.length)
    throw new Error("Declare nonempty, uniquely named public requirements")
  if (criteria.some((item) => !item.sourceQuote.trim() || !goal.includes(item.sourceQuote)))
    throw new Error("Each criterion must quote the issued task; strategies cannot invent acceptance terms")
  return Schema.decodeUnknownSync(State)({
    version: 1,
    specHash,
    criteria,
    rounds: 0,
    strategy: criteria[0].strategy,
    checks: [],
    revisions: [],
    ready: false,
  })
}

export function revise(state: State, goal: string, criteria: (typeof Criterion.Type)[], reason: string) {
  if (!reason.trim()) throw new Error("Changing a check method requires an explicit rationale")
  if (
    state.criteria.some(
      (previous) =>
        !criteria.some((next) => next.id === previous.id && next.sourceQuote.includes(previous.sourceQuote)),
    )
  )
    throw new Error("A strategy revision cannot remove a requirement or weaken its task quotation")
  return {
    ...plan(state.specHash, goal, criteria),
    rounds: state.rounds,
    revisions: [...state.revisions, { reason, previousChecks: state.checks }],
  }
}

export function conclude(state: State, checks: (typeof Check.Type)[], before: string, after: string): State {
  const failure = checks.find((check) => !check.passed)
  const suggested =
    failure && /out of memory|killed|sigkill|exit(?:ed)?(?: with code)? 137|timed out/i.test(failure.observation)
      ? "resource-safe"
      : failure && /not found|no module named|exit(?:ed)?(?: with code)? 127/i.test(failure.observation)
        ? "bootstrap"
        : failure
          ? state.criteria.find((item) => item.id === failure.criterion)?.strategy
          : undefined
  const ready =
    before === after &&
    checks.length === state.criteria.length &&
    new Set(checks.map((check) => check.criterion)).size === state.criteria.length &&
    state.criteria.every((criterion) => checks.some((check) => check.criterion === criterion.id)) &&
    !failure
  return {
    ...state,
    rounds: state.rounds + 1,
    checks,
    subjectHash: after,
    ready,
    strategy: ready
      ? "counterexample-review"
      : suggested && suggested !== state.strategy
        ? suggested
        : "counterexample-review",
  }
}

export function guidance(state: State) {
  if (state.ready) return "All declared public checks passed on the recorded candidate. Review coverage and unresolved assumptions before final submission; this is not official acceptance. report_ready ends the attempt and hidden grading will not provide repair feedback."
  const directions = {
    bootstrap:
      "Establish the required toolchain and verify capabilities. General dependency installation is allowed; benchmark answers and hidden evaluator files are not.",
    "spec-probe":
      "List competing interpretations and construct a public counterexample that distinguishes them before choosing an implementation.",
    differential:
      "Use an independently derived reference, formula, or metamorphic invariant; do not copy the implementation's assumptions into its tests.",
    roundtrip:
      "Open the exact deliverable with its real consumer and validate semantics, not just syntax, fields, or file existence.",
    "business-audit":
      "Check every decision's prerequisites, missing evidence, and source precedence before committing side effects.",
    "resource-safe":
      "Reduce or bound working data, use streaming/sparse algorithms, and validate resource use before scaling the experiment.",
    "counterexample-review":
      "Investigate the remaining counterexample or coverage gap and change the representation or algorithm instead of repeating the same claim.",
  }
  return `${directions[state.strategy]} Public checks are execution evidence, not final benchmark acceptance. report_ready ends this attempt; hidden grading will not return repair feedback.`
}

export interface Interface {
  readonly read: (sessionID: SessionSchema.ID) => Effect.Effect<State | undefined>
  readonly write: (sessionID: SessionSchema.ID, state: State) => Effect.Effect<void>
  readonly exclusive: <A, E, R>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ProContractStrategy") {}

export function make(directory: string, fs: FileSystem.FileSystem): Interface {
  const locks = new Map<string, Semaphore.Semaphore>()
  const filename = (sessionID: SessionSchema.ID) => path.join(directory, Hash.sha256(sessionID) + ".json")
  return {
    read: Effect.fn("ProContractStrategy.read")(function* (sessionID) {
      if (!(yield* fs.exists(filename(sessionID)).pipe(Effect.orDie))) return undefined
      return yield* fs
        .readFileString(filename(sessionID))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(State))), Effect.orDie)
    }),
    write: Effect.fn("ProContractStrategy.write")(function* (sessionID, state) {
      yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie)
      yield* fs
        .writeFileString(filename(sessionID) + ".pending", Schema.encodeSync(Schema.fromJsonString(State))(state))
        .pipe(Effect.orDie)
      yield* fs.rename(filename(sessionID) + ".pending", filename(sessionID)).pipe(Effect.orDie)
    }),
    exclusive: (sessionID, effect) =>
      Effect.suspend(() => {
        const lock = locks.get(sessionID) ?? Semaphore.makeUnsafe(1)
        locks.set(sessionID, lock)
        return lock.withPermit(effect)
      }),
  }
}

export const node = makeGlobalNode({
  service: Service,
  deps: [filesystem],
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return make(path.join(Global.Path.data, "execution-strategy"), fs)
    }),
  ),
})
