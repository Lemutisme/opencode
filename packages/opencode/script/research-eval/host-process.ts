// The sandbox receives this exact entrypoint, never the controller or oracle modules.
import { OpenCode } from "../../../sdk-next/src"
import { Effect } from "effect"
import { appendFileSync } from "node:fs"
import type { ProContract } from "@opencode-ai/core/pro-contract"

if (!process.send) throw new Error("Research host requires a private IPC channel")
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* OpenCode.create({ research: true, principalPassword: crypto.randomUUID() })
      const trace = { sequence: 0 }
      const command = Effect.fnUntraced(function* (message: {
        id: string
        action: string
        contractID: ProContract.ID
        input?: unknown
        operationDeadline?: number
      }) {
        if (message.action === "research-issue")
          return yield* host.research!.issue(
            message.input as Parameters<NonNullable<typeof host.research>["issue"]>[0],
            process.env.RESEARCH_ISSUE_TRACE
              ? (event) =>
                  appendFileSync(
                    process.env.RESEARCH_ISSUE_TRACE!,
                    JSON.stringify({
                      ...event,
                      sequence: ++trace.sequence,
                      requestID: message.id,
                      hostPID: process.pid,
                      operationDeadline: message.operationDeadline,
                    }) + "\n",
                    { mode: 0o600, flush: true },
                  )
              : undefined,
          )
        if (message.action === "research-get") return yield* host.research!.get(message.contractID)
        if (message.action === "research-history") return yield* host.research!.history(message.contractID)
        if (message.action === "research-cancel")
          return yield* host.research!.cancel(
            message.contractID,
            (message.input as { reason?: string } | undefined)?.reason ?? "Evaluation stopped",
          )
        if (message.action === "research-recover")
          return yield* host.research!.recover(message.contractID, message.input as { retry?: boolean } | undefined)
        if (message.action === "research-object")
          return Buffer.from(yield* host.research!.object(message.contractID)).toString("utf8")
        if (message.action === "root-attest")
          return yield* host["server.proContract"].attest(
            message.input as Parameters<(typeof host)["server.proContract"]["attest"]>[0],
          )
        if (message.action === "root-challenge")
          return yield* host["server.proContract"].challenge(
            message.input as Parameters<(typeof host)["server.proContract"]["challenge"]>[0],
          )
        if (message.action === "job-get") return yield* host.contractJobs.get(message.contractID)
        if (message.action === "job-cancel")
          return yield* host.contractJobs.cancel(message.contractID, "Scheduled evaluation recovery")
        if (message.action === "job-audit") return yield* host.contractJobs.audit(message.contractID)
        if (message.action === "execution") return yield* host.contractExecution.get(message.contractID)
        if (message.action === "operations") return yield* host.contractJobs.operations(message.contractID)
        if (message.action === "session-context")
          return yield* host.sessions.context(message.input as Parameters<typeof host.sessions.context>[0])
        return yield* Effect.die("Unknown evaluation command")
      })
      process.on("message", (message: Parameters<typeof command>[0]) => {
        void Effect.runPromise(command(message)).then(
          (result) => process.send!({ id: message.id, result }),
          (error) => process.send!({ id: message.id, error: String(error) }),
        )
      })
      process.send!({ ready: true, pid: process.pid })
      yield* Effect.never
    }),
  ),
)
