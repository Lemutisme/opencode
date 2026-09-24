// A host process using the production embedded Server/Core graph. Only the host
// policy is a finite test driver; provider, Sessions, tools, store and scheduler
// are the real implementations.
import { OpenCode } from "../../../sdk-next/src"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { Effect, Scope } from "effect"
import { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import type { Binding } from "@opencode-ai/core/pro-contract/open-code"

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* OpenCode.create({
        research: process.argv[3] === "research",
        nativeAdvisory: process.argv[4] === "native-advisory",
        principalPassword: process.argv[3] === "research" ? "contract-process-test" : undefined,
        contractDrivers:
          process.argv[2] === "loaded"
            ? [
                {
                  identity: "test-process:1",
                  activate: () => true,
                  claim: () => true,
                  heartbeat: () => true,
                  outcome: () => ({ type: "wait" }),
                },
              ]
            : [],
      })
      const scope = yield* Scope.Scope
      const command = Effect.fnUntraced(function* (message: {
        readonly id: string
        readonly action: string
        readonly contractID: ProContract.ID
        readonly input?: unknown
        readonly expected?: Binding
      }) {
        if (message.action === "native-issue") {
          const input = message.input as {
            issue: Parameters<NonNullable<typeof host.nativeAdvisory>["issue"]>[0]
            configuration: Parameters<NonNullable<typeof host.nativeAdvisory>["issue"]>[1]
          }
          return yield* host.nativeAdvisory!.issue(input.issue, input.configuration)
        }
        if (message.action === "native-requests") return yield* host.nativeAdvisory!.requests(message.contractID)
        if (message.action === "native-attachment") return yield* host.nativeAdvisory!.attachment(message.contractID)
        if (message.action === "native-history") return yield* host.nativeAdvisory!.history(message.contractID)
        if (message.action === "native-object")
          return Buffer.from(yield* host.nativeAdvisory!.object(message.contractID)).toString("utf8")
        if (message.action === "research-issue")
          return yield* host.research!.issue(message.input as Parameters<NonNullable<typeof host.research>["issue"]>[0])
        if (message.action === "research-get") return yield* host.research!.get(message.contractID)
        if (message.action === "research-history") return yield* host.research!.history(message.contractID)
        if (message.action === "research-cancel")
          return yield* host.research!.cancel(
            message.contractID,
            (message.input as { reason?: string } | undefined)?.reason,
          )
        if (message.action === "research-recover")
          return yield* host.research!.recover(message.contractID, message.input as { retry?: boolean } | undefined)
        if (message.action === "research-bundle") return yield* host.research!.bundle(message.contractID)
        if (message.action === "research-object")
          return Buffer.from(yield* host.research!.object(message.contractID)).toString("utf8")
        if (message.action === "root-attest")
          return yield* host["server.proContract"].attest(
            message.input as Parameters<(typeof host)["server.proContract"]["attest"]>[0],
          )
        if (message.action === "root-revision-decision")
          return yield* host["server.proContract"].decideRevision(
            message.input as Parameters<(typeof host)["server.proContract"]["decideRevision"]>[0],
          )
        if (message.action === "root-challenge")
          return yield* host["server.proContract"].challenge(
            message.input as Parameters<(typeof host)["server.proContract"]["challenge"]>[0],
          )
        if (message.action === "issue")
          return yield* host.contractExecution.issue(
            message.input as Parameters<typeof host.contractExecution.issue>[0],
          )
        if (message.action === "job-create")
          return yield* host.contractJobs.create(message.input as ProContractJob.Input)
        if (message.action === "job-get") return yield* host.contractJobs.get(message.contractID)
        if (message.action === "job-audit") return yield* host.contractJobs.audit(message.contractID)
        if (message.action === "job-cancel") return yield* host.contractJobs.cancel(message.contractID)
        if (message.action === "job-queue") return yield* host.contractJobs.start(message.contractID, { resume: false })
        if (["job-start", "job-verify", "job-recover"].includes(message.action)) {
          const run: Effect.Effect<unknown, unknown> =
            message.action === "job-start"
              ? host.contractJobs.start(message.contractID)
              : message.action === "job-verify"
                ? host.contractJobs.verify(message.contractID)
                : host.contractJobs.recover(message.contractID)
          yield* Effect.forkIn(
            run.pipe(Effect.catchCause((cause) => Effect.logWarning("Test job ended", cause))),
            scope,
          )
          return { scheduled: true }
        }
        if (message.action === "job-recover-sync") return yield* host.contractJobs.recover(message.contractID)
        if (message.action === "operations") return yield* host.contractJobs.operations(message.contractID)
        if (message.action === "root-info")
          return yield* host["server.proContract"].get({ contractID: message.contractID })
        if (message.action === "root-recognition")
          return yield* host["server.proContract"].recognition({ contractID: message.contractID })
        if (message.action === "session-create")
          return yield* host.sessions.create(message.input as Parameters<typeof host.sessions.create>[0])
        if (message.action === "session-prompt")
          return yield* host.sessions.prompt(message.input as Parameters<typeof host.sessions.prompt>[0])
        if (message.action === "session-agent")
          return yield* host.sessions.switchAgent(message.input as Parameters<typeof host.sessions.switchAgent>[0])
        if (message.action === "session-model")
          return yield* host.sessions.switchModel(message.input as Parameters<typeof host.sessions.switchModel>[0])
        if (message.action === "session-revert")
          return yield* host.sessions.stage(message.input as Parameters<typeof host.sessions.stage>[0])
        if (message.action === "session-context")
          return yield* host.sessions.context(message.input as Parameters<typeof host.sessions.context>[0])
        if (message.action === "permission-list")
          return yield* host.permissions.list(message.input as Parameters<typeof host.permissions.list>[0])
        if (message.action === "permission-reply")
          return yield* host.permissions.reply(message.input as Parameters<typeof host.permissions.reply>[0])
        if (message.action === "get") return yield* host.contractExecution.get(message.contractID)
        if (!["open", "close"].includes(message.action)) return yield* Effect.die("Unknown test command")
        const binding = message.expected ?? (yield* host.contractExecution.get(message.contractID))!
        const recognition = yield* host["server.proContract"].recognition({ contractID: message.contractID })
        return yield* host.contractExecution.setAdmission({
          expected: binding,
          context: recognition.context!.target,
          open: message.action === "open",
          reason: "Test host phase boundary",
        })
      })
      process.on("message", (message: Parameters<typeof command>[0]) => {
        void Effect.runPromise(command(message)).then(
          (result) => process.send!({ id: message.id, result }),
          (error) => process.send!({ id: message.id, error: String(error) }),
        )
      })
      process.send!({ ready: true, owner: host.contractExecution.owner })
      yield* Effect.never
    }),
  ),
)
