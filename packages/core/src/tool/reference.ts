export * as ReferenceTools from "./reference"

import { ToolFailure } from "@opencode-ai/llm"
import { Clock, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { ProContract } from "../pro-contract"
import { ProContractExecutor } from "../pro-contract/executor"
import { ProContractObservation } from "../pro-contract/observation"
import { ProContractOpenCode } from "../pro-contract/open-code"
import { AbsolutePath, PositiveInt } from "../schema"
import { Hash } from "../util/hash"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export type Configuration = {
  readonly contractID: ProContract.ID
  readonly executable: AbsolutePath
  readonly hash: string
  readonly directory: AbsolutePath
  readonly timeout: number
}

/** Installed by the host for a particular Contract; no reference path comes from a model call. */
export function nodeWith(configuration: Configuration) {
  const configured = Object.freeze({ ...configuration })
  return makeLocationNode({
    name: "tool/reference",
    deps: [
      ToolRegistry.node,
      FSUtil.node,
      Location.node,
      PermissionV2.node,
      ProContract.node,
      ProContractOpenCode.node,
      ProContractExecutor.node,
      ProContractObservation.node,
    ],
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const tools = yield* Tools.Service
        const fs = yield* FSUtil.Service
        const location = yield* Location.Service
        const permissions = yield* PermissionV2.Service
        const contracts = yield* ProContract.Service
        const bindings = yield* ProContractOpenCode.Service
        const executor = yield* ProContractExecutor.Service
        const observations = yield* ProContractObservation.Service
        const failure = (message: string) => new ToolFailure({ message })

        const requireDelegation = Effect.fnUntraced(function* (context: Tool.Context) {
          const binding = yield* bindings.forSession(context.sessionID)
          const contract = yield* contracts.get(configured.contractID)
          if (
            !binding ||
            binding.contractID !== configured.contractID ||
            binding.revision !== contract?.revision ||
            contract.status !== "active" ||
            contract.pendingRevision ||
            !binding.dispatched ||
            binding.leaseOwner !== bindings.owner ||
            (binding.leaseExpiresAt ?? 0) <= (yield* Clock.currentTimeMillis) ||
            !contract.spec.authority.includes("reference.run")
          )
            return yield* failure("No active reference delegation for this Session")
          if (contract.spec.budget.deadline <= (yield* Clock.currentTimeMillis))
            return yield* failure("Contract deadline exhausted")
          return contract.spec.budget.deadline
        })

        const authorize = Effect.fnUntraced(function* (context: Tool.Context, action: string) {
          yield* requireDelegation(context)
          yield* permissions
            .assert({
              action,
              resources: [configured.hash],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            .pipe(Effect.mapError((error) => failure(String(error))))
          // Permission may wait for a user decision while the Contract is released or revised.
          return yield* requireDelegation(context)
        })

        const verifyReference = Effect.fnUntraced(function* () {
          const root = yield* fs.realPath(location.vcs ? location.project.directory : location.directory)
          const directory = yield* fs.realPath(configured.directory)
          const executable = yield* fs.realPath(configured.executable)
          if (FSUtil.contains(root, directory) || FSUtil.contains(directory, root) || FSUtil.contains(root, executable))
            return yield* failure("Reference and candidate must occupy separate directories")
          if (
            !Schema.is(ProContractObservation.Digest)(configured.hash) ||
            Hash.sha256(Buffer.from(yield* fs.readFile(executable))) !== configured.hash
          )
            return yield* failure("Reference executable failed identity validation")
          return { directory, executable }
        })

        yield* tools
          .register({
            reference_run: Tool.make({
              description: `Run the host-configured reference program directly with argv and stdin. Reference executable SHA-256: ${configured.hash}. Each call is a separate process; cwd is fixed by the host. First use a small probe to establish availability. The reference is separate from the candidate. Process completion does not prove a target statement executed or that behavior is covered. Captured bytes are retained for reference_read; no observation settles an obligation.`,
              input: Schema.Struct({
                args: Schema.Array(Schema.String),
                stdin: Schema.String,
                timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(600_000)).pipe(Schema.optional),
              }),
              output: Schema.Struct({
                ...ProContractObservation.Recorded.fields,
                preview: Schema.Struct({
                  encoding: Schema.Literal("utf8-lossy"),
                  stdout: Schema.String,
                  stderr: Schema.String,
                  truncated: Schema.Boolean,
                }),
              }),
              execute: (input, context) =>
                Effect.gen(function* () {
                  const deadline = yield* authorize(context, "reference_run")
                  if (!Number.isInteger(configured.timeout) || configured.timeout <= 0 || configured.timeout > 600_000)
                    return yield* failure("Invalid host reference timeout")
                  const reference = yield* verifyReference()
                  const remaining = deadline - (yield* Clock.currentTimeMillis)
                  if (remaining <= 0) return yield* failure("Contract deadline exhausted")
                  const argv = [reference.executable, ...input.args]
                  const result = yield* executor
                    .run({
                      argv,
                      cwd: reference.directory,
                      stdin: input.stdin,
                      timeout: Math.min(input.timeout ?? configured.timeout, configured.timeout, remaining),
                    })
                    .pipe(Effect.catch((error) => Effect.succeed({ error: error.message })))
                  const recorded = yield* observations.record({
                    scope: configured.contractID,
                    subject: { kind: "reference", identity: configured.hash },
                    argv,
                    cwd: reference.directory,
                    stdin: input.stdin,
                    result,
                  })
                  yield* verifyReference()
                  return {
                    ...recorded,
                    preview: {
                      encoding: "utf8-lossy" as const,
                      stdout: "error" in result ? "" : result.stdout.subarray(0, 2048).toString("utf8"),
                      stderr: "error" in result ? "" : result.stderr.subarray(0, 2048).toString("utf8"),
                      truncated:
                        "error" in result ||
                        result.stdoutTruncated ||
                        result.stderrTruncated ||
                        result.stdout.length > 2048 ||
                        result.stderr.length > 2048,
                    },
                  }
                }).pipe(Effect.mapError((error) => failure(error.message))),
            }),
            reference_read: Tool.make({
              description:
                "Read an exact byte range from this Contract's retained reference observation. Base64 is lossless, offsets and lengths are bytes. Check execution, exit, and capture completeness before using the output as an observation; target execution remains unobserved.",
              input: ProContractObservation.ReadInput,
              output: Schema.Struct({
                receipt: ProContractObservation.Receipt,
                content: ProContractObservation.ReadOutput,
              }),
              execute: (input, context) =>
                Effect.gen(function* () {
                  yield* authorize(context, "reference_read")
                  const receipt = yield* observations.get(input.handle)
                  if (
                    receipt.scope !== configured.contractID ||
                    receipt.subject.kind !== "reference" ||
                    receipt.subject.identity !== configured.hash
                  )
                    return yield* failure("Observation is not from this Contract's reference")
                  return { receipt, content: yield* observations.read(input) }
                }).pipe(Effect.mapError((error) => failure(error.message))),
            }),
          })
          .pipe(Effect.orDie)
      }),
    ),
  })
}
