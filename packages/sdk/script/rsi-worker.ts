// Mutable H entrypoint. All deployment/evaluation authority stays outside this process.
import path from "node:path"
import fs from "node:fs/promises"
import { Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Plugin } from "@opencode/plugin"
import { ProviderTransport } from "@opencode/core/effect/provider-transport"
import { requestExecutor } from "@opencode/core/effect/app-node-platform"
import { PromiseSdk } from "../src/promise"
import { ContractDelivery } from "./contract-delivery"
import { contractProfile, drainDelivery } from "./contract-profile"
import { ProposalMetadata, proposalCheck, proposalKind } from "./rsi-proposal-check"

const Input = Schema.Struct({
  id: Schema.String,
  deadline: Schema.Number,
  model: Schema.String,
  effort: Schema.String,
  goal: Schema.String,
  artifact: Schema.String,
  mode: Schema.optional(Schema.Literals(["programbench", "bridge", "tau"])),
  allowRevise: Schema.optional(Schema.Boolean),
  proposal: Schema.optional(ProposalMetadata),
})
const input = Schema.decodeUnknownSync(Schema.fromJsonString(Input))(await Bun.file("/admission/worker.json").text())
if (!/^[a-z][a-z0-9_.-]*$/.test(input.artifact)) throw new Error("invalid output artifact")
const standing = async () => {
  if (Date.now() >= input.deadline || !(await Bun.file("/admission/active").exists()))
    throw new Error("execution admission ended")
}
while (!(await Bun.file("/admission/ready").exists())) {
  await standing()
  await Bun.sleep(25)
}
if (await Bun.file("/state/session.sqlite").exists()) throw new Error("implicit execution recovery is not qualified")
const disposition = { digest: "", summary: "", blocked: "" }
const controller = new AbortController()
const kind = proposalKind(input)
const check = kind
  ? await proposalCheck({
      kind,
      artifact: path.join("/candidate", input.artifact),
      source: "/candidate/source",
      state: "/state/proposal-check",
      runtime: "/runtime",
      bun: "/runtime-bun",
      parentArchive: "/parent-source.tar",
      metadata: input.proposal,
      deadline: input.deadline,
      signal: controller.signal,
      standing,
    })
  : undefined
const serial = { pending: Promise.resolve() }
const exclusive = <T>(run: () => Promise<T>) => {
  const result = serial.pending.then(run)
  serial.pending = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}
const revisionRequest = { reason: undefined as string | undefined }
if (input.allowRevise && (input.mode === "bridge" || input.mode === "tau"))
  throw new Error("external task-local revision is not qualified")
const external = await (async () => {
  if (input.mode === "tau") {
    const { tauProfile } = await import("./rsi-tau-worker")
    return tauProfile({ deadline: input.deadline, standing })
  }
  if (input.mode === "bridge") {
    const { bridgeProfile } = await import("./rsi-bridge-worker")
    return bridgeProfile({ deadline: input.deadline, standing })
  }
})()
const delivery =
  input.mode === "programbench"
    ? await ContractDelivery.create({
        directory: "/candidate/workspace",
        state: "/state/delivery",
        reference: "/workspace/executable",
        deadline: input.deadline,
        signal: controller.signal,
        assertStanding: standing,
        obligations: (await Bun.file("/task/obligations.json").exists())
          ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(ContractDelivery.Obligation)))(
              await Bun.file("/task/obligations.json").text(),
            )
          : [],
      })
    : undefined
