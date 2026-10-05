import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractRun } from "@opencode-ai/core/pro-contract/run"
import { ProContractVersion } from "@opencode-ai/core/pro-contract/version"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Clock, Effect, Schema } from "effect"
import { cp, mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import type { Argv } from "yargs"
import { CliError, effectCmd, fail } from "../effect-cmd"

const FreezeCommand = effectCmd({
  command: "freeze",
  describe: "freeze an offline workflow's exact source, configuration, and runtime identity",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("directory", { type: "string", demandOption: true, describe: "workflow source directory" })
      .option("entrypoint", {
        type: "string",
        demandOption: true,
        describe: "normalized source-relative Bun entrypoint",
      })
      .option("config", { type: "string", describe: "workflow configuration JSON file" }),
  handler: Effect.fn("Cli.contract.version.freeze")(function* (args) {
    const config = args.config === undefined ? undefined : yield* readJson(args.config, Schema.Json)
    const global = yield* Global.Service
    const versions = ProContractVersion.make({ directory: ProContractVersion.storePath(global.data) })
    const version = yield* operation(() =>
      versions.freeze({ directory: path.resolve(args.directory), entrypoint: args.entrypoint, config }),
    )
    console.log(JSON.stringify(version, null, 2))
  }),
})

const InspectCommand = effectCmd({
  command: "inspect <versionHash>",
  describe: "verify and inspect an exact frozen executable version",
  instance: false,
  builder: (yargs) =>
    yargs.positional("versionHash", { type: "string", demandOption: true, describe: "frozen executable version hash" }),
  handler: Effect.fn("Cli.contract.version.inspect")(function* (args) {
    const global = yield* Global.Service
    const versions = ProContractVersion.make({ directory: ProContractVersion.storePath(global.data) })
    const manifest = yield* operation(() => versions.inspect(args.versionHash))
    console.log(JSON.stringify({ versionHash: args.versionHash, manifest }, null, 2))
  }),
})

const QualifyCommand = effectCmd({
  command: "qualify <versionHash>",
  describe: "explicitly run a frozen candidate offline for qualification, without accepting or deploying it",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("versionHash", { type: "string", demandOption: true, describe: "frozen executable version hash" })
      .option("task", { type: "string", demandOption: true, describe: "qualification task JSON file" })
      .option("workspace", { type: "string", demandOption: true, describe: "workspace copied into isolated execution" })
      .option("deadline", { type: "string", demandOption: true, describe: "absolute ISO qualification deadline" }),
  handler: Effect.fn("Cli.contract.version.qualify")(function* (args) {
    const deadline = Date.parse(args.deadline)
    if (!Number.isSafeInteger(deadline) || deadline < 0) return yield* fail(`Invalid deadline: ${args.deadline}`)
    const task = yield* readJson(args.task, Schema.Json)
    const global = yield* Global.Service
    const versions = ProContractVersion.make({ directory: ProContractVersion.storePath(global.data) })
    const run = yield* operation((signal) =>
      versions.run({
        versionHash: args.versionHash,
        task: { purpose: "qualification", input: task },
        view: {},
        workspace: path.resolve(args.workspace),
        deadline,
        signal,
      }),
    )
    console.log(
      JSON.stringify(
        { run, qualification: { runID: run.id, evidenceHash: ProContractVersion.subjectHash(run) } },
        null,
        2,
      ),
    )
    if (run.status !== "completed") return yield* fail(`Version qualification ${run.id}: ${run.status}`, 2)
  }),
})

const RunCommand = effectCmd({
  command: "run",
  describe: "admit one durable task and run its exact authorized version; outputs are untrusted proposals",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("id", { type: "string", describe: "Contract ID for exact admission retries" })
      .option("scope", { type: "string", demandOption: true, describe: "authorized strategy scope" })
      .option("role", {
        choices: ["incumbent", "research_executor"] as const,
        demandOption: true,
        describe: "execution role",
      })
      .option("task", { type: "string", demandOption: true, describe: "task JSON file" })
      .option("workspace", { type: "string", demandOption: true, describe: "workspace copied into isolated execution" })
      .option("deadline", {
        type: "string",
        demandOption: true,
        describe: "absolute ISO deadline, with no cumulative count cap",
      })
      .option("target-version", { type: "string", describe: "archived bundle hash being researched" })
      .option("require", {
        type: "array",
        string: true,
        describe: "explicit result-evidence dependency as ID@revision",
      })
      .option("view", {
        type: "string",
        describe: "JSON file selecting permitted versionHashes, experimentIDs, and contractIDs",
      })
      .option("model", {
        type: "string",
        describe: "authorize native text-only reasoning requests with provider/model",
      })
      .option("variant", { type: "string", describe: "model variant; requires --model" }),
  handler: Effect.fn("Cli.contract.version.run")(function* (args) {
    const deadline = Date.parse(args.deadline)
    if (!Number.isSafeInteger(deadline) || deadline < 0) return yield* fail(`Invalid deadline: ${args.deadline}`)
    if (args.variant !== undefined && args.model === undefined) return yield* fail("--variant requires --model")
    const requires =
      args.require === undefined
        ? undefined
        : yield* Effect.forEach(args.require, (value) => {
            if (typeof value !== "string") return fail("Invalid required Contract")
            const match = /^(pct_.+)@([1-9]\d*)$/.exec(value)
            if (!match || !Number.isSafeInteger(Number(match[2]))) return fail(`Invalid required Contract: ${value}`)
            return Effect.succeed({ contractID: ProContract.ID.make(match[1]), revision: Number(match[2]) })
          })
    const task = yield* readJson(args.task, Schema.Json)
    const view = args.view === undefined ? undefined : yield* readJson(args.view, ProContractRun.View)
    const parsed = args.model === undefined ? undefined : ModelV2.parse(args.model)
    const runs = yield* ProContractRun.Service
    const now = yield* Clock.currentTimeMillis
    const contract = yield* runs.issue({
      id: args.id === undefined ? undefined : ProContract.ID.make(args.id),
      scope: args.scope,
      role: args.role,
      task,
      workspace: AbsolutePath.make(path.resolve(args.workspace)),
      deadline,
      targetVersion: args.targetVersion,
      view,
      requires,
      model:
        parsed === undefined
          ? undefined
          : ModelV2.Ref.make({
              providerID: parsed.providerID,
              id: parsed.modelID,
              variant: args.variant === undefined ? undefined : ModelV2.VariantID.make(args.variant),
            }),
      now,
    })
    const result = yield* runs.execute({ contractID: contract.id })
    console.log(JSON.stringify({ ...result, contract: ProContract.info(result.contract) }, null, 2))
    if (result.run.status !== "completed") return yield* fail(`Version run ${result.run.id}: ${result.run.status}`, 2)
  }),
})

const ResumeCommand = effectCmd({
  command: "resume <contractID>",
  describe: "explicitly resume an existing task without changing its frozen binding or original deadline",
  instance: false,
  builder: (yargs) => yargs.positional("contractID", { type: "string", demandOption: true, describe: "Contract ID" }),
  handler: Effect.fn("Cli.contract.version.resume")(function* (args) {
    const runs = yield* ProContractRun.Service
    const result = yield* runs.execute({ contractID: ProContract.ID.make(args.contractID), resume: true })
    console.log(JSON.stringify({ ...result, contract: ProContract.info(result.contract) }, null, 2))
    if (result.run.status !== "completed") return yield* fail(`Version run ${result.run.id}: ${result.run.status}`, 2)
  }),
})

const ShowCommand = effectCmd({
  command: "show <contractID>",
  describe: "show a task's durable responsibility, retained runs, and interrupted attempts",
  instance: false,
  builder: (yargs) => yargs.positional("contractID", { type: "string", demandOption: true, describe: "Contract ID" }),
  handler: Effect.fn("Cli.contract.version.show")(function* (args) {
    const runs = yield* ProContractRun.Service
    const result = yield* runs.get(ProContract.ID.make(args.contractID))
    console.log(JSON.stringify({ ...result, contract: ProContract.info(result.contract) }, null, 2))
  }),
})

const ExportCommand = effectCmd({
  command: "export <runID>",
  describe: "copy verified retained artifacts to a new directory, never overwriting existing files",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("runID", { type: "string", demandOption: true, describe: "version run ID" })
      .option("directory", { type: "string", demandOption: true, describe: "new output directory; parent must exist" }),
  handler: Effect.fn("Cli.contract.version.export")(function* (args) {
    const global = yield* Global.Service
    const versions = ProContractVersion.make({ directory: ProContractVersion.storePath(global.data) })
    const source = yield* operation(() => versions.artifactDirectory(args.runID))
    const directory = path.resolve(args.directory)
    // Atomic creation refuses even an existing empty directory. Copy failures leave
    // a partial export, never alter retained evidence, and are reported as failures.
    yield* operation(async () => {
      const destination = path.join(await realpath(path.dirname(directory)), path.basename(directory))
      const store = await realpath(global.data)
      if (destination === store || destination.startsWith(store + path.sep))
        throw new Error("Artifact exports must remain outside host data storage")
      await mkdir(directory, { mode: 0o700 })
      await cp(source, directory, { recursive: true, force: false, errorOnExist: true })
    })
    console.log(JSON.stringify({ runID: args.runID, directory }, null, 2))
  }),
})

export const ContractVersionCommand = effectCmd({
  command: "version",
  describe: "freeze and run replaceable workflows behind durable responsibility and host authorization",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .command(FreezeCommand)
      .command(InspectCommand)
      .command(QualifyCommand)
      .command(RunCommand)
      .command(ResumeCommand)
      .command(ShowCommand)
      .command(ExportCommand)
      .demandCommand(),
  handler: Effect.fn("Cli.contract.version")(function* () {}),
})

function operation<A>(run: (signal: AbortSignal) => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new CliError({ message: cause instanceof Error ? cause.message : String(cause) }),
  })
}

function readJson<A>(file: string, schema: Schema.Codec<A, unknown>) {
  return operation(() => Bun.file(path.resolve(file)).text()).pipe(
    Effect.catchTag("CliError", (error) => fail(`Cannot read JSON file ${file}: ${error.message}`)),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)),
    Effect.flatMap(Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })),
    Effect.catchTag("SchemaError", (error) => fail(`Invalid JSON file ${file}: ${error.message}`)),
  )
}
