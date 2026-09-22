export * as ReferenceTools from "./reference"

import { ToolFailure } from "@opencode-ai/llm"
import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { makeGlobalNode, makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { ProContract } from "../pro-contract"
import { ProContractExecutor } from "../pro-contract/executor"
import { ProContractObservation } from "../pro-contract/observation"
import { ProContractOpenCode } from "../pro-contract/open-code"
import { AbsolutePath, NonNegativeInt, PositiveInt } from "../schema"
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
  readonly candidateDirectory?: AbsolutePath
  readonly attestation?: AbsolutePath
}

export const Binding = Schema.Struct({
  contractID: ProContract.ID,
  candidateDirectory: AbsolutePath,
  executable: AbsolutePath,
  hash: ProContractObservation.Digest,
  directory: AbsolutePath,
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(600_000)),
  attestation: AbsolutePath,
})

export class HostBinding extends Context.Service<HostBinding, Configuration | undefined>()(
  "@opencode/ReferenceTools.HostBinding",
) {}

export const bindingLayer = (setting: string | undefined) =>
  Layer.sync(HostBinding, () => {
    if (setting === undefined) return undefined
    return Option.getOrThrowWith(
      Schema.decodeUnknownOption(Schema.fromJsonString(Binding))(setting),
      () => new Error("Invalid OPENCODE_REFERENCE_BINDING"),
    )
  })

export const bindingNode = makeGlobalNode({
  service: HostBinding,
  layer: Layer.suspend(() => bindingLayer(process.env.OPENCODE_REFERENCE_BINDING)),
  deps: [],
})

const RunInput = Schema.Struct({
  args: Schema.Array(Schema.String),
  stdin: Schema.String,
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(600_000)).pipe(Schema.optional),
})

const Preview = Schema.Struct({
  encoding: Schema.Literal("utf8-lossy"),
  stdout: Schema.String,
  stderr: Schema.String,
  truncated: Schema.Boolean,
})

const RunOutput = Schema.Struct({
  ...ProContractObservation.Recorded.fields,
  preview: Preview,
})

const ContrastCase = Schema.Struct({
  label: Schema.NonEmptyString,
  ...RunInput.fields,
})

export const ContrastInput = Schema.Struct({
  hypothesis: Schema.NonEmptyString.annotate({
    description: "The semantic or setup decision this contrast can change.",
  }),
  expected: Schema.Literals(["same", "different"]).annotate({
    description: "The caller's expected relation between the two complete exit/stdout/stderr outcomes.",
  }),
  left: ContrastCase,
  right: ContrastCase,
})

const ContrastStage = Schema.Struct({
  label: Schema.NonEmptyString,
  callID: Schema.String,
  status: Schema.Literals(["completed", "incomplete", "unavailable", "skipped"]),
  observation: ProContractObservation.Recorded.pipe(Schema.optional),
  preview: Preview.pipe(Schema.optional),
  outcomeHash: ProContractObservation.Digest.pipe(Schema.optional),
  error: Schema.String.pipe(Schema.optional),
})

export const ContrastOutput = Schema.Struct({
  hypothesis: Schema.NonEmptyString,
  expected: Schema.Literals(["same", "different"]),
  relation: Schema.Literals(["same-exact-outcome", "different-exact-outcome", "incomplete"]),
  exactRelationMet: Schema.Boolean.pipe(Schema.optional),
  left: ContrastStage,
  right: ContrastStage,
  interpretation: Schema.String,
})

const dependencies = [
  ToolRegistry.node,
  FSUtil.node,
  Location.node,
  PermissionV2.node,
  ProContract.node,
  ProContractOpenCode.node,
  ProContractExecutor.node,
  ProContractObservation.node,
] as const

/** Installed by the host for a particular Contract; no reference path comes from a model call. */
export const nodeWith = (configuration: Configuration) =>
  makeLocationNode({
    name: "tool/reference",
    deps: dependencies,
    layer: layerWith(configuration),
  })

export const configuredNode = makeLocationNode({
  name: "tool/reference-configured",
  deps: [bindingNode, ...dependencies],
  layer: Layer.unwrap(
    Effect.gen(function* () {
      const binding = yield* HostBinding
      return binding ? layerWith(binding) : Layer.empty
    }),
  ),
})