const artifact = path.join("/candidate", input.artifact)
const snapshot = async () => {
  const info = await fs.lstat(artifact)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0 || info.size > 16 * 1024 * 1024)
    throw new Error("one bounded regular artifact required")
  return Bun.SHA256.hash(await Bun.file(artifact).bytes(), "hex")
}
const plugin = Plugin.define({
  id: "rsi.worker",
  async setup(context) {
    await context.tool.transform((editor) => {
      for (const tool of editor.list()) {
        if (!["glob", "grep", "read", "patch", "shell"].includes(tool.name)) {
          editor.remove(tool.id)
          continue
        }
        editor.update(tool.id, (current) => {
          current.options = { ...current.options, codemode: false, pinned: undefined }
          const execute = current.execute
          current.execute = async (value, call) => {
            const run = async () => {
              await standing()
              call.signal.throwIfAborted()
              if (check && (tool.name === "patch" || tool.name === "shell")) disposition.digest = ""
              return execute(
                tool.name === "shell"
                  ? {
                      ...value,
                      background: false,
                      timeout: Math.min(value.timeout || 600000, 600000, input.deadline - Date.now()),
                    }
                  : value,
                call,
              )
            }
            return check ? exclusive(run) : run()
          }
        })
      }
      if (check)
        editor.add({
          name: "rsi_check",
          description:
            "Check current proposal bytes without submitting. H: apply exact /candidate/h to the admitted parent, include every changed/new source file, then actually bundle the native entry with /runtime-bun and read-only /runtime dependencies. S: validate nonempty UTF-8 without NUL, at most 64 KiB. Compiler diagnostics are local feedback, not host release or performance authority. Fix within the original deadline.",
          input: Schema.Struct({}),
          options: { codemode: false },
          execute: async (_, call) =>
            exclusive(async () => {
              disposition.digest = ""
              return { content: JSON.stringify(await check(call.signal)) }
            }),
        })
      editor.add({
        name: "rsi_handoff",
        description:
          "Submit the exact output artifact for independent host verification. H/S are checked again now; a stale earlier rsi_check is insufficient. Failed local checks return diagnostics and keep this same allocation open for repair. This does not certify performance or authorize promotion.",
        input: Schema.Struct({ summary: Schema.String }),
        options: { codemode: false },
        execute: async (value, call) =>
          exclusive(async () => {
            await standing()
            call.signal.throwIfAborted()
            disposition.digest = ""
            if (!value.summary.trim() || value.summary.length > 8192)
              throw new Error("Handoff requires a nonempty summary of at most 8192 characters")
            const checked = await check?.(call.signal)
            if (checked && !checked.ok)
              return {
                content: JSON.stringify({
                  submitted: false,
                  check: checked,
                  correctionBeforeHandoffAllowed: true,
                  authoritativeCompletion: false,
                }),
              }
            const digest = await snapshot()
            if (checked && checked.artifactHash !== digest)
              return {
                content:
                  "Proposal changed after checking. Export the current bytes and call rsi_handoff again; the original deadline is unchanged.",
              }
            disposition.digest = digest
            disposition.summary = value.summary
            return { content: JSON.stringify({ submitted: disposition.digest, authoritativeCompletion: false }) }
          }),
      })
      editor.add({
        name: "rsi_blocked",
        description: "Stop this allocation with a concrete unresolved reason.",
        input: Schema.Struct({ reason: Schema.String }),
        options: { codemode: false },
        execute: async (value, call) =>
          exclusive(async () => {
            await standing()
            call.signal.throwIfAborted()
            if (!value.reason.trim()) throw new Error("A concrete nonempty blocking reason is required")
            disposition.digest = ""
            disposition.blocked = value.reason
            return { content: "Blocked; not a successful proposal." }
          }),
      })
    })
  },
})
const host = await PromiseSdk.create(
  {
    app: { name: "native-rsi-worker" },
    database: { path: "/state/session.sqlite" },
    events: { persist: true },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
    config: {
      directory: "/state/config",
      project: false,
      content: JSON.stringify({
        model: `openai/${input.model}`,
        permissions: [
          { action: "*", resource: "*", effect: "allow" },
          { action: "execute", resource: "*", effect: "deny" },
        ],
        providers: {
          openai: {
            package: "@opencode/ai/providers/openai",
            canonical: "openai",
            env: [],
            settings: {
              baseURL: "http://programbench-provider.invalid/v1",
              apiKey: "no-credential",
              transport: "http",
              timeout: 900000,
              chunkTimeout: 900000,
            },
            models: {
              [input.model]: {
                limit: { context: 272000, output: 128000 },
                capabilities: { tools: true, reasoning: true, input: ["text"], output: ["text"] },
                body: { reasoning: { effort: input.effort }, store: false },
                variants: [{ id: input.effort, body: { reasoning: { effort: input.effort } } }],
              },
            },
          },
        },
      }),
    },
    plugins: [
      delivery
        ? contractProfile(
            delivery,
            input.deadline,
            input.allowRevise
              ? (reason) => {
                  revisionRequest.reason = reason
                }
              : undefined,
          )
        : (external?.plugin ?? plugin),
    ],
  },
  {
    overrides: [
      requestExecutor.replace(
        ProviderTransport.layerWith("/channel/provider.sock").pipe(Layer.provide(FetchHttpClient.layer)),
      ),
    ],
  },
)
const session = await host.sessions.create({
  id: input.id,
  title: "RSI allocation",
  location: { directory: delivery ? "/candidate/workspace" : "/candidate" },
  model: { providerID: "openai", id: input.model, variant: input.effort },
})
const abort = () => {
  controller.abort()
  void host.sessions.interrupt({ sessionID: session.id }).catch(() => undefined)
}
process.on("SIGTERM", abort)
process.on("SIGINT", abort)
const timer = setTimeout(abort, Math.max(0, input.deadline - Date.now()))
try {
  await host.sessions.prompt({
    sessionID: session.id,
    text:
      `${await Bun.file("/strategy").text()}\n\n${input.goal}\n\n` +
      (delivery
        ? ContractDelivery.instructions +
          (input.allowRevise
            ? "\nIf the execution strategy or harness prevents further progress, use rsi_revise with a concrete diagnosis. The host may evaluate a replacement; your task checkpoint and original deadline are retained. Do not use this merely to edit task source."
            : "")
        : (external?.instructions ??
          `Deliver /candidate/${input.artifact} using rsi_handoff with an honest summary. If unable, use rsi_blocked. Host verification and promotion are independent; never self-certify.`)) +
      (check
        ? input.artifact === "h"
          ? `\nThe installed compiler is /runtime-bun (it need not be named bun on PATH). The admitted native entry is ${input.proposal?.kind === "h" ? input.proposal.entry : "missing: report this admission problem"}. Export the exact working source to /candidate/h using git diff --binary HEAD; use git add -N for new files first. rsi_check verifies patch application to immutable /parent-source.tar, exact working-source coverage, and actual Bun entry bundling with fixed read-only /runtime dependencies. It ignores only Git metadata and dependency directories; keep generated build output outside /candidate/source. This is parsing/bundling, not full typecheck or task-quality evidence. Run focused tests separately within this same original deadline where appropriate. rsi_handoff always checks the current bytes again; repair actionable diagnostics before submission. A local check is not host release admission or permission to retry after formal issuer rejection.`
          : "\nUse rsi_check to validate /candidate/s: nonempty UTF-8 without NUL, at most 64 KiB. rsi_handoff validates the current exact bytes again. A local check does not attest performance; the original deadline and independent qualification remain unchanged."
        : ""),
  })
  const wait = async () => {
    await host.sessions.wait({ sessionID: session.id })
    await standing()
    const events = await Array.fromAsync(host.sessions.log({ sessionID: session.id }))
    await Bun.write("/state/events.json", JSON.stringify(events))
    if (events.some((e) => e.type === "session.execution.failed")) throw new Error("native Session failed")
  }
  if (delivery) {
    const result = await drainDelivery({
      wait,
      prompt: (text) => host.sessions.prompt({ sessionID: session.id, text }),
      status: delivery.status,
      assertActive: standing,
      revision: () => revisionRequest.reason,
    })
    // Outside workspace: writing the handoff must not invalidate its source snapshot.
    await Bun.write(
      artifact,
      JSON.stringify({ kind: "programbench-handoff", result, obligations: delivery.obligations() }),
    )
    disposition.digest = await snapshot()
    disposition.summary =
      ("summary" in result ? result.summary : "reason" in result ? result.reason : undefined) ??
      "Task artifact submitted"
  }
  if (external) {
    while (true) {
      await wait()
      const result = external.status()
      if (result.state !== "open") {
        await Bun.write(
          artifact,
          JSON.stringify({
            kind: input.mode === "tau" ? "tau-handoff" : "bridge-handoff",
            result,
            authoritativeCompletion: false,
          }),
        )
        disposition.digest = await snapshot()
        disposition.summary = ("summary" in result ? result.summary : undefined) ?? "Official conversation ended"
        break
      }
      await host.sessions.prompt({
        sessionID: session.id,
        text: "No benchmark handoff is recorded. Continue using the admitted benchmark tools until the official conversation ends, or explicitly submit task_handoff/task_blocked if those tools are available. The original deadline is unchanged.",
      })
    }
  }
  while (!delivery && !external) {
    await wait()
    if (disposition.blocked) throw new Error(disposition.blocked)
    if (disposition.digest && disposition.digest === (await snapshot())) break
    await host.sessions.prompt({
      sessionID: session.id,
      text: "No valid artifact handoff is recorded. Finish and call rsi_handoff, or explicitly report rsi_blocked. The original deadline is unchanged.",
    })
  }
  await Bun.write(
    "/state/handoff.json",
    JSON.stringify({ ...disposition, deadline: input.deadline, authoritativeCompletion: false }),
  )
} finally {
  clearTimeout(timer)
  controller.abort()
  await host.close()
}
