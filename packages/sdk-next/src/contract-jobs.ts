export * as ContractJobs from "./contract-jobs"

import { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import { ProContractActivity } from "@opencode-ai/core/pro-contract/activity"
import { ProContractReplay } from "@opencode-ai/core/pro-contract/replay"
import { ProContractRecognition } from "@opencode-ai/core/pro-contract/recognition"
import { ExecutionPermit } from "@opencode-ai/core/session/execution-permit"
import { SessionV2 } from "@opencode-ai/core/session"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Cause, Clock, Effect, Exit } from "effect"

/** Host orchestration uses the same durable Session inbox and serialized runner as public Sessions. */
export const make = Effect.gen(function* () {
  const jobs = yield* ProContractJob.Service
  const sessions = yield* SessionV2.Service
  const permits = yield* ExecutionPermit.Service
  const locations = yield* LocationServiceMap.Service
  const activity = yield* ProContractActivity.Service
  const prepare = (job: ProContractJob.Job) =>
    sessions.create({
      id: job.input.sessionID,
      location: job.input.location,
      model: job.input.model,
      agent: job.input.agent,
    })
  const review = (job: ProContractJob.Job, resume = true) =>
    activity.run(
      job.input.contractID,
      Effect.gen(function* () {
        yield* jobs.authorize(ProContractJob.execution(job))
        yield* prepare(job)
        yield* jobs.authorize(ProContractJob.execution(job))
        yield* sessions.prompt({
          id: job.input.promptID,
          sessionID: job.input.sessionID,
          prompt: job.input.prompt,
          resume: false,
        })
        yield* jobs.authorize(ProContractJob.execution(job))
        if (resume) yield* sessions.resume(job.input.sessionID)
        return (yield* jobs.get(job.input.id))!
      }),
    )
  const verify = (job: ProContractJob.Job) =>
    activity.run(
      job.input.contractID,
      Effect.gen(function* () {
        yield* jobs.authorize(ProContractJob.execution(job))
        yield* prepare(job)
        const permit = yield* permits.capture(job.input.sessionID)
        if (!ProContractRecognition.same(permit.job, ProContractJob.execution(job)))
          return yield* new ProContractJob.Denied({
            message: "Verification requires its original job execution identity",
          })
        const environment = yield* permits.context(permit)
        const result = yield* permits.run(permit, undefined, () =>
          ProContractReplay.Service.use((replay) =>
            replay.verify({ contractID: job.input.contractID, ...job.input.verification! }),
          ).pipe(Effect.provide(locations.get(job.input.location)), Effect.provideContext(environment)),
        )
        yield* permits.check(permit)
        return result
      }).pipe(
        Effect.onExit((exit) =>
          jobs.finish(
            ProContractJob.execution(job),
            Exit.isSuccess(exit) ? "completed" : Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed",
            Exit.isSuccess(exit) ? exit.value : undefined,
          ),
        ),
      ),
    )
  return {
    create: jobs.create,
    get: jobs.get,
    operations: jobs.operations,
    audit: jobs.audit,
    start: (id: string, options?: { readonly resume?: boolean }) =>
      Effect.gen(function* () {
        const job = yield* jobs.get(id)
        if (job?.input.kind !== "review")
          return yield* new ProContractJob.Denied({ message: "Use the frozen verification entry for verifier jobs" })
        const started = yield* jobs.start(id)
        return yield* review(started, options?.resume !== false).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? jobs.finish(ProContractJob.execution(started), "interrupted") : Effect.void,
          ),
        )
      }),
    verify: (id: string) =>
      Effect.gen(function* () {
        const job = yield* jobs.get(id)
        if (job?.input.kind !== "verify")
          return yield* new ProContractJob.Denied({ message: "Verification requires a frozen verifier job" })
        return yield* verify(yield* jobs.start(id))
      }),
    recover: (id: string) =>
      Effect.gen(function* () {
        const job = yield* jobs.recover(id)
        if (job.status !== "open") return { job }
        if (job.input.kind === "verify") {
          const result = yield* verify(job)
          return { job: (yield* jobs.get(id))!, result }
        }
        return {
          job: yield* review(job).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? jobs.finish(ProContractJob.execution(job), "interrupted") : Effect.void,
            ),
          ),
        }
      }),
    cancel: (id: string, reason = "Cancelled by host") =>
      Effect.gen(function* () {
        const job = yield* jobs.cancel(id, reason)
        if (!job.owner) return job
        yield* sessions.interrupt(job.input.sessionID)
        yield* Effect.gen(function* () {
          while (activity.has(job.input.contractID)) yield* Effect.sleep("10 millis")
        }).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () =>
              Effect.fail(
                new ProContractJob.Denied({ message: "Cancellation is durable; execution cleanup is still in flight" }),
              ),
          }),
        )
        yield* jobs.finish(ProContractJob.execution(job), "interrupted")
        // Another host owns its own process cleanup. Revocation cannot retire its live lease here.
        yield* Effect.gen(function* () {
          while (true) {
            const current = yield* jobs.get(id)
            if (!current?.owner || (current.leaseExpiresAt ?? 0) <= (yield* Clock.currentTimeMillis)) return
            yield* Effect.sleep("20 millis")
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () =>
              Effect.fail(
                new ProContractJob.Denied({
                  message: "Cancellation is durable; the remote execution lease is still live",
                }),
              ),
          }),
        )
        return yield* jobs.audit(id)
      }),
  }
})