function layerWith(configuration: Configuration) {
  const configured = Object.freeze({ ...configuration })
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const tools = yield* Tools.Service
      const registry = yield* ToolRegistry.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const permissions = yield* PermissionV2.Service
      const contracts = yield* ProContract.Service
      const bindings = yield* ProContractOpenCode.Service
      const executor = yield* ProContractExecutor.Service
      const observations = yield* ProContractObservation.Service
      const failure = (message: string) => new ToolFailure({ message })
      // The process may host other Locations; an environment binding delegates
      // reference access only in the exact candidate placement named by its issuer.
      if (
        configured.candidateDirectory &&
        (yield* fs.realPath(location.directory).pipe(Effect.orDie)) !==
          (yield* fs.realPath(configured.candidateDirectory).pipe(Effect.orDie))
      )
        return

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
        if (configured.attestation) {
          const attestation = yield* fs.realPath(configured.attestation)
          if (
            attestation !== configured.attestation ||
            FSUtil.contains(root, attestation) ||
            executable !== configured.executable
          )
            return yield* failure("Reference attestation must be host-owned outside the candidate")
          yield* Effect.tryPromise({
            try: () => verifyAttestedReference(configured),
            catch: () => failure("Reference host attestation failed identity validation"),
          })
          return { directory, executable }
        }
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
            description: `Run the host-configured reference program directly with argv and stdin. Reference executable SHA-256: ${configured.hash}. Each call is a separate process; cwd is fixed by the host. First use a small probe to establish availability. The reference is separate from the candidate. Process completion does not prove a target statement executed or that behavior is covered. Captured bytes are retained for reference_read; no observation settles an obligation. Use reference_contrast when two inputs are intended to discriminate setup or semantic alternatives.`,
            input: RunInput,
            output: RunOutput,
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
          reference_contrast: Tool.withSubactions(
            Tool.make({
              description:
                "Run two labeled invocations serially against the same host reference and compare their complete captured exit/stdout/stderr tuples. Use for a semantic-vs-setup contrast, documented invariant or state/order check; state the decision and expected exact relation. Vary one ingress dimension unless repetition is the tested dimension. Each case is retained and charged as a normal reference action. Equal outcomes are only a collapse signal; different outcomes show only process-boundary variation. Neither proves target execution, coverage or settlement. The cwd is shared; process-local state is not.",
              input: ContrastInput,
              output: ContrastOutput,
              execute: (input, context) =>
                Effect.gen(function* () {
                  if (input.left.label === input.right.label)
                    return yield* failure("Reference contrast labels must be distinct")
                  yield* authorize(context, "reference_contrast")
                  const catalog = yield* registry.materialize()
                  if (!catalog.definitions.some((tool) => tool.name === "reference_run"))
                    return yield* failure("Reference run tool is unavailable under the current policy")
                  const invoke = Effect.fnUntraced(function* (
                    side: typeof ContrastCase.Type,
                    suffix: "left" | "right",
                  ) {
                    const callID = `${context.toolCallID}:${suffix}`
                    const result = yield* catalog.settle({
                      sessionID: context.sessionID,
                      agent: context.agent,
                      assistantMessageID: context.assistantMessageID,
                      call: {
                        type: "tool-call",
                        id: callID,
                        name: "reference_run",
                        input: { args: side.args, stdin: side.stdin, timeout: side.timeout },
                      },
                    })
                    return contrastStage(side.label, callID, result)
                  })
                  const left = yield* invoke(input.left, "left")
                  const right =
                    left.status === "unavailable"
                      ? ({
                          label: input.right.label,
                          callID: `${context.toolCallID}:right`,
                          status: "skipped" as const,
                          error: "The first reference call was unavailable; the second case was not run.",
                        } satisfies typeof ContrastStage.Type)
                      : yield* invoke(input.right, "right")
                  return contrastResult(input, left, right)
                }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : failure(String(error))))),
            }),
          ),
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
  )
}

const Attestation = Schema.Struct({
  executable: AbsolutePath,
  hash: ProContractObservation.Digest,
  stat: Schema.Struct({
    dev: NonNegativeInt,
    ino: NonNegativeInt,
    mode: NonNegativeInt,
    uid: NonNegativeInt,
    size: NonNegativeInt,
    mtime: NonNegativeInt,
  }),
})

