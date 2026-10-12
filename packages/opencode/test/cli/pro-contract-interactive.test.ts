import { describe, expect } from "bun:test"
import { $ } from "bun"
import { Effect, Fiber } from "effect"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractExecutionPolicy } from "@opencode-ai/core/pro-contract/execution-policy"
import { ServerAuth } from "../../src/server/auth"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { loadDialogContracts } from "../../../tui/src/component/dialog-contracts"

describe("ProContract interactive user entry", () => {
  cliIt.live(
    "rejects, revises, approves, executes, and settles through the real server",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const directory = `${home}/workspace`
        const env = {
          OPENCODE_SERVER_PASSWORD: ServerAuth.workerEnv({}, false).OPENCODE_SERVER_PASSWORD,
          OPENCODE_DB: "",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            procontract: { execution_policy: "r2-v5" },
          }),
        }
        yield* Effect.promise(() => Bun.write(`${directory}/opencode.json`, env.OPENCODE_CONFIG_CONTENT))
        yield* Effect.promise(() => Bun.write(`${directory}/proof.txt`, "ready\n"))
        yield* Effect.promise(async () => {
          await $`git -C ${directory} init`.quiet()
          await $`git -C ${directory} add .`.quiet()
          await $`git -C ${directory} -c user.name=fixture -c user.email=fixture@example.invalid commit -m fixture`.quiet()
        })
        const server = yield* opencode.serve({ env, extraArgs: ["--print-logs"] })
        const client = createOpencodeClient({
          baseUrl: server.url,
          directory,
          headers: ServerAuth.headers({ password: env.OPENCODE_SERVER_PASSWORD }),
        })
        const session = (yield* Effect.promise(() =>
          client.session.create({ model: { providerID: "test", id: "test-model" } }),
        )).data
        if (!session) return yield* Effect.die("issuer Session was not created")
        const defaults = ProContract.defaultSpec("Complete the user task after approval", Date.now())
        const spec = {
          ...defaults,
          budget: { deadline: Date.now() + 21_600_000 },
          evidence: {
            ...defaults.evidence,
            replay: {
              checks: [{ argv: ["sh", "-c", 'test "$(cat proof.txt)" = ready'], timeout: 1000, exit: 0 }],
              protected: [],
              artifacts: ["proof.txt"],
            },
          },
        }

        for (const feedback of ["Continue without a Contract", "Keep the goal, but explain the verification claim"]) {
          yield* llm.tool("contract_propose", { spec })
          const prompted = yield* Effect.promise(() =>
            client.session.prompt({
              sessionID: session.id,
              parts: [
                {
                  type: "text",
                  text: "Please use ProContract to independently verify proof.txt for this durable task",
                },
              ],
            }),
          ).pipe(Effect.forkChild)
          const approval = yield* pollWithTimeout(
            Effect.promise(() => client.permission.list()).pipe(
              Effect.map((result) =>
                result.data?.find((item) => item.sessionID === session.id && item.permission === "contract_issue"),
              ),
            ),
            "proposal did not reach the user",
          )
          expect(approval.metadata.details).toContain(ProContractExecutionPolicy.R2V5)
          expect(
            (yield* Effect.promise(() => client.v2.proContract.list({ scope: session.projectID }))).data?.data,
          ).toEqual([])
          yield* Effect.promise(() =>
            client.permission.reply({ requestID: approval.id, reply: "reject", message: feedback }),
          )
          yield* Fiber.join(prompted)
          expect(
            (yield* Effect.promise(() => client.v2.proContract.list({ scope: session.projectID }))).data?.data,
          ).toEqual([])
        }

        yield* llm.tool("contract_propose", { spec })
        // Match the native executor separately from the issuer's continuation.
        yield* llm.toolMatch(
          (hit) => JSON.stringify(hit.body).includes("Contract execution: this Session is already bound"),
          "contract_report_ready",
          { summary: "The user task is ready for independent review", uncertainties: [] },
        )
        const prompted = yield* Effect.promise(() =>
          client.session.prompt({
            sessionID: session.id,
            parts: [
              { type: "text", text: "Please use ProContract to independently verify proof.txt for this durable task" },
            ],
          }),
        ).pipe(Effect.forkChild)
        const approval = yield* pollWithTimeout(
          Effect.promise(() => client.permission.list()).pipe(
            Effect.map((result) =>
              result.data?.find((item) => item.sessionID === session.id && item.permission === "contract_issue"),
            ),
          ),
          "approval was not displayed",
        )
        yield* Effect.promise(() => client.permission.reply({ requestID: approval.id, reply: "once" }))
        yield* Fiber.join(prompted)
        const visible = yield* Effect.promise(() =>
          loadDialogContracts({
            scope: session.projectID,
            directory,
            list: (query) => client.v2.proContract.list(query),
          }),
        )
        expect(visible).toHaveLength(1)
        const contractID = visible[0].id
        const ready = yield* pollWithTimeout(
          Effect.promise(() => client.v2.proContract.get({ contractID })).pipe(
            Effect.map((result) => (result.data?.data.status === "verification" ? result.data.data : undefined)),
          ),
          "native execution did not reach independent verification",
          "20 seconds",
        ).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const state = yield* Effect.promise(() => client.v2.proContract.get({ contractID }))
              const binding = yield* Effect.promise(() => client.v2.proContract.execution({ contractID }))
              return yield* Effect.fail(
                new Error(
                  `${String(error)}\nContract: ${JSON.stringify(state.data)}\nBinding: ${JSON.stringify(binding.data)}\nServer: ${server.diagnostics()}`,
                ),
              )
            }),
          ),
        )
        expect(ready.spec.budget).toEqual(spec.budget)
        expect(ready.handoff?.summary).toBe("The user task is ready for independent review")
        expect(ready.handoff?.replay?.passed).toBe(true)
        const execution = (yield* Effect.promise(() => client.v2.proContract.execution({ contractID }))).data
        expect(execution?.executionPolicy).toBe(ProContractExecutionPolicy.R2V5)
        expect(execution?.sessionID).not.toBe(session.id)
        if (!execution) return yield* Effect.die("execution binding missing")
        expect(
          (yield* Effect.promise(() => client.session.get({ sessionID: execution.sessionID }))).response.status,
        ).toBe(200)
        const transcript = (yield* Effect.promise(() => client.v2.session.messages({ sessionID: execution.sessionID })))
          .data?.data
        expect(
          transcript?.some(
            (message) =>
              message.type === "assistant" &&
              message.content.some(
                (part) =>
                  part.type === "tool" && part.name === "contract_report_ready" && part.state.status === "completed",
              ),
          ),
        ).toBe(true)
        expect(
          (yield* Effect.promise(() => client.v2.proContract.quiet({ scope: session.projectID }))).data?.quiet,
        ).toBe(false)

        // A new server process adopts durable verification, not another model run.
        server.kill()
        yield* Effect.promise(() => server.exited)
        const restarted = yield* opencode.serve({ env })
        const restored = createOpencodeClient({
          baseUrl: restarted.url,
          directory,
          headers: ServerAuth.headers({ password: env.OPENCODE_SERVER_PASSWORD }),
        })
        expect((yield* Effect.promise(() => restored.v2.proContract.get({ contractID }))).data?.data.handoff).toEqual(
          ready.handoff,
        )
        expect(
          (yield* Effect.promise(() =>
            restored.v2.proContract.attest({ contractID, evidenceHash: "independent-user-review" }),
          )).response.status,
        ).toBe(200)
        expect((yield* Effect.promise(() => restored.v2.proContract.get({ contractID }))).data?.data.status).toBe(
          "discharged",
        )
        expect(
          (yield* Effect.promise(() => restored.v2.proContract.quiet({ scope: session.projectID }))).data?.quiet,
        ).toBe(true)

        if (process.platform !== "linux") return
        yield* llm.toolMatch((hit) => JSON.stringify(hit.body.tools).includes("contract_report_ready"), "bash", {
          command: "printf '%s' $$ > executor.pid; exec sleep 60",
        })
        const cancelled = yield* Effect.promise(() =>
          restored.v2.proContract.issue({
            id: "pct_cancelled_execution",
            scope: session.projectID,
            goal: "Run the approved process until I cancel",
            authority: ["filesystem.read", "filesystem.write", "process.execute"],
            budget: { deadline: Date.now() + 21_600_000 },
            location: { directory },
            model: { providerID: "test", id: "test-model" },
          }),
        )
        expect(cancelled.response.status).toBe(200)
        const pid = yield* pollWithTimeout(
          Effect.promise(async () => {
            if (!(await Bun.file(`${directory}/executor.pid`).exists())) return
            const pid = Number(await Bun.file(`${directory}/executor.pid`).text())
            return pid > 0 ? pid : undefined
          }),
          "executor process did not start",
          "10 seconds",
        )
        expect(pid).toBeGreaterThan(0)
        const released = yield* Effect.promise(() =>
          restored.v2.proContract.release({
            contractID: "pct_cancelled_execution",
            reason: "User cancelled running work",
          }),
        )
        expect(released.response.status).toBe(200)
        yield* pollWithTimeout(
          Effect.promise(async () => (!(await Bun.file(`/proc/${pid}/stat`).exists()) ? true : undefined)),
          "released executor was not interrupted",
        )
        expect(
          (yield* Effect.promise(() => restored.v2.proContract.get({ contractID: "pct_cancelled_execution" }))).data
            ?.data.status,
        ).toBe("released")
        expect(
          (yield* Effect.promise(() => restored.v2.proContract.quiet({ scope: session.projectID }))).data?.quiet,
        ).toBe(true)
      }),
    90_000,
  )
})
