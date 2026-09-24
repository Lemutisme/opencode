export * as ExecutionPermit from "./execution-permit"

import { Clock, Context, Effect, Exit, Cause, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { ProContract } from "../pro-contract"
import { ProContractActivity } from "../pro-contract/activity"
import { ProContractJob } from "../pro-contract/job"
import { ProContractOpenCode } from "../pro-contract/open-code"
import { ProContractRecognition } from "../pro-contract/recognition"
import { ProContractOpenCodeSessionTable } from "../pro-contract/sql"
import { ExecutionContext } from "./execution-context"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"

export type Permit = {
  readonly sessionID: SessionSchema.ID
  readonly root?: ProContractOpenCode.Execution
  readonly job?: ProContractJob.Execution
  readonly source?: ProContractJob.Source
}

export type Capability = ProContractOpenCode.Capability

export interface Interface {
  readonly capture: (sessionID: SessionSchema.ID) => Effect.Effect<Permit, ProContractJob.Denied>
  readonly check: (permit: Permit) => Effect.Effect<void, ProContractJob.Denied>
  readonly require: (
    sessionID: SessionSchema.ID,
    captured?: Permit,
    root?: ProContractOpenCode.Execution,
  ) => Effect.Effect<Permit, ProContractJob.Denied>
  readonly tool: (permit: Permit, capability?: Capability, agent?: string) => Effect.Effect<void, ProContractJob.Denied>
  readonly context: (permit: Permit) => Effect.Effect<Context.Context<never>, ProContractJob.Denied>
  readonly run: <A, E, R>(
    permit: Permit,
    kind: ProContractJob.Operation["kind"] | undefined,
    effect: (operation?: ProContractJob.Operation) => Effect.Effect<A, E, R>,
    detail?: string,
  ) => Effect.Effect<A, E | ProContractJob.Denied, R>
  readonly mutable: (sessionID: SessionSchema.ID) => Effect.Effect<void, ProContractJob.Denied>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ExecutionPermit") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const jobs = yield* ProContractJob.Service
    const bindings = yield* ProContractOpenCode.Service
    const store = yield* SessionStore.Service
    const database = yield* Database.Service
    const activity = yield* ProContractActivity.Service
    const rootForSession = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const binding = yield* bindings.forSession(sessionID)
      if (binding) return binding
      const marker = yield* database.db
        .select()
        .from(ProContractOpenCodeSessionTable)
        .where(eq(ProContractOpenCodeSessionTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (marker) return yield* new ProContractJob.Denied({ message: "Controlled Session binding is unavailable" })
    })
    const check = Effect.fnUntraced(function* (permit: Permit) {
      const job = yield* jobs.forSession(permit.sessionID)
      if (job) {
        if (
          !permit.job ||
          permit.root ||
          permit.job.sessionID !== permit.sessionID ||
          permit.job.jobID !== job.input.id
        )
          return yield* new ProContractJob.Denied({
            message: "Controlled job requires its original execution identity",
          })
        yield* jobs.authorize(permit.job)
        const session = yield* store.get(permit.sessionID)
        if (!session) return yield* new ProContractJob.Denied({ message: "Controlled Session is unavailable" })
        yield* jobs.assertCoordinates({
          id: session.id,
          location: session.location,
          model: session.model,
          agent: session.agent,
        })
        return
      }
      if (permit.job) return yield* new ProContractJob.Denied({ message: "Controlled job mapping is unavailable" })
      const root = yield* rootForSession(permit.sessionID)
      if (root) {
        if (!permit.root || permit.root.sessionID !== permit.sessionID)
          return yield* new ProContractJob.Denied({ message: "Root execution requires its original identity" })
        yield* bindings
          .authorize(permit.root)
          .pipe(Effect.mapError((error) => new ProContractJob.Denied({ message: error.message })))
        return
      }
      if (permit.root) return yield* new ProContractJob.Denied({ message: "Root execution mapping is unavailable" })
    })
    const capture = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const job = yield* jobs.forSession(sessionID)
      const root = job ? undefined : yield* rootForSession(sessionID)
      const contract = root
        ? yield* bindings
            .authorize(ProContractOpenCode.execution(root))
            .pipe(Effect.mapError((error) => new ProContractJob.Denied({ message: error.message })))
        : undefined
      const identity = job
        ? { job: ProContractJob.execution(job) }
        : root
          ? { root: ProContractOpenCode.execution(root) }
          : {}
      const permit: Permit = {
        sessionID,
        ...identity,
        source:
          job || contract
            ? {
                contractID: job?.input.contractID ?? contract!.id,
                sessionID,
                jobID: job?.input.id,
                identity: ProContractRecognition.fingerprint(identity),
                deadline: job?.deadline ?? contract!.spec.budget.deadline,
              }
            : undefined,
      }
      yield* check(permit)
      return permit
    })
    const service: Interface = Service.of({
      capture,
      check,
      require: (sessionID, captured, root) =>
        Effect.gen(function* () {
          const current = yield* capture(sessionID)
          if (captured) {
            if (!ProContractRecognition.same(current, captured))
              return yield* new ProContractJob.Denied({ message: "Stale execution permit" })
            return captured
          }
          if (
            current.job ||
            (current.root && !ProContractRecognition.same(current.root, root)) ||
            (!current.root && root)
          )
            return yield* new ProContractJob.Denied({ message: "Tool invocation lacks its original execution permit" })
          return current
        }),
      tool: (permit, capability, agent) =>
        Effect.gen(function* () {
          yield* check(permit)
          if (!permit.source) return
          if (!capability)
            return yield* new ProContractJob.Denied({
              message: "Tool implementation does not support controlled execution",
            })
          if (permit.job) {
            const job = yield* jobs.authorize(permit.job)
            if (job.input.kind !== "review" || capability !== "read" || agent !== job.input.agent)
              return yield* new ProContractJob.Denied({
                message: "Reviewer permits only supported read-only tools under its fixed agent",
              })
            return
          }
          const contract = yield* bindings
            .authorize(permit.root!)
            .pipe(Effect.mapError((error) => new ProContractJob.Denied({ message: error.message })))
          const binding = yield* bindings.get(permit.root!.contractID)
          if (binding?.admission?.capabilities && !binding.admission.capabilities.includes(capability))
            return yield* new ProContractJob.Denied({
              message: "Current host admission does not permit this capability",
            })
          const required: ReadonlyArray<ProContract.Contract["spec"]["authority"][number]> =
            capability === "read"
              ? ["filesystem.read"]
              : capability === "write"
                ? ["filesystem.write"]
                : capability === "process"
                  ? ["process.execute"]
                  : capability === "reference"
                    ? ["reference.run"]
                    : capability === "compose"
                      ? ["filesystem.write", "process.execute"]
                      : []
          if (!required.every((authority) => contract.spec.authority.includes(authority)))
            return yield* new ProContractJob.Denied({ message: "Root authority does not permit this tool" })
        }),
      context: (permit) =>
        Effect.gen(function* () {
          yield* check(permit)
          if (!permit.source) return Context.empty()
          const job = permit.job ? yield* jobs.authorize(permit.job) : undefined
          const root = permit.root
            ? yield* bindings
                .authorize(permit.root)
                .pipe(Effect.mapError((error) => new ProContractJob.Denied({ message: error.message })))
            : undefined
          const binding = permit.root ? yield* bindings.get(permit.root.contractID) : undefined
          const capabilities = binding?.admission?.capabilities
          return Context.make(ExecutionContext.Current, {
            sessionID: permit.sessionID,
            contractID: permit.source.contractID,
            replay: job?.input.verification
              ? ProContractRecognition.fingerprint({ contractID: job.input.contractID, ...job.input.verification })
              : undefined,
            process:
              job?.input.kind === "verify" ||
              (root?.spec.authority.includes("process.execute") && (!capabilities || capabilities.includes("process"))),
            deadline: permit.source.deadline,
            directory: job?.input.location.directory ?? binding?.location.directory,
            readOnly: job?.input.kind === "review" || (!!capabilities && !capabilities.includes("write")),
            verification: (detail, effect) =>
              Effect.gen(function* () {
                if (job?.input.kind === "review") return yield* Effect.interrupt
                return yield* service.run(permit, "verification", () => effect, detail)
              }).pipe(Effect.catchTag("ExecutionDenied", () => Effect.interrupt)),
            check: check(permit).pipe(Effect.catch(() => Effect.interrupt)),
          })
        }),
      run: (permit, kind, effect, detail) =>
        Effect.gen(function* () {
          yield* check(permit)
          if (!permit.source) return yield* effect()
          const source = permit.source
          return yield* activity.run(
            source.contractID,
            Effect.acquireUseRelease(
              kind ? jobs.begin(source, kind, detail) : Effect.succeed(undefined),
              (operation) =>
                Effect.gen(function* () {
                  yield* check(permit)
                  if (
                    permit.root &&
                    (kind === "provider" || kind === "compaction") &&
                    !(yield* bindings.reserveTurn(permit.sessionID, yield* Clock.currentTimeMillis, permit.root))
                  )
                    return yield* new ProContractJob.Denied({ message: "Root provider budget exhausted" })
                  const monitor = Effect.gen(function* () {
                    while (true) {
                      yield* Effect.sleep(
                        Math.max(1, Math.min(1000, source.deadline - (yield* Clock.currentTimeMillis))),
                      )
                      yield* check(permit).pipe(Effect.catch(() => Effect.interrupt))
                      if (permit.job) yield* jobs.heartbeat(permit.job).pipe(Effect.catch(() => Effect.interrupt))
                    }
                  })
                  return yield* effect(operation).pipe(Effect.raceFirst(monitor))
                }),
              (operation, exit) =>
                operation
                  ? jobs.end(
                      operation.id,
                      Exit.isSuccess(exit) ? "completed" : Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed",
                    )
                  : Effect.void,
            ),
          )
        }),
      mutable: (sessionID) =>
        Effect.gen(function* () {
          if ((yield* jobs.forSession(sessionID)) || (yield* rootForSession(sessionID)))
            return yield* new ProContractJob.Denied({ message: "Controlled Session coordinates and history are fixed" })
        }),
    })
    return service
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [ProContractJob.node, ProContractOpenCode.node, SessionStore.node, Database.node, ProContractActivity.node],
})