// Production references are root-owned and execute-only. The isolated worker
// verifies the issuer's immutable inode attestation, never reads oracle bytes.
async function verifyAttestedReference(configured: Configuration) {
  const uid = process.geteuid?.()
  if (uid === undefined || uid === 0) throw new Error("Reference attestation requires an isolated non-root worker")
  const file = await open(configured.attestation!, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 16_384 || info.uid === uid || info.mode & 0o222)
      throw new Error("Untrusted reference attestation")
    const receipt = Schema.decodeUnknownSync(Schema.fromJsonString(Attestation))(await file.readFile("utf8"))
    const executable = await lstat(configured.executable)
    if (
      !executable.isFile() ||
      executable.uid !== 0 ||
      executable.mode & 0o222 ||
      receipt.executable !== configured.executable ||
      receipt.hash !== configured.hash ||
      receipt.stat.dev !== executable.dev ||
      receipt.stat.ino !== executable.ino ||
      receipt.stat.uid !== executable.uid ||
      receipt.stat.mode !== (executable.mode & 0o7777) ||
      receipt.stat.size !== executable.size ||
      receipt.stat.mtime !== Math.floor(executable.mtimeMs)
    )
      throw new Error("Reference identity changed")
  } finally {
    await file.close()
  }
}

// Compare only complete retained process-boundary fields; the caller's hypothesis never changes this relation.
function exactOutcome(receipt: ProContractObservation.Receipt) {
  if (
    receipt.execution !== "completed" ||
    typeof receipt.exit !== "number" ||
    !receipt.stdout?.complete ||
    !receipt.stderr?.complete
  )
    return
  return Hash.sha256(
    JSON.stringify({
      execution: receipt.execution,
      exit: receipt.exit,
      stdout: receipt.stdout,
      stderr: receipt.stderr,
    }),
  )
}

function contrastStage(label: string, callID: string, result: ToolRegistry.Settlement): typeof ContrastStage.Type {
  const output = result.output?.structured
  if (!Schema.is(RunOutput)(output))
    return {
      label,
      callID,
      status: "unavailable",
      error:
        result.result.type === "error"
          ? typeof result.result.value === "string"
            ? result.result.value
            : String(result.result.value)
          : "Reference observation was unavailable",
    }
  const outcomeHash = exactOutcome(output.receipt)
  return {
    label,
    callID,
    status: outcomeHash ? "completed" : "incomplete",
    observation: { handle: output.handle, receipt: output.receipt },
    preview: output.preview,
    outcomeHash,
  }
}

function contrastResult(
  input: typeof ContrastInput.Type,
  left: typeof ContrastStage.Type,
  right: typeof ContrastStage.Type,
): typeof ContrastOutput.Type {
  const relation =
    !left.outcomeHash || !right.outcomeHash
      ? ("incomplete" as const)
      : left.outcomeHash === right.outcomeHash
        ? ("same-exact-outcome" as const)
        : ("different-exact-outcome" as const)
  const exactRelationMet =
    relation === "incomplete"
      ? undefined
      : input.expected === "same"
        ? relation === "same-exact-outcome"
        : relation === "different-exact-outcome"
  const interpretation = (() => {
    if (relation === "incomplete")
      return "At least one invocation or capture was incomplete or unavailable. Preserve both statuses; this contrast cannot establish the caller's expected relation or target execution."
    if (relation === "same-exact-outcome" && input.expected === "different")
      return "The two caller-supplied invocations produced the same complete captured exit/stdout/stderr tuple. This is a bounded collapse signal: investigate setup, launcher or pre-dispatch obstruction before treating it as downstream semantics. Target execution remains unobserved, and uncaptured side effects may differ."
    if (relation === "different-exact-outcome" && input.expected === "different")
      return "The complete captured process tuples differ, so variation is observable at or before the process boundary. This does not identify which semantic layer ran, validate either output as target semantics or establish coverage."
    if (relation === "same-exact-outcome")
      return "The caller's expected exact invariant was observed for these two bounded process outcomes. Target execution and broader invariant scope remain unobserved."
    return "The caller's expected exact invariant did not hold at the process boundary. Inspect input, shared state, setup and capture before choosing a repair; target execution remains unobserved."
  })()
  return {
    hypothesis: input.hypothesis,
    expected: input.expected,
    relation,
    exactRelationMet,
    left,
    right,
    interpretation,
  }
}
